/* PlanQuest 手机版核心引擎
 * 从桌面版 src/main.js 移植的平台无关业务逻辑：
 * 数据结构 / 打卡积分 / 等级徽章 / 商城规则 / 守护名单 / 三件事 / 目标契约
 * 与桌面版保持同样的数据结构与扣分规则（惩罚类扣分可扣成负分）。
 * 平台相关能力（进程管控/通知/悬浮窗）通过 window.NativeGuard 调安卓插件。
 */
'use strict';

/* ---------------- 时间工具 ---------------- */
const pad = (n) => String(n).padStart(2, '0');
const dateKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const minutesOf = (hhmm) => {
  const [h, m] = String(hhmm || '00:00').split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
};
const nowMinutes = () => {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
};

/* 计划触发时机：p.when = 'time'（默认，定时）| 'boot'（开机 / 打开应用时） */
let bootMinutes = null;
const REMIND_WINDOW_MIN = 45;
const planStartMin = (p) => (p && p.when === 'boot' ? (bootMinutes == null ? nowMinutes() : bootMinutes) : minutesOf(p.time));
const hasActivePlanNow = () => {
  const now = nowMinutes();
  return plansForDate(dateKey()).some((p) => {
    const m = planStartMin(p);
    return now >= m && now <= m + REMIND_WINDOW_MIN;
  });
};

const CLOSE_PENALTY = 10;
const PLAN_PROC_PENALTY = 10;
const GRAY_REDEEM_DAILY_LIMIT = 30;
const GRAY_REDEEM_COST_PER10 = 15;
const SHOP_TICKET_MIN = 50;
const SHOP_PLAIN_MIN = 10;

/* 护眼节奏三档：工作 N 分钟 → 休息 M 分钟（与桌面版 EYE_PLANS 一致） */
const EYE_PLANS = { 30: 10, 45: 15, 60: 20 };

/* ---------------- 默认数据（与桌面版结构一致） ---------------- */
function defaultData() {
  return {
    version: 1,
    settings: {
      autoStart: false, closeToTray: true, sound: true, theme: 'dark',
      snoozeMinutes: 10, repeatRemind: true, eyeCare: false, eyeCarePlan: 45,
      eyeExerciseMs: 4 * 60 * 1000 + 12 * 1000, eyeRestMs: 15 * 60 * 1000, eyeIntervalMs: 45 * 60 * 1000,
    },
    profile: { points: 100, totalDone: 0, bestStreak: 0, perfectDays: 0, name: '我', avatar: '🙂', focusMinutes: 0, pomodoros: 0 },
    plans: [],
    log: {}, fired: {}, snooze: {}, bonus: {}, pomodoro: {}, focus: {}, mits: {},
    guardian: { user: '', salt: '', hash: '', whitelist: [], graylist: [], blacklist: [], enabled: false, allowUntil: 0 },
    reminderStrikes: {},
    shop: { items: [], history: [], seeded: false },
    goals: [], contracts: [], contractProjects: [], diary: {}, reviews: {}, makeups: {}, lastRemind: {},
    grayRedeem: {},
    micro: {}, forceDays: {}, witness: {}, rescue: null,
    credit: {
      score: 100, limit: 50, rate: 0.2, loan: null, blockUntil: 0, history: [],
      rep: { flips: { ok: 0, bad: 0 }, reports: { ok: 0, bad: 0 }, loans: { ok: 0, bad: 0 }, help: { ok: 0, bad: 0 }, online: { ok: 0, bad: 0 }, legion: { ok: 0, bad: 0 }, discipline: { ok: 0, bad: 0 }, growth: { ok: 0 } },
      ledger: [],
    },
    discipline: {
      desert: { count: 0, lastAt: 0 },
      audits: { voidCount: 0, lastAt: 0 },
      contracts: {},
      flags: [],
      ban: null,
      frozenUntil: 0,
    },
  };
}

function normalize(d) {
  const base = defaultData();
  const out = { ...base, ...(d || {}) };
  out.settings = { ...base.settings, ...(d?.settings || {}) };
  out.profile = { ...base.profile, ...(d?.profile || {}) };
  out.plans = Array.isArray(d?.plans) ? d.plans : [];
  for (const k of ['log', 'fired', 'snooze', 'bonus', 'pomodoro', 'focus', 'mits', 'reminderStrikes', 'diary', 'reviews', 'makeups', 'lastRemind', 'grayRedeem'])
    out[k] = d?.[k] && typeof d[k] === 'object' ? d[k] : {};
  out.guardian = { ...base.guardian, ...(d?.guardian && typeof d.guardian === 'object' ? d.guardian : {}) };
  out.shop = { items: Array.isArray(d?.shop?.items) ? d.shop.items : [], history: Array.isArray(d?.shop?.history) ? d.shop.history : [], seeded: !!d?.shop?.seeded };
  out.goals = Array.isArray(d?.goals) ? d.goals : [];
  out.contracts = Array.isArray(d?.contracts) ? d.contracts : [];
  out.contractProjects = Array.isArray(d?.contractProjects) ? d.contractProjects : [];
  out.credit = { ...base.credit, ...(d?.credit && typeof d.credit === 'object' ? d.credit : {}) };
  out.credit.rep = { ...base.credit.rep, ...(out.credit.rep || {}) };
  out.discipline = { ...base.discipline, ...(d?.discipline && typeof d.discipline === 'object' ? d.discipline : {}) };
  out.discipline.contracts = out.discipline.contracts && typeof out.discipline.contracts === 'object' ? out.discipline.contracts : {};
  out.discipline.flags = Array.isArray(out.discipline.flags) ? out.discipline.flags : [];
  return out;
}

/* ---------------- 守护密码（手机版独立哈希，与桌面版不互通） ---------------- */
function syncHash(salt, pw) {
  const s = String(salt) + '\u0001' + String(pw);
  let h1 = 0x811c9dc5, h2 = 0xc9dc5118;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = (h1 ^ c) >>> 0; h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 = (h2 + Math.imul(c + i, 0x85ebca6b)) >>> 0; h2 = (h2 ^ (h2 >>> 13)) >>> 0;
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}
const guardian = {
  hasPassword: () => !!(data.guardian.hash && data.guardian.salt),
  verify: (pw) => guardian.hasPassword() && syncHash(data.guardian.salt, pw) === data.guardian.hash,
  isEscalated: () => !!data.guardian.enabled && (data.profile.points || 0) < 0,
  setPoints: (n) => { data.guardian.points = n; },
  publicInfo() {
    return {
      enabled: !!data.guardian.enabled,
      whitelist: data.guardian.whitelist || [],
      graylist: data.guardian.graylist || [],
      blacklist: data.guardian.blacklist || [],
      strikeLimit: 5, strikeDeduct: 15,
      allowUntil: data.guardian.allowUntil || 0,
      points: data.profile.points || 0,
      escalated: guardian.isEscalated(),
      hasPassword: guardian.hasPassword(),
      isAdmin: true,
      native: typeof window.NativeGuard !== 'undefined' ? window.NativeGuard.capabilities() : { available: false },
    };
  },
};

/* ---------------- 数据存取 ---------------- */
const STORE_KEY = 'planquest-data-v1';
let data = null;
let saveTimer = null;
function saveNow() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(data)); } catch (e) { console.error('[store] 保存失败', e); }
  guardian.setPoints(data.profile.points || 0);
  // 本地优先：本地写完后再排一次云端同步（未登录/离线时为空操作）
  if (window.PQCloud && typeof window.PQCloud.notifyLocalChange === 'function') {
    try { window.PQCloud.notifyLocalChange(); } catch (e) {}
  }
}
function saveData() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 150);
}
function setProfilePoints(v) {
  data.profile.points = v;
  guardian.setPoints(v);
}
function loadData() {
  let fresh = false;
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) data = normalize(JSON.parse(raw));
    else { data = defaultData(); fresh = true; }
  } catch (e) { data = defaultData(); fresh = true; }
  if (fresh) seedDemoPlans();
  sweepTempPlans();
  saveNow();
}
function seedDemoPlans() {
  const stamp = new Date().toISOString();
  data.plans = [
    { id: 'demo-1', title: '晨间阅读', desc: '读 20 页书，做三条笔记', icon: '📖', color: 'mint', time: '07:30', days: [0, 1, 2, 3, 4, 5, 6], points: 20, enabled: true, createdAt: stamp },
    { id: 'demo-2', title: '核心训练', desc: '平板支撑 3 组 + 拉伸', icon: '🏃', color: 'coral', time: '18:30', days: [1, 2, 3, 4, 5], points: 30, enabled: true, createdAt: stamp },
    { id: 'demo-3', title: '睡前复盘', desc: '写三行今日小结', icon: '🧭', color: 'indigo', time: '21:30', days: [0, 1, 2, 3, 4, 5, 6], points: 25, enabled: true, createdAt: stamp },
  ];
  data.shop.seeded = false;
}
function sweepTempPlans() {
  const today = dateKey();
  const before = data.plans.length;
  data.plans = data.plans.filter((p) => !(p.temp && p.expireKey && p.expireKey < today));
  if (data.plans.length !== before) saveNow();
}

/* ---------------- 业务计算（与桌面版同规则） ---------------- */
function plansForDate(key) {
  const dow = new Date(key + 'T00:00:00').getDay();
  return data.plans
    .filter((p) => !p.temp && p.enabled && (p.days || []).includes(dow))
    .sort((a, b) => planStartMin(a) - planStartMin(b));
}
const logOf = (key) => data.log[key] || {};
function completedCount(key) {
  return Object.values(logOf(key)).filter((v) => v && v.status === 'done').length;
}
function computeStreak() {
  let streak = 0;
  const cursor = new Date();
  if (completedCount(dateKey(cursor)) === 0) cursor.setDate(cursor.getDate() - 1);
  for (let i = 0; i < 400; i++) {
    const key = dateKey(cursor);
    const due = plansForDate(key);
    if (due.length === 0) { cursor.setDate(cursor.getDate() - 1); continue; }
    if (completedCount(key) > 0) { streak++; cursor.setDate(cursor.getDate() - 1); }
    else break;
  }
  return streak;
}
function todayPoints(key) {
  return Object.values(logOf(key)).reduce((s, v) => s + (v && v.status === 'done' ? v.points || 0 : 0), 0);
}
function levelOf(points) {
  let level = 1, need = 120, rest = points;
  while (rest >= need && level < 99) { rest -= need; level++; need = Math.round(need * 1.28); }
  return { level, cur: rest, need };
}
const BADGES = [
  { id: 'first', icon: '🌱', name: '第一步', desc: '完成第一次打卡', test: (s) => s.totalDone >= 1 },
  { id: 'streak3', icon: '🔥', name: '三日之火', desc: '连续打卡 3 天', test: (s) => s.bestStreak >= 3 },
  { id: 'streak7', icon: '⚡', name: '一周不断', desc: '连续打卡 7 天', test: (s) => s.bestStreak >= 7 },
  { id: 'streak30', icon: '👑', name: '月度王者', desc: '连续打卡 30 天', test: (s) => s.bestStreak >= 30 },
  { id: 'perfect', icon: '🎯', name: '全勤日', desc: '一天内完成全部计划', test: (s) => s.perfectDays >= 1 },
  { id: 'points500', icon: '💎', name: '积分新星', desc: '累计 500 积分', test: (s) => s.points >= 500 },
  { id: 'points2000', icon: '🚀', name: '积分大师', desc: '累计 2000 积分', test: (s) => s.points >= 2000 },
];
function countEarlyDays(daysBack = 90) {
  let count = 0;
  for (let i = 0; i < daysBack; i++) {
    const dt = new Date(); dt.setDate(dt.getDate() - i);
    const key = dateKey(dt);
    const early = plansForDate(key).filter((p) => minutesOf(p.time) < 8 * 60);
    if (early.some((p) => logOf(key)[p.id]?.status === 'done')) count++;
  }
  return count;
}
function todayGrayRedeem() {
  const k = dateKey();
  data.grayRedeem[k] = data.grayRedeem[k] || {};
  return data.grayRedeem[k];
}
const grayRedeemLeft = (name) => GRAY_REDEEM_DAILY_LIMIT - (todayGrayRedeem()[name] || 0);

/* ---------------- 快照（与桌面版 state:get 同形状） ---------------- */
function snapshot() {
  const today = dateKey();
  const streak = computeStreak();
  const profile = { ...data.profile };
  if (streak > (profile.bestStreak || 0)) profile.bestStreak = streak;
  const lv = levelOf(profile.points || 0);
  const mits = (data.mits[today] || []).map((m) => ({ ...m }));

  const week = [];
  for (let i = 6; i >= 0; i--) {
    const dt = new Date(); dt.setDate(dt.getDate() - i);
    const key = dateKey(dt);
    week.push({
      key, label: ['日', '一', '二', '三', '四', '五', '六'][dt.getDay()], date: dt.getDate(),
      due: plansForDate(key).length, done: completedCount(key), points: todayPoints(key), isToday: key === today,
    });
  }
  const todayPlans = plansForDate(today).map((p) => {
    const st = logOf(today)[p.id];
    const late = nowMinutes() > planStartMin(p) + 45;
    return { ...p, status: st?.status || (late ? 'missed' : 'pending'), at: st?.at || null, earned: st?.points || 0 };
  });
  const badges = BADGES.map((b) => ({
    id: b.id, icon: b.icon, name: b.name, desc: b.desc,
    unlocked: b.test({ ...profile, bestStreak: Math.max(profile.bestStreak || 0, streak), streak, earlyDays: countEarlyDays() }),
  }));

  const nowD = new Date();
  const monthDays = new Date(nowD.getFullYear(), nowD.getMonth() + 1, 0).getDate();
  const month = { year: nowD.getFullYear(), month: nowD.getMonth() + 1, firstWeekday: new Date(nowD.getFullYear(), nowD.getMonth(), 1).getDay(), days: [] };
  for (let i = 1; i <= monthDays; i++) {
    const dt = new Date(nowD.getFullYear(), nowD.getMonth(), i);
    const k = dateKey(dt);
    month.days.push({ key: k, day: i, due: plansForDate(k).length, done: completedCount(k), isToday: k === today, future: k > today });
  }
  const trend30 = [];
  for (let i = 29; i >= 0; i--) {
    const dt = new Date(); dt.setDate(dt.getDate() - i);
    const k = dateKey(dt);
    const due = plansForDate(k).length;
    trend30.push({ key: k, rate: due ? Math.round((completedCount(k) / due) * 100) : null });
  }
  const goals = (data.goals || []).map((g) => {
    const total = (g.milestones || []).length;
    const done = (g.milestones || []).filter((m) => m.done).length;
    return { ...g, total, done, percent: total ? Math.round((done / total) * 100) : 0 };
  });
  const monthKey = today.slice(0, 7);

  /* 契约项目：补结算 → 进度 / 今日 / 累计应扣；昨日结算横幅；35 天热度图 */
  if (settleContractProjects()) saveNow();
  const contractProjects = (data.contractProjects || []).map((c) => {
    const end = contractEndDate(c);
    const dayIndex = Math.max(0, Math.min(Math.floor((new Date(today) - new Date(c.start)) / 86400000) + 1, Number(c.days) || 30));
    let sched = 0, doneN = 0;
    const dd = new Date((c.start || today) + 'T00:00:00');
    for (let i = 0; i < 400; i++) {
      const k = dateKey(dd);
      if (k > today || k > end) break;
      const tasks = contractTasksForDate(c, k);
      sched += tasks.length;
      doneN += tasks.filter((p) => logOf(k)[p.id]?.status === 'done').length;
      dd.setDate(dd.getDate() + 1);
    }
    const tTasks = contractTasksForDate(c, today);
    // 每个项目自己的热度图：近 35 天，只统计本项目
    const heat = (() => {
      const days = [];
      for (let i = 34; i >= 0; i--) {
        const dt = new Date(); dt.setDate(dt.getDate() - i);
        const k = dateKey(dt);
        const tasks = k >= c.start && k <= end ? contractTasksForDate(c, k) : [];
        const due = tasks.length;
        const done = tasks.filter((p) => logOf(k)[p.id]?.status === 'done').length;
        days.push({ key: k, due, done, owe: c.settlements?.[k]?.owe || 0, pct: due ? Math.round((done / due) * 100) : null, isToday: k === today, future: k > today });
      }
      return { days, totalOwe: contractOweTotal(c) };
    })();
    return {
      ...c, dayIndex, endDate: end, expired: today > end,
      progressPct: sched ? Math.round((doneN / sched) * 100) : 0,
      todayCount: tTasks.length,
      todayDone: tTasks.filter((p) => logOf(today)[p.id]?.status === 'done').length,
      oweTotal: contractOweTotal(c), oweUnpaid: contractOweTotal(c, true),
      heat,
    };
  });
  const contractYesterday = (() => {
    const yd = new Date(); yd.setDate(yd.getDate() - 1);
    const y = dateKey(yd);
    const items = [];
    for (const c of data.contractProjects || []) {
      const s = c.settlements?.[y];
      if (s && s.due > 0) items.push({ id: c.id, title: c.title, pct: s.pct, owe: s.owe, due: s.due, done: s.done, paid: !!c.paid?.[y] });
    }
    return { date: y, items, total: items.reduce((a, b) => a + (b.owe || 0), 0) };
  })();

  return {
    settings: data.settings,
    profile: { ...profile, streak, level: lv.level, levelCur: Math.max(lv.cur, 0), levelNeed: lv.need },
    plans: data.plans,
    todayPlans,
    activeNow: hasActivePlanNow(),
    todayPoints: todayPoints(today),
    todayBonus: !!data.bonus[today],
    week, badges,
    autoStartReal: false,
    dataFile: '(手机本地存储)',
    mits,
    todayPomodoro: data.pomodoro[today] || 0,
    todayFocus: data.focus[today] || 0,
    room: { inRoom: false, code: '', role: '', members: [], funAllowUntil: data.guardian.allowUntil || 0, messages: [] },
    peers: [],
    shop: { items: data.shop.items || [], history: data.shop.history || [] },
    guard: guardian.publicInfo(),
    penalty: (() => {
      const on = !!data.guardian.enabled;
      const p = data.profile.points || 0;
      if (!on || p >= 0) return { key: 'ok', label: '正常', mult: 1, canRedeem: 'all', cheapMax: 100, points: p };
      if (p >= -10) return { key: 'light', label: '轻度欠分', mult: 2, canRedeem: 'cheap', cheapMax: 100, points: p };
      if (p >= -30) return { key: 'mid', label: '中度欠分', mult: 2, canRedeem: 'rescue', cheapMax: 100, points: p };
      return { key: 'heavy', label: '重度欠分', mult: 2, canRedeem: 'none', cheapMax: 100, points: p };
    })(),
    rescue: data.rescue || null,
    micro: microState(),
    credit: creditState(),
    discipline: disciplineState(),
    witness: data.witness || {},
    force: forceStats(),
    grayRedeem: { used: { ...todayGrayRedeem() }, limit: GRAY_REDEEM_DAILY_LIMIT, costPer10: GRAY_REDEEM_COST_PER10 },
    month, trend30, goals,
    contractProjects, contractYesterday,
    contracts: (data.contracts || []).map((c) => {
      const days = c.days || 30;
      const startD = new Date(c.start);
      const dayIndex = Math.floor((new Date(today) - startD) / 86400000) + 1;
      const checked = Object.keys(c.checkins || {}).length;
      const missed = [];
      for (let i = 0; i < Math.min(dayIndex, days); i++) {
        const k = dateKey(new Date(startD.getTime() + i * 86400000));
        if (!c.checkins?.[k] && k <= today) missed.push(k);
      }
      return { ...c, dayIndex, checked, missed, pendingRedpacket: missed.filter((k) => !c.paid?.[k]).length };
    }),
    diaryToday: data.diary[today] || null,
    reviews: data.reviews || {},
    makeupUsed: (data.makeups[monthKey] || []).length,
    makeupRecords: data.makeups[monthKey] || [],
    focusMode: false,
    eyeCare: { enabled: !!data.settings.eyeCare, phase: 'idle', endsAt: 0, plan: eyePlanMin(), intervalMin: eyePlanMin(), restMin: EYE_PLANS[eyePlanMin()] },
  };
}

/* ---------------- 打卡（含需密码确认 / 待验证 / 负分规则） ---------------- */
function doCheckin(planId, key = dateKey(), password) {
  data.log[key] = data.log[key] || {};
  const plan = data.plans.find((p) => p.id === planId);
  if (!plan || plan.temp) return { ok: false, message: '计划不存在' };
  const st = data.log[key][planId];
  if (st && (st.status === 'done' || st.status === 'awaiting')) return { ok: false, message: '今天已经打过卡了' };

  if (plan.needConfirm && guardian.hasPassword() && !guardian.verify(password)) {
    if (!data.log[key][planId]) {
      data.log[key][planId] = { status: 'awaiting', at: Date.now() };
      delete data.snooze[planId];
      data.fired[key] = data.fired[key] || {};
      data.fired[key][planId] = true;
      saveNow();
    }
    return { ok: true, pending: true, needPassword: true, message: '已打卡，等待密码验证' };
  }

  const streakBefore = computeStreak();
  const bonus = Math.min(streakBefore, 10) * 2;
  const base = Number(plan.points) || 20;
  // 限时挑战：周末双倍（与桌面端一致，只加不扣）
  const dow = new Date(key + 'T00:00:00').getDay();
  const weekendBonus = dow === 0 || dow === 6 ? base + bonus : 0;
  let gained = base + bonus + weekendBonus;
  const loanRate = data.credit && data.credit.loan && !data.credit.loan.repaidAt ? Number(data.credit.rate) || 0 : 0;
  if (loanRate > 0) gained = Math.max(1, Math.round(gained * (1 - loanRate)));

  data.log[key][planId] = { status: 'done', at: Date.now(), points: gained, bonus, weekendBonus };
  setProfilePoints((data.profile.points || 0) + gained);
  data.profile.totalDone = (data.profile.totalDone || 0) + 1;
  delete data.snooze[planId];
  data.fired[key] = data.fired[key] || {};
  data.fired[key][planId] = true;

  let perfectBonus = 0;
  const due = plansForDate(key);
  const allDone = due.length > 0 && due.every((p) => data.log[key][p.id]?.status === 'done');
  if (allDone && !data.bonus[key]) {
    perfectBonus = 30;
    data.bonus[key] = true;
    setProfilePoints((data.profile.points || 0) + perfectBonus);
    data.profile.perfectDays = (data.profile.perfectDays || 0) + 1;
    creditEvent('growth_ok', `全勤达标：${key} 完成全部 ${due.length} 个计划`);
    creditOnPerfectDay();
  }
  creditOnEarn(gained + perfectBonus);
  let micro = null;
  if ((data.profile.points || 0) < 0) micro = microComplete('one', key);
  const streakAfter = computeStreak();
  if (streakAfter > (data.profile.bestStreak || 0)) data.profile.bestStreak = streakAfter;
  saveNow();
  const levelUp = levelOf(data.profile.points).level > levelOf(data.profile.points - gained - perfectBonus).level;
  return { ok: true, gained, base, bonus, perfectBonus, streak: streakAfter, streakUp: streakAfter > streakBefore, points: data.profile.points, levelUp, planTitle: plan.title, weekendBonus, loanRate, micro };
}

function undoCheckin(planId, key = dateKey()) {
  data.log[key] = data.log[key] || {};
  const rec = data.log[key][planId];
  if (!rec) return { ok: false };
  if (rec.status === 'awaiting') { delete data.log[key][planId]; saveNow(); return { ok: true }; }
  if (rec.status !== 'done') return { ok: false };
  // 惩罚/退回类扣分允许扣成负分（负分触发名单升级），不设 0 下限
  setProfilePoints((data.profile.points || 0) - (rec.points || 0));
  data.profile.totalDone = Math.max(0, (data.profile.totalDone || 0) - 1);
  if (data.bonus[key]) {
    setProfilePoints(data.profile.points - 30);
    data.profile.perfectDays = Math.max(0, (data.profile.perfectDays || 0) - 1);
    delete data.bonus[key];
  }
  delete data.log[key][planId];
  saveNow();
  return { ok: true };
}

/* ---------------- 计划增删改（与桌面版同价：编辑扣 10） ---------------- */
function savePlan(plan) {
  const isEdit = !!(plan && plan.id && data.plans.some((p) => p.id === plan.id && !/^demo-/.test(p.id)));
  const rejected = [];
  const title = String(plan?.title || '').trim().slice(0, 30);
  if (!title) return { ok: false, message: '请填写计划名称' };
  const time = /^\d{1,2}:\d{2}$/.test(String(plan?.time || '')) ? plan.time : '08:00';
  if (guardian.hasPassword() && !guardian.verify(plan?.password)) return { ok: false, needPassword: true };
  const days = Array.isArray(plan?.days) ? plan.days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6) : [];
  if (!days.length) return { ok: false, message: '至少选择一个星期' };
  const allowProcs = Array.isArray(plan?.allowProcs) ? plan.allowProcs.map((s) => String(s).trim().toLowerCase().replace(/\.exe$/, '')).filter(Boolean).slice(0, 12) : [];
  for (const ap of allowProcs) {
    if (data.guardian.blacklist.some((b) => String(b).toLowerCase() === ap)) rejected.push(ap);
  }
  const clean = {
    id: isEdit ? plan.id : 'p-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    title, desc: String(plan?.desc || '').trim().slice(0, 80),
    icon: String(plan?.icon || '📌').slice(0, 4),
    color: ['mint', 'coral', 'sky', 'amber', 'indigo', 'pink'].includes(plan?.color) ? plan.color : 'mint',
    time, days,
    when: plan?.when === 'boot' ? 'boot' : 'time',
    points: Math.max(5, Math.min(200, Number(plan?.points) || 20)),
    allowProcs, needConfirm: !!plan?.needConfirm,
    durationMin: Math.max(0, Math.min(240, Number(plan?.durationMin) || 0)),
    enabled: plan?.enabled !== false,
    contract: plan?.contract && (data.contractProjects || []).some((c) => c.id === plan.contract) ? plan.contract : null,
    createdAt: isEdit ? (data.plans.find((p) => p.id === plan.id)?.createdAt || new Date().toISOString()) : new Date().toISOString(),
  };
  /* 积分只跟「计划里新放行非白名单普通软件」挂钩：
     改标题/时间/星期、只放行白名单软件 —— 都不扣分 */
  const prevPlan = isEdit ? data.plans.find((p) => p.id === clean.id) : null;
  const prevSet = new Set(((prevPlan && prevPlan.allowProcs) || []).map((x) => String(x).toLowerCase()));
  const normalAdded = allowProcs.filter((n) => {
    if (prevSet.has(n)) return false;
    return !(data.guardian.whitelist || []).some((w) => String(w).toLowerCase().replace(/\.exe$/, '') === n);
  });
  const idx = data.plans.findIndex((p) => p.id === clean.id);
  if (idx >= 0) data.plans[idx] = clean; else data.plans.push(clean);
  /* 契约任务创建/编辑一律不扣分 */
  const deducted = !clean.contract && normalAdded.length ? PLAN_PROC_PENALTY : 0;
  if (deducted) setProfilePoints((data.profile.points || 0) - deducted); // 可扣成负分
  saveNow();
  return { ok: true, id: clean.id, deducted, rejected, normalProcs: normalAdded };
}
function deletePlan(id, password) {
  if (guardian.hasPassword() && !guardian.verify(password)) return { ok: false, needPassword: true };
  const existed = data.plans.some((p) => p.id === id);
  const isTemp = data.plans.some((p) => p.id === id && p.temp);
  /* 契约任务到期前不可删除 */
  const cPlan = data.plans.find((p) => p.id === id);
  if (cPlan?.contract) {
    const c = (data.contractProjects || []).find((x) => x.id === cPlan.contract);
    if (c && !contractExpired(c)) return { ok: false, message: `契约任务在项目到期（${contractEndDate(c)}）前不可删除` };
  }
  data.plans = data.plans.filter((p) => p.id !== id);
  delete data.snooze[id];
  // 删除计划不扣分（积分只跟「计划放行非白名单普通软件」挂钩）
  const deducted = 0;
  saveNow();
  return { ok: true, deducted };
}
function togglePlan(id, enabled) {
  const p = data.plans.find((x) => x.id === id);
  if (p) p.enabled = !!enabled;
  // 暂停 / 重新启用都不扣分
  saveNow();
  return { ok: true, deducted: 0 };
}

/* ---------------- 积分商城（普通≥10 / 娱乐券≥50 / 设置需密码） ---------------- */
function ensureShopDefaults() {
  if (data.shop.items.length === 0 && (data.shop.history || []).length === 0 && !data.shop.seeded) {
    data.shop.items = [
      { id: 'r-game', name: '游戏时间 30 分钟', icon: '🎮', cost: 60, type: 'ticket', minutes: 30 },
      { id: 'r-video', name: '看剧时间 30 分钟', icon: '📺', cost: 50, type: 'ticket', minutes: 30 },
      { id: 'r-snack', name: '一份零食', icon: '🍫', cost: 40, type: 'plain' },
      { id: 'r-rest', name: '睡个懒觉', icon: '😴', cost: 80, type: 'plain' },
    ];
    data.shop.seeded = true;
    saveNow();
  }
}
function shopAddItem(item) {
  if (guardian.hasPassword() && !guardian.verify(item?.password)) return { ok: false, needPassword: true };
  const type = item?.type === 'ticket' && Number(item?.minutes) > 0 ? 'ticket' : 'plain';
  const minCost = type === 'ticket' ? SHOP_TICKET_MIN : SHOP_PLAIN_MIN;
  const clean = {
    id: 'r-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name: String(item?.name || '').trim().slice(0, 24) || '自定义奖励',
    icon: ['🎮', '📺', '🍫', '😴', '☕', '🎁', '🏀', '🎵'].includes(item?.icon) ? item.icon : '🎁',
    cost: Math.max(minCost, Math.min(5000, Number(item?.cost) || minCost)),
    type,
    minutes: Math.max(1, Math.min(600, Number(item?.minutes) || 30)),
    custom: true,
  };
  data.shop.items.push(clean);
  saveNow();
  return { ok: true, item: clean };
}
function shopDeleteItem(payload) {
  const id = typeof payload === 'string' ? payload : payload?.id;
  if (guardian.hasPassword() && !guardian.verify(typeof payload === 'object' && payload ? payload.password : undefined)) return { ok: false, needPassword: true };
  data.shop.items = data.shop.items.filter((x) => x.id !== id);
  saveNow();
  return { ok: true };
}
function shopRescueStart() {
  const on = !!data.guardian.enabled;
  const p = data.profile.points || 0;
  if (!on || p >= -10) return { ok: false, message: '还没到需要救赎券的程度' };
  if (p < -30) return { ok: false, message: '这一档已锁定兑换，先打卡回升' };
  if (data.rescue && !data.rescue.usedAt) return { ok: false, message: '救赎挑战已经领过了' };
  data.rescue = { startedAt: new Date().toISOString(), need: 5, done: 0, unlocked: false, usedAt: null };
  saveNow();
  return { ok: true, rescue: data.rescue };
}

function witnessSet(payload) {
  const projectId = payload && payload.projectId;
  const name = String((payload && payload.name) || '').trim().slice(0, 20);
  const proj = (data.contractProjects || []).find((c) => c.id === projectId);
  if (!proj) return { ok: false, message: '项目不存在' };
  data.witness = data.witness || {};
  if (!name) delete data.witness[projectId];
  else data.witness[projectId] = { name, at: new Date().toISOString() };
  saveNow();
  return { ok: true, witness: data.witness[projectId] || null };
}

function shopRedeem(id) {
  const item = data.shop.items.find((x) => x.id === id);
  if (!item) return { ok: false, message: '商品不存在' };
  const points = data.profile.points || 0;
  // 负分分级（仅强制模式生效）
  const on = !!data.guardian.enabled;
  let cost = item.cost;
  let usedRescue = false;
  if (on && points < 0) {
    if (points < -30) return { ok: false, message: `当前欠分 ${points}，兑换已锁定。先打卡把积分拉回 -30 以上。` };
    if (points < -10) {
      const r = data.rescue;
      if (!r || !r.unlocked || r.usedAt) return { ok: false, message: '中度欠分时只能先领「救赎券」：完成微目标后解锁一次兑换。' };
      usedRescue = true;
    } else if (Number(item.cost) > 100) {
      return { ok: false, message: '轻度欠分期间只能兑换 100 分以内的低价奖励。' };
    }
    cost = Math.round(Number(item.cost) * 2);
  }
  if (points < cost) return { ok: false, message: `积分不足（还差 ${cost - points} 分${cost !== item.cost ? '，欠分期间价格双倍' : ''}）` };
  setProfilePoints(points - cost);
  if (usedRescue) data.rescue = null;
  data.shop.history = [{ at: new Date().toISOString(), name: item.name, icon: item.icon, cost }, ...(data.shop.history || [])].slice(0, 100);
  let ticketUntil = 0;
  if (item.type === 'ticket') {
    ticketUntil = Math.max(Date.now(), data.guardian.allowUntil || 0) + item.minutes * 60000;
    data.guardian.allowUntil = ticketUntil;
    if (window.NativeGuard) window.NativeGuard.grantTicket(item.minutes);
  }
  saveNow();
  return {
    ok: true, points: data.profile.points, ticketUntil,
    message: item.type === 'ticket'
      ? `${item.icon} ${item.name} 已兑换，${item.minutes} 分钟内灰名单应用放行`
      : `${item.icon} ${item.name} 已兑换，记得兑现给自己`,
  };
}

/* ---------------- 守护（名单 / 强制模式 / 灰名单兑换） ---------------- */
const normProc = (s) => String(s || '').trim().toLowerCase().replace(/\.exe$/, '');
async function guardSetup({ user, password }) {
  if (guardian.hasPassword()) return { ok: false, message: '密码已设置' };
  if (!password || String(password).length < 4) return { ok: false, message: '密码至少 4 位' };
  const salt = Math.random().toString(36).slice(2, 10);
  data.guardian.user = String(user || '').slice(0, 20);
  data.guardian.salt = salt;
  data.guardian.hash = syncHash(salt, password);
  saveNow();
  return { ok: true };
}
function guardSetLists({ lists, password }) {
  if (guardian.hasPassword() && !guardian.verify(password)) return { ok: false, needPassword: true };
  const L = lists || {};
  const clean = (a) => Array.isArray(a) ? a.map((x) => normProc(x)).filter(Boolean).slice(0, 200) : [];
  data.guardian.whitelist = clean(L.whitelist);
  data.guardian.graylist = clean(L.graylist);
  data.guardian.blacklist = clean(L.blacklist);
  saveNow();
  if (window.NativeGuard) window.NativeGuard.setLists({ whitelist: data.guardian.whitelist, graylist: data.guardian.graylist, blacklist: data.guardian.blacklist });
  return { ok: true, lists: guardian.publicInfo() };
}
async function guardToggle({ enabled, password }) {
  if (guardian.hasPassword() && !guardian.verify(password)) return { ok: false, needPassword: true };
  data.guardian.enabled = !!enabled;
  saveNow();
  let native = { ok: true };
  if (window.NativeGuard) native = await window.NativeGuard.setEnabled(!!enabled);
  return { ok: true, enabled: !!enabled, elevating: false, native };
}
async function guardProcesses() {
  if (window.NativeGuard) {
    try { return await window.NativeGuard.listWindowApps(); } catch (e) { /* fallthrough */ }
  }
  return [];
}
function guardRedeemGray(payload) {
  const name = normProc(payload?.name);
  const wantMin = Math.round(Number(payload?.minutes) || 0);
  if (!guardian.isEscalated()) return { ok: false, message: '只有积分为负（名单升级）时才能兑换灰名单时长' };
  if (!name || !data.guardian.graylist.some((x) => normProc(x) === name)) return { ok: false, message: '该软件不在灰名单里' };
  if (wantMin < 5) return { ok: false, message: '至少兑换 5 分钟' };
  const left = grayRedeemLeft(name);
  if (left <= 0) return { ok: false, message: `「${name}」今天已兑换满 ${GRAY_REDEEM_DAILY_LIMIT} 分钟，明天再来` };
  const minutes = Math.min(wantMin, left);
  const cost = Math.ceil(minutes / 10) * GRAY_REDEEM_COST_PER10;
  setProfilePoints((data.profile.points || 0) - cost); // 负分时允许扣得更深
  todayGrayRedeem()[name] = (todayGrayRedeem()[name] || 0) + minutes;
  const now = new Date();
  const hh = pad(now.getHours()), mm = pad(now.getMinutes());
  data.plans.push({
    id: 'tmp-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    temp: true, title: `⏳ ${name}（兑换 ${minutes} 分钟）`,
    desc: `灰名单兑换：${hh}:${mm} 起 ${minutes} 分钟内放行，明天自动删除`,
    icon: '⏳', color: 'coral', time: `${hh}:${mm}`, days: [now.getDay()],
    points: 0, allowProcs: [name], durationMin: minutes, enabled: true,
    createdAt: now.toISOString(), expireKey: dateKey(now),
  });
  saveNow();
  return { ok: true, minutes, cost, left: grayRedeemLeft(name), points: data.profile.points, message: `⏳ 已为「${name}」兑换 ${minutes} 分钟（扣 ${cost} 积分），该软件今天还剩 ${grayRedeemLeft(name)} 分钟可兑换` };
}

/* ---------------- 三件事 / 番茄钟 / 目标 / 契约 / 小结复盘补卡 ---------------- */
function mitAdd(text) {
  const today = dateKey();
  const list = data.mits[today] || [];
  if (list.length >= 3) return { ok: false, message: '今天的三件事已满，先完成一件吧' };
  list.push({ id: 'm-' + Date.now().toString(36), text: String(text || '').trim().slice(0, 40), done: false });
  data.mits[today] = list;
  saveNow();
  return { ok: true };
}
function mitToggle(id) {
  const today = dateKey();
  const item = (data.mits[today] || []).find((m) => m.id === id);
  if (!item) return { ok: false };
  item.done = !item.done;
  if (item.done) { setProfilePoints((data.profile.points || 0) + 10); item.points = 10; }
  else { setProfilePoints((data.profile.points || 0) - (item.points || 0)); item.points = 0; } // 可扣成负分
  saveNow();
  return { ok: true };
}
function mitDelete(id) {
  const today = dateKey();
  data.mits[today] = (data.mits[today] || []).filter((m) => m.id !== id);
  saveNow();
  return { ok: true };
}
function focusComplete({ minutes, kind }) {
  const today = dateKey();
  const m = Math.max(1, Math.min(180, Math.round(Number(minutes) || 0)));
  if (kind === 'break') return { ok: true, gained: 0, message: '休息完成，回来继续！' };
  const gained = Math.round(m * 0.8);
  setProfilePoints((data.profile.points || 0) + gained);
  data.profile.focusMinutes = (data.profile.focusMinutes || 0) + m;
  data.profile.pomodoros = (data.profile.pomodoros || 0) + 1;
  data.pomodoro[today] = (data.pomodoro[today] || 0) + 1;
  data.focus[today] = (data.focus[today] || 0) + m;
  const prevBest = Math.max(0, ...Object.entries(data.focus || {}).filter(([k]) => k !== today).map(([, v]) => Number(v) || 0));
  const beforeToday = (Number(data.focus[today]) || 0) - m;
  if (prevBest > 0 && beforeToday <= prevBest && data.focus[today] > prevBest && !(data.focusRecord && data.focusRecord.noted && data.focusRecord.noted[today])) {
    data.focusRecord = data.focusRecord || { noted: {} };
    data.focusRecord.noted[today] = true;
    creditEvent('record_ok', `单次专注 ${m} 分钟，刷新个人纪录`);
  }
  saveNow();
  return { ok: true, gained, pomodoros: data.pomodoro[today], minutes: m };
}
function goalAdd(g) {
  data.goals.push({
    id: 'g-' + Date.now().toString(36),
    title: String(g?.title || '').trim().slice(0, 30) || '未命名目标',
    icon: ['🎯', '📚', '💪', '🌱', '🎨', '💰'].includes(g?.icon) ? g.icon : '🎯',
    unit: String(g?.unit || '次').slice(0, 6),
    total: Math.max(1, Math.min(999, Number(g?.total) || 10)),
    deadline: String(g?.deadline || '').slice(0, 10),
    milestones: [],
  });
  saveNow();
  return { ok: true };
}
function goalDelete(id) { data.goals = data.goals.filter((g) => g.id !== id); saveNow(); return { ok: true }; }
function goalAddMilestone({ goalId, title }) {
  const g = data.goals.find((x) => x.id === goalId);
  if (!g) return { ok: false };
  g.milestones = g.milestones || [];
  if (g.milestones.length >= 20) return { ok: false, message: '里程碑最多 20 个' };
  g.milestones.push({ id: 'ms-' + Date.now().toString(36), title: String(title || '').trim().slice(0, 30), done: false });
  saveNow();
  return { ok: true };
}
function goalDeleteMilestone({ goalId, msId }) {
  const g = data.goals.find((x) => x.id === goalId);
  if (g) g.milestones = (g.milestones || []).filter((m) => m.id !== msId);
  saveNow();
  return { ok: true };
}
function goalToggleMilestone({ goalId, msId }) {
  const g = data.goals.find((x) => x.id === goalId);
  const m = g && (g.milestones || []).find((x) => x.id === msId);
  if (m) m.done = !m.done;
  saveNow();
  return { ok: true };
}
function contractAdd(c) {
  data.contracts.push({
    id: 'c-' + Date.now().toString(36),
    title: String(c?.title || '').trim().slice(0, 30) || '未命名契约',
    stake: Math.max(0, Math.min(9999, Number(c?.stake) || 0)),
    friends: Array.isArray(c?.friends) ? c.friends.map((s) => String(s).slice(0, 12)).slice(0, 5) : [],
    start: c?.start || dateKey(),
    days: Math.max(1, Math.min(365, Number(c?.days) || 30)),
    checkins: {}, paid: {},
  });
  saveNow();
  return { ok: true };
}
function contractCheckin(id) {
  const c = data.contracts.find((x) => x.id === id);
  if (!c) return { ok: false };
  c.checkins = c.checkins || {};
  c.checkins[dateKey()] = true;
  saveNow();
  return { ok: true };
}
function contractPay({ id, date }) {
  const c = data.contracts.find((x) => x.id === id);
  if (!c) return { ok: false };
  c.paid = c.paid || {};
  c.paid[date] = true;
  saveNow();
  return { ok: true };
}
function contractDelete(id) { data.contracts = data.contracts.filter((c) => c.id !== id); saveNow(); return { ok: true }; }
function diarySave({ mood, text }) {
  data.diary[dateKey()] = { mood: Math.max(1, Math.min(5, Number(mood) || 3)), text: String(text || '').slice(0, 500) };
  saveNow();
  return { ok: true };
}
function reviewSetItems({ week, items }) {
  const wk = week || (() => { const d = new Date(); const onejan = new Date(d.getFullYear(), 0, 1); return `${d.getFullYear()}-W${String(Math.ceil((((d - onejan) / 86400000) + onejan.getDay() + 1) / 7)).padStart(2, '0')}`; })();
  data.reviews[wk] = { rate: data.reviews[wk]?.rate || 3, items: (items || []).slice(0, 10).map((t) => ({ id: 'r' + Math.random().toString(36).slice(2, 8), text: String(t).slice(0, 60), done: false })) };
  saveNow();
  return { ok: true };
}
function makeupAdd({ date, planId, reason }) {
  const monthKey = String(date || dateKey()).slice(0, 7);
  data.makeups[monthKey] = data.makeups[monthKey] || [];
  if (data.makeups[monthKey].length >= 3) return { ok: false, message: '这个月已补卡 3 次' };
  data.makeups[monthKey].push({ date, planId, reason: String(reason || '').slice(0, 60) });
  const plan = data.plans.find((p) => p.id === planId);
  const gained = Math.round((Number(plan?.points) || 20) / 2);
  data.log[date] = data.log[date] || {};
  data.log[date][planId] = { status: 'done', at: Date.now(), points: gained, madeUp: true };
  setProfilePoints((data.profile.points || 0) + gained);
  saveNow();
  return { ok: true, gained };
}

/* ---------------- 契约项目（新）：项目 + 子任务 + 每日结算 ---------------- */
function contractEndDate(c) {
  const d = new Date((c.start || dateKey()) + 'T00:00:00');
  d.setDate(d.getDate() + Math.max(1, Number(c.days) || 30) - 1);
  return dateKey(d);
}
function contractExpired(c) { return dateKey() > contractEndDate(c); }
function contractTasksForDate(c, key) {
  const dow = new Date(key + 'T00:00:00').getDay();
  return data.plans.filter((p) => p.contract === c.id && !p.temp && p.enabled !== false && (p.days || []).includes(dow));
}
function contractSettleDay(c, key) {
  if (!c.settlements) c.settlements = {};
  if (c.settlements[key]) return false;
  const tasks = contractTasksForDate(c, key);
  const done = tasks.filter((p) => logOf(key)[p.id]?.status === 'done').length;
  const pct = tasks.length ? Math.round((done / tasks.length) * 100) : null;
  const owe = tasks.length && pct < 100 ? Math.max(1, Math.round(((Number(c.stake) || 0) * (100 - pct)) / 100)) : 0;
  c.settlements[key] = { pct, owe, due: tasks.length, done };
  return true;
}
function settleContractProjects() {
  let changed = false;
  const today = dateKey();
  for (const c of data.contractProjects || []) {
    const end = contractEndDate(c);
    const d = new Date((c.start || today) + 'T00:00:00');
    for (let i = 0; i < 400; i++) {
      const k = dateKey(d);
      if (k >= today || k > end) break;
      if (contractSettleDay(c, k)) changed = true;
      d.setDate(d.getDate() + 1);
    }
  }
  return changed;
}
function contractOweTotal(c, onlyUnpaid = false) {
  let sum = 0;
  for (const [k, s] of Object.entries(c.settlements || {})) {
    if (!s || !s.owe) continue;
    if (onlyUnpaid && c.paid?.[k]) continue;
    sum += s.owe;
  }
  return sum;
}
function contractProjectAdd(p) {
  const title = String(p?.title || '').trim().slice(0, 40);
  if (!title) return { ok: false, message: '请填写项目名称' };
  data.contractProjects.push({
    id: 'cp-' + Date.now().toString(36),
    title,
    stake: Math.max(1, Math.min(9999, Number(p?.stake) || 10)),
    days: Math.max(1, Math.min(365, Number(p?.days) || 30)),
    start: dateKey(),
    createdAt: new Date().toISOString(),
    settlements: {}, paid: {},
  });
  saveNow();
  return { ok: true };
}
function contractProjectDelete(id) {
  const c = (data.contractProjects || []).find((x) => x.id === id);
  if (!c) return { ok: false, message: '项目不存在' };
  if (!contractExpired(c)) return { ok: false, message: `契约未到期（${contractEndDate(c)} 到期），不可删除` };
  const taskIds = new Set(data.plans.filter((p) => p.contract === id).map((p) => p.id));
  data.plans = data.plans.filter((p) => p.contract !== id);
  data.contractProjects = data.contractProjects.filter((x) => x.id !== id);
  for (const day of Object.values(data.log)) for (const pid of Object.keys(day)) if (taskIds.has(pid)) delete day[pid];
  saveNow();
  return { ok: true };
}
function contractProjectPay({ id, date }) {
  const c = (data.contractProjects || []).find((x) => x.id === id);
  if (c) { c.paid = c.paid || {}; c.paid[date] = true; saveNow(); }
  return { ok: true };
}

/* ---------------- 提醒循环（本地通知 + 应用内提示） ---------------- */
const emitter = { state: [], toast: [] };
function emitState() { const s = snapshot(); emitter.state.forEach((cb) => { try { cb(s); } catch (e) {} }); }
function onState(cb) { emitter.state.push(cb); return () => { emitter.state = emitter.state.filter((x) => x !== cb); }; }
function onToast(cb) { emitter.toast.push(cb); return () => { emitter.toast = emitter.toast.filter((x) => x !== cb); }; }
function toast(msg, sub, isErr) { emitter.toast.forEach((cb) => { try { cb({ msg, sub, isErr }); } catch (e) {} }); }

function reminderTick() {
  const key = dateKey();
  const now = nowMinutes();
  for (const p of plansForDate(key)) {
    if (now < planStartMin(p) || now > planStartMin(p) + 45) continue;
    const st = logOf(key)[p.id];
    if (st && (st.status === 'done' || st.status === 'awaiting')) continue;
    data.fired[key] = data.fired[key] || {};
    if (data.fired[key][p.id] && !data.settings.repeatRemind) continue;
    const snoozedUntil = data.snooze[p.id] || 0;
    const lastK = p.id + '@' + key;
    if (Date.now() < snoozedUntil) continue;
    if (data.fired[key][p.id] && Date.now() - (data.lastRemind[lastK] || 0) < 2 * 60 * 60 * 1000) continue;
    data.lastRemind[lastK] = Date.now();
    data.fired[key][p.id] = true;
    const msg = `⏰ 该做「${p.title}」了`;
    toast(msg, `计划时间 ${p.time}，完成后 +${p.points} 积分`);
    if (window.NativeGuard && window.NativeGuard.notify) window.NativeGuard.notify({ title: msg, body: `计划时间 ${p.time}，完成后 +${p.points} 积分`, planId: p.id });
    saveNow();
  }
}

/* ---------------- 护眼模式（开关/跳过/节奏需密码；本体由原生悬浮窗实现） ---------------- */
/* 节奏三档：工作 N 分钟 → 休息 M 分钟；旧数据没有 eyeCarePlan 就走 45/15 */
function eyePlanMin() {
  const m = Number(data.settings.eyeCarePlan);
  return EYE_PLANS[m] ? m : 45;
}
function eyeRestMs() { return EYE_PLANS[eyePlanMin()] * 60000; }
function eyeIntervalMs() { return eyePlanMin() * 60000; }

async function eyeCareToggle({ password }) {
  if (guardian.hasPassword() && !guardian.verify(password)) return { ok: false, needPassword: true };
  data.settings.eyeCare = !data.settings.eyeCare;
  saveNow();
  let native = { ok: true };
  if (window.NativeGuard) native = await window.NativeGuard.setEyeCare(data.settings.eyeCare, {
    exerciseMs: data.settings.eyeExerciseMs, restMs: eyeRestMs(), intervalMs: eyeIntervalMs(),
  });
  return { ok: true, enabled: data.settings.eyeCare, native };
}
async function eyeCareSetPlan({ plan, password }) {
  if (guardian.hasPassword() && !guardian.verify(password)) return { ok: false, needPassword: true };
  const m = Number(plan);
  if (!EYE_PLANS[m]) return { ok: false, message: '不支持的护眼节奏' };
  data.settings.eyeCarePlan = m;
  data.settings.eyeRestMs = EYE_PLANS[m] * 60000;
  data.settings.eyeIntervalMs = m * 60000;
  saveNow();
  let native = { ok: true };
  if (window.NativeGuard && data.settings.eyeCare) {
    native = await window.NativeGuard.setEyeCare(true, {
      exerciseMs: data.settings.eyeExerciseMs, restMs: eyeRestMs(), intervalMs: eyeIntervalMs(),
    });
  }
  return { ok: true, plan: m, restMin: EYE_PLANS[m], native };
}
async function eyeCareSkip({ password }) {
  if (guardian.hasPassword() && !guardian.verify(password)) return { ok: false, needPassword: true };
  if (window.NativeGuard) await window.NativeGuard.skipEyeCare();
  return { ok: true };
}

/* ---------------- 导出 ---------------- */
function exportCsv() {
  const rows = [['日期', '计划', '状态', '积分', '时间']];
  for (const [k, day] of Object.entries(data.log)) {
    for (const [pid, rec] of Object.entries(day)) {
      const p = data.plans.find((x) => x.id === pid);
      rows.push([k, p ? p.title : pid, rec.status, rec.points || 0, rec.at ? new Date(rec.at).toLocaleString() : '']);
    }
  }
  return { ok: true, csv: rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n') };
}
function exportData() {
  return { ok: true, json: JSON.stringify(data, null, 2) };
}

/* ---------------- 同步码（跨设备迁移，纯本地，不经服务器） ---------------- */
function encodeSyncCode() {
  const json = JSON.stringify(data);
  const bytes = new TextEncoder().encode(json);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return 'PQ1.' + btoa(bin).replace(/=+$/, '');
}
function decodeSyncCode(text) {
  let s = String(text || '').trim().replace(/\s+/g, '');
  if (!s.startsWith('PQ1.')) throw new Error('不是有效的同步码（应以 PQ1. 开头）');
  let b64 = s.slice(4).replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  const parsed = JSON.parse(new TextDecoder().decode(bytes));
  if (!parsed || !Array.isArray(parsed.plans)) throw new Error('同步码内容无法识别');
  return parsed;
}
const pickBigger = (a, b) => (Math.abs(Number(b) || 0) > Math.abs(Number(a) || 0) ? Number(b) || 0 : Number(a) || 0);
function mergeLists(a, b) {
  const seen = new Set((a || []).map((x) => String(x).toLowerCase()));
  const out = [...(a || [])];
  for (const x of b || []) {
    const k = String(x).toLowerCase();
    if (!seen.has(k)) { seen.add(k); out.push(x); }
  }
  return out;
}
/* 计划文件（.pqplan）导入核心：同合并逻辑供文件导入与同步码共用；scope=all/normal/contract */
function filterDataByScope(src, scope) {
  if (!scope || scope === 'all') return src;
  const out = JSON.parse(JSON.stringify(src));
  if (scope === 'meta') {
    // 仅军团元数据：不带任何计划、打卡记录与档案，只留空心结构给信封用
    out.plans = [];
    out.contractProjects = [];
    out.log = {};
    for (const k of ['fired', 'snooze', 'bonus', 'mits', 'diary', 'reviews', 'makeups', 'grayRedeem', 'guardian', 'shop', 'profile', 'goals', 'pomodoro', 'focus', 'lastRemind', 'reminderStrikes', 'settings']) delete out[k];
    return out;
  }
  // 先记下契约项目 id：下面 normal 分支会清空 contractProjects，闭包再读就判断不出来了
  const cIds = new Set((out.contractProjects || []).map((c) => c && c.id));
  const isContract = (p) => !!(p && p.contract && cIds.has(p.contract));
  if (scope === 'normal') {
    out.contractProjects = [];
    out.plans = (out.plans || []).filter((p) => !isContract(p));
  } else if (scope === 'contract') {
    out.plans = (out.plans || []).filter(isContract);
  }
  const keep = new Set((out.plans || []).map((p) => p.id));
  const log = {};
  for (const [k, day] of Object.entries(out.log || {})) {
    const nd = {};
    for (const [pid, rec] of Object.entries(day || {})) if (keep.has(pid)) nd[pid] = rec;
    if (Object.keys(nd).length) log[k] = nd;
  }
  out.log = log;
  if (scope !== 'all') {
    for (const k of ['fired', 'snooze', 'bonus', 'mits', 'diary', 'reviews', 'makeups', 'grayRedeem', 'guardian', 'shop', 'profile', 'goals', 'pomodoro', 'focus', 'lastRemind', 'reminderStrikes', 'settings']) delete out[k];
  }
  return out;
}
function importDataObj(obj, mode, scope) {
  const inc = normalize(filterDataByScope(obj, scope));
  const stats = { plans: 0, logs: 0, goals: 0, contracts: 0, shop: 0, mode: mode === 'replace' ? '覆盖' : '合并' };

  if (mode === 'replace' && (!scope || scope === 'all')) {
    data = inc;
    saveNow();
    emitState();
    return { ok: true, message: `已覆盖为本机数据：${data.plans.length} 个计划`, stats };
  }

  if (mode === 'replace') {
    /* 范围覆盖：只把本地这一类计划换成文件里的 */
    const isC = (p) => p && p.contract;
    const delIds = new Set(data.plans.filter((p) => (scope === 'contract' ? isC(p) : !isC(p))).map((p) => p.id));
    data.plans = data.plans.filter((p) => (scope === 'contract' ? !isC(p) : isC(p)));
    if (scope === 'contract') data.contractProjects = [];
    for (const day of Object.values(data.log || {})) for (const pid of Object.keys(day)) if (delIds.has(pid)) delete day[pid];
  }

  /* 合并模式 */
  // 计划 / 目标 / 契约：按 id 合并，同 id 保留本机版本
  const byId = (arr) => new Map((arr || []).filter((x) => x && x.id).map((x) => [x.id, x]));
  const mergeArr = (curKey, incArr) => {
    const cur = byId(data[curKey]);
    let n = 0;
    for (const item of incArr || []) {
      if (item && item.id && !cur.has(item.id)) { cur.set(item.id, item); n++; }
    }
    data[curKey] = [...cur.values()];
    return n;
  };
  stats.plans = mergeArr('plans', inc.plans);
  stats.goals = mergeArr('goals', inc.goals);
  stats.contracts = mergeArr('contracts', inc.contracts);
  stats.cprojects = mergeArr('contractProjects', inc.contractProjects);

  // 打卡日志：按 日期+计划 合并，时间戳新者胜
  for (const [k, day] of Object.entries(inc.log || {})) {
    data.log[k] = data.log[k] || {};
    for (const [pid, rec] of Object.entries(day || {})) {
      const cur = data.log[k][pid];
      if (!cur || (rec?.at || 0) > (cur?.at || 0)) { data.log[k][pid] = rec; stats.logs++; }
    }
  }
  // 布尔/简单值映射表：incoming 有就补上
  for (const k of ['fired', 'snooze', 'bonus', 'mits', 'diary', 'reviews', 'makeups', 'grayRedeem']) {
    for (const [k2, v] of Object.entries(inc[k] || {})) {
      if (data[k][k2] === undefined) data[k][k2] = v;
      else if (typeof v === 'object' && v && typeof data[k][k2] === 'object') Object.assign(data[k][k2], v);
    }
  }
  // 计数器：取绝对值更大的一方（负分机制下 |x| 更领先）
  for (const k of ['points', 'totalDone', 'bestStreak', 'perfectDays', 'focusMinutes', 'pomodoros'])
    data.profile[k] = pickBigger(data.profile[k], inc.profile[k]);
  // 守护名单：并集；密码本机已有则保留本机
  data.guardian.whitelist = mergeLists(data.guardian.whitelist, inc.guardian.whitelist);
  data.guardian.graylist = mergeLists(data.guardian.graylist, inc.guardian.graylist);
  data.guardian.blacklist = mergeLists(data.guardian.blacklist, inc.guardian.blacklist);
  data.guardian.enabled = data.guardian.enabled || inc.guardian.enabled;
  if (!data.guardian.hash && inc.guardian.hash) {
    data.guardian.user = inc.guardian.user; data.guardian.salt = inc.guardian.salt; data.guardian.hash = inc.guardian.hash;
  }
  // 商城：商品按 id 合并；history 按 JSON 去重
  const shopIds = new Set(data.shop.items.map((x) => x.id));
  for (const it of inc.shop.items || []) if (!shopIds.has(it.id)) { data.shop.items.push(it); stats.shop++; }
  const histKeys = new Set(data.shop.history.map((h) => JSON.stringify(h)));
  for (const h of inc.shop.history || []) { const k = JSON.stringify(h); if (!histKeys.has(k)) { data.shop.history.push(h); histKeys.add(k); } }

  saveNow();
  emitState();
  const scopeName = scope === 'normal' ? '普通计划' : scope === 'contract' ? '契约计划' : '全部内容';
  return {
    ok: true,
    message: `${mode === 'replace' ? '覆盖' : '合并'}导入完成（${scopeName}）：新增计划 ${stats.plans} · 合并打卡 ${stats.logs}`,
    stats,
  };
}

function importData(codeText, mode) {
  let incoming;
  try { incoming = decodeSyncCode(codeText); } catch (e) { return { ok: false, message: e.message }; }
  return importDataObj(incoming, mode);
}

/* ---------------- 计划文件（.pqplan 专用格式） ----------------
 * 信封：{ magic, format, app, version, exportedAt, from, checksum, data }
 * checksum = SHA-256(JSON.stringify(data))，缺 SubtleCrypto 时置 null（导入跳过校验）。 */

async function sha256Hex(text) {
  try {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch (_) {
    return null;
  }
}

async function planFileEnvelope(scope, legion) {
  const payload = filterDataByScope(data, scope);
  const env = {
    magic: 'PLANQUEST-PLAN',
    format: 1,
    app: 'PlanQuest',
    version: '2.7.0',
    exportedAt: new Date().toISOString(),
    from: 'PlanQuest 移动/网页版',
    checksum: await sha256Hex(JSON.stringify(payload)),
    data: payload,
  };
  if (legion && typeof legion === 'object') env.legion = legion;
  return env;
}

async function parsePlanFileText(text) {
  let env;
  try { env = JSON.parse(String(text || '')); } catch (_) { return { ok: false, message: '文件内容不是有效的 JSON' }; }
  if (!env || typeof env !== 'object') return { ok: false, message: '文件内容不是有效的 JSON' };
  if (env.magic !== 'PLANQUEST-PLAN') return { ok: false, message: '不是 PlanQuest 计划文件（应选 .pqplan 文件）' };
  if (Number(env.format) !== 1) return { ok: false, message: '格式版本不支持（format=' + env.format + '）' };
  if (!env.data || typeof env.data !== 'object' || !Array.isArray(env.data.plans)) return { ok: false, message: '文件缺少计划数据' };
  if (env.checksum) {
    const sum = await sha256Hex(JSON.stringify(env.data));
    if (sum && sum !== env.checksum) return { ok: false, message: '校验和不匹配：文件可能已损坏或被手动改动' };
  }
  return { ok: true, data: env.data, checksum: env.checksum || null, legion: env.legion || null };
}

/* ---------------- 微目标 / 借分（与桌面端同规则） ---------------- */
const MICRO_STEPS = [
  { key: 'open', text: '打开 PlanQuest（已经做到了）', gain: 5 },
  { key: 'one', text: '完成任意 1 个计划打卡', gain: 5 },
  { key: 'note', text: '写一句今天的小结，10 个字也够', gain: 5 },
];
function microState(key = dateKey()) {
  const rec = (data.micro && data.micro[key]) || {};
  const pts = Number(data.profile.points) || 0;
  return {
    active: pts < 0,
    points: pts,
    gain: 5,
    steps: MICRO_STEPS.map((s) => ({ key: s.key, text: s.text, gain: s.gain, done: !!rec[s.key] })),
    done: MICRO_STEPS.filter((s) => rec[s.key]).length,
    total: MICRO_STEPS.length,
  };
}
function microComplete(stepKey, key = dateKey()) {
  const pts = Number(data.profile.points) || 0;
  if (pts >= 0) return { ok: false, message: '现在是正分，不需要微目标' };
  const step = MICRO_STEPS.find((s) => s.key === stepKey);
  if (!step) return { ok: false, message: '没有这一步' };
  data.micro = data.micro || {};
  data.micro[key] = data.micro[key] || {};
  if (data.micro[key][stepKey]) return { ok: false, message: '这一步今天已经算过了' };
  data.micro[key][stepKey] = true;
  setProfilePoints(pts + step.gain);
  if (data.rescue && !data.rescue.usedAt && !data.rescue.unlocked) {
    data.rescue.done = (data.rescue.done || 0) + 1;
    if (data.rescue.done >= data.rescue.need) data.rescue.unlocked = true;
  }
  saveNow();
  return { ok: true, gain: step.gain, points: data.profile.points, message: `离正分又近了 ${step.gain} 分，继续保持。` };
}
function creditState() {
  const c = data.credit || {};
  const loan = c.loan || null;
  const dueIn = loan ? Math.ceil((new Date(loan.due + 'T23:59:59') - new Date(dateKey() + 'T00:00:00')) / 86400000) : 0;
  return {
    score: Number(c.score) || 0,
    limit: Number(c.limit) || 0,
    rate: Number(c.rate) || 0,
    loan,
    dueIn,
    blockUntil: Number(c.blockUntil) || 0,
    history: (c.history || []).slice(0, 10),
    rep: c.rep || {},
    ledger: (c.ledger || []).slice(0, 20),
    pillars: creditPillars(),
    jailed: (Number(c.score) || 0) <= 0,
  };
}

/* 三支柱（最近 30 天账本汇总）：诚实度 / 联盟贡献 / 成长 */
function creditPillars() {
  const c = data.credit || {};
  const since = Date.now() - 30 * 86400000;
  const out = { honest: 0, ally: 0, growth: 0 };
  for (const e of c.ledger || []) {
    if (new Date(e.at).getTime() < since) continue;
    if (e.pillar in out) out[e.pillar] += Number(e.delta) || 0;
  }
  return out;
}

/* 信誉分账本（与借贷共用 0~160 分；同类事件每天有绝对上限，刷不出来） */
const CREDIT_EVENTS = {
  flip_ok:   { delta: 3,   cap: 6,   pillar: 'honest', label: '翻案被证实' },
  flip_bad:  { delta: -8,  cap: 16,  pillar: 'honest', label: '翻案被推翻' },
  report_ok: { delta: 4,   cap: 8,   pillar: 'honest', label: '举报属实' },
  report_bad:{ delta: -10, cap: 20,  pillar: 'honest', label: '恶意举报' },
  loan_ok:   { delta: 10,  cap: 10,  pillar: 'honest', label: '按时还清借款' },
  loan_bad:  { delta: -30, cap: 30,  pillar: 'honest', label: '借款逾期' },
  help_ok:   { delta: 2,   cap: 6,   pillar: 'ally',   label: '助人被确认' },
  help_bad:  { delta: -3,  cap: 6,   pillar: 'ally',   label: '互刷好评' },
  online_ok: { delta: 1,   cap: 2,   pillar: 'ally',   label: '联机稳定在线' },
  online_bad:{ delta: -2,  cap: 4,   pillar: 'ally',   label: '挂机 / 恶意掉线' },
  legion_ok: { delta: 2,   cap: 6,   pillar: 'ally',   label: '军团贡献' },
  growth_ok: { delta: 1,   cap: 3,   pillar: 'growth', label: '连续达标' },
  record_ok: { delta: 2,   cap: 4,   pillar: 'growth', label: '突破个人纪录' },
  /* 军团纪律（与桌面端同一组口径） */
  desert_bad:  { delta: -3, cap: 12, pillar: 'honest', label: '专注期离开（逃兵）' },
  farm_bad:    { delta: -4, cap: 12, pillar: 'honest', label: '专注挂机刷时长' },
  contract_bad:{ delta: -6, cap: 12, pillar: 'honest', label: '契约违约' },
};

function creditEvent(type, note) {
  const cfg = CREDIT_EVENTS[type];
  if (!cfg) return { ok: false, message: '未知的信誉事件' };
  data.credit = data.credit || { score: 100, limit: 50, rate: 0.2, loan: null, blockUntil: 0, history: [] };
  const c = data.credit;
  const today = dateKey();
  c.ledger = Array.isArray(c.ledger) ? c.ledger : [];
  const used = c.ledger
    .filter((e) => e.type === type && String(e.at || '').slice(0, 10) === today)
    .reduce((sum, e) => sum + (Number(e.delta) || 0), 0);
  let delta = cfg.delta;
  if (delta > 0) delta = Math.max(0, Math.min(delta, cfg.cap - used));
  else delta = -Math.max(0, Math.min(-delta, cfg.cap + used));
  if (!delta) return { ok: true, delta: 0, score: Number(c.score) || 0, capped: true };

  const before = Number(c.score) || 0;
  c.score = Math.max(-30, Math.min(160, before + delta)); // -30 是负分缓冲的底，不设 0 否则冻结线永远到不了
  if (c.score <= 0 && delta < 0) c.blockUntil = Math.max(Number(c.blockUntil) || 0, Date.now() + 86400000);
  c.ledger = [{ at: new Date().toISOString(), type, delta, pillar: cfg.pillar, note: String(note || cfg.label).slice(0, 80) }, ...c.ledger].slice(0, 120);
  c.history = [{ at: new Date().toISOString(), type, amount: Math.abs(delta), note: `${cfg.label}：信用 ${before} → ${c.score}` }, ...(c.history || [])].slice(0, 40);
  c.rep = c.rep || {};
  if (type === 'growth_ok' || type === 'record_ok') {
    c.rep.growth = c.rep.growth || { ok: 0 };
    c.rep.growth.ok += 1;
  } else {
    const bucket = { flip: 'flips', report: 'reports', loan: 'loans', help: 'help', online: 'online', legion: 'legion', desert: 'discipline', farm: 'discipline', contract: 'discipline' }[type.split('_')[0]];
    if (bucket && c.rep[bucket]) c.rep[bucket][type.endsWith('_ok') ? 'ok' : 'bad'] += 1;
  }
  saveNow();
  return { ok: true, delta, score: c.score };
}
/* 信用扣分（翻案风控用：恶意翻案 / 行为不一致被回滚，与借贷同一套信用分） */
function creditPenalize(amount, note) {
  data.credit = data.credit || { score: 100, limit: 50, rate: 0.2, loan: null, blockUntil: 0, history: [] };
  const c = data.credit;
  const dec = Math.max(0, Math.min(50, Number(amount) || 0));
  if (!dec) return { ok: false, message: '扣分额度不合法' };
  c.score = Math.max(0, (Number(c.score) || 0) - dec);
  c.history = [{ at: new Date().toISOString(), type: 'penalty', amount: dec, note: String(note || '违规').slice(0, 60) }, ...(c.history || [])].slice(0, 40);
  saveNow();
  return { ok: true, score: c.score, limit: c.limit };
}
function creditBorrow(amount) {
  data.credit = data.credit || { score: 100, limit: 50, rate: 0.2, loan: null, blockUntil: 0, history: [] };
  const c = data.credit;
  if (Date.now() < (c.blockUntil || 0)) return { ok: false, message: '失信期内不能借分，先把打卡续上' };
  if (c.loan && !c.loan.repaidAt) return { ok: false, message: '上一笔还没结清' };
  const amt = Math.max(10, Math.min(Number(c.limit) || 50, Number(amount) || 0));
  if (!amt) return { ok: false, message: '借款额度不足' };
  const today = dateKey();
  const due = new Date(new Date(today + 'T00:00:00').getTime() + 7 * 86400000).toISOString().slice(0, 10);
  c.loan = { id: 'ln-' + Date.now().toString(36), amount: amt, at: today, due, earned: 0, taskNeed: 3, taskDone: 0, repaidAt: null, overdue: false };
  c.history = [{ at: new Date().toISOString(), type: 'borrow', amount: amt, note: `借 ${amt} 分，${due} 前还清` }, ...(c.history || [])].slice(0, 40);
  setProfilePoints((data.profile.points || 0) + amt);
  saveNow();
  return { ok: true, points: data.profile.points, loan: c.loan, state: creditState() };
}
function creditOnEarn(gained) {
  const c = data.credit;
  if (!c || !c.loan || c.loan.repaidAt) return;
  c.loan.earned = (c.loan.earned || 0) + Math.max(0, Number(gained) || 0);
  tryRepayLoan();
}
function creditOnPerfectDay() {
  const c = data.credit;
  if (!c || !c.loan || c.loan.repaidAt) return;
  c.loan.taskDone = (c.loan.taskDone || 0) + 1;
  tryRepayLoan();
}
function tryRepayLoan() {
  const c = data.credit;
  const l = c && c.loan;
  if (!l || l.repaidAt) return;
  if ((l.earned || 0) >= l.amount && (l.taskDone || 0) >= (l.taskNeed || 3)) {
    l.repaidAt = new Date().toISOString();
    c.score = Math.min(160, (Number(c.score) || 0) + 10);
    c.limit = Math.min(200, Math.max(50, (Number(c.limit) || 50) * 2));
    c.rate = Math.max(0.1, Number(((Number(c.rate) || 0.2) - 0.05).toFixed(2)));
    c.history = [{ at: new Date().toISOString(), type: 'repaid', amount: l.amount, note: `按时还清 ${l.amount} 分，信用 +10` }, ...(c.history || [])].slice(0, 40);
    creditEvent('loan_ok', `按时还清借款 ${l.amount} 分`);
  }
}
function forceStats() {
  const days = data.forceDays || {};
  const today = dateKey();
  const month = today.slice(0, 7);
  const monthDays = Object.keys(days).filter((d) => d.startsWith(month)).length;
  const dt = new Date(today + 'T00:00:00');
  const monthTotal = new Date(dt.getFullYear(), dt.getMonth() + 1, 0).getDate();
  let streak = 0;
  const cur = new Date(today + 'T00:00:00');
  if (!days[today]) cur.setDate(cur.getDate() - 1);
  for (;;) {
    const k = `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}-${String(cur.getDate()).padStart(2, '0')}`;
    if (!days[k]) break;
    streak++;
    cur.setDate(cur.getDate() - 1);
  }
  return { monthDays, monthTotal, streak, enabledToday: !!days[today], everUsed: Object.keys(days).length > 0 };
}

/* ---------------- 军团纪律（逃兵 / 刷分 / 契约 / 外挂） ----------------
   规则本体在 web/legion-discipline.js（桌面端 require 的也是同一份），
   这里只做落库，保证手机版和电脑版判定完全一致。 */
function disciplineOf() {
  if (!data.discipline) {
    data.discipline = {
      desert: { count: 0, lastAt: 0 },
      audits: { voidCount: 0, lastAt: 0 },
      contracts: {},
      flags: [],
      ban: null,
      frozenUntil: 0,
    };
  }
  const d = data.discipline;
  d.contracts = d.contracts && typeof d.contracts === 'object' ? d.contracts : {};
  d.flags = Array.isArray(d.flags) ? d.flags : [];
  return d;
}

function disciplineState() {
  const D = window.PQLegionDiscipline;
  const d = disciplineOf();
  if (!D) return { canJoinLegion: true, canSpeak: true, canPk: true, reasons: [], contracts: [], flags: [], frozen: false, banned: false };
  const st = D.stateOf({ credit: Number((data.credit || {}).score) || 0, discipline: d, now: Date.now() });
  return {
    ...st,
    contracts: Object.values(d.contracts).sort((a, b) => Number(b.createdAt) - Number(a.createdAt)).slice(0, 8),
    flags: d.flags.slice(0, 8),
  };
}

function disciplineSession(s) {
  const D = window.PQLegionDiscipline;
  if (!D) return { ok: true, voided: false, penalty: 0, messages: [], state: disciplineState() };
  const d = disciplineOf();
  const audit = D.focusAudit(s || {});
  const desert = D.desertVerdict(s || {});
  const messages = [];
  let voided = false;
  let penalty = 0;

  if (audit.level === 'void') {
    const r = D.applyAudit(d, audit, { now: Date.now() });
    voided = true;
    messages.push(audit.detail);
    if (r.penalty) {
      const ev = creditEvent('farm_bad', audit.detail);
      penalty += Math.abs(Number(ev.delta) || 0);
      if (ev.delta) messages.push(`累计第 ${r.strikes} 次挂机，信誉分 ${ev.delta}。`);
    }
  } else if (audit.level === 'suspect') {
    messages.push(audit.detail);
  }

  if (!voided && desert.level === 'desert') {
    const ev = creditEvent('desert_bad', desert.note);
    penalty += Math.abs(Number(ev.delta) || 0);
    D.applyDesert(d, desert, { creditAfter: Number((data.credit || {}).score) || 0, now: Date.now() });
    messages.push(desert.note);
  } else if (!voided && desert.level === 'warn') {
    messages.push(desert.note);
  }
  saveNow();
  return { ok: true, voided, penalty, messages: messages.filter(Boolean), state: disciplineState() };
}

function discContractNew(info) {
  const D = window.PQLegionDiscipline;
  if (!D) return { ok: false, message: '当前环境不支持契约' };
  const r = D.contractNew({
    title: (info || {}).title,
    deposit: (info || {}).deposit,
    witness: (info || {}).witness,
    dueAt: (info || {}).dueAt,
    points: Number(data.profile.points) || 0,
  });
  if (!r.ok) return r;
  const d = disciplineOf();
  d.contracts[r.contract.id] = r.contract;
  setProfilePoints((Number(data.profile.points) || 0) - r.contract.deposit);
  saveNow();
  return { ok: true, contract: r.contract, points: data.profile.points };
}

function discContractSettle({ id, done } = {}) {
  const D = window.PQLegionDiscipline;
  if (!D) return { ok: false, message: '当前环境不支持契约' };
  const d = disciplineOf();
  const c = d.contracts[id];
  const r = D.contractSettle(c, { done: !!done, now: Date.now() });
  if (!r.ok) return r;
  c.status = r.status;
  c.settledAt = Date.now();
  if (r.refund) setProfilePoints((Number(data.profile.points) || 0) + r.refund);
  if (r.penalty) creditEvent('contract_bad', `${c.title} · 见证人 ${c.witness}`);
  saveNow();
  return { ...r, points: data.profile.points, state: disciplineState() };
}

function discScan() {
  const D = window.PQLegionDiscipline;
  if (!D) return { ok: true, added: 0, flags: [] };
  const d = disciplineOf();
  const today = dateKey();
  const scan = D.scanCheat({
    focusMinutes: Number((data.focus || {})[today]) || 0,
    credit: Number((data.credit || {}).score) || 0,
    pointsJump: Number(data.profile.pointsJump) || 0,
    clockBackMs: Number(data.profile.clockBackMs) || 0,
    clickIntervalMs: Number(data.profile.clickIntervalMs) || 0,
    clickCount: Number(data.profile.clickCount) || 0,
  });
  let added = 0;
  for (const h of scan.hits) {
    const dup = d.flags.some((f) => f.kind === h.kind && String(f.at || '').slice(0, 10) === today && f.status === 'pending');
    if (dup) continue;
    d.flags.unshift({ id: `f${Date.now().toString(36)}${added}`, at: new Date().toISOString(), kind: h.kind, detail: h.detail, severity: h.severity, status: 'pending' });
    added += 1;
  }
  d.flags = d.flags.slice(0, 30);
  if (added) saveNow();
  return { ok: true, added, flags: d.flags.slice(0, 8) };
}

function discReview({ id, uphold } = {}) {
  const D = window.PQLegionDiscipline;
  if (!D) return { ok: false, message: '当前环境不支持审核' };
  const d = disciplineOf();
  const f = d.flags.find((x) => x.id === id);
  const r = D.reviewCheat(f, { uphold: !!uphold, now: Date.now() });
  if (!r.ok) return r;
  f.status = r.status;
  f.reviewedAt = r.at;
  if (r.wipe) {
    data.credit = data.credit || {};
    data.credit.score = 0;
    data.credit.blockUntil = Math.max(Number(data.credit.blockUntil) || 0, Date.now() + 86400000);
  }
  if (r.ban) {
    d.ban = { at: Date.now(), permanent: true, reason: f.detail || f.kind };
    d.frozenUntil = 0;
  }
  saveNow();
  return { ...r, state: disciplineState() };
}

function discThaw() {
  const d = disciplineOf();
  if (d.ban && d.ban.permanent) return { ok: false, message: '外挂坐实属于永久封禁，不能自助解冻' };
  const dates = Object.keys(data.log || {}).sort().slice(-3);
  const okDays = dates.filter((k) => Object.values(data.log[k] || {}).some((x) => x && x.status === 'done')).length;
  if (okDays < 3) return { ok: false, message: `还需要连续 3 天打卡，目前 ${okDays} 天` };
  d.frozenUntil = 0;
  d.desert = { count: 0, lastAt: Date.now() };
  saveNow();
  return { ok: true, state: disciplineState() };
}

/* ---------------- 初始化 ---------------- */
loadData();
bootMinutes = nowMinutes();
bootMinutes = nowMinutes();
ensureShopDefaults();
setInterval(reminderTick, 30 * 1000);
setTimeout(reminderTick, 3000);
