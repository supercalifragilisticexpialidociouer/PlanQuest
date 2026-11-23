'use strict';

/*
 * Guardian —— 强制模式
 * - 白名单：随时可用，永不关闭
 * - 灰名单：没有计划进行中的时段，强制关闭
 * - 黑名单：强制模式开启期间，强制关闭
 * - 修改名单 / 开关强制模式 / 改计划：需要守护密码（scrypt 哈希存储，绝不存明文）
 * - 局域网同步只上传 用户名+哈希+盐，不上传明文
 */

const { execFile } = require('node:child_process');
const crypto = require('node:crypto');

// 系统关键进程，任何情况下不允许结束
const PROTECTED = new Set([
  'system', 'idle', 'smss.exe', 'csrss.exe', 'wininit.exe', 'winlogon.exe',
  'services.exe', 'lsass.exe', 'svchost.exe', 'dwm.exe', 'explorer.exe',
  'fontdrvhost.exe', 'runtimebroker.exe', 'conhost.exe', 'cmd.exe',
  'powershell.exe', 'pwsh.exe', 'tasklist.exe', 'taskkill.exe', 'wudfhost.exe',
  'memory', 'registry', 'searchhost.exe', 'shellexperiencehost.exe',
  'startmenuexperiencehost.exe', 'textinputhost.exe', 'widgets.exe',
  'msedgewebview2.exe', 'applicationframehost.exe', 'lockapp.exe',
  'securityhealthservice.exe', 'securityhealthsystray.exe', 'wmiapsrv.exe',
  'workbuddy.exe', 'workbuddy', // 助手宿主，任何模式下都不允许关闭
]);

// 自家进程，永远不算“未授权软件”（electron 是开发模式下的进程名）
const SELF = new Set(['planquest', 'electron']);

const state = {
  user: '',
  salt: '',
  hash: '',
  enabled: false,       // 强制模式（黑名单生效）
  whitelist: [],
  graylist: [],
  blacklist: [],
  strikeLimit: 5,
  strikeDeduct: 15,
  allowUntil: 0,        // 娱乐券生效截止时间戳（灰名单放行）
  points: 0,            // 当前积分（负分 → 名单升级）
};

/* 计划内放行的进程：累计使用额度（超过后按违规处理）
   PQ_PLAN_BUDGET_MS 仅用于自动化测试，正式运行固定 1 小时 */
const PLAN_PROC_BUDGET_MS = Number(process.env.PQ_PLAN_BUDGET_MS) || 60 * 60 * 1000;
const planUsage = { planId: '', ms: Object.create(null) };
const overNotified = new Set();
let lastUsageTick = 0;
let planAllowFn = null;   // () => { procs: [], id: '' }
let lastEscalated = false;

function setPoints(n) {
  state.points = Number(n) || 0;
}

function isEscalated() {
  return !!state.enabled && (Number(state.points) || 0) < 0;
}

/* 负分分级（梯度式，不是一刀切封禁）
 *   0 及以上   → ok     正常
 *   -10 ~ -1   → light  低价奖励仍可兑换，但价格 ×2（代价变贵，不是断供）
 *   -30 ~ -11  → mid    只能领「救赎券」：完成额外挑战后解锁一次兑换
 *   -30 以下   → heavy  全面锁定，先靠打卡把分拉回 -30 以上
 * 这样惩罚是渐进的，用户在每一档都看得到「怎么回来」。 */
const TIERS = {
  ok: { key: 'ok', label: '正常', mult: 1, canRedeem: 'all', advice: '' },
  light: { key: 'light', label: '轻度欠分', mult: 2, canRedeem: 'cheap', advice: '还能换低价奖励，只是要付双倍积分。' },
  mid: { key: 'mid', label: '中度欠分', mult: 2, canRedeem: 'rescue', advice: '先领救赎券，完成挑战就能解锁一次兑换。' },
  heavy: { key: 'heavy', label: '重度欠分', mult: 2, canRedeem: 'none', advice: '兑换全锁，先打卡把积分拉回 -30 以上。' },
};
const CHEAP_MAX = 100; // 「低价奖励」上限，超过的按高价档处理

function tierOf(points) {
  const p = Number(points) || 0;
  if (p >= 0) return TIERS.ok;
  if (p >= -10) return TIERS.light;
  if (p >= -30) return TIERS.mid;
  return TIERS.heavy;
}

function tier() {
  // 负分分级只在「强制模式」开启时才生效：没开守护的用户，负分就只是负分，不限制兑换
  if (!state.enabled) return TIERS.ok;
  return tierOf(state.points);
}

function setPlanAllowProvider(fn) {
  planAllowFn = typeof fn === 'function' ? fn : null;
}

/* 计划放行进程的剩余时间（分钟），给界面展示 */
function planUsageInfo() {
  const out = {};
  for (const k of Object.keys(planUsage.ms)) {
    out[k] = Math.max(0, Math.round((PLAN_PROC_BUDGET_MS - planUsage.ms[k]) / 60000));
  }
  return { planId: planUsage.planId, remain: out, budgetMin: PLAN_PROC_BUDGET_MS / 60000 };
}

/* 未授权软件：累计提醒次数（按程序名） */
const unlistedStrikes = new Map();
const lastWarnedAt = new Map();
let winProcCache = { at: 0, list: [] };
let lastUnlistedCheck = 0;

let loopTimer = null;
let scanning = false;
let onEvent = () => {};
let needAdmin = false;

function setEmitter(fn) {
  onEvent = fn || (() => {});
}

function emit(type, payload = {}) {
  try {
    onEvent({ type, ...payload });
  } catch (_) {}
}

/* ---------------- 密码 ---------------- */

function hasPassword() {
  return !!state.hash;
}

function setPassword(user, password) {
  state.user = String(user || '').slice(0, 20);
  state.salt = crypto.randomBytes(16).toString('hex');
  state.hash = crypto.scryptSync(String(password), state.salt, 32).toString('hex');
}

function verify(password) {
  if (!state.hash) return true; // 未设置密码时不需要验证
  try {
    const h = crypto.scryptSync(String(password || ''), state.salt, 32).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(h), Buffer.from(state.hash));
  } catch (_) {
    return false;
  }
}

/* ---------------- 名单 ---------------- */

const normName = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/\.exe$/, '')
    .trim();

function inList(list, name) {
  return list.some((x) => normName(x) === normName(name));
}

function setLists({ whitelist, graylist, blacklist }) {
  const clean = (arr) =>
    (Array.isArray(arr) ? arr : [])
      .map((x) => String(x).trim())
      .filter(Boolean)
      .slice(0, 100);
  state.whitelist = clean(whitelist);
  state.graylist = clean(graylist).filter((x) => !inList(state.whitelist, x) && !PROTECTED.has(normName(x) + '.exe'));
  state.blacklist = clean(blacklist).filter((x) => !inList(state.whitelist, x) && !PROTECTED.has(normName(x) + '.exe'));
  return state;
}

function publicInfo() {
  return {
    hasPassword: hasPassword(),
    user: state.user,
    enabled: state.enabled,
    needAdmin,
    whitelist: [...state.whitelist],
    graylist: [...state.graylist],
    blacklist: [...state.blacklist],
    allowUntil: state.allowUntil || 0,
    points: Number(state.points) || 0,
    escalated: isEscalated(),
    planUsage: planUsageInfo(),
  };
}

/* 娱乐券：minutes 分钟内灰名单放行 */
function grantTicket(minutes) {
  const base = Math.max(Date.now(), state.allowUntil || 0);
  state.allowUntil = base + Math.max(1, Number(minutes) || 0) * 60000;
  return state.allowUntil;
}

/* 直接设定灰名单放行截止时间（娱乐房期间放行用；0 = 立即取消） */
function setAllowUntil(ts) {
  state.allowUntil = Math.max(0, Number(ts) || 0);
  return state.allowUntil;
}

/* 局域网同步用的账户摘要（绝不含明文密码） */
function credentialSummary() {
  if (!hasPassword()) return null;
  return { user: state.user, salt: state.salt, hash: state.hash };
}

/* ---------------- 进程扫描与强制关闭 ---------------- */

function listProcesses() {
  return new Promise((resolve) => {
    execFile('tasklist', ['/FO', 'CSV', '/NH'], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve([]);
      const out = new Map(); // name -> [pid...]
      for (const line of String(stdout || '').split('\n')) {
        const m = line.match(/^"([^"]+)","(\d+)"/);
        if (m) {
          const name = m[1];
          const pid = Number(m[2]);
          if (!out.has(name)) out.set(name, []);
          out.get(name).push(pid);
        }
      }
      resolve([...out.entries()].map(([name, pids]) => ({ name, pids })));
    });
  });
}

/* 是否以管理员身份运行（net session 仅管理员可成功） */
function isAdmin() {
  return new Promise((resolve) => {
    execFile('net', ['session'], { windowsHide: true }, (err) => resolve(!err));
  });
}

/* 整软查杀：按程序名强制结束主进程+子进程+所有实例 */
function killSoftware(imageName) {
  return new Promise((resolve) => {
    execFile('taskkill', ['/F', '/T', '/IM', imageName], { windowsHide: true }, (err, _out, stderr) => {
      if (err) {
        const msg = String(err.message || '') + String(stderr || '');
        if (/没有找到进程|not found|找不到/i.test(msg)) return resolve({ ok: true, gone: true });
        resolve({ ok: false, denied: /拒绝访问|Access is denied|\b5\b/i.test(msg) });
      } else resolve({ ok: true });
    });
  });
}

/* 有可见窗口的进程 = 用户正在用的软件（系统后台服务不算） */
function listWindowProcesses() {
  return new Promise((resolve) => {
    if (Date.now() - winProcCache.at < 4000) return resolve(winProcCache.list);
    const ps =
      "Get-Process | Where-Object { $_.MainWindowTitle } | ForEach-Object { $_.ProcessName } | Sort-Object -Unique";
    execFile('powershell.exe', ['-NoProfile', '-Command', ps], { windowsHide: true, timeout: 15000 }, (err, stdout) => {
      if (err) return resolve(winProcCache.list);
      const list = String(stdout || '')
        .split(/\r?\n/)
        .map((x) => x.trim())
        .filter(Boolean);
      winProcCache = { at: Date.now(), list };
      resolve(list);
    });
  });
}

async function enforceNow(hasActivePlan) {
  if (scanning) return;
  scanning = true;
  try {
    const procs = await listProcesses();
    const killed = [];
    let denied = false;
    const nowTs = Date.now();
    // 娱乐券生效期内灰名单放行（黑名单不受影响）
    const ticketActive = nowTs < (state.allowUntil || 0);
    // 负积分 → 名单升级：灰名单按黑名单处理，普通非白名单软件按灰名单处理
    const escalated = isEscalated();
    if (escalated !== lastEscalated) {
      lastEscalated = escalated;
      emit('escalation', { on: escalated, points: Number(state.points) || 0 });
    }

    /* 当前计划的放行进程 + 累计使用额度（1 小时）
       tempOnly：当前只有灰名单兑换的临时计划在生效——此时只放行兑换的软件，
       普通「非白名单」软件仍按升级后的灰名单规则处理 */
    let allow = [];
    let allowId = '';
    let tempOnly = false;
    if (hasActivePlan && planAllowFn) {
      try {
        const r = planAllowFn() || {};
        allow = Array.isArray(r.procs) ? r.procs : [];
        allowId = String(r.id || '');
        tempOnly = !!r.tempOnly;
      } catch (_) {}
    }
    if (hasActivePlan && allowId) {
      if (planUsage.planId !== allowId) {
        planUsage.planId = allowId;
        planUsage.ms = Object.create(null);
        overNotified.clear();
        lastUsageTick = nowTs;
      }
      const delta = lastUsageTick ? Math.min(nowTs - lastUsageTick, 15000) : 0;
      lastUsageTick = nowTs;
      const running = new Set(procs.map((p) => normName(p.name)));
      for (const n of allow) {
        const b = normName(n);
        if (running.has(b)) planUsage.ms[b] = (planUsage.ms[b] || 0) + delta;
      }
    } else {
      lastUsageTick = 0;
    }
    // 剩余额度 > 0 才放行；用完后回归“普通进程”，按名单外的规则处理
    const allowExempt = (base) =>
      !!hasActivePlan && inList(allow, base) && (planUsage.ms[base] || 0) < PLAN_PROC_BUDGET_MS;

    /* 额度用尽提醒（每个进程每个计划只提醒一次） */
    for (const n of allow) {
      const b = normName(n);
      if (!hasActivePlan || !inList(allow, b)) continue;
      if ((planUsage.ms[b] || 0) >= PLAN_PROC_BUDGET_MS && !overNotified.has(b)) {
        overNotified.add(b);
        emit('planProcOver', { name: b, budgetMin: PLAN_PROC_BUDGET_MS / 60000 });
      }
    }

    const imageOf = new Map();
    for (const { name } of procs) imageOf.set(normName(name), name);

    for (const { name } of procs) {
      const base = normName(name);
      if (PROTECTED.has(base + '.exe') || PROTECTED.has(base)) continue;
      if (inList(state.whitelist, base)) continue;
      if (allowExempt(base)) continue;

      let shouldKill = false;
      // 黑名单：强制模式开启期间始终关闭
      if (state.enabled && inList(state.blacklist, base)) shouldKill = true;
      // 负积分升级：灰名单按黑名单处理
      if (escalated && inList(state.graylist, base)) shouldKill = true;
      // 灰名单：没有计划进行中、且没有娱乐券时才关闭
      if (!hasActivePlan && !ticketActive && inList(state.graylist, base)) shouldKill = true;

      if (!shouldKill) continue;
      // 按映像名整树查杀：覆盖该软件的全部进程与子进程
      const r = await killSoftware(name);
      if (!r.ok && r.denied) denied = true;
      else if (r.ok) killed.push(name);
    }

    /* 负积分升级（第二层）：普通“非白名单”的有窗口软件 升级为灰名单
       → 没有计划进行中时强制关闭（有计划时放行，符合灰名单语义；
         但只有临时计划生效时不放行——临时计划只放行兑换的那个灰名单软件） */
    if (escalated && (!hasActivePlan || tempOnly) && !ticketActive) {
      const winProcs = await listWindowProcesses();
      for (const raw of winProcs) {
        const base = normName(raw);
        if (!base) continue;
        if (PROTECTED.has(base) || PROTECTED.has(base + '.exe')) continue;
        if (SELF.has(base)) continue;
        if (inList(state.whitelist, base)) continue;
        if (inList(state.blacklist, base) || inList(state.graylist, base)) continue; // 上面已处理
        if (allowExempt(base)) continue;
        const img = imageOf.get(base);
        if (!img) continue;
        const r = await killSoftware(img);
        if (!r.ok && r.denied) denied = true;
        else if (r.ok) killed.push(img);
      }
    }

    if (denied !== needAdmin) {
      needAdmin = denied;
      emit('admin', { needAdmin: denied });
    }
    if (killed.length) {
      emit('killed', { names: [...new Set(killed)] });
    }

    /* 未授权软件：既不在白名单、也不在灰/黑名单里，且当前正在使用 → 弹窗提醒
       只有强制模式开启才提醒（非强制模式不管普通软件）
       同一软件 4 分钟内只提醒一次；累计到 strikeLimit(5) 次 → 扣 strikeDeduct(15) 积分并清零 */
    if (state.enabled && Date.now() - lastUnlistedCheck > 12000) {
      lastUnlistedCheck = Date.now();
      const winProcs = await listWindowProcesses();
      const fresh = [];
      const penalties = [];
      const now = Date.now();
      for (const raw of winProcs) {
        const base = normName(raw);
        if (!base) continue;
        if (PROTECTED.has(base) || PROTECTED.has(base + '.exe')) continue;
        if (SELF.has(base)) continue;
        if (inList(state.whitelist, base) || inList(state.graylist, base) || inList(state.blacklist, base)) continue;
        if (allowExempt(base)) continue; // 计划内放行的进程不提醒
        if (now - (lastWarnedAt.get(base) || 0) < 4 * 60 * 1000) continue;
        lastWarnedAt.set(base, now);
        const count = (unlistedStrikes.get(base) || 0) + 1;
        if (count >= state.strikeLimit) {
          unlistedStrikes.set(base, 0);
          penalties.push({ name: base, count });
        } else {
          unlistedStrikes.set(base, count);
        }
        fresh.push({ name: base, count, limit: state.strikeLimit });
      }
      if (fresh.length) {
        emit('unlisted', {
          items: fresh,
          penalties,
          deduct: state.strikeDeduct,
        });
      }
    }
  } finally {
    scanning = false;
  }
}

function startLoop(hasActivePlanFn) {
  stopLoop();
  loopTimer = setInterval(() => {
    let active = false;
    try {
      active = !!hasActivePlanFn();
    } catch (_) {}
    // 空闲：没开强制模式、没有进行中的计划、灰名单也是空的 → 什么都不用做
    if (!state.enabled && !active && !state.graylist.length) return;
    enforceNow(active);
  }, 2500);
  enforceNow(false);
}

function stopLoop() {
  if (loopTimer) {
    clearInterval(loopTimer);
    loopTimer = null;
  }
}

function setEnabled(on, hasActivePlanFn) {
  state.enabled = !!on;
  // 循环常驻，但内部会判断“是否需要动作”，空闲时直接跳过（不扫进程）
  startLoop(hasActivePlanFn);
}

module.exports = {
  state,
  setPassword,
  verify,
  hasPassword,
  setLists,
  publicInfo,
  credentialSummary,
  listProcesses,
  enforceNow,
  startLoop,
  stopLoop,
  setEnabled,
  setEmitter,
  grantTicket,
  setAllowUntil,
  isAdmin,
  killSoftware,
  PROTECTED,
  normName,
  setPoints,
  isEscalated,
  tier,
  tierOf,
  TIERS,
  CHEAP_MAX,
  setPlanAllowProvider,
  planUsageInfo,
};
