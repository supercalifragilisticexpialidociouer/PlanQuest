'use strict';

/*
 * 局域网自习房
 * - 房主开 TCP 服务器（默认端口 48765，被占用自动 +1）
 * - 成员通过 房主IP + 4位房间码 加入
 * - JSON 行协议：join / welcome / snapshot / state / reaction / bye / error
 * - 通过 onEvent 回调抛给主进程，再转发到渲染层
 */

const net = require('node:net');
const os = require('node:os');
/* 附件（计划 / 房间 / 军团链接）跟军团频道共用同一份清洗规则，
   房间只管转发，不认识的一律丢掉 */
const chatLib = require('./legion-chat');

const BASE_PORT = 48765;
const HEARTBEAT_MS = 5000;
const MEMBER_TIMEOUT_MS = 20000;

let mode = 'none'; // none | host | client
let server = null;
let client = null;
let roomCode = '';
let myInfo = { name: '我', avatar: '🙂' };
let members = new Map(); // id -> { id, name, avatar, state, lastSeen, socket }
let onEvent = () => {};
let stateTimer = null;
let heartbeatTimer = null;

/* 房间类型与娱乐房时长 */
let roomType = 'study'; // study | fun
let funEndsAt = 0; // 娱乐房到期时间戳（0 = 非娱乐房）
let funEndTimer = null;
let clientId = ''; // 我在房间里的成员 id（成员模式）

/* 聊天与禁言 */
const CHAT_MAX = 200; // 聊天记录上限
let chatLog = []; // { id, from, avatar, text, at, sys? }
let mutes = new Map(); // memberId -> { until, reason }
let lastMsg = new Map(); // memberId -> { text, count }
let rateMap = new Map(); // memberId -> [时间戳]

/* 违规词库：命中即禁言（广告 / 招嫖博彩 / 代写代考 / 私下交易） */
const BAD_WORDS = [
  '加微信', '加qq', '加我微信', '代考', '代写', '刷单', '兼职日结', '返利',
  '扫码', '二维码', '博彩', '赌博', '色情', '约炮', '贷款', '私聊交易',
  '点击链接', 'http://', 'https://', 'www.',
];

/* LiveKit 语音门票签发（main.js 注入 src/livekit.js 的 grant） */
let livekitIssuer = null;
let livekitInfo = null; // 成员模式：房主下发的 { url, token, room, exp }

function setLivekitIssuer(fn) {
  livekitIssuer = typeof fn === 'function' ? fn : null;
}

function setEmitter(fn) {
  onEvent = fn || (() => {});
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

/* ---------------- 房主 ---------------- */

function createRoom({ name, avatar, cred, type, minutes }) {
  leaveRoom(true);
  myInfo = { name: name || '房主', avatar: avatar || '🙂', cred: cred || null };
  roomCode = String(1000 + Math.floor(Math.random() * 9000));
  roomType = type === 'fun' ? 'fun' : 'study';
  const mins = Math.max(1, Math.min(120, Number(minutes) || 0));
  funEndsAt = roomType === 'fun' && mins ? Date.now() + mins * 60000 : 0;
  chatLog = [];
  mutes = new Map();
  lastMsg = new Map();
  rateMap = new Map();

  return new Promise((resolve) => {
    let port = BASE_PORT;
    let attempts = 0;
    const tryListen = () => {
      server = net.createServer((socket) => {
        let buf = '';
        socket.on('data', (chunk) => {
          buf += chunk.toString('utf8');
          let idx;
          while ((idx = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (line) handleHostMessage(socket, line);
          }
        });
        socket.on('error', () => {});
        socket.on('close', () => removeMemberBySocket(socket));
      });

      server.on('error', () => {
        server = null;
        if (++attempts < 10) {
          port++;
          tryListen();
        } else {
          mode = 'none';
          resolve({ ok: false, message: '端口被占用，创建失败' });
        }
      });

      server.listen(port, () => {
        mode = 'host';
        members = new Map();
        members.set('host', {
          id: 'host',
          name: myInfo.name,
          avatar: myInfo.avatar,
          cred: myInfo.cred,
          state: {},
          lastSeen: Date.now(),
          socket: null,
        });
        startHeartbeat();
        if (roomType === 'fun' && funEndsAt) startFunTimer();
        broadcastSnapshot(); // 建房即把成员列表推给房主本机
        // 房主自己的语音门票
        const selfGrant = livekitIssuer ? livekitIssuer({ identity: 'host', name: myInfo.name, room: roomCode }) : null;
        if (selfGrant) {
          livekitInfo = selfGrant;
          emit('livekit', selfGrant);
        }
        resolve({
          ok: true,
          code: roomCode,
          port,
          ip: lanIP(),
          type: roomType,
          minutes: funEndsAt ? Math.round((funEndsAt - Date.now()) / 60000) : 0,
          funEndsAt,
        });
      });
    };
    tryListen();
  });
}

function handleHostMessage(socket, line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch (_) {
    return;
  }

  if (msg.type === 'probe') {
    // 加入前探测：只告知房间类型与时长，不加入
    if (String(msg.code) !== roomCode) {
      socket.write(encode({ type: 'error', message: '房间码不对' }));
      socket.end();
      return;
    }
    socket.write(
      encode({ type: 'info', code: roomCode, roomType, funEndsAt, members: members.size })
    );
    socket.end();
    return;
  }

  if (msg.type === 'join') {
    if (String(msg.code) !== roomCode) {
      socket.write(encode({ type: 'error', message: '房间码不对' }));
      socket.end();
      return;
    }
    const id = 'm-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const memberName = String(msg.name || '同学').slice(0, 12);
    socket.memberId = id;
    members.set(id, {
      id,
      name: memberName,
      avatar: String(msg.avatar || '🙂').slice(0, 4),
      cred: msg.cred || null,
      state: {},
      lastSeen: Date.now(),
      socket,
    });
    socket.write(
      encode({
        type: 'welcome',
        yourId: id,
        code: roomCode,
        roomType,
        funEndsAt,
        chat: chatLog.slice(-40),
        mutes: [...mutes.entries()].map(([mid, m]) => ({ id: mid, until: m.until, reason: m.reason })),
        // 语音门票：密钥只在房主本机，成员拿到的是限房间限时的 token
        livekit: livekitIssuer ? livekitIssuer({ identity: id, name: memberName, room: roomCode }) : undefined,
      })
    );
    broadcastSnapshot();
    emit('reaction', { emoji: '👋', from: members.get(id).name, text: ' 加入了房间' });
    return;
  }

  const member = members.get(socket.memberId);
  if (!member) return;
  member.lastSeen = Date.now();

  if (msg.type === 'state') {
    member.state = msg.state || {};
    broadcastSnapshot();
  } else if (msg.type === 'camFrame') {
    // 摄像头帧中继：成员的帧打上 from 标记转给全房间（超大帧直接丢弃）
    const d = String(msg.d || '');
    if (d && d.length <= 120000) broadcast({ type: 'camFrame', from: member.id, d });
  } else if (msg.type === 'shareFrame') {
    // 屏幕共享帧中继：分辨率比摄像头大，上限放宽到 400KB
    const d = String(msg.d || '');
    if (d && d.length <= 2000000) broadcast({ type: 'shareFrame', from: member.id, d });
  } else if (msg.type === 'chat') {
    handleChat(member, msg.text, msg.link);
  } else if (msg.type === 'reaction') {
    const e = { type: 'reaction', emoji: String(msg.emoji || '👍').slice(0, 4), from: member.name };
    broadcast(e);
    emit('reaction', e);
  } else if (msg.type === 'rtc') {
    // 局域网点对点语音的信令：房主只做转发（SDP / ICE），不参与音频解码
    const to = String(msg.to || '');
    const data = msg.data;
    if (!to || !data) return;
    if (to === 'host') {
      emit('rtc', { from: member.id, data });
    } else {
      const target = members.get(to);
      if (target && target.socket) target.socket.write(encode({ type: 'rtc', from: member.id, data }));
    }
  } else if (msg.type === 'bye') {
    socket.end();
  }
}

/* 局域网语音信令发送：房主直接投递给目标成员，成员交给房主中转 */
function rtcSend(to, data) {
  const target = String(to || '');
  if (!target || !data) return false;
  if (mode === 'host') {
    if (target === 'host') return false;
    const t = members.get(target);
    if (t && t.socket) {
      t.socket.write(encode({ type: 'rtc', from: 'host', data }));
      return true;
    }
    return false;
  }
  if (mode === 'client' && client && !client.destroyed) {
    client.write(encode({ type: 'rtc', to: target, data }));
    return true;
  }
  return false;
}

/* ---------------- 聊天与发言检测（房主端执行，权威判定） ---------------- */

function muteState(id) {
  const m = mutes.get(id);
  if (!m) return null;
  if (Date.now() >= m.until) {
    mutes.delete(id);
    return null;
  }
  return m;
}

/* 规则判定：返回 { ban:秒, reason } 或 null；同时记录频率与重复 */
function inspect(member, text) {
  const lower = text.toLowerCase();
  for (const w of BAD_WORDS) {
    if (lower.includes(w.toLowerCase())) return { ban: 300, reason: `含违规内容「${w}」` };
  }
  if (text.length > 200) return { ban: 60, reason: '消息过长（超过 200 字）' };

  const now = Date.now();
  const arr = (rateMap.get(member.id) || []).filter((t) => now - t < 10000);
  arr.push(now);
  rateMap.set(member.id, arr);
  if (arr.length > 5) return { ban: 60, reason: `10 秒内发了 ${arr.length} 条，疑似刷屏` };

  /* 重复内容：只看 60 秒内的连续重复（以前没有时间窗，隔几小时说同一句也会被算成刷屏） */
  const prev = lastMsg.get(member.id);
  if (prev && prev.text === text && now - (prev.at || 0) < 60000) {
    prev.count += 1;
    prev.at = now;
    if (prev.count >= 4) return { ban: 60, reason: '连续重复发送相同内容' };
  } else {
    lastMsg.set(member.id, { text, count: 1, at: now });
  }
  return null;
}

function addChat(entry) {
  chatLog.push(entry);
  if (chatLog.length > CHAT_MAX) chatLog = chatLog.slice(-CHAT_MAX);
}

function handleChat(member, rawText, attach) {
  const text = String(rawText == null ? '' : rawText).replace(/[\r\n]+/g, ' ').trim().slice(0, 200);
  const link = chatLib && chatLib.cleanLink ? chatLib.cleanLink(attach) : null;
  if (!text && !link) return;

  /* AI 播报（🤖 开头，如「AI 盯学：检测到我在摸鱼」）走旁路：
     不判违规词、不算刷屏、不算重复，永远不会把自己刷成禁言。
     这类消息按系统提示展示（chat-line sys），也不进闲聊雷达。 */
  if (text.startsWith('🤖')) {
    const aiEntry = { id: 'sys-' + Date.now().toString(36), sys: true, ai: true, text, at: Date.now() };
    addChat(aiEntry);
    broadcast({ type: 'chat', msg: aiEntry });
    emit('chat', { msg: aiEntry });
    return;
  }

  const muted = muteState(member.id);
  if (muted) {
    const left = Math.ceil((muted.until - Date.now()) / 1000);
    const deny = { type: 'chatDenied', reason: muted.reason, left };
    if (member.socket && !member.socket.destroyed) {
      try {
        member.socket.write(encode(deny));
      } catch (_) {}
    }
    emit('chatDenied', { id: member.id, name: member.name, reason: muted.reason, left });
    return;
  }

  const verdict = inspect(member, text);
  if (verdict) {
    // 房主自己不适用禁言，只拦截这条消息
    if (member.id === 'host') {
      emit('chatDenied', { reason: `内容已被拦截：${verdict.reason}`, left: 0 });
      return;
    }
    mutes.set(member.id, { until: Date.now() + verdict.ban * 1000, reason: verdict.reason });
    const sys = { type: 'mute', id: member.id, name: member.name, seconds: verdict.ban, reason: verdict.reason };
    broadcast(sys);
    emit('mute', sys);
    addChat({ id: 'sys', sys: true, text: `🔇 ${member.name} 因「${verdict.reason}」被禁言 ${verdict.ban / 60} 分钟`, at: Date.now() });
    broadcast({ type: 'chat', msg: chatLog[chatLog.length - 1] });
    broadcastSnapshot();
    return;
  }

  const entry = {
    id: 'c-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    from: member.name,
    avatar: member.avatar,
    memberId: member.id,
    text,
    at: Date.now(),
  };
  /* 附件只认白名单里的字段，超长计划包在 main 那边就被截到 60KB */
  if (link) entry.link = link;
  addChat(entry);
  broadcast({ type: 'chat', msg: entry });
  emit('chat', { msg: entry });
}

/* 房主手动禁言 / 解禁 */
function muteMember(id, minutes, reason) {
  if (mode !== 'host') return { ok: false, message: '只有房主可以禁言' };
  const m = members.get(id);
  if (!m) return { ok: false, message: '成员不在房间' };
  if (id === 'host') return { ok: false, message: '不能禁言自己' };
  const secs = Math.max(1, Math.min(120, Number(minutes) || 5)) * 60;
  mutes.set(id, { until: Date.now() + secs * 1000, reason: reason || '房主手动禁言' });
  const sys = { type: 'mute', id, name: m.name, seconds: secs, reason: reason || '房主手动禁言' };
  broadcast(sys);
  emit('mute', sys);
  addChat({ id: 'sys', sys: true, text: `🔇 ${m.name} 被房主禁言 ${secs / 60} 分钟`, at: Date.now() });
  broadcast({ type: 'chat', msg: chatLog[chatLog.length - 1] });
  broadcastSnapshot();
  return { ok: true };
}

function unmuteMember(id) {
  if (mode !== 'host') return { ok: false, message: '只有房主可以解禁' };
  mutes.delete(id);
  const m = members.get(id);
  broadcast({ type: 'unmute', id });
  addChat({ id: 'sys', sys: true, text: `🔊 ${m ? m.name : '成员'} 已解除禁言`, at: Date.now() });
  broadcast({ type: 'chat', msg: chatLog[chatLog.length - 1] });
  broadcastSnapshot();
  return { ok: true };
}

/* 娱乐房倒计时：到点自动结束 */
function startFunTimer() {
  stopFunTimer();
  funEndTimer = setInterval(() => {
    if (!funEndsAt) return;
    const left = funEndsAt - Date.now();
    if (left <= 0) {
      broadcast({ type: 'funEnded', reason: '兑换时长已用完' });
      emit('funEnded', { reason: '兑换时长已用完' });
      stopFunTimer();
      leaveRoom(false);
    }
  }, 5000);
}

function stopFunTimer() {
  if (funEndTimer) {
    clearInterval(funEndTimer);
    funEndTimer = null;
  }
}

function removeMemberBySocket(socket) {
  if (mode !== 'host' || !socket.memberId) return;
  const m = members.get(socket.memberId);
  if (m) {
    members.delete(socket.memberId);
    broadcastSnapshot();
    emit('reaction', { emoji: '🚪', from: m.name, text: ' 离开了自习房' });
  }
}

function broadcast(obj) {
  if (mode !== 'host') return;
  const line = encode(obj);
  for (const m of members.values()) {
    if (m.socket && !m.socket.destroyed) {
      try {
        m.socket.write(line);
      } catch (_) {}
    }
  }
}

function snapshotPayload() {
  return {
    type: 'snapshot',
    roomType,
    funEndsAt,
    mutes: [...mutes.entries()].map(([id, m]) => ({ id, until: m.until, reason: m.reason })),
    members: [...members.values()].map((m) => ({
      id: m.id,
      name: m.name,
      avatar: m.avatar,
      cred: m.cred || null,
      state: m.state || {},
      ...(m.ai ? { ai: true } : {}),
    })),
  };
}

function broadcastSnapshot() {
  const pay = snapshotPayload();
  broadcast(pay);
  // 房主自己的 socket 是 null，broadcast 送不到本机：单独补一份给房主渲染层，
  // 否则房主拿不到成员列表（语音建连、成员列表都会缺人）
  if (mode === 'host') emit('snapshot', pay);
}

function startHeartbeat() {
  stopTimers();
  heartbeatTimer = setInterval(() => {
    if (mode !== 'host') return;
    const now = Date.now();
    let changed = false;
    for (const [id, m] of members) {
      if (id !== 'host' && id !== 'aci' && now - m.lastSeen > MEMBER_TIMEOUT_MS) {
        members.delete(id);
        changed = true;
        if (m.socket && !m.socket.destroyed) {
          try {
            m.socket.destroy();
          } catch (_) {}
        }
      }
    }
    broadcastSnapshot(); // 顺带当心跳
    if (changed) emit('reaction', { emoji: '💤', from: '', text: '有成员掉线被移出' });
  }, HEARTBEAT_MS);
}

/* ---------------- 成员 ---------------- */

function joinRoom({ ip, port, code, name, avatar, cred }) {
  leaveRoom(true);
  myInfo = { name: name || '我', avatar: avatar || '🙂', cred: cred || null };
  roomCode = String(code || '');

  return new Promise((resolve) => {
    let settled = false;
    client = new net.Socket();
    client.setTimeout(4000);

    const fail = (message) => {
      if (settled) return;
      settled = true;
      try {
        client.destroy();
      } catch (_) {}
      client = null;
      mode = 'none';
      resolve({ ok: false, message });
    };

    client.on('error', () => fail('连不上，请检查 IP 和网络'));
    client.on('timeout', () => fail('连接超时'));

    client.connect(Number(port) || BASE_PORT, ip, () => {
      client.write(encode({ type: 'join', code: String(code || ''), name, avatar, cred: myInfo.cred }));
    });

    let buf = '';
    client.on('data', (chunk) => {
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
        if (msg.type === 'error') return fail(msg.message || '加入失败');
        if (msg.type === 'welcome') {
          if (!settled) {
            settled = true;
            mode = 'client';
            clientId = msg.yourId;
            roomType = msg.roomType === 'fun' ? 'fun' : 'study';
            funEndsAt = Number(msg.funEndsAt) || 0;
            chatLog = Array.isArray(msg.chat) ? msg.chat.slice(-CHAT_MAX) : [];
            mutes = new Map((msg.mutes || []).map((m) => [m.id, { until: m.until, reason: m.reason }]));
            livekitInfo = msg.livekit && msg.livekit.url && msg.livekit.token ? msg.livekit : null;
            if (livekitInfo) emit('livekit', livekitInfo);
            resolve({
              ok: true,
              yourId: msg.yourId,
              code: roomCode,
              type: roomType,
              funEndsAt,
              chat: chatLog,
            });
          }
          continue;
        }
        if (msg.type === 'snapshot') {
          emit('snapshot', {
            members: msg.members || [],
            roomType: msg.roomType || 'study',
            funEndsAt: Number(msg.funEndsAt) || 0,
            mutes: msg.mutes || [],
            yourId: clientId,
          });
        } else if (msg.type === 'chat') {
          addChat(msg.msg);
          emit('chat', { msg: msg.msg });
        } else if (msg.type === 'mute') {
          mutes.set(msg.id, { until: Date.now() + Number(msg.seconds || 60) * 1000, reason: msg.reason });
          emit('mute', msg);
        } else if (msg.type === 'unmute') {
          mutes.delete(msg.id);
          emit('unmute', msg);
        } else if (msg.type === 'chatDenied') {
          emit('chatDenied', { reason: msg.reason, left: msg.left });
        } else if (msg.type === 'funEnded') {
          emit('funEnded', { reason: msg.reason || '时长已用完' });
        } else if (msg.type === 'reaction') {
          emit('reaction', msg);
        } else if (msg.type === 'camFrame') {
          // 房主中继来的摄像头帧（发送者会收到自己的帧，由渲染层按 from 过滤）
          emit('camFrame', { from: msg.from, d: msg.d });
        } else if (msg.type === 'shareFrame') {
          emit('shareFrame', { from: msg.from, d: msg.d });
        } else if (msg.type === 'rtc') {
          emit('rtc', { from: msg.from, data: msg.data });
        }
      }
    });

    client.on('close', () => {
      if (mode === 'client') {
        mode = 'none';
        emit('closed', {});
      }
    });
  });
}

/* ---------------- 加入前探测（付费确认用） ---------------- */

function probeRoom({ ip, port, code }) {
  return new Promise((resolve) => {
    let settled = false;
    const sock = new net.Socket();
    sock.setTimeout(3500);
    const done = (r) => {
      if (settled) return;
      settled = true;
      try {
        sock.destroy();
      } catch (_) {}
      resolve(r);
    };
    sock.on('error', () => done({ ok: false, message: '连不上，请检查 IP 和网络' }));
    sock.on('timeout', () => done({ ok: false, message: '对方未响应' }));
    sock.connect(Number(port) || BASE_PORT, ip, () => {
      sock.write(encode({ type: 'probe', code: String(code || '') }));
    });
    let buf = '';
    sock.on('data', (chunk) => {
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
        if (msg.type === 'error') return done({ ok: false, message: msg.message || '探测失败' });
        if (msg.type === 'info') {
          return done({
            ok: true,
            roomType: msg.roomType === 'fun' ? 'fun' : 'study',
            funEndsAt: Number(msg.funEndsAt) || 0,
            members: Number(msg.members) || 1,
          });
        }
      }
    });
  });
}

/* ---------------- 通用 ---------------- */

function sendState(state) {
  const payload = encode({ type: 'state', state });
  if (mode === 'host') {
    const me = members.get('host');
    if (me) {
      me.state = state;
      me.lastSeen = Date.now();
      broadcastSnapshot();
    }
  } else if (mode === 'client' && client && !client.destroyed) {
    try {
      client.write(payload);
    } catch (_) {}
  }
}

function sendReaction(emoji) {
  if (mode === 'host') {
    const e = { type: 'reaction', emoji: String(emoji || '👍').slice(0, 4), from: myInfo.name };
    broadcast(e);
    emit('reaction', e);
  } else if (mode === 'client' && client && !client.destroyed) {
    try {
      client.write(encode({ type: 'reaction', emoji }));
    } catch (_) {}
  }
}

/* 房主也发摄像头帧：房主直接广播（from='host'），成员发帧交给房主中继 */
function sendCamFrame(d) {
  const data = String(d || '');
  if (!data || data.length > 120000) return;
  if (mode === 'host') {
    broadcast({ type: 'camFrame', from: 'host', d: data });
  } else if (mode === 'client' && client && !client.destroyed) {
    try {
      client.write(encode({ type: 'camFrame', d: data }));
    } catch (_) {}
  }
}

/* 房主也发屏幕帧：房主直接广播（from='host'），成员发帧交给房主中继 */
function sendShareFrame(d) {
  const data = String(d || '');
  if (!data || data.length > 2000000) return;
  if (mode === 'host') {
    broadcast({ type: 'shareFrame', from: 'host', d: data });
  } else if (mode === 'client' && client && !client.destroyed) {
    try {
      client.write(encode({ type: 'shareFrame', d: data }));
    } catch (_) {}
  }
}

/* 发消息：房主本地判定，成员发给房主判定
   附件（计划包 / pq:// 链接）跟正文一起走，房间只认白名单字段 */
function sendChat(text, myId, attach) {
  const clean = String(text == null ? '' : text).replace(/[\r\n]+/g, ' ').trim().slice(0, 200);
  const link = chatLib && chatLib.cleanLink ? chatLib.cleanLink(attach) : null;
  if (!clean && !link) return { ok: false, message: '空消息' };
  const body = clean || '📎 附件';
  if (mode === 'host') {
    const me = members.get('host');
    if (me) handleChat(me, body, link);
    return { ok: true };
  }
  if (mode === 'client' && client && !client.destroyed) {
    try {
      client.write(encode({ type: 'chat', text: body, link: link || undefined }));
      return { ok: true };
    } catch (e) {
      return { ok: false, message: e.message };
    }
  }
  return { ok: false, message: '不在房间中' };
}

function leaveRoom(silent = false) {
  stopTimers();
  stopFunTimer();
  if (mode === 'client' && client && !client.destroyed) {
    try {
      client.write(encode({ type: 'bye' }));
      client.destroy();
    } catch (_) {}
  }
  if (server) {
    try {
      server.close();
    } catch (_) {}
    for (const m of members.values()) {
      if (m.socket && !m.socket.destroyed) {
        try {
          m.socket.destroy();
        } catch (_) {}
      }
    }
  }
  const wasIn = mode !== 'none';
  server = null;
  client = null;
  members = new Map();
  mode = 'none';
  roomCode = '';
  roomType = 'study';
  funEndsAt = 0;
  clientId = '';
  livekitInfo = null;
  chatLog = [];
  mutes = new Map();
  lastMsg = new Map();
  rateMap = new Map();
  if (wasIn && !silent) emit('closed', { left: true });
}

function stopTimers() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  if (stateTimer) {
    clearInterval(stateTimer);
    stateTimer = null;
  }
}

/* 把「阿刺」作为虚拟战友拉进/移出房间（自习房 & 娱乐房共用，同一成员体系）。
 * 虚拟成员 socket=null，只发言不收包；发言走 handleChat 的 🤖 旁路。
 * 只有房主本机有权拉入（房主是房间的权威）。 */
function setCompanion(joined, info) {
  if (mode !== 'host') return { ok: false, message: '只有房主能把阿刺拉进房间' };
  const i = info || {};
  if (joined) {
    if (members.has('aci')) {
      broadcastSnapshot();
      return { ok: true, message: '阿刺已经在房间里了' };
    }
    members.set('aci', {
      id: 'aci',
      name: i.name || '阿刺',
      avatar: i.avatar || '🌵',
      cred: null,
      state: {},
      lastSeen: Date.now(),
      socket: null,
      ai: true,
    });
    /* 进场时自动说一句（走 🤖 旁路，不判违规词、不算刷屏） */
    const me = members.get('host');
    const hello = roomType === 'fun'
      ? '🤖 阿刺蹦进娱乐房：放松归放松，计划别忘了打卡。'
      : '🤖 阿刺搬着小板凳进来自习了。你学你的，我盯着呢。';
    if (me) handleChat(me, hello, null);
    broadcastSnapshot();
    return { ok: true, message: '阿刺进房了（🤖 战友）' };
  }
  if (!members.has('aci')) return { ok: true, message: '阿刺不在房间里' };
  members.delete('aci');
  broadcastSnapshot();
  return { ok: true, message: '阿刺离开房间了' };
}

function companionJoined() {
  return members.has('aci');
}

function roomStatus() {
  return {
    inRoom: mode !== 'none',
    isHost: mode === 'host',
    code: roomCode,
    ip: mode === 'host' ? lanIP() : null,
    port: mode === 'host' ? (server ? server.address().port : BASE_PORT) : null,
    type: roomType,
    funEndsAt,
    myId: mode === 'host' ? 'host' : clientId,
    muted: mode === 'host' ? null : muteState(clientId),
    livekit: livekitInfo,
  };
}

module.exports = {
  createRoom,
  joinRoom,
  probeRoom,
  leaveRoom,
  sendState,
  sendReaction,
  sendCamFrame,
  sendShareFrame,
  sendChat,
  rtcSend,
  muteMember,
  unmuteMember,
  setEmitter,
  setLivekitIssuer,
  roomStatus,
  setCompanion,
  companionJoined,
};
