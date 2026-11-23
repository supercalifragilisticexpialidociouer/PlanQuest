/* PlanQuest · 军团 PK（跨军团出操率对垒）
 *
 * 布告栏已经换成「私有 GitHub 仓库」，布局见 pk-store.js：
 *   legions/<军团码>.json   每个军团一个文件 —— 各写各的，50 个军团同时上报也不会互相覆盖
 *   results/<周一>/*.json   Actions 校验 + 配对 + 结算写出来的结果，客户端只读
 *   keys/<军团码>.json      首次见到的公钥（TOFU 固定，用来发现「换钥匙」）
 *   snapshots/<小时>/*      每小时快照，被改坏了可回滚
 *
 * 四道防线（按成本从低到高）：
 *   1. 单文件写入 + sha 乐观锁 —— 防「最后写的人覆盖前面 49 个」；
 *   2. Ed25519 签名 + 公钥固定 —— 防「别人替我改」；
 *   3. 主仓 / 备仓双写双读对比 —— 防「单边篡改没被发现」；
 *   4. 每小时快照 —— 真被改坏了，回滚有据可依。
 *
 * 铁规矩（和军团同步同款）：
 *   1. 只有军团主（host / hub）会往网上写东西；成员只读，连自己的码都不上传；
 *   2. 上传的只有聚合数字：军团码、人数、每日出操率百分比 —— 没有名字、没有计划、没有积分；
 *   3. 对手永远只是一个代号，看不到对面军团里是谁；
 *   4. 没加入军团 / 没配置仓库 → 一个网络请求都不发。
 */
'use strict';

const crypto = require('node:crypto');
const store = require('./pk-store');
const signer = require('./pk-sign');
const V = require('./pk-validate');

const HOUR = 3600e3;
const DAY = 86400e3;
const SNAP_MS = HOUR;

/* ---------------- 时间工具（周一为一周起点） ---------------- */

function ymd(d) {
  const t = d instanceof Date ? d : new Date(d);
  const m = String(t.getMonth() + 1).padStart(2, '0');
  const dd = String(t.getDate()).padStart(2, '0');
  return `${t.getFullYear()}-${m}-${dd}`;
}

function dateKeyOf(k) {
  return new Date(k + 'T00:00:00');
}

function weekKeyOf(now) {
  const t = new Date(now);
  const dow = (t.getDay() + 6) % 7;
  t.setHours(12, 0, 0, 0);
  return ymd(new Date(t.getTime() - dow * DAY));
}

function nextMonday(now) {
  const t = new Date(now);
  const dow = (t.getDay() + 6) % 7;
  t.setHours(12, 0, 0, 0);
  return new Date(t.getTime() + (7 - dow) * DAY);
}

function seasonKeyOf(now) {
  const t = new Date(now);
  return `${t.getFullYear()}Q${Math.floor(t.getMonth() / 3) + 1}`;
}

/* ---------------- 纯逻辑（可测试） ---------------- */

function pctOf(cnt, n) {
  if (!n) return null;
  return Math.round(((Number(cnt) || 0) / n) * 100);
}

/* 候选：同赛季、同周、三天内活跃、未冻结；保留自己（相邻配对要知道位置） */
function candidatesOf(list, mine) {
  const now = Date.now();
  return (Array.isArray(list) ? list : [])
    .filter((e) => e && e.code)
    .filter((e) => !e.frozen)
    .filter((e) => e.season === mine.season && e.week === mine.week)
    .filter((e) => now - (Number(e.ts) || 0) < 3 * DAY)
    .sort((a, b) => (Number(a.rate7) || 0) - (Number(b.rate7) || 0) || String(a.code).localeCompare(String(b.code)));
}

function pairOf(list, myCode) {
  const idx = list.findIndex((e) => e.code === myCode);
  if (idx < 0) return '';
  const other = idx % 2 === 0 ? idx + 1 : idx - 1;
  return other >= 0 && other < list.length ? list[other].code : '';
}

function weekDays(wk) {
  const out = [];
  const t = dateKeyOf(wk);
  for (let i = 0; i < 7; i++) out.push(ymd(new Date(t.getTime() + i * DAY)));
  return out;
}

function sumDays(days, wk) {
  const m = days || {};
  return weekDays(wk).reduce((s, d) => s + (Number(m[d]) || 0), 0);
}

function judge(myDays, oppDays, wk) {
  const my = sumDays(myDays, wk);
  const opp = sumDays(oppDays, wk);
  if (Math.abs(my - opp) < 7) return { draw: true, my, opp };
  return { draw: false, win: my > opp, my, opp };
}

function reportText(mine, theirs) {
  if (mine == null || theirs == null) return '今日战报还没凑齐，等双方都上报了再比。';
  const d = mine - theirs;
  if (d > 0) return d >= 10 ? `今日我方出操率 ${mine}%，敌方 ${theirs}%，大幅领先。` : `今日我方出操率 ${mine}%，敌方 ${theirs}%，暂时领先。`;
  if (d < 0) return d <= -10 ? `今日我方出操率 ${mine}%，敌方 ${theirs}%，落后不少，明天补上。` : `今日我方出操率 ${mine}%，敌方 ${theirs}%，差距缩小中。`;
  return `今日我方出操率 ${mine}%，敌方 ${theirs}%，咬得很紧。`;
}

/* ---------------- 模块状态 ---------------- */

let ctx = null;

function st() {
  const d = ctx.data();
  if (!d.pk) {
    d.pk = {
      season: '',
      opponent: '',
      matchWeek: '',
      matchState: 'idle', // idle | matching | active | bye | done
      reports: [],
      reportedDay: '',
      settledWeek: '',
      banner: null,
      badges: [],
      buff: null,
      frozenUntil: 0,
      seasonWins: 0,
      seasonDraws: 0,
      seasonLosses: 0,
      lastTickAt: 0,
      lastSnapAt: 0,
      pins: {}, // code -> 首次见到的公钥
      alerts: [], // [{at, kind, text}]
      err: '',
    };
  }
  if (!d.pk.pins) d.pk.pins = {};
  if (!Array.isArray(d.pk.alerts)) d.pk.alerts = [];
  return d.pk;
}

/* 本机的签名密钥：第一次参加 PK 时生成，私钥不出这台机器 */
function keys() {
  const d = ctx.data();
  if (!d.pkKeys || !d.pkKeys.pub || !d.pkKeys.priv) {
    d.pkKeys = signer.newKeyPair();
    ctx.saveNow();
  }
  return d.pkKeys;
}

function alert(kind, text) {
  const s = st();
  s.alerts.push({ at: Date.now(), kind, text: String(text).slice(0, 200) });
  if (s.alerts.length > 20) s.alerts = s.alerts.slice(-20);
}

function init(c) {
  ctx = c;
  store.init(() => {
    try {
      const d = ctx.data();
      const r = (d.settings && d.settings.pkRepo) || {};
      return r;
    } catch (_) {
      return {};
    }
  });
}

function inLegion() {
  try {
    const s = ctx.legion.snapshot();
    return !!(s && s.inLegion);
  } catch (_) {
    return false;
  }
}

function isManager() {
  try {
    const s = ctx.legion.snapshot();
    return !!(s && s.inLegion && (s.role === 'host' || s.role === 'hub' || s.role === 'mesh'));
  } catch (_) {
    return false;
  }
}

function legionCode() {
  try {
    const s = ctx.legion.snapshot();
    return String((s && s.code) || '').trim();
  } catch (_) {
    return '';
  }
}

function myDays() {
  try {
    const agg = ctx.legion.aggNow();
    if (!agg || !agg.n || !Array.isArray(agg.weeks)) return {};
    const out = {};
    for (const w of agg.weeks) {
      if (w && w.day) {
        const p = pctOf(w.cnt, agg.n);
        if (p != null) out[w.day] = p;
      }
    }
    return out;
  } catch (_) {
    return {};
  }
}

function myMeta() {
  const days = myDays();
  const vals = Object.keys(days).sort().slice(-7).map((d) => days[d]);
  const rate7 = vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : 0;
  let size = 0;
  try {
    const agg = ctx.legion.aggNow();
    size = (agg && Number(agg.n)) || 0;
  } catch (_) {}
  return { code: legionCode(), size, days, rate7 };
}

/* ---------------- 读写档案（带验签与冗余） ---------------- */

function payloadOf(s, my, extra) {
  const e = extra || {};
  return {
    v: 1,
    code: my.code,
    name: '军团 ' + my.code,
    season: s.season || seasonKeyOf(Date.now()),
    week: e.week || weekKeyOf(Date.now()),
    size: my.size,
    rate7: my.rate7,
    days: my.days,
    opponent: e.opponent != null ? e.opponent : '',
    result: e.result || null,
    updated: Date.now(),
  };
}

async function putLegion(payload) {
  const s = st();
  const k = keys();
  /* 写之前先自查：越界值就地回退，别把脏数据推上去再让 Actions 抓 */
  const chk = V.validateLegionFile(payload, null, Date.now());
  const body = chk.value || payload;
  const sealed = signer.seal(body, k);
  const w = await store.writeFile(store.pathOfLegion(body.code), sealed, { message: `pk: ${body.code} ${body.week}` });
  if (w.ok && w.backupOk === false) alert('mirror', '备仓写入失败：' + (w.backupMessage || ''));
  return { ...w, warnings: chk.warnings };
}

/* 读一个军团档案：验签 + 公钥固定 + 主备对比 */
async function getLegion(code) {
  const s = st();
  const r = await store.readFile(store.pathOfLegion(code));
  if (!r.ok) return { ok: false, missing: !!r.missing, message: r.message || '' };

  const opened = signer.openSealed(r.data);
  if (!opened.ok) {
    if (opened.unsigned) {
      alert('unsigned', `军团 ${code} 的档案没有签名（旧版本或被人重写了）`);
      return { ok: false, message: '档案没有签名' };
    }
    alert('tamper', `军团 ${code} 的档案签名校验失败：${opened.why}`);
    return { ok: false, tampered: true, message: opened.why };
  }

  /* TOFU 固定：第一次见到的公钥记下来，之后变了就报警（换机需要在本机解绑） */
  const pin = s.pins[code];
  if (!pin) {
    s.pins[code] = opened.pub;
    ctx.saveNow();
  } else if (pin !== opened.pub) {
    alert('keychange', `军团 ${code} 的公钥变了（可能是换设备，也可能是有人冒名）`);
    return { ok: false, tampered: true, message: '公钥变了' };
  }

  if (r.mismatch) alert('mirror', `军团 ${code} 的主备档案内容不一致，已按主仓为准`);

  /* 校验数字：异常值回退到「上一次合法值」 */
  const chk = V.validateLegionFile(opened.payload, null, Date.now());
  if (!chk.ok && chk.warnings.length) {
    alert('invalid', `军团 ${code} 档案有异常值：${V.summarize(chk.warnings)}`);
  }
  return { ok: true, payload: chk.value, warnings: chk.warnings, mismatch: !!r.mismatch, source: r.source };
}

/* ---------------- 报名（军团主） ---------------- */

async function join() {
  const s = st();
  if (!inLegion()) return { ok: false, message: '未加入军团，不参加 PK' };
  if (!isManager()) return { ok: false, message: 'PK 由军团主的电脑报名（服务器交给军团主）' };
  if (Date.now() < (s.frozenUntil || 0)) return { ok: false, message: 'PK 资格冻结中，两周后自动解冻' };
  if (!store.configured()) return { ok: false, message: store.describe() };

  const my = myMeta();
  if (!my.code) return { ok: false, message: '军团码缺失' };
  if (!my.size) return { ok: false, message: '军团还没有成员数据，等聚合出人数再报名' };

  const now = Date.now();
  const wk = weekKeyOf(now);
  s.season = seasonKeyOf(now);

  const w = await putLegion(payloadOf(s, my, { week: wk, opponent: s.matchWeek === wk ? s.opponent : '' }));
  s.lastTickAt = now;
  s.err = w.ok ? '' : '上报失败，稍后自动重试';
  if (!w.ok) alert('write', w.message || '上报失败');
  ctx.saveNow();
  tick().catch(() => {});
  return { ok: w.ok, message: w.ok ? '' : w.message, week: wk, warnings: w.warnings };
}

/* ---------------- Actions 写出来的配对表 ---------------- */

async function readPairing(wk) {
  const r = await store.readFile(store.pathOfPairing(wk));
  if (!r.ok) return null;
  const f = r.data;
  if (!f || !Array.isArray(f.pairs)) return null;
  return f;
}

/* ---------------- 主流程 ---------------- */

async function tick() {
  if (!ctx || !inLegion()) return;
  const s = st();
  const now = Date.now();
  if (now - (s.lastTickAt || 0) < 20 * 60e3) return;
  s.lastTickAt = now;

  const manager = isManager();
  const my = myMeta();
  const wk = weekKeyOf(now);
  const season = seasonKeyOf(now);

  /* 赛季切换：PK 记录清零（徽章保留） */
  if (s.season && s.season !== season) {
    s.season = season;
    s.opponent = '';
    s.matchWeek = '';
    s.matchState = 'idle';
    s.reports = [];
    s.reportedDay = '';
    s.settledWeek = '';
    s.seasonWins = 0;
    s.seasonDraws = 0;
    s.seasonLosses = 0;
    s.buff = null;
  }
  s.season = season;

  if (!store.configured()) {
    s.err = store.describe();
    return;
  }

  /* 熔断：PK 期间军团日志里禁言事件 ≥3 次 → 自动判负 + 冻结两周 */
  if (s.matchState === 'active' && !s.settledWeek) {
    let mutes = 0;
    try {
      const agg = ctx.legion.aggNow();
      const wStart = new Date(wk + 'T00:00:00').getTime();
      for (const e of agg.log || []) {
        if (e && e.kind === 'mute' && Number(e.at || 0) >= wStart) mutes++;
      }
    } catch (_) {}
    if (mutes >= 3) {
      applyVerdict(s, { draw: false, win: false }, wk, now, true);
      s.frozenUntil = now + 14 * DAY;
      ctx.saveNow();
      return;
    }
  }

  /* 结算：周已过且本周没结算过 —— 由军团主判决并写回，成员读同一份结果 */
  const weekOver = weekKeyOf(now) !== (s.matchWeek || wk) || new Date(now).getDay() === 0;
  if (manager && s.matchState === 'active' && s.matchWeek && weekOver && s.settledWeek !== s.matchWeek) {
    const opp = await getLegion(s.opponent);
    if (opp.ok && opp.payload.days) {
      const v = judge(my.days, opp.payload.days, s.matchWeek);
      applyVerdict(s, v, s.matchWeek, now, false);
      await putLegion(payloadOf(s, my, {
        week: s.matchWeek,
        opponent: s.opponent,
        result: { win: !!v.win, draw: !!v.draw, my: v.my, opp: v.opp, at: now },
      }));
      await store.writeFile(store.pathOfResult(s.matchWeek, my.code), { code: my.code, ...v, at: now }, { sha: '' });
      ctx.saveNow();
    }
  }

  /* 配对：优先用 Actions 写好的配对表（它已经统一校验过所有档案）；
     Actions 还没跑（或没配）时，退回到「按出操率相邻配对」的本地逻辑，保证可用。 */
  if (manager && now >= (s.frozenUntil || 0) && (s.matchWeek !== wk || !s.opponent)) {
    s.matchWeek = wk;
    s.settledWeek = '';
    let pair = '';
    let bye = false;

    const pairing = await readPairing(wk);
    if (pairing) {
      const hit = pairing.pairs.find((p) => Array.isArray(p) && (p[0] === my.code || p[1] === my.code));
      if (hit) pair = hit[0] === my.code ? hit[1] : hit[0];
      else if (Array.isArray(pairing.bye) && pairing.bye.includes(my.code)) bye = true;
      if (Array.isArray(pairing.anomalies) && pairing.anomalies.includes(my.code)) {
        alert('anomaly', 'Actions 判定本军团数据异常，本周成绩按上次合法值计');
      }
    } else {
      const dir = await store.listDir('legions');
      const list = [];
      for (const f of (dir.list || []).slice(0, 120)) {
        const g = await getLegion(String(f.name).replace(/\.json$/i, ''));
        if (!g.ok || !g.payload) continue;
        list.push({
          code: g.payload.code,
          season: g.payload.season,
          week: g.payload.week,
          rate7: g.payload.rate7 || 0,
          frozen: now < (s.frozenUntil || 0) && g.payload.code === my.code,
          ts: g.payload.updated || 0,
        });
      }
      const cand = candidatesOf(list, { code: my.code, season, week: wk });
      pair = pairOf(cand, my.code);
      bye = !pair;
    }

    if (pair) {
      const opp = await getLegion(pair);
      if (opp.ok && (!opp.payload.opponent || opp.payload.opponent === my.code)) {
        s.opponent = pair;
        s.matchState = 'active';
      } else {
        s.matchState = 'bye';
        s.opponent = '';
      }
    } else {
      s.matchState = bye ? 'bye' : 'idle';
      s.opponent = '';
    }

    if (my.size) {
      const w = await putLegion(payloadOf(s, my, { week: wk, opponent: s.opponent }));
      s.err = w.ok ? '' : '上报失败，稍后自动重试';
    }
    ctx.saveNow();
  }

  /* 成员镜像：军团主档案里写着对手与结果，成员读过来保持全团一致 */
  if (!manager) {
    const mine = await getLegion(my.code);
    if (mine.ok && mine.payload) {
      const f = mine.payload;
      const fwk = f.week || wk;
      if (f.opponent && s.opponent !== f.opponent) {
        s.opponent = f.opponent;
        s.matchWeek = fwk;
        s.matchState = 'active';
        s.settledWeek = '';
        ctx.saveNow();
      }
      if (f.result && s.settledWeek !== fwk && s.matchWeek === fwk) {
        applyVerdict(s, { draw: !!f.result.draw, win: !!f.result.win }, fwk, now, false);
      }
    }
  }

  /* 每日战报 */
  if (s.matchState === 'active' && s.opponent) {
    const today = ymd(now);
    const cached = s._oppCache && s._oppCache.at > now - 10 * 60e3 ? s._oppCache.data : null;
    const oppPayload = cached || (await getLegion(s.opponent)).payload;
    if (oppPayload) {
      s._oppCache = { at: now, data: oppPayload };
      const minePct = (my.days || {})[today];
      const theirs = (oppPayload.days || {})[today];
      if (minePct != null && theirs != null && s.reportedDay !== today) {
        s.reportedDay = today;
        s.reports.push({ day: today, mine: minePct, theirs, text: reportText(minePct, theirs) });
        if (s.reports.length > 7) s.reports = s.reports.slice(-7);
        ctx.saveNow();
      }
    }
  }

  /* 每小时快照：军团主把自己这份档案备份一份，被改坏了能回滚 */
  if (manager && now - (s.lastSnapAt || 0) > SNAP_MS && my.code) {
    s.lastSnapAt = now;
    const mine = await store.readFile(store.pathOfLegion(my.code));
    if (mine.ok) store.snapshot(store.pathOfLegion(my.code), mine.data).catch(() => {});
    ctx.saveNow();
  }
}

/* ---------------- 结算落袋 ---------------- */

function applyVerdict(s, v, wk, now, forced) {
  s.settledWeek = wk;
  s.matchState = 'done';
  s.banner = { kind: v.draw ? 'draw' : v.win ? 'win' : 'lose', until: now + 24 * HOUR };
  if (v.draw) {
    addBadge(s, '旗鼓相当');
    s.seasonDraws++;
  } else if (v.win) {
    addBadge(s, '战役胜利');
    s.seasonWins++;
  } else {
    addBadge(s, '钢铁意志');
    s.seasonLosses++;
  }
  const nm = nextMonday(now);
  const pct = v.draw ? 0 : v.win ? 5 : 3;
  s.buff = pct ? { pct, from: ymd(nm), to: ymd(new Date(nm.getTime() + 6 * DAY)) } : null;
  if (forced) s.reports.push({ day: ymd(now), mine: null, theirs: null, text: 'PK 期间军团内部举报异常，本场自动判负并冻结两周。' });
}

function addBadge(s, name) {
  if (!s.badges.includes(name)) s.badges.push(name);
  if (s.badges.length > 60) s.badges = s.badges.slice(-60);
}

/* ---------------- 给 UI 的快照 ---------------- */

function snapshot() {
  const s = st();
  const now = Date.now();
  const joined = inLegion();
  const frozen = now < (s.frozenUntil || 0);
  const my = joined ? myMeta() : { code: '', size: 0, days: {}, rate7: 0 };
  const opp = s._oppCache && s._oppCache.data
    ? { code: s._oppCache.data.code || '', size: Number(s._oppCache.data.size) || 0, rate7: null }
    : null;
  return {
    joined,
    canManage: joined && isManager(),
    ready: store.configured(),
    board: store.describe(),
    dual: store.dualEnabled(),
    season: s.season || seasonKeyOf(now),
    week: weekKeyOf(now),
    frozen,
    frozenLeft: frozen ? Math.max(0, s.frozenUntil - now) : 0,
    match: {
      state: joined ? s.matchState : 'idle',
      week: s.matchWeek || '',
      opponent: opp || (s.opponent ? { code: s.opponent, size: 0, rate7: null } : null),
    },
    my: { code: my.code, size: my.size, rate7: my.rate7 },
    myDays: Object.keys(my.days || {}).sort().map((d) => ({ day: d, pct: my.days[d] })),
    reports: s.reports.slice(-5).reverse(),
    banner: s.banner && now < s.banner.until ? { kind: s.banner.kind, leftH: Math.ceil((s.banner.until - now) / HOUR) } : null,
    badges: s.badges.slice(),
    buff: s.buff || null,
    record: { w: s.seasonWins || 0, d: s.seasonDraws || 0, l: s.seasonLosses || 0 },
    alerts: s.alerts.slice(-5).reverse(),
    err: s.err || '',
  };
}

async function statusTick() {
  await tick().catch(() => {});
  return snapshot();
}

module.exports = {
  init,
  join,
  tick,
  snapshot,
  statusTick,
  _pure: {
    ymd,
    weekKeyOf,
    seasonKeyOf,
    nextMonday,
    weekDays,
    pctOf,
    candidatesOf,
    pairOf,
    sumDays,
    judge,
    reportText,
    applyVerdict,
    addBadge,
    payloadOf,
  },
};
