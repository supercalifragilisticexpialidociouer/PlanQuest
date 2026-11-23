'use strict';

/*
 * 军团同步服务 · 局域网版
 *
 * 与自习房（src/study-room.js）同一套技术：裸 TCP + JSON 行协议。
 * 房主开服务（默认端口 48770，被占用自动 +1），军团成员连进来。
 *
 * 和房间的区别：房间是实时互动（每秒推状态），军团是「每几小时一次」的批量上报。
 * 成员把一份脱敏摘要推给房主 → 房主聚合 → 把军团概况广播回去。
 * 不经过任何服务器，数据不出局域网。
 *
 * 严格白名单：只接受 6 个字段的「档位值」，任何计划名、押金金额、备注、
 * 精确积分都不会离开成员本机。服务端会再裁一次，就算前端被改也传不出去。
 *
 * 协议（每行一条 JSON）：
 *   → {t:'probe', code}                        ← {t:'info'|'error'}
 *   → {t:'hello', code, alias, uid, ver}       ← {t:'welcome', myUid, code, intervalH, agg}
 *   → {t:'push', bundle}                       ← {t:'ack', at} + 广播 {t:'agg'}
 *   ← {t:'agg', agg}                            （房主主动下发）
 *   → {t:'chat', text, at, id}                  ← 广播 {t:'chat', msg} / {t:'chatDenied', reason, left}
 *   ← {t:'chatRules', rules}                     （团长改规则后下发）
 *   → {t:'bye'}
 *
 * 频道：军团自己的频道，不复用自习房闲聊。规则（开关/严格度/时长/自定义词）
 * 由团长定，判定用 src/legion-chat.js 的纯函数 —— 房主与成员算出同一结果。
 */

const net = require('node:net');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const chatRulesLib = require('./legion-chat');
const govLib = require('./legion-gov');

const BASE_PORT = 48770;
const KEEP_DAYS = 120; // 保留 120 天：连击周要往前数 12 周（每条只有 3 个 bit，占不了多少）
const ALIVE_MS = 24 * 3600e3; // 24 小时内推过 = 活跃
const HELLO_TIMEOUT = 6000;
const IDLE_TIMEOUT = 90e3; // 连上后 90 秒没动静就断开（军团是低频的，不必长挂）

let mode = 'none'; // none | host（局域网服务端） | client（局域网成员） | hub（异地：只聚合，连接由渲染层 WebRTC 负责）
let server = null;
let client = null;
let roomCode = '';
let myAlias = '我';
let myUid = '';
let legacyPath = ''; // 房主侧落盘路径
let onEvent = () => {};
let cleanupTimer = null;

/* 房主侧：uid -> { uid, alias, bundle, days, lastAt } */
const members = new Map();
/* 成员侧：最近一次收到的聚合 */
let lastAgg = null;
/* 成员侧：房主 IP / 端口 */
let hostAddr = { ip: '', port: BASE_PORT };

/* 军团级账本：只记事件与合计数，不记任何人的明细 */
let storeLog = []; // [{ at, kind, n }]，最多 60 条
let rescueTotal = 0; // 救援值：累计点灯次数
let badges = {}; // { '2026-W47': { at, n } } 达标的集体挑战周
let muted = false; // 熔断开关：暂停一切自动化挑战奖励，直到用户手动恢复

/* 军团频道：规则、聊天记录、禁言账本都由房主持有并落盘 */
let chatRules = chatRulesLib.normalizeRules();
let chatLog = []; // [{ id, uid, alias, text, at, sys? }]，最多 120 条
let chatMutes = {}; // uid -> { until, count, reason, at }
let govElection = null; // 团长选举（团长退团后全团接任用）

function pushLog(kind, n) {
  storeLog.push({ at: Date.now(), kind: String(kind || ''), n: Number(n) || 0 });
  if (storeLog.length > 60) storeLog = storeLog.slice(-60);
}

function setEmitter(fn) {
  onEvent = typeof fn === 'function' ? fn : () => {};
}

function setStorePath(p) {
  legacyPath = String(p || '');
  loadStore();
}

function emit(type, payload = {}) {
  try {
    onEvent({ type, ...payload });
  } catch (_) {}
}

function lanIP() {
  const ifs = os.networkInterfaces();
  for (const list of Object.values(ifs)) {
    for (const it of list || []) {
      if (it.family === 'IPv4' && !it.internal) return it.address;
    }
  }
  return '127.0.0.1';
}

function encode(obj) {
  return JSON.stringify(obj) + '\n';
}

/* ---------------- 脱敏：只留档位 ---------------- */

const BAND = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(3, Math.round(n))) : 0;
};

/* 白名单裁剪。bundle 里其它任何字段一律丢弃，不做「顺便带上」。
 *
 * v2 只保留四种状态，全部是 0/1：
 *   checked 今日是否已打卡 / force 是否处于强制模式 / neg 是否正在负分
 * 计划内容、具体时长、积分余额、契约金额、摄像头画面 —— 一个都不在协议里，
 * 所以就算有人改前端也构造不出发不出去的字段。 */
function sanitizeBundle(raw) {
  const b = raw && typeof raw === 'object' ? raw : {};
  const day = String(b.day || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const bit = (v) => (v ? 1 : 0);
  return { v: 2, day, checked: bit(b.checked), force: bit(b.force), neg: bit(b.neg) };
}

/* ---------------- 聚合 ---------------- */

function dayKey(d) {
  const t = d instanceof Date ? d : new Date(d);
  const m = String(t.getMonth() + 1).padStart(2, '0');
  const dd = String(t.getDate()).padStart(2, '0');
  return `${t.getFullYear()}-${m}-${dd}`;
}

/* 本周一 00:00（周一算一周的开始） */
function weekStart(now) {
  const t = new Date(now);
  t.setHours(0, 0, 0, 0);
  const wd = (t.getDay() + 6) % 7; // 周一 = 0
  t.setDate(t.getDate() - wd);
  return t.getTime();
}

function tidyDays(m, now) {
  const keepFrom = dayKey(now - KEEP_DAYS * 86400e3);
  for (const k of Object.keys(m.days || {})) {
    if (k < keepFrom) delete m.days[k];
  }
}

function computeAgg() {
  const now = Date.now();
  const today = dayKey(now);
  const wStart = weekStart(now);
  const wKey = dayKey(wStart);
  const list = [...members.values()];
  const n = list.length;

  const out = {
    at: now,
    n, // 军团人数（真实计数）
    today: { checked: 0, unchecked: 0, force: 0, neg: 0 }, // 四态计数
    rate: 0, // 出操率档位 0 没人动 / 1 零星 / 2 过半 / 3 全员
    streakWeeks: 0, // 连击周：连续达标的周数
    rescue: rescueTotal, // 救援值：累计点灯次数
    challenge: { key: wKey, target: n * 5, done: 0, reached: false, badge: !!badges[wKey] },
    weeks: [], // 最近 7 天：只给人数与档位
    log: storeLog.slice(-8).reverse(), // 只记事件，不记人名
    muted: !!muted,
    mood: 'idle',
  };

  let checkedToday = 0;
  for (const m of list) {
    const b = m.bundle;
    const reported = !!(b && b.day === today);
    if (reported && b.checked) {
      out.today.checked++;
      checkedToday++;
    } else {
      out.today.unchecked++;
    }
    if (reported && b.force) out.today.force++;
    if (reported && b.neg) out.today.neg++;

    /* 本周打卡人次：只统计「已打卡」这个 bit，不碰任何时长/积分 */
    for (const [d, v] of Object.entries(m.days || {})) {
      const t = new Date(d + 'T00:00:00').getTime();
      if (t >= wStart && v && v.checked) out.challenge.done++;
    }
  }

  out.challenge.reached = out.challenge.target > 0 && out.challenge.done >= out.challenge.target;

  const ratio = n ? checkedToday / n : 0;
  /* 宁可说轻一点：正好一半仍算「零星」，过半才说「过半」 */
  out.rate = !checkedToday ? 0 : ratio >= 0.95 ? 3 : ratio >= 0.6 ? 2 : 1;
  out.mood = !n ? 'idle' : !checkedToday ? 'flat' : out.rate === 3 ? 'hot' : out.rate === 2 ? 'warm' : 'cold';

  /* 连击周：从上一周往前数，连续达到「人均每周 5 天」的周数（本周未结束，不计） */
  if (n) {
    for (let i = 1; i <= 12; i++) {
      const ws = wStart - i * 7 * 86400e3;
      const we = ws + 7 * 86400e3;
      let cnt = 0;
      for (const m of list) {
        for (const [d, v] of Object.entries(m.days || {})) {
          const t = new Date(d + 'T00:00:00').getTime();
          if (t >= ws && t < we && v && v.checked) cnt++;
        }
      }
      if (cnt >= n * 5) out.streakWeeks++;
      else break;
    }
  }

  for (let i = 6; i >= 0; i--) {
    const d = dayKey(now - i * 86400e3);
    let cnt = 0;
    for (const m of list) {
      const v = (m.days || {})[d];
      if (v && v.checked) cnt++;
    }
    out.weeks.push({ day: d, cnt, level: n ? (cnt >= n ? 3 : cnt * 2 >= n ? 2 : cnt > 0 ? 1 : 0) : 0 });
  }

  /* 集体挑战只奖不罚：达标记一次徽章（每个自然周只记一次），没达标什么都不发生 */
  if (out.challenge.reached && !badges[wKey] && !muted) {
    badges[wKey] = { at: now, n };
    pushLog('challenge', n);
  }

  return out;
}

function broadcastToMembers(payload) {
  if (mode !== 'host') return;
  const line = encode(payload);
  for (const m of members.values()) {
    if (m.socket && !m.socket.destroyed) {
      try {
        m.socket.write(line);
      } catch (_) {}
    }
  }
}

function pushAgg() {
  const agg = computeAgg();
  persistStore();
  broadcastToMembers({ t: 'agg', agg });
  emit('agg', { agg });
  return agg;
}

/* ---------------- 落盘（只房主写） ---------------- */

function persistStore() {
  if (!legacyPath || (mode !== 'host' && mode !== 'hub')) return;
  try {
    const now = Date.now();
    const obj = {
      v: 2,
      code: roomCode,
      savedAt: now,
      rescue: rescueTotal,
      log: storeLog.slice(-60),
      badges,
      muted: !!muted,
      chat: { rules: chatRules, log: chatLog.slice(-80), mutes: chatMutes },
      members: [...members.values()].map((m) => ({
        uid: m.uid,
        alias: m.alias,
        bundle: m.bundle,
        days: m.days || {},
        lastAt: m.lastAt || 0,
      })),
    };
    fs.writeFileSync(legacyPath, JSON.stringify(obj), 'utf8');
  } catch (_) {}
}

function loadStore() {
  if (!legacyPath) return;
  try {
    if (!fs.existsSync(legacyPath)) return;
    const obj = JSON.parse(fs.readFileSync(legacyPath, 'utf8'));
    if (!obj || (obj.v !== 1 && obj.v !== 2)) return;
    rescueTotal = Number(obj.rescue) || 0;
    storeLog = Array.isArray(obj.log) ? obj.log.slice(-60) : [];
    badges = obj.badges && typeof obj.badges === 'object' ? obj.badges : {};
    muted = !!obj.muted;
    if (obj.chat && typeof obj.chat === 'object') {
      chatRules = chatRulesLib.normalizeRules(obj.chat.rules || chatRules);
      chatLog = Array.isArray(obj.chat.log) ? obj.chat.log.slice(-80) : [];
      chatMutes = chatRulesLib.pruneMutes(obj.chat.mutes || {}, Date.now());
    }
    members.clear();
    for (const m of obj.members || []) {
      if (!m || !m.uid) continue;
      members.set(String(m.uid), {
        uid: String(m.uid),
        alias: String(m.alias || '').slice(0, 12),
        bundle: m.bundle || null,
        days: m.days || {},
        lastAt: Number(m.lastAt) || 0,
        socket: null,
      });
    }
  } catch (_) {}
}

/* ---------------- 房主 ---------------- */

function createLegion({ code, alias, uid, credit } = {}) {
  if (mode === 'host') {
    return Promise.resolve({
      ok: true,
      code: roomCode,
      port: server && server.address() ? server.address().port : BASE_PORT,
      ip: lanIP(),
      reused: true,
    });
  }
  if (mode === 'client') return Promise.resolve({ ok: false, message: '已在军团里，先退出' });

  roomCode = String(code || '').trim() || randomCode();
  myAlias = String(alias || '我').slice(0, 12);
  myUid = String(uid || '').trim() || 'u-' + Math.random().toString(36).slice(2, 10);
  /* 房主自己也进成员表：房主的数据同样走白名单 */
  if (!members.has(myUid)) {
    members.set(myUid, {
      uid: myUid,
      alias: myAlias,
      bundle: null,
      days: {},
      lastAt: 0,
      socket: null,
      credit: credit == null || !Number.isFinite(Number(credit)) ? null : Number(credit),
    });
  }

  return new Promise((resolve) => {
    let port = BASE_PORT;
    let tries = 0;

    const tryListen = () => {
      const s = net.createServer((socket) => handleConn(socket));
      s.once('error', () => {
        try {
          s.close();
        } catch (_) {}
        if (++tries > 10) return resolve({ ok: false, message: '端口 48770–48780 都被占用了' });
        port += 1;
        tryListen();
      });
      s.listen(port, '0.0.0.0', () => {
        server = s;
        mode = 'host';
        startCleanup();
        resolve({ ok: true, code: roomCode, port, ip: lanIP(), uid: myUid });
        emit('status', { inLegion: true, role: 'host', code: roomCode, port, ip: lanIP() });
      });
    };
    tryListen();
  });
}

/* ---------------- 异地（P2P）聚合枢纽 ----------------
 *
 * 异地模式不开 TCP 服务：连接由渲染层的 WebRTC DataChannel 负责（与自习房的
 * net.html 同一套技术），本进程只当「算账的」——把成员经 DataChannel 送来的
 * 摘要做同一份白名单裁剪、同一份聚合，这样局域网与异地的概况口径完全一致。
 */

function startHub({ code, alias, uid } = {}) {
  if (mode === 'host') return { ok: true, reused: true, code: roomCode, uid: myUid, role: 'host' };
  if (mode === 'hub') return { ok: true, reused: true, code: roomCode, uid: myUid, role: 'hub' };
  if (mode === 'client') return { ok: false, message: '已在军团里，先退出' };

  roomCode = String(code || '').trim() || randomCode();
  myAlias = String(alias || '我').slice(0, 12);
  myUid = String(uid || '').trim() || 'u-' + Math.random().toString(36).slice(2, 10);
  mode = 'hub';
  members.clear();
  members.set(myUid, { uid: myUid, alias: myAlias, bundle: null, days: {}, lastAt: 0, socket: null });
  startCleanup();
  emit('status', { inLegion: true, role: 'hub', code: roomCode });
  return { ok: true, code: roomCode, uid: myUid, role: 'hub' };
}

/* 网格模式：成员之间直连，各自用同一份 computeAgg 算聚合。
   主进程只负责「收下别人的摘要 + 算自己这份」，不再当唯一的算账中心。 */
function startMesh({ code, alias, uid } = {}) {
  if (mode === 'host' || mode === 'hub') return { ok: true, reused: true, code: roomCode, uid: myUid, role: mode };
  if (mode === 'client') return { ok: false, message: '已在军团里，先退出' };

  roomCode = String(code || '').trim() || randomCode();
  myAlias = String(alias || '我').slice(0, 12);
  myUid = String(uid || '').trim() || 'u-' + Math.random().toString(36).slice(2, 10);
  mode = 'mesh';
  members.clear();
  members.set(myUid, { uid: myUid, alias: myAlias, bundle: null, days: {}, lastAt: 0, socket: null });
  startCleanup();
  emit('status', { inLegion: true, role: 'mesh', code: roomCode });
  return { ok: true, code: roomCode, uid: myUid, role: 'mesh' };
}

/* 异地成员上报：走与 TCP 完全相同的 sanitizeBundle + computeAgg */
function absorb({ uid, alias, bundle } = {}) {
  if (mode !== 'hub' && mode !== 'host' && mode !== 'mesh') return { ok: false, message: '未加入军团' };
  const id = String(uid || '').trim();
  if (!id) return { ok: false, message: '缺少成员标识' };
  const b = sanitizeBundle(bundle);
  if (!b) return { ok: false, message: '摘要格式不对' };

  const m = members.get(id) || { uid: id, alias: '', bundle: null, days: {}, lastAt: 0, socket: null };
  m.alias = String(alias || m.alias || '').slice(0, 12);
  m.bundle = b;
  m.lastAt = Date.now();
  m.days = m.days || {};
  m.days[b.day] = { checked: b.checked, force: b.force, neg: b.neg };
  members.set(id, m);
  tidyDays(m, Date.now());
  persistStore();
  return { ok: true, at: m.lastAt, agg: computeAgg() };
}

function aggNow() {
  if (mode === 'host' || mode === 'hub' || mode === 'mesh') return computeAgg();
  return lastAgg;
}

function handleConn(socket) {
  socket.setNoDelay(true);
  let uid = '';
  socket.setTimeout(IDLE_TIMEOUT, () => {
    try {
      socket.destroy();
    } catch (_) {}
  });

  const send = (obj) => {
    try {
      socket.write(encode(obj));
    } catch (_) {}
  };

  let buf = '';
  socket.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    if (buf.length > 400000) {
      buf = '';
      socket.destroy();
      return;
    }
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch (_) {
        continue;
      }
      handleHostMessage(socket, msg, send, (u) => {
        uid = u;
      });
    }
  });

  socket.on('error', () => {});
  socket.on('close', () => {
    if (!uid) return;
    const m = members.get(uid);
    if (m && m.socket === socket) m.socket = null; // 保留摘要，只是不在线
    pushAgg();
    emit('member-offline', { uid });
  });
}

function handleHostMessage(socket, msg, send, setUid) {
  const t = String(msg.t || '');

  if (t === 'probe') {
    if (String(msg.code) !== roomCode) {
      send({ t: 'error', message: '军团码不对' });
      socket.end();
      return;
    }
    send({ t: 'info', code: roomCode, n: members.size, ver: 1 });
    socket.end();
    return;
  }

  if (t === 'hello') {
    if (String(msg.code) !== roomCode) {
      send({ t: 'error', message: '军团码不对' });
      socket.end();
      return;
    }
    const u = String(msg.uid || '').trim().slice(0, 24) || 'u-' + Math.random().toString(36).slice(2, 10);
    const alias = String(msg.alias || '').slice(0, 12);
    let m = members.get(u);
    if (!m) {
      m = { uid: u, alias, bundle: null, days: {}, lastAt: 0, socket, credit: null };
      members.set(u, m);
    }
    m.socket = socket;
    m.alias = alias || m.alias;
    if (msg.credit != null && Number.isFinite(Number(msg.credit))) m.credit = Number(msg.credit);
    setUid(u);
    send({
      t: 'welcome',
      myUid: u,
      code: roomCode,
      intervalH: Number(msg.intervalH) || 4,
      agg: computeAgg(),
      chat: { rules: chatRules, log: chatLog.slice(-40) },
    });
    pushAgg();
    emit('member-online', { uid: u, alias });
    return;
  }

  if (t === 'push') {
    const u = String(msg.uid || '').trim();
    const m = u ? members.get(u) : null;
    if (!m) {
      send({ t: 'error', message: '还没握手，先发 hello' });
      return;
    }
    const b = sanitizeBundle(msg.bundle);
    if (!b) {
      send({ t: 'error', message: '摘要格式不对' });
      return;
    }
    m.bundle = b;
    m.lastAt = Date.now();
    m.days = m.days || {};
    m.days[b.day] = { checked: b.checked, force: b.force, neg: b.neg };
    tidyDays(m, Date.now());
    send({ t: 'ack', at: m.lastAt, day: b.day });
    send({ t: 'you', pos: positionOf(u) }); // 只发给本人，不进广播
    pushAgg();
    emit('pushed', { uid: u, alias: m.alias, day: b.day });
    return;
  }

  /* 点灯：只加一个计数，不记录是谁点的、点给谁 */
  if (t === 'rescue') {
    lightLamp();
    send({ t: 'ack', rescue: rescueTotal });
    pushAgg();
    return;
  }

  /* 频道发言：房主代成员判定并广播（成员之间可能不直连，不能自己转发） */
  if (t === 'chat') {
    const u = String(msg.uid || '').trim();
    const m = u ? members.get(u) : null;
    if (!m) {
      send({ t: 'chatDenied', reason: '还没握手，先发 hello', left: 0 });
      return;
    }
    const r = sendChat(msg.text, {
      uid: u,
      alias: m.alias,
      credit: Number(msg.credit),
      isNewbie: !!msg.newbie,
      invite: msg.invite,
      link: msg.link,
    });
    if (!r.ok) {
      send({ t: 'chatDenied', reason: r.message || '这条没发出去', left: r.left || 0 });
      emit('chatDenied', { uid: u, reason: r.message || '', left: r.left || 0 });
    }
    return;
  }

  if (t === 'bye') socket.end();
}

/* ---------------- 军团频道 ----------------
 *
 * 和自习房闲聊分开：这是军团自己的频道，规则由团长定、写进频道顶部、改完全员立即同步。
 * 判定复用 src/legion-chat.js 的纯函数，房主与成员算出的结果一致 ——
 * 房主只是「代为广播」，不是「凭印象放行」。
 */

function chatSysEntry(text) {
  return { id: 'sys-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6), sys: true, text: String(text).slice(0, 120), at: Date.now() };
}

function chatRecent(uid, now) {
  const t = now || Date.now();
  return chatLog
    .filter((m) => m && !m.sys && m.uid === uid && t - (Number(m.at) || 0) < 120e3)
    .map((m) => ({ text: m.text, at: m.at }));
}

function chatAppend(entry, broadcast = true) {
  chatLog = chatRulesLib.pushLog(chatLog, entry);
  if (broadcast) broadcastToMembers({ t: 'chat', msg: entry });
  emit('chat', { msg: entry });
  return entry;
}

/* 频道快照：成员进来时拿一份完整规则 + 最近记录 */
function chatState() {
  const now = Date.now();
  chatMutes = chatRulesLib.pruneMutes(chatMutes, now);
  return {
    rules: chatRules,
    log: chatLog.slice(-80),
    mutes: chatMutes,
    self: myUid,
    role: mode,
    left: chatRulesLib.muteLeft(chatMutes, myUid, now),
  };
}

/* 发言：房主本地发送 / 成员消息经房主中继，走同一段判定 */
function sendChat(text, who = {}) {
  if (mode !== 'host') return { ok: false, message: '这里不是房主，消息由房主中继' };
  const uid = String(who.uid || myUid || '');
  const alias = String(who.alias || (uid === myUid ? myAlias : '') || '成员').slice(0, 12);
  const now = Date.now();

  const left = chatRulesLib.muteLeft(chatMutes, uid, now);
  if (left > 0) {
    return { ok: false, left, message: `你还在禁言中，${chatRulesLib.leftText(left)}后可以发言` };
  }

  const gate = chatRulesLib.canSpeak(who.credit, chatRules, !!who.isNewbie);
  if (!gate.ok) return { ok: false, message: gate.reason };

  const body = chatRulesLib.clip(text);
  if (!body) return { ok: false, message: '空消息' };

  const verdict = chatRulesLib.scan(body, chatRecent(uid, now), chatRules, now);
  if (verdict.level === 'deny') {
    chatMutes = chatRulesLib.applyMute(chatMutes, uid, verdict.minutes || chatRules.muteMin, verdict.reason, now);
    const notice = chatSysEntry(`${alias} 的消息被拦下：${verdict.reason}，禁言 ${verdict.minutes || chatRules.muteMin} 分钟`);
    chatAppend(notice);
    persistStore();
    return {
      ok: false,
      muted: true,
      left: chatRulesLib.muteLeft(chatMutes, uid, now),
      message: `消息被拦下：${verdict.reason}，禁言 ${verdict.minutes || chatRules.muteMin} 分钟`,
    };
  }

  const entry = chatRulesLib.makeEntry(uid, alias, body, now, who.invite, who.link);
  chatAppend(entry);
  persistStore();
  return { ok: true, msg: entry, warn: verdict.level === 'warn' ? verdict.reason : '' };
}

/* 团长改规则：开关 / 严格度 / 时长 / 自定义词，一次全量下发 */
function setChatRules(patch = {}) {
  if (mode !== 'host' && mode !== 'hub' && mode !== 'mesh') {
    return { ok: false, message: '只有军团主能改频道规则' };
  }
  const prev = chatRules;
  const src = { ...prev, ...patch };
  /* 只换档位、没单独填时长时，时长跟着新档位的默认值走（除非团长手改过） */
  chatRules =
    patch.level && !('muteMin' in patch)
      ? chatRulesLib.withLevel({ ...src, level: prev.level }, patch.level)
      : chatRulesLib.normalizeRules(src);

  /* 局域网房主在这里下发；异地(网格)由渲染层经网格广播，主进程只存 */
  if (mode === 'host') broadcastToMembers({ t: 'chatRules', rules: chatRules });
  emit('chatRules', { rules: chatRules });

  if (prev.on !== chatRules.on) {
    chatAppend(chatSysEntry(chatRules.on ? '军团频道已开启' : '军团频道已关闭，暂时只读'), mode === 'host');
  } else {
    chatAppend(chatSysEntry(`频道规则已更新：${chatRulesLib.rulesText(chatRules)}`), mode === 'host');
  }
  persistStore();
  return { ok: true, rules: chatRules };
}

/* 统一发言入口：房主本地判定，成员交给房主中继 */
function chatSend(text, meta = {}) {
  if (mode === 'host') {
    return sendChat(text, {
      uid: myUid,
      alias: myAlias,
      credit: meta.credit,
      isNewbie: meta.newbie,
      invite: meta.invite,
      link: meta.link,
    });
  }
  if (mode === 'client') {
    if (!client || client.destroyed) return { ok: false, message: '还没连上房主' };
    const now = Date.now();
    const left = chatRulesLib.muteLeft(chatMutes, myUid, now);
    if (left > 0) {
      return { ok: false, left, message: `你还在禁言中，${chatRulesLib.leftText(left)}后可以发言` };
    }
    const gate = chatRulesLib.canSpeak(meta.credit, chatRules, !!meta.newbie);
    if (!gate.ok) return { ok: false, message: gate.reason };
    const body = chatRulesLib.clip(text);
    if (!body) return { ok: false, message: '空消息' };
    const verdict = chatRulesLib.scan(body, chatRecent(myUid, now), chatRules, now);
    if (verdict.level === 'deny') {
      /* 本地先拦一次，省一趟往返；房主那边还会再判一次 */
      return { ok: false, message: `消息被拦下：${verdict.reason}` };
    }
    try {
      client.write(
        encode({
          t: 'chat',
          uid: myUid,
          text: body,
          credit: Number(meta.credit) || 0,
          newbie: !!meta.newbie,
          invite: chatRulesLib.cleanInvite(meta.invite) || undefined,
          link: chatRulesLib.cleanLink(meta.link) || undefined,
        })
      );
      return { ok: true, pending: true };
    } catch (_) {
      return { ok: false, message: '发送失败' };
    }
  }
  return { ok: false, message: '未加入军团' };
}

/* 团长手动禁言 / 解禁（乱发投票、刷屏但没触发自动判定时用） */
function chatMute(uid, minutes, reason) {
  if (mode !== 'host' && mode !== 'hub' && mode !== 'mesh') return { ok: false, message: '只有军团主能操作' };
  const id = String(uid || '');
  if (!id) return { ok: false, message: '缺少成员标识' };
  if (id === myUid) return { ok: false, message: '不能禁言自己' };
  const m = members.get(id);
  const alias = (m && m.alias) || String(reason || '').slice(0, 12) || '成员';
  const min = Math.max(1, Math.min(60, Number(minutes) || chatRules.muteMin));
  const until = Date.now() + min * 60e3;
  chatMutes = chatRulesLib.applyMute(chatMutes, id, min, reason || '团长处理', Date.now());
  /* 通知本人（他本地要立刻停手），别人只知道「有人被禁言了」 */
  broadcastToMembers({ t: 'chatMute', uid: id, alias, until, reason: String(reason || '团长处理').slice(0, 30) });
  emit('chatMute', { uid: id, alias, until });
  chatAppend(chatSysEntry(`${alias} 被禁言 ${min} 分钟${reason ? '：' + String(reason).slice(0, 30) : ''}`));
  persistStore();
  return { ok: true, mutes: chatMutes };
}

function chatUnmute(uid) {
  if (mode !== 'host' && mode !== 'hub' && mode !== 'mesh') return { ok: false, message: '只有军团主能操作' };
  const id = String(uid || '');
  const before = chatRulesLib.muteLeft(chatMutes, id);
  chatMutes = chatRulesLib.clearMute(chatMutes, id);
  if (before > 0) {
    const m = members.get(id);
    broadcastToMembers({ t: 'chatUnmute', uid: id });
    emit('chatMute', { uid: id, clear: true });
    chatAppend(chatSysEntry(`${(m && m.alias) || '成员'} 的禁言已解除`));
  }
  persistStore();
  return { ok: true, mutes: chatMutes };
}

/* 团长退团公告与选举（LAN）：广播给成员后由主进程接手；异地模式由渲染层经网格广播 */
function govAnnounceLeave({ uid, alias, p2p } = {}) {
  const election = govLib.newElection({ prevUid: String(uid || myUid), prevAlias: String(alias || myAlias) });
  if (p2p) {
    /* 异地：网格由渲染层广播，这里只把选举记录在本机 */
    govElection = election;
    emit('govElection', { election, self: true });
    return { ok: true, election };
  }
  const notice = chatSysEntry(
    `📢 团长「${String(alias || myAlias).slice(0, 12)}」已退团，局域网军团随之解散。想继续一起，任何人都可以重建军团并分享 pq://legion 链接。`
  );
  chatAppend(notice);
  broadcastToMembers({ t: 'gvElection', election });
  govElection = election;
  emit('govElection', { election, self: true });
  return { ok: true, election };
}

function govElectionState() {
  return govElection;
}

function govElectionSeed(election) {
  const e = govLib.normalizeElection(election);
  /* 别用旧选举盖掉新的：比较开始时间 */
  if (govElection && govElection.status === 'open' && Number(govElection.startedAt) > Number(e.startedAt)) {
    return { ok: false, message: '已有更新的选举' };
  }
  govElection = e;
  return { ok: true, election: govElection };
}

function lightLamp() {
  rescueTotal++;
  pushLog('rescue', 1);
  persistStore();
  return { ok: true, rescue: rescueTotal };
}

/* 个人位置：只算给本人看，绝不广播、绝不排行。
 * 返回 top / upper / mid / lower / only（军团只有你一个人） */
function positionOf(uid) {
  const now = Date.now();
  const wStart = weekStart(now);
  const scored = [...members.values()].map((m) => {
    let cnt = 0;
    for (const [d, v] of Object.entries(m.days || {})) {
      const t = new Date(d + 'T00:00:00').getTime();
      if (t >= wStart && v && v.checked) cnt++;
    }
    return { uid: m.uid, cnt };
  });
  if (scored.length < 2) return 'only';
  const me = scored.find((x) => x.uid === uid);
  if (!me) return 'only';
  const better = scored.filter((x) => x.cnt > me.cnt).length;
  const ratio = better / scored.length;
  return ratio <= 0.2 ? 'top' : ratio <= 0.5 ? 'upper' : ratio < 0.8 ? 'mid' : 'lower';
}

/* 从救援池里取一盏灯（负分者领取，池子空就取不到） */
function takeLamp() {
  if (rescueTotal <= 0) return { ok: false, message: '救援池空了' };
  rescueTotal--;
  pushLog('claim', 1);
  persistStore();
  return { ok: true, rescue: rescueTotal };
}

/* 熔断开关：一键关掉自动化的集体挑战与徽章发放（不解散、不惩罚） */
function setMuted(b) {
  muted = !!b;
  pushLog(muted ? 'mute' : 'unmute', 0);
  persistStore();
  return { ok: true, muted };
}

/* 清理长期不动的成员（30 天没推过就删，避免军团无限膨胀） */
function startCleanup() {
  stopCleanup();
  cleanupTimer = setInterval(() => {
    const now = Date.now();
    let changed = false;
    for (const [uid, m] of members.entries()) {
      if (m.uid === myUid) continue; // 自己永远保留
      if (!m.lastAt || now - m.lastAt > KEEP_DAYS * 86400e3) {
        members.delete(uid);
        changed = true;
      }
    }
    if (changed) pushAgg();
  }, 6 * 3600e3);
  if (cleanupTimer.unref) cleanupTimer.unref();
}

function stopCleanup() {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}

/* 房主把自己的摘要写进成员表（不走网络） */
function pushLocal(bundle) {
  if (mode !== 'host' && mode !== 'hub' && mode !== 'mesh') return { ok: false, message: '不是房主' };
  const b = sanitizeBundle(bundle);
  if (!b) return { ok: false, message: '摘要格式不对' };
  const m = members.get(myUid) || { uid: myUid, alias: myAlias, bundle: null, days: {}, lastAt: 0 };
  m.bundle = b;
  m.lastAt = Date.now();
  m.days = m.days || {};
  m.days[b.day] = { checked: b.checked, force: b.force, neg: b.neg };
  members.set(myUid, m);
  tidyDays(m, Date.now());
  pushAgg();
  return { ok: true, at: m.lastAt };
}

/* ---------------- 成员 ---------------- */

function joinLegion({ ip, port, code, alias, uid, intervalH, credit } = {}) {
  if (mode === 'host') return Promise.resolve({ ok: false, message: '你正在当房主，先解散军团' });
  leaveLegion(true);

  const hostIp = String(ip || '').trim();
  const hostPort = Number(port) || BASE_PORT;
  if (!hostIp) return Promise.resolve({ ok: false, message: '请填写房主的局域网 IP' });

  roomCode = String(code || '').trim();
  myAlias = String(alias || '我').slice(0, 12);
  myUid = String(uid || '').trim() || 'u-' + Math.random().toString(36).slice(2, 10);
  hostAddr = { ip: hostIp, port: hostPort };

  return new Promise((resolve) => {
    let done = false;
    let s;
    try {
      s = net.createConnection({ host: hostIp, port: hostPort }, () => {
        try {
          s.write(
            encode({
              t: 'hello',
              code: roomCode,
              alias: myAlias,
              uid: myUid,
              intervalH: Number(intervalH) || 4,
              /* 团内可见「信誉等级」是既定设计：只报分值，不报明细 */
              credit: Number.isFinite(Number(credit)) ? Number(credit) : undefined,
              ver: 1,
            })
          );
        } catch (_) {}
      });
    } catch (e) {
      return resolve({ ok: false, message: '连不上房主：' + (e && e.message ? e.message : '未知错误') });
    }

    const fail = (message) => {
      if (done) return;
      done = true;
      try {
        s.destroy();
      } catch (_) {}
      resolve({ ok: false, message });
    };

    const timer = setTimeout(() => fail(`连不上 ${hostIp}:${hostPort}（同一 WiFi 才能连；确认房主已开军团）`), HELLO_TIMEOUT);

    let buf = '';
    s.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch (_) {
          continue;
        }
        if (msg.t === 'error' && !done) return fail(msg.message || '加入失败');
        if (msg.t === 'welcome' && !done) {
          done = true;
          clearTimeout(timer);
          client = s;
          mode = 'client';
          myUid = String(msg.myUid || myUid);
          lastAgg = msg.agg || null;
          resolve({
            ok: true,
            code: msg.code || roomCode,
            uid: myUid,
            ip: hostIp,
            port: hostPort,
            agg: lastAgg,
            chat: msg.chat || null,
          });
          emit('status', { inLegion: true, role: 'member', code: roomCode, ip: hostIp, port: hostPort });
          if (lastAgg) emit('agg', { agg: lastAgg });
          if (msg.chat) {
            if (msg.chat.rules) {
              chatRules = chatRulesLib.normalizeRules(msg.chat.rules);
              emit('chatRules', { rules: chatRules });
            }
            if (Array.isArray(msg.chat.log)) {
              chatLog = msg.chat.log.slice(-80);
              emit('chatHistory', { log: chatLog });
            }
          }
          return;
        }
        if (msg.t === 'agg') {
          lastAgg = msg.agg || null;
          emit('agg', { agg: lastAgg });
        } else if (msg.t === 'ack') {
          emit('ack', { at: msg.at, day: msg.day });
        } else if (msg.t === 'chat') {
          chatLog = chatRulesLib.pushLog(chatLog, msg.msg);
          emit('chat', { msg: msg.msg });
        } else if (msg.t === 'chatRules') {
          chatRules = chatRulesLib.normalizeRules(msg.rules);
          emit('chatRules', { rules: chatRules });
        } else if (msg.t === 'chatDenied') {
          const left = Number(msg.left) || 0;
          if (left > 0) {
            chatMutes = chatRulesLib.applyMute(chatMutes, myUid, Math.ceil(left / 60e3), msg.reason, Date.now());
          }
          emit('chatDenied', { reason: msg.reason || '', left });
        } else if (msg.t === 'chatMute') {
          const until = Number(msg.until) || 0;
          if (msg.uid) {
            chatMutes = {
              ...chatMutes,
              [msg.uid]: { until, count: 1, reason: String(msg.reason || '').slice(0, 40), at: Date.now() },
            };
          }
          emit('chatMute', { uid: msg.uid, alias: msg.alias, until, reason: msg.reason || '' });
        } else if (msg.t === 'chatUnmute') {
          chatMutes = chatRulesLib.clearMute(chatMutes, msg.uid);
          emit('chatMute', { uid: msg.uid, clear: true });
        } else if (msg.t === 'gvElection') {
          /* 团长退团：成员本地也种下同一场选举，等结算时全员算出同一个新团长 */
          govElection = govLib.normalizeElection(msg.election);
          emit('govElection', { election: govElection });
        }
      }
    });

    s.on('error', (e) => fail('连不上房主：' + (e && e.code === 'ECONNREFUSED' ? '端口没开' : e && e.message ? e.message : '网络错误')));
    s.on('close', () => {
      if (!done) return fail('房主断开了连接');
      if (mode === 'client') {
        mode = 'none';
        client = null;
        emit('offline', {});
      }
    });
  });
}

function pushRemote(bundle) {
  if (mode !== 'client' || !client || client.destroyed) return { ok: false, message: '未连接' };
  const b = sanitizeBundle(bundle);
  if (!b) return { ok: false, message: '摘要格式不对' };
  try {
    client.write(encode({ t: 'push', uid: myUid, bundle: b }));
    return { ok: true };
  } catch (e) {
    return { ok: false, message: '发送失败' };
  }
}

/* 统一入口：房主/网格本地记录，成员走网络 */
function pushBundle(bundle) {
  if (mode === 'host' || mode === 'hub' || mode === 'mesh') return pushLocal(bundle);
  if (mode === 'client') return pushRemote(bundle);
  return { ok: false, message: '未加入军团' };
}

function leaveLegion(silent) {
  if (mode === 'client' && client) {
    try {
      client.write(encode({ t: 'bye' }));
    } catch (_) {}
    try {
      client.destroy();
    } catch (_) {}
  }
  if (mode === 'host' || mode === 'hub' || mode === 'mesh') {
    if (mode !== 'mesh') persistStore();
    for (const m of members.values()) {
      if (m.socket && !m.socket.destroyed) {
        try {
          m.socket.destroy();
        } catch (_) {}
      }
    }
    try {
      server && server.close();
    } catch (_) {}
    server = null;
    stopCleanup();
  }
  client = null;
  /* 成员的频道记录跟着连接走；房主的记录留在本地，重开军团还在 */
  const wasClient = mode === 'client';
  mode = 'none';
  roomCode = '';
  lastAgg = null;
  members.clear();
  govElection = null;
  if (wasClient) {
    chatLog = [];
    chatMutes = {};
  }
  if (!silent) emit('status', { inLegion: false });
  return { ok: true };
}

function randomCode() {
  const alphabet = '23456789';
  let out = '';
  for (let i = 0; i < 4; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

function status() {
  return {
    inLegion: mode !== 'none',
    role: mode,
    code: roomCode,
    ip: mode === 'host' ? lanIP() : hostAddr.ip,
    port: mode === 'host' ? (server && server.address() ? server.address().port : BASE_PORT) : hostAddr.port,
    uid: myUid,
    n: members.size,
    agg: lastAgg,
  };
}

/* 房主的聚合快照（渲染层刷新时用） */
function snapshot() {
  const isHubHost = mode === 'host' || mode === 'hub' || mode === 'mesh';
  /* 团内目录：只给 uid / 昵称 / 在线标记，不给任何明细数据。
     信誉分等级由渲染端用网格名册合并（那里才带 credit），这里不重复存。 */
  const list = [];
  for (const m of members.values()) {
    list.push({
      uid: String(m.uid || ''),
      alias: String(m.alias || '成员').slice(0, 12),
      self: m.uid === myUid,
      online: m.uid === myUid ? true : Date.now() - (Number(m.lastAt) || 0) < 90e3,
      /* 等级够用即可：只带分值，明细不出现 */
      credit: m.credit == null || !Number.isFinite(Number(m.credit)) ? null : Number(m.credit),
      lastAt: Number(m.lastAt) || 0,
    });
  }
  list.sort((a, b) => (b.self ? 1 : 0) - (a.self ? 1 : 0) || a.uid.localeCompare(b.uid));
  return { ...status(), agg: isHubHost ? computeAgg() : lastAgg, members: list, chat: chatState() };
}

module.exports = {
  createLegion,
  startHub,
  startMesh,
  absorb,
  aggNow,
  lightLamp,
  takeLamp,
  positionOf,
  setMuted,
  joinLegion,
  leaveLegion,
  pushBundle,
  status,
  snapshot,
  chatState,
  chatSend,
  setChatRules,
  chatMute,
  chatUnmute,
  govAnnounceLeave,
  govElectionState,
  govElectionSeed,
  setEmitter,
  setStorePath,
  randomCode,
  sanitizeBundle,
};
