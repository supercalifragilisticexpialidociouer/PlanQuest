'use strict';

const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  ipcMain,
  nativeImage,
  Notification,
  shell,
  session,
  desktopCapturer,
  clipboard,
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const room = require('./study-room');
const legion = require('./legion-room');
const legionPk = require('./legion-pk');
const creditShield = require('./credit-shield');
const chatRulesLib = require('./legion-chat');
const tierLib = require('./legion-tier');
const friendLib = require('./friend');
const planGuard = require('./plan-guard');
const discipline = require('./legion-discipline');
const gov = require('./legion-gov');
const pkToken = require('./pk-token');
const pkOAuth = require('./pk-oauth');
const livekit = require('./livekit');
const netroom = require('./netroom');
const discovery = require('./discovery');
const guardian = require('./guardian');
const alaLLM = require('./ala-llm');
const alaWeb = require('./ala-web');
const alaTTS = require('./ala-tts');
const updateFlow = require('./update-flow');
const aciCore = require('./aci-core');

const APP_NAME = 'PlanQuest';
app.setName(APP_NAME);
// 会议语音：允许远端音频在无用户手势时自动播放（连上即听见，符合会议软件习惯）
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
if (process.platform === 'win32') app.setAppUserModelId('com.wya.planquest');
// 调试：多实例并行测试时隔离数据目录
if (process.env.PQ_USERDATA) {
  app.setPath('userData', path.join(app.getPath('appData'), 'PlanQuest-' + process.env.PQ_USERDATA));
}
// 调试：打包版临时开 CDP 调试口（设置 PQ_DEBUG_PORT 环境变量才生效）
if (process.env.PQ_DEBUG_PORT) {
  app.commandLine.appendSwitch('remote-debugging-port', process.env.PQ_DEBUG_PORT);
}

const LAUNCH_HIDDEN = process.argv.includes('--hidden');
const ROOT = path.join(__dirname, '..');

let mainWindow = null;
let tray = null;
let reminderWindow = null;
/* 护眼模式状态（模块级：snapshot 也要读） */
let eyeCareWindow = null;
let eyeCareTimer = null;
let eyeCarePhase = null; // null | 'exercise' | 'rest'
let eyeCareEndsAt = 0;
let eyeCarePhaseTimer = null;
let eyeCareAllowClose = false;
/* 护眼节奏三档：工作 N 分钟 → 休息 M 分钟（改节奏走 eyecare:plan，需守护密码）。
   必须放在模块级：snapshot()/saveNow 在 loadData 阶段就会用到。 */
const EYE_PLANS = { 30: 10, 45: 15, 60: 20 };
function eyePlan() {
  const m = data && data.settings ? Number(data.settings.eyeCarePlan) : NaN;
  return EYE_PLANS[m] ? m : 45;
}
function eyeIntervalMs() {
  return Number(process.env.PQ_EYE_INT_MS) || eyePlan() * 60000;
}
function eyeRestMs() {
  return Number(process.env.PQ_EYE_REST_MS) || EYE_PLANS[eyePlan()] * 60000;
}
let netWindow = null; // 异地联机独立窗口
let roomWindow = null; // 局域网房间独立窗口
let unlistedWindow = null;
let quitting = false;
let funAllowUntil = 0; // 娱乐房期间灰名单放行截止时间
let pickedDisplaySource = null; // 用户选定的屏幕共享源（一次性授权）
let pendingOpenFile = null;     // 双击 .pqplan 启动时待处理的文件路径
/* .pqplan 处理函数定义在 registerIpc() 内部（依赖其局部函数），这里持有引用供启动流程调用 */
let openPlanFileHook = null;
let registerPlanFileAssocHook = null;

/* ------------------------------------------------------------------ */
/* 数据层                                                              */
/* ------------------------------------------------------------------ */

let dataFile = null;
let data = null;

function defaultData() {
  return {
    version: 1,
    settings: {
      autoStart: false,
      closeToTray: true,
      sound: true,
      theme: 'dark',
      snoozeMinutes: 10,
      repeatRemind: true, // 未完成每 2 小时连续提醒
      eyeCare: false,     // 护眼模式：到点眼保健操 + 息屏休息（开关需守护密码）
      eyeCarePlan: 45,    // 护眼节奏（分钟）：30→休息10 / 45→休息15 / 60→休息20
      netMode: 'direct',  // 异地通道：direct = 点对点直传（默认）；relay = 纯中继（经 TURN）
      netTurn: null,      // 自建 TURN 服务器 { urls, username, credential }；null = 用内置公共中继
      /* PK 布告栏（私有 GitHub 仓库，一个军团一个文件）
         owner/repo/branch/token 由军团主自己填；backup 是备仓，双写双读对比 */
      pkRepo: { owner: '', repo: '', branch: 'main', token: '', oauthAt: 0, backup: { owner: '', repo: '', branch: 'main' } },
      pkOAuth: { clientId: '' },  // GitHub OAuth App 的 Client ID（一次性，Device Flow 用）
    },
    profile: { points: 100, totalDone: 0, bestStreak: 0, perfectDays: 0, name: '我', avatar: '🙂', focusMinutes: 0, pomodoros: 0 },
    plans: [],
    log: {},       // log['2026-10-27'] = { [planId]: { status, at, points } }
    fired: {},     // fired['2026-10-27'] = { [planId]: true }
    snooze: {},    // snooze[planId] = timestamp(ms)
    bonus: {},     // bonus['2026-10-27'] = true  全勤奖励是否已发
    pomodoro: {},  // pomodoro['2026-10-27'] = 番茄个数
    focus: {},     // focus['2026-10-27'] = 专注分钟数
    mits: {},      // mits['2026-10-27'] = [{ id, text, done }] 今日三件事
    guardian: { user: '', salt: '', hash: '', whitelist: [], graylist: [], blacklist: [], enabled: false },
    reminderStrikes: {}, // planId -> 忽略弹窗次数
    shop: { items: [], history: [] }, // 积分商城：商品与兑换记录
    goals: [],     // 目标：[{ id, title, icon, unit, total, deadline, milestones: [{ id, title, done }] }]
    contracts: [], // 契约模式（旧·红包挑战）：[{ id, title, stake, friends: [name], start, days, checkins: {date:true}, paid: {date:true} }]
    contractProjects: [], // 契约项目（新）：[{ id, title, stake, days, start, createdAt, settlements: { date: { pct, owe, due, done } }, paid: { date: true } }]
                           // 子任务 = data.plans 里带 contract: 项目id 的计划（复用打卡/提醒/日志机制），到期前不可删除
    diary: {},     // diary['2026-10-28'] = { mood, text } 每日小结
    reviews: {},   // reviews['2026-W44'] = { rate, items: [] } 每周复盘改进项
    makeups: {},   // makeups['2026-10'] = [{ date, planId, reason }] 补卡记录（每月限 3 次）
    lastRemind: {}, // lastRemind['planId@date'] = timestamp 连续提醒用
    focusMode: false, // 专注模式（隐藏桌面图标）
    iconHiddenBackup: null,
    grayRedeem: {},  // grayRedeem['2026-10-30'] = { [灰名单名]: 已兑换分钟数 }（负分状态下每项每天上限 30 分钟）
    rescue: null,    // 救赎券：{ startedAt, need, done, unlocked, usedAt }（中度欠分时领挑战，完成后解锁一次兑换）
    witness: {},     // 契约见证人：{ [projectId]: { name, at } }（纯本地记录，不联网）
    micro: {},       // 微目标：micro['2026-11-17'] = { open:true, one:true, note:false }（欠分时的极小步骤）
    forceDays: {},   // 强制模式开启记录：forceDays['2026-11-17'] = true（只用于统计与正反馈，关掉不惩罚）
    credit: {        // 借分与信用（纯本地，不联网、不上报）
      score: 100,    // 信用分 0~120
      limit: 50,     // 当前可借额度
      rate: 0.2,     // 还款期内积分效率损失比例
      loan: null,    // 当前借款 { id, amount, at, due, earned, taskNeed, taskDone, repaidAt, overdue }
      blockUntil: 0, // 失信后禁止借款的截止时间戳
      history: [],   // [{ at, type, amount, note }] 借贷历史
      rep: { flips: { ok: 0, bad: 0 }, reports: { ok: 0, bad: 0 }, loans: { ok: 0, bad: 0 }, help: { ok: 0, bad: 0 }, online: { ok: 0, bad: 0 }, legion: { ok: 0, bad: 0 }, discipline: { ok: 0, bad: 0 }, growth: { ok: 0 } },
      ledger: [],    // 信誉账本：[{ at, type, delta, pillar, note }] 诚实度 / 联盟贡献 / 成长
    },
    discipline: {    // 军团纪律：逃兵 / 刷分 / 契约 / 外挂（纯本地，不上报）
      desert: { count: 0, lastAt: 0 },
      audits: { voidCount: 0, lastAt: 0 },
      contracts: {},   // contracts[id] = { id, title, deposit, witness, dueAt, status }
      flags: [],       // flags[] = { id, at, kind, detail, severity, status }
      ban: null,       // { at, permanent, reason } 外挂坐实后永久封禁军团功能
      frozenUntil: 0,  // 逃兵冻结到什么时候
    },
    gov: {           // 军团治理：团内目录、投票、职务、举报
      votes: [],     // votes[] = { id, type, by, target, role, question, createdAt, endsAt, status, votes{}, reports[] }
      roles: {},     // roles[uid] = 'deputy' | 'judge' | 'arbiter' | 'scribe'
      reports: [],
      daily: {},     // daily[uid] = { day, n }  每日发起次数
      bans: {},      // bans[uid] = 截止时间（乱发投票）
      log: [],       // log[] = { at, kind, by, detail }
      hostUid: '',   // 建团那台机器上的 uid（团长身份）
      election: null, // 团长选举（团长退团后全团接任）
      collective: null, // 集体任务：{ id, title, target, day, status, progress, contributions }
      warnings: {},  // Lv1 劝导：warnings[uid] = [{ at, by, msgId }]
      watch: {},     // Lv1 观察名单：watch[uid] = { since, count }
      abuse: 0,      // Lv2 团长滥用管制次数（3 次自动解除职务）
      appeals: {},   // Lv3 申诉：appeals[uid] = { at, until, status, evidence }
      planBan: [],   // 军团计划文件黑名单（uid 数组）
      tierStrikes: {}, // L1 闲聊抽检：tierStrikes[uid] = 时间戳数组 + [uid:until] 回落截止
    },
    friends: {},     // 好友区：friends[uid] = F1/F2 档案（friend.js）
    friendGates: {}, // 问答申请：friendGates[uid] = { questions, answers, status }
    friendMsgs: {},  // friendMsgs[uid] = 消息数组（24h 焚毁，本地缓存上限 200 条）
    sandbox: null,   // .pqplan 沙箱：{ text, src, at, expiresAt, promoted }
    aci: aciCore.defaultAci(), // 阿刺养成 + 战友 PK 状态（aci-core.js），独立于用户积分等级
  };
}

function normalize(d) {
  const base = defaultData();
  const out = { ...base, ...(d || {}) };
  out.settings = { ...base.settings, ...(d?.settings || {}) };
  out.profile = { ...base.profile, ...(d?.profile || {}) };
  out.plans = Array.isArray(d?.plans) ? d.plans : [];
  out.log = d?.log && typeof d.log === 'object' ? d.log : {};
  out.fired = d?.fired && typeof d.fired === 'object' ? d.fired : {};
  out.snooze = d?.snooze && typeof d.snooze === 'object' ? d.snooze : {};
  out.bonus = d?.bonus && typeof d.bonus === 'object' ? d.bonus : {};
  out.pomodoro = d?.pomodoro && typeof d.pomodoro === 'object' ? d.pomodoro : {};
  out.focus = d?.focus && typeof d.focus === 'object' ? d.focus : {};
  out.mits = d?.mits && typeof d.mits === 'object' ? d.mits : {};
  out.reminderStrikes = d?.reminderStrikes && typeof d.reminderStrikes === 'object' ? d.reminderStrikes : {};
  out.guardian = { ...base.guardian, ...(d?.guardian && typeof d.guardian === 'object' ? d.guardian : {}) };
  out.shop = {
    items: Array.isArray(d?.shop?.items) ? d.shop.items : [],
    history: Array.isArray(d?.shop?.history) ? d.shop.history : [],
  };
  out.goals = Array.isArray(d?.goals) ? d.goals : [];
  out.contracts = Array.isArray(d?.contracts) ? d.contracts : [];
  out.contractProjects = Array.isArray(d?.contractProjects) ? d.contractProjects : [];
  out.diary = d?.diary && typeof d.diary === 'object' ? d.diary : {};
  out.reviews = d?.reviews && typeof d.reviews === 'object' ? d.reviews : {};
  out.makeups = d?.makeups && typeof d.makeups === 'object' ? d.makeups : {};
  out.lastRemind = d?.lastRemind && typeof d.lastRemind === 'object' ? d.lastRemind : {};
  out.focusMode = !!d?.focusMode;
  out.iconHiddenBackup = typeof d?.iconHiddenBackup === 'number' ? d.iconHiddenBackup : null;
  out.grayRedeem = d?.grayRedeem && typeof d.grayRedeem === 'object' ? d.grayRedeem : {};
  out.credit = { ...base.credit, ...(d?.credit && typeof d.credit === 'object' ? d.credit : {}) };
  /* 老数据没有「纪律」分项：补上，避免账本记到空对象里丢掉 */
  out.credit.rep = { ...base.credit.rep, ...(out.credit.rep || {}) };
  out.discipline = { ...base.discipline, ...(d?.discipline && typeof d.discipline === 'object' ? d.discipline : {}) };
  out.discipline.contracts = out.discipline.contracts && typeof out.discipline.contracts === 'object' ? out.discipline.contracts : {};
  out.discipline.flags = Array.isArray(out.discipline.flags) ? out.discipline.flags : [];
  out.gov = { ...base.gov, ...(d?.gov && typeof d.gov === 'object' ? d.gov : {}) };
  out.gov.votes = Array.isArray(out.gov.votes) ? out.gov.votes : [];
  out.gov.reports = Array.isArray(out.gov.reports) ? out.gov.reports : [];
  out.gov.log = Array.isArray(out.gov.log) ? out.gov.log.slice(0, 200) : [];
  out.gov.roles = out.gov.roles && typeof out.gov.roles === 'object' ? out.gov.roles : {};
  out.gov.daily = out.gov.daily && typeof out.gov.daily === 'object' ? out.gov.daily : {};
  out.gov.bans = out.gov.bans && typeof out.gov.bans === 'object' ? out.gov.bans : {};
  out.gov.election = out.gov.election && typeof out.gov.election === 'object' ? out.gov.election : null;
  out.gov.collective = out.gov.collective && typeof out.gov.collective === 'object' ? out.gov.collective : null;
  out.gov.warnings = out.gov.warnings && typeof out.gov.warnings === 'object' ? out.gov.warnings : {};
  out.gov.watch = out.gov.watch && typeof out.gov.watch === 'object' ? out.gov.watch : {};
  out.gov.abuse = Math.max(0, Math.min(3, Number(out.gov.abuse) || 0));
  out.gov.appeals = out.gov.appeals && typeof out.gov.appeals === 'object' ? out.gov.appeals : {};
  out.gov.planBan = Array.isArray(out.gov.planBan) ? out.gov.planBan : [];
  out.gov.tierStrikes = out.gov.tierStrikes && typeof out.gov.tierStrikes === 'object' ? out.gov.tierStrikes : {};
  out.friends = d?.friends && typeof d.friends === 'object' ? d.friends : {};
  out.friendGates = d?.friendGates && typeof d.friendGates === 'object' ? d.friendGates : {};
  out.friendMsgs = d?.friendMsgs && typeof d.friendMsgs === 'object' ? d.friendMsgs : {};
  out.sandbox = d?.sandbox && typeof d.sandbox === 'object' ? d.sandbox : null;
  out.friendRates = d?.friendRates && typeof d.friendRates === 'object' ? d.friendRates : { day: '', my: 0, peers: {} };
  out.friendRates.peers = out.friendRates.peers && typeof out.friendRates.peers === 'object' ? out.friendRates.peers : {};
  out.micro = d?.micro && typeof d.micro === 'object' ? d.micro : {};
  out.witness = d?.witness && typeof d.witness === 'object' ? d.witness : {};
  out.forceDays = d?.forceDays && typeof d.forceDays === 'object' ? d.forceDays : {};
  out.aci = aciCore.normalizeAci(d?.aci); // 阿刺养成状态：缺字段补齐 + 数值兜底
  return out;
}

function loadData() {
  dataFile = path.join(app.getPath('userData'), 'data.json');
  let fresh = false; // 仅首次创建数据文件时播种示例计划；用户删空后不再重新生成
  try {
    if (fs.existsSync(dataFile)) {
      data = normalize(JSON.parse(fs.readFileSync(dataFile, 'utf8')));
    } else {
      data = defaultData();
      fresh = true;
    }
  } catch (err) {
    console.error('[store] 读取失败，使用默认数据', err);
    data = defaultData();
    try {
      fs.copyFileSync(dataFile, dataFile + '.broken-' + Date.now());
    } catch (_) {}
  }
  if (fresh) seedDemoPlans();
  else {
    // 一次性迁移：清除历史版本播种的示例计划（demo-1/2/3），用户删掉后不再复活
    const before = data.plans.length;
    data.plans = data.plans.filter((p) => !/^demo-[123]$/.test(String(p && p.id)));
    if (data.plans.length !== before) {
      console.log('[store] 已清除示例计划 x' + (before - data.plans.length));
    }
  }
  sweepTempPlans(); // 隔天启动：清掉昨天兑换的临时计划
  saveNow();
}

function seedDemoPlans() {
  const today = new Date();
  const stamp = today.toISOString();
  data.plans = [
    {
      id: 'demo-1',
      title: '晨间阅读',
      desc: '读 20 页书，做三条笔记',
      icon: '📖',
      color: 'mint',
      time: '07:30',
      days: [0, 1, 2, 3, 4, 5, 6],
      points: 20,
      enabled: true,
      createdAt: stamp,
    },
    {
      id: 'demo-2',
      title: '核心训练',
      desc: '平板支撑 3 组 + 拉伸',
      icon: '🏃',
      color: 'coral',
      time: '18:30',
      days: [1, 2, 3, 4, 5],
      points: 30,
      enabled: true,
      createdAt: stamp,
    },
    {
      id: 'demo-3',
      title: '复盘与规划',
      desc: '写下今天最重要的三件事',
      icon: '🧭',
      color: 'indigo',
      time: '21:30',
      days: [0, 1, 2, 3, 4, 5, 6],
      points: 25,
      enabled: true,
      createdAt: stamp,
    },
  ];
}

let saveTimer = null;
function saveData() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 150);
}

/* 积分统一写入入口：每次变动立即同步守护模块（负分 → 名单升级），不等防抖落盘 */
function setProfilePoints(v) {
  if (!data || !data.profile) return;
  data.profile.points = v;
  try {
    guardian.setPoints(v);
  } catch (_) {}
}

let suppressCloudNotify = false; // 应用云端数据时，不要把自己的写入当成「本机新改动」

function saveNow() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (!dataFile || !data) return;
  // 守护模块要知道当前积分：负分时名单自动升级
  try {
    guardian.setPoints(data.profile?.points || 0);
  } catch (_) {}
  try {
    const tmp = dataFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, dataFile);
  } catch (err) {
    console.error('[store] 写入失败', err);
  }
  broadcast();
  if (!suppressCloudNotify) notifyCloudLocalChange();
}

/* 本机数据变了 → 通知渲染层排队上传云端（未登录时渲染层什么也不做） */
function notifyCloudLocalChange() {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send('cloud:localChange');
    } catch (_) {}
  }
}

function broadcast() {
  const payload = snapshot();
  // 状态要推给所有窗口：独立房间窗口（standalone）也靠它刷新 inRoom / 成员列表
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      try {
        win.webContents.send('state:update', payload);
      } catch (_) {}
    }
  }
  buildTrayMenu();
}

/* ------------------------------------------------------------------ */
/* 时间 / 业务计算                                                      */
/* ------------------------------------------------------------------ */

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

function plansForDate(key) {
  const dt = new Date(key + 'T00:00:00');
  const dow = dt.getDay();
  return data.plans
    .filter((p) => !p.temp && p.enabled && (p.days || []).includes(dow))
    .sort((a, b) => minutesOf(a.time) - minutesOf(b.time));
}

function logOf(key) {
  return data.log[key] || {};
}

function completedCount(key) {
  const log = logOf(key);
  return Object.values(log).filter((v) => v && v.status === 'done').length;
}

function computeStreak() {
  let streak = 0;
  const cursor = new Date();
  // 今天还没打卡时，从昨天开始算，避免早上就把连续天数清零
  if (completedCount(dateKey(cursor)) === 0) cursor.setDate(cursor.getDate() - 1);
  for (let i = 0; i < 400; i++) {
    const key = dateKey(cursor);
    const due = plansForDate(key);
    if (due.length === 0) {
      // 当天没有安排，不打断连续
      cursor.setDate(cursor.getDate() - 1);
      continue;
    }
    if (completedCount(key) > 0) {
      streak++;
      cursor.setDate(cursor.getDate() - 1);
    } else {
      break;
    }
  }
  return streak;
}

function todayPoints(key) {
  const log = logOf(key);
  return Object.values(log).reduce((sum, v) => sum + (v && v.status === 'done' ? v.points || 0 : 0), 0);
}

function levelOf(points) {
  let level = 1;
  let need = 120;
  let rest = points;
  while (rest >= need && level < 99) {
    rest -= need;
    level++;
    need = Math.round(need * 1.28);
  }
  return { level, cur: rest, need };
}

const BADGES = [
  { id: 'first', icon: '🌱', name: '第一步', desc: '完成第一次打卡', test: (s) => s.totalDone >= 1 },
  { id: 'streak3', icon: '🔥', name: '三日之火', desc: '连续打卡 3 天', test: (s) => s.bestStreak >= 3 },
  { id: 'streak7', icon: '⚡', name: '一周不断', desc: '连续打卡 7 天', test: (s) => s.bestStreak >= 7 },
  { id: 'streak30', icon: '👑', name: '月度王者', desc: '连续打卡 30 天', test: (s) => s.bestStreak >= 30 },
  { id: 'perfect', icon: '🎯', name: '全勤日', desc: '一天内完成全部计划', test: (s) => s.perfectDays >= 1 },
  { id: 'perfect5', icon: '🏅', name: '全勤达人', desc: '达成 5 个全勤日', test: (s) => s.perfectDays >= 5 },
  { id: 'points500', icon: '💎', name: '积分新星', desc: '累计 500 积分', test: (s) => s.points >= 500 },
  { id: 'points2000', icon: '🚀', name: '积分大师', desc: '累计 2000 积分', test: (s) => s.points >= 2000 },
  { id: 'done50', icon: '🏆', name: '五十次', desc: '累计完成 50 次打卡', test: (s) => s.totalDone >= 50 },
  // 差异化徽章
  { id: 'rookie', icon: '🌟', name: '初出茅庐', desc: '连续打卡 7 天', test: (s) => s.bestStreak >= 7 },
  { id: 'master30', icon: '🥋', name: '自律达人', desc: '连续打卡 30 天', test: (s) => s.bestStreak >= 30 },
  { id: 'earlybird', icon: '🌅', name: '晨型人', desc: '累计 14 天完成早起计划（8 点前）', test: (s) => (s.earlyDays || 0) >= 14 },
  // 铁人三项：连续开强制模式、保持正分、不断打卡——三者同时成立才算
  { id: 'ironman', icon: '🛡️', name: '铁人三项', desc: '连续 7 天开启强制模式 · 保持正分 · 每天都有打卡', test: (s) => (s.forceStreak || 0) >= 7 && (s.points || 0) >= 0 && (s.streak || 0) >= 7 },
];

/* 统计最近 N 天内完成过 8 点前计划的distinct天数（晨型人徽章用） */
function countEarlyDays(daysBack = 90) {
  let count = 0;
  for (let i = 0; i < daysBack; i++) {
    const dt = new Date();
    dt.setDate(dt.getDate() - i);
    const key = dateKey(dt);
    const earlyPlans = plansForDate(key).filter((p) => minutesOf(p.time) < 8 * 60);
    if (earlyPlans.some((p) => logOf(key)[p.id]?.status === 'done')) count++;
  }
  return count;
}

/* ---------------- 军团治理：团内目录 / 投票 / 职务 ----------------
 * 规则全在 src/legion-gov.js（纯函数，单测覆盖），这里只负责落库、结算与权限校验。 */

function govSelf() {
  const st = (legion && legion.snapshot()) || {};
  const uid = String(st.uid || '');
  /* 团长身份只认「本机建团时写下的 uid」；换台机器当成员，hostUid 对不上就不是团长 */
  if (uid && !data.gov.hostUid && (st.role === 'host' || st.role === 'hub' || st.role === 'mesh')) {
    data.gov.hostUid = uid;
  }
  const score = Number((data.credit || {}).score) || 0;
  return {
    uid,
    alias: String((data.profile || {}).name || '我').slice(0, 12),
    credit: score,
    tier: gov.tierIndex(score),
    tierName: gov.tierOf(score).name,
    isHost: !!uid && String(data.gov.hostUid || '') === uid,
    /* 自己职务带来的权限（如「提议任命职务」），界面用它决定能不能发起职务投票 */
    perms: gov.permsOf(data.gov.roles, uid),
    rosterSize: Math.max(1, Number(st.n) || 1),
    role: st.role || 'none',
    joined: !!st.inLegion,
  };
}

/* 结算所有到期投票；返回是否有变化（有变化就要存盘） */
function govSettle() {
  const now = Date.now();
  const size = govSelf().rosterSize;
  let dirty = false;
  for (const v of data.gov.votes) {
    if (!v || v.status !== 'open') continue;
    /* 管制 / 驱逐投票有自己的法定数：管制看副团长过半，驱逐看全员 2/3 */
    if (v.type === 'moderate' || v.type === 'evict') {
      const t = v.type === 'moderate' ? gov.tallyModerate(v, deputyCount(), now) : gov.tallyEvict(v, size, now);
      if (!t.expired) continue;
      dirty = true;
      v.settledAt = now;
      v.status = t.pass ? 'pass' : 'fail';
      v.result = { yes: t.yes, no: t.no, joined: t.joined, need: t.need, at: now };
      if (t.pass) {
        if (v.type === 'moderate') {
          legion.chatMute(v.target, v.moderateMin, v.reason);
          govLog('moderate', v.by, `管制生效：${v.targetAlias || v.target} 禁言 ${v.moderateMin} 分钟（副团长过半同意）`);
        } else {
          data.gov.evicted = data.gov.evicted && typeof data.gov.evicted === 'object' ? data.gov.evicted : {};
          data.gov.evicted[v.target] = { at: now, until: now + gov.LIMITS.APPEAL_MS, voteId: v.id, byHost: v.by };
          gov.openAppeal(data.gov, v.target, now);
          govLog('evict', v.by, `驱逐执行：${v.targetAlias || v.target} 进入 7 天申诉期（赞成 ${t.yes}/${size}）`);
        }
      } else {
        govLog('reject', v.by, `${v.type === 'moderate' ? '管制' : '驱逐'}投票未通过`);
      }
      continue;
    }
    const t = gov.settle(v, size, now);
    if (v.status === 'open') continue;
    dirty = true;
    v.settledAt = now;
    if (v.status === 'void') {
      /* 乱发投票：作废 + 24 小时禁发起 + 扣分（只扣一次） */
      if (!v.penalized) {
        v.penalized = true;
        data.gov.bans[v.by] = Math.max(Number(data.gov.bans[v.by]) || 0, now + gov.LIMITS.REPORT_BAN_MS);
        if (v.by === govSelf().uid) creditEvent('vote_bad', `投票「${v.question}」被 ${gov.joinQ ? gov.joinQ(v) : v.reports.length} 人举报作废`);
      }
      govLog('void', v.by, `投票「${v.question}」被集体否决（${v.reports.length} 人举报）`);
      /* 管制投票被 3 人否决 = 滥用管制：记账，3 次自动解除团长职务 */
      if (v.type === 'moderate') {
        const a = gov.abuseTick(data.gov, `管制「${v.question}」被集体否决`, now);
        if (a.removed) {
          data.gov.hostUid = '';
          govLog('abuse', v.by, '滥用管制 3 次，自动解除团长职务');
          if (v.by === govSelf().uid) creditEvent('abuse_bad', '滥用管制 3 次，解除团长职务');
        }
      }
    } else if (v.status === 'pass') {
      if (v.type === 'role' && v.target && v.role) {
        const r = gov.assign(data.gov.roles, v.target, v.role);
        if (r.ok) {
          data.gov.roles = r.roles;
          govLog('assign', v.by, `投票通过：${v.targetAlias || v.target} 任${gov.ROLES[v.role].name}`);
        } else {
          /* 比如投票期间他已经拿了别的职务：一人一职，这条结果落空并记进台账 */
          govLog('assign', v.by, `投票通过但没能任命：${r.message}`);
        }
      } else if (v.type === 'speech' && v.target && v.speech) {
        const verdict = 'fish'; // 同意 = 判为摸鱼
        if (v.speech.current !== verdict) {
          if (v.speech.current === 'work') {
            if (v.target === govSelf().uid) creditEvent('fish_ok', `发言「${v.speech.text}」经团内投票判为摸鱼`);
          } else if (v.target === govSelf().uid) {
            creditEvent('speech_ok', '发言误判经团内投票撤销');
          }
          govLog('speech', v.by, `投票通过：${v.targetAlias || v.target} 的发言改判为摸鱼`);
        }
      }
    } else if (v.status === 'fail') {
      govLog('reject', v.by, `投票「${v.question}」未通过`);
    }
  }
  return dirty;
}

/* 创建军团 = 自动成为军团长：立刻写死 hostUid，不再等懒判定；
   如果换了团（hostUid 变了），旧团的治理台账一并清空，职务和投票不会带过来 */
function govClaimHost(uid) {
  const id = String(uid || '');
  if (!id) return;
  const changed = String(data.gov.hostUid || '') !== id;
  data.gov.hostUid = id;
  if (changed) {
    data.gov.roles = {};
    data.gov.votes = [];
    data.gov.reports = [];
    data.gov.daily = {};
    data.gov.bans = {};
    data.gov.election = null;
    data.gov.log = [{ at: new Date().toISOString(), kind: 'host', by: id, detail: '创建军团，自动成为军团长' }];
    saveNow();
  }
}

/* ---------------- 团长选举：团长退团 → 公告 → 全团投票接任 ---------------- */

/* 到点结算：全员在同一份纯函数上算出同一个新团长，各自把 hostUid 改过去 */
function govElectionTick() {
  const el = data.gov.election;
  if (!el || el.status !== 'open') return;
  const me = govSelf();
  const e = gov.settleElection(el, me.rosterSize, Date.now());
  if (e === el || e.status === 'open') return;
  data.gov.election = e;
  if (e.status === 'pass' && e.result) {
    data.gov.hostUid = e.result;
    const w = e.candidates.find((c) => c.uid === e.result) || {};
    govLog('election', e.prevUid || '', `选举产生新团长：${w.alias || e.result}`);
  } else {
    govLog('election', e.prevUid || '', '选举未成：参选或投票人数不足，团里暂时没有团长');
  }
  saveNow();
  broadcast();
}

function govAnnounceLeave(payload) {
  const me = govSelf();
  if (!me.isHost || !me.joined) return { ok: false, message: '只有团长退团才会发起接任流程' };
  const r = legion.govAnnounceLeave({ uid: me.uid, alias: me.alias, p2p: !!((payload || {}).p2p) });
  if (r && r.ok) {
    data.gov.election = r.election;
    saveNow();
  }
  return r || { ok: false, message: '公告失败' };
}

/* 选举没成（人数不足 / 无人参选）：任何普通及以上成员都可以重新发一场 */
function govAnnounceElection() {
  const me = govSelf();
  if (!me.joined) return { ok: false, message: '还没加入军团' };
  if (me.tier < gov.LIMITS.MIN_TIER) return { ok: false, message: '信誉等级不够（需要「普通」及以上）' };
  const cur = data.gov.election;
  if (cur && cur.status === 'open' && Date.now() < Number(cur.endsAt)) return { ok: false, message: '已有一场选举在进行' };
  const e = gov.newElection({ prevUid: cur ? cur.prevUid : '', prevAlias: cur ? cur.prevAlias : '' });
  data.gov.election = e;
  govLog('election', me.uid, '重新发起团长选举');
  saveNow();
  broadcast();
  return { ok: true, election: e };
}

function govCampaign() {
  const me = govSelf();
  if (!me.joined) return { ok: false, message: '还没加入军团' };
  const el = data.gov.election;
  if (!el || el.status !== 'open') return { ok: false, message: '没有进行中的团长选举' };
  const r = gov.campaign(el, me.uid, me.alias, me.credit, Date.now());
  if (!r.ok) return r;
  data.gov.election = r.election;
  govLog('election', me.uid, '参选团长');
  saveNow();
  broadcast();
  return { ok: true, election: r.election };
}

function govBallotVote(payload) {
  const me = govSelf();
  if (!me.joined) return { ok: false, message: '还没加入军团' };
  const el = data.gov.election;
  if (!el || el.status !== 'open') return { ok: false, message: '没有进行中的团长选举' };
  const r = gov.castBallot(el, me.uid, (payload || {}).choice, Date.now());
  if (!r.ok) return r;
  data.gov.election = r.election;
  saveNow();
  broadcast();
  return { ok: true, election: r.election };
}

/* 收到别人的参选 / 投票 / 选举帧：本地记账（广播是渲染层的事） */
function govElectionApply(kind, payload) {
  const p = payload || {};
  const el = data.gov.election;
  if (kind === 'seed') {
    const r = legion.govElectionSeed(p.election);
    if (r.ok) data.gov.election = r.election;
    return r;
  }
  if (!el || el.status !== 'open') return { ok: false, message: '没有进行中的选举' };
  if (kind === 'candidacy') {
    const r = gov.campaign(el, p.uid, p.alias, p.credit, Date.now());
    if (r.ok) data.gov.election = r.election;
    return r;
  }
  if (kind === 'ballot') {
    const r = gov.castBallot(el, p.voter, p.choice, Date.now());
    if (r.ok) data.gov.election = r.election;
    return r;
  }
  return { ok: false, message: '未知选举帧' };
}

/* 退出军团 = 治理台账一并清空：职务、投票、选举都不会带进下一团 */
function govResetOnLeave() {
  data.gov.hostUid = '';
  data.gov.election = null;
  data.gov.roles = {};
  data.gov.votes = [];
  data.gov.reports = [];
  data.gov.daily = {};
  data.gov.bans = {};
  data.gov.collective = null;
  data.gov.warnings = {};
  data.gov.watch = {};
  data.gov.abuse = 0;
  data.gov.appeals = {};
  data.gov.planBan = [];
  data.gov.tierStrikes = {};
}

function govLog(kind, by, detail) {
  data.gov.log = [{ at: new Date().toISOString(), kind, by: String(by || ''), detail: String(detail || '').slice(0, 120) }, ...data.gov.log].slice(0, 200);
}

/* ---------------- 好友区（F0 未结缘 / F1 搭子档 / F2 战友档） ---------------- */

function todayDayKey() {
  return friendLib.dayKey(Date.now());
}

/* 我今天的完成率：data.log[today] 里已打卡 / 有状态记录的项 */
function friendTodayRate() {
  const day = todayDayKey();
  const log = (data.log && data.log[day]) || {};
  const ids = Object.keys(log).filter((id) => !String(id).startsWith('legion-collective-'));
  if (!ids.length) return 0;
  let done = 0;
  for (const id of ids) {
    const st = log[id] && (log[id].status !== undefined ? log[id].status : log[id]);
    if (st === 'done' || st === true) done += 1;
  }
  return Math.round((done / ids.length) * 100);
}

/* 当日完成率快照：给「双方全勤」判定用（次日结算时取昨天的快照） */
function friendRateSnapshot() {
  data.friendRates = data.friendRates && typeof data.friendRates === 'object' ? data.friendRates : { day: '', my: 0, peers: {} };
  const day = todayDayKey();
  if (data.friendRates.day !== day) data.friendRates = { day, my: friendTodayRate(), peers: {} };
  return data.friendRates;
}

function friendState() {
  for (const uid of Object.keys(data.friendMsgs || {})) {
    data.friendMsgs[uid] = friendLib.pruneBurned(data.friendMsgs[uid], Date.now());
    if (!data.friendMsgs[uid].length) delete data.friendMsgs[uid];
  }
  const gates = {};
  for (const [k, g] of Object.entries(data.friendGates || {})) {
    /* 未处理的申请不把答案透出给渲染层 */
    gates[k] = { ...g, questions: Array.isArray(g.questions) ? g.questions.map((q) => ({ q: q.q, a: g.status === 'open' ? '' : q.a })) : [] };
  }
  return { friends: data.friends, gates, rates: { my: friendTodayRate() }, limits: friendLib.LIMITS, tiers: friendLib.TIERS, me: govSelf() };
}

function friendGateNew(p) {
  const uid = String((p || {}).uid || '');
  if (!uid) return { ok: false, message: '没有这个人' };
  if (data.friends[uid]) return { ok: false, message: '已经结缘了，不用再答题' };
  const r = friendLib.makeGate(uid, (p || {}).alias, (p || {}).questions, Date.now());
  if (!r.ok) return r;
  data.friendGates[uid] = r.gate;
  saveNow();
  return { ok: true, gate: { ...r.gate, questions: r.gate.questions.map((q) => ({ q: q.q })) } };
}

function friendGateAnswer(p) {
  const uid = String((p || {}).uid || '');
  const g = data.friendGates[uid];
  if (!g) return { ok: false, message: '没有这份问答申请' };
  const r = friendLib.answerGate(g, (p || {}).answers);
  if (!r.ok) return r;
  if (r.pass && Object.keys(data.friends).length < friendLib.LIMITS.MAX_FRIENDS) {
    const b = friendLib.bond(uid, g.alias, 'gate', Date.now());
    if (b.ok) data.friends[uid] = b.friend;
  }
  saveNow();
  return { ...r, friend: data.friends[uid] || null };
}

/* 双人自习室 / 对赌契约路上认识的：同房打卡过或互为监督人后由界面发起 */
function friendBondDo(p) {
  const uid = String((p || {}).uid || '');
  if (!uid) return { ok: false, message: '没有这个人' };
  if (data.friends[uid]) return { ok: true, friend: data.friends[uid] };
  if (Object.keys(data.friends).length >= friendLib.LIMITS.MAX_FRIENDS) {
    return { ok: false, message: `好友最多 ${friendLib.LIMITS.MAX_FRIENDS} 人，防好友区变成通讯录` };
  }
  const b = friendLib.bond(uid, (p || {}).alias, (p || {}).via, Date.now());
  if (!b.ok) return b;
  data.friends[uid] = b.friend;
  saveNow();
  return b;
}

function friendPeerRate(p) {
  const uid = String((p || {}).uid || '');
  const f = data.friends[uid];
  if (!f) return { ok: false };
  const v = Math.max(0, Math.min(100, Math.round(Number((p || {}).rate) || 0)));
  f.peerRate = v;
  const snap = friendRateSnapshot();
  if (snap.day === todayDayKey()) snap.peers[uid] = v;
  saveNow();
  return { ok: true };
}

function friendSendMsg(p) {
  const uid = String((p || {}).uid || '');
  const f = data.friends[uid];
  if (!f) return { ok: false, message: '还没结缘，发不了私信' };
  const r = friendLib.send(f, Date.now(), {
    kind: String((p || {}).kind || 'text'),
    myRate: friendTodayRate(),
    peerRate: Number(f.peerRate) || 0,
  });
  if (!r.ok) return { ok: false, message: r.reason, gate: !!r.gate };
  const me = govSelf();
  const msg = friendLib.makeMsg(me.uid, me.alias, String((p || {}).text || ''), Date.now(), (p || {}).kind || 'text');
  data.friendMsgs[uid] = friendLib.pruneBurned(data.friendMsgs[uid], Date.now());
  data.friendMsgs[uid].push(msg);
  saveNow();
  return { ok: true, msg, burnLeft: friendLib.burnLeft(msg, Date.now()) };
}

function friendMsgsOf(uid) {
  const list = friendLib.pruneBurned(data.friendMsgs[String(uid || '')], Date.now());
  return { ok: true, msgs: list.map((m) => ({ ...m, burnLeft: friendLib.burnLeft(m, Date.now()) })) };
}

/* 每日结算：F1→F2 升级 / 断勤降档 / 连续 3 天断勤解缘（取昨天的完成率快照） */
function friendSettle() {
  const snap = data.friendRates;
  const day = snap && snap.day;
  if (!day || day === todayDayKey()) return;
  const notes = [];
  for (const [uid, f] of Object.entries(data.friends || {})) {
    const peerFull = (Number(snap.peers[uid]) || 0) >= 100;
    const full = snap.my >= 100 && peerFull;
    const r = friendLib.settleDay(f, day, full);
    /* 互相契约记账：断勤自动累计漏卡，到期自动结算押金 */
    const p = friendLib.pactTick(f, day, full, Date.now());
    if (p && p.ok && p.ended) {
      data.profile.points = Math.max(0, (Number(data.profile.points) || 0) - (Number(p.penalty) || 0));
      notes.push(`互相契约结算：${p.pass ? '全勤，押金全退 ✅' : `漏 ${p.missed} 天，扣 ${p.penalty} 分`}（${f.alias || uid}）`);
    }
    if (r.unbond) {
      delete data.friends[uid];
      notes.push(`${f.alias || uid} ${r.note}`);
    } else if (r.note) {
      notes.push(`${f.alias || uid} ${r.note}`);
    }
  }
  data.friendRates = { day: todayDayKey(), my: friendTodayRate(), peers: {} };
  saveNow();
  return notes;
}

/* ---------------- 好友排行 / 互相契约 / 自动提醒对方 ---------------- */

function friendRank() {
  return {
    ok: true,
    rows: friendLib.ranking(data.friends, friendTodayRate(), (data.profile || {}).name || '我'),
  };
}

function friendPactSet(p) {
  const uid = String((p || {}).uid || '');
  const f = data.friends[uid];
  const r = friendLib.makePact(f, { deposit: (p || {}).deposit, days: (p || {}).days }, Date.now());
  if (!r.ok) return r;
  saveNow();
  return r;
}

function friendPactSettle(p) {
  const uid = String((p || {}).uid || '');
  const f = data.friends[uid];
  const r = friendLib.pactSettle(f, Date.now());
  if (!r.ok) return r;
  data.profile.points = Math.max(0, (Number(data.profile.points) || 0) - (Number(r.penalty) || 0));
  saveNow();
  return r;
}

/* 我今天还剩几项没打卡（自动提醒的触发条件） */
function friendTodayLeft() {
  const day = todayDayKey();
  const log = (data.log && data.log[day]) || {};
  const ids = Object.keys(log).filter((id) => !String(id).startsWith('legion-collective-'));
  let done = 0;
  for (const id of ids) {
    const st = log[id] && (log[id].status !== undefined ? log[id].status : log[id]);
    if (st === 'done' || st === true) done += 1;
  }
  return Math.max(0, ids.length - done);
}

/* 每晚 21 点后自动提醒：还有没打完的卡就给每个搭子发一条免费提醒（不占额度） */
function friendRemindTick() {
  const left = friendTodayLeft();
  if (left <= 0) return 0;
  const t = Date.now();
  let n = 0;
  for (const [uid, f] of Object.entries(data.friends || {})) {
    if (!friendLib.shouldRemind(f, t, left)) continue;
    data.friendMsgs[uid] = friendLib.pruneBurned(data.friendMsgs[uid], t);
    data.friendMsgs[uid].push(friendLib.makeMsg('sys', '搭子提醒', friendLib.remindText(left), t, 'remind'));
    n++;
  }
  if (n) saveNow();
  return n;
}

/* ---------------- 军团集体任务（团长发起 / 完成全团加成，本身算一个任务） ---------------- */

function collectiveSet(p) {
  const me = govSelf();
  if (!me.joined) return { ok: false, message: '还没加入军团' };
  if (!me.isHost) return { ok: false, message: '集体任务只有团长能直接发起（其他成员走投票发起）' };
  const r = gov.setCollective(data.gov, { title: (p || {}).title, target: (p || {}).target, day: todayDayKey(), by: me.uid, now: Date.now() });
  if (r.ok) {
    friendRateSnapshot();
    saveNow();
    broadcast();
  }
  return r;
}

function collectiveProgress(p) {
  const me = govSelf();
  const uid = String((p || {}).uid || me.uid || '');
  const r = gov.progressCollective(data.gov, uid, (p || {}).pct);
  if (r.ok && !r.unchanged) {
    friendRateSnapshot();
    saveNow();
    broadcast();
  }
  return r;
}

/* 到点结算：达成 → 全团 +20 分 + 记成今天完成的一个任务 → 解锁 L2 狂欢档 */
function collectiveTick() {
  const r = gov.settleCollective(data.gov, Date.now());
  if (r.ok && r.met) {
    const day = todayDayKey();
    data.log[day] = data.log[day] || {};
    const key = 'legion-collective-' + r.collective.id;
    if (!data.log[day][key]) {
      data.log[day][key] = { status: 'done', at: Date.now(), points: 20 };
      data.profile.points = (Number(data.profile.points) || 0) + 20;
      data.gov.collectiveDays = Array.isArray(data.gov.collectiveDays) ? data.gov.collectiveDays : [];
      if (!data.gov.collectiveDays.includes(day)) data.gov.collectiveDays.push(day);
      govLog('collective', govSelf().uid, `集体任务「${r.collective.title}」达成 ${r.progress}%，全团 +20 分`);
    }
    friendRateSnapshot();
    saveNow();
    broadcast();
  }
  return r;
}

/* 本周集体全勤：周一到今天，每天集体任务都达成（L3 荣光档条件之一） */
function collectiveWeekFull() {
  const days = Array.isArray(data.gov.collectiveDays) ? data.gov.collectiveDays : [];
  const d = new Date();
  const dow = d.getDay() === 0 ? 7 : d.getDay();
  for (let i = 1; i <= dow; i++) {
    const x = new Date(d);
    x.setDate(d.getDate() - (dow - i));
    const key = x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0');
    if (!days.includes(key)) return false;
  }
  return true;
}

/* ---------------- 军团闲聊档位（L0~L3，生效档 = 任务完成情况决定） ---------------- */

function legionTierInfo() {
  const me = govSelf();
  const rate = friendTodayRate();
  const met = gov.collectiveMetFor(data.gov, todayDayKey());
  const streak7 = (Number((data.profile || {}).streak) || 0) >= 7 || (Number((data.profile || {}).bestStreak) || 0) >= 7;
  const base = tierLib.computeTier({
    personalRate: rate,
    collectiveMet: met,
    contribution: gov.contributionOf(data.gov, me.uid),
    streak7,
    weekFull: collectiveWeekFull(),
  });
  const key = tierLib.effectiveTier(base.key, data.gov.tierStrikes, me.uid, Date.now());
  return { ...tierLib.policyOf(key), base: base.key, reason: base.reason, rate, collective: data.gov.collective };
}

/* 发言前的档位闸：L1 限 50 字 + 闲聊抽检；L0 雷达折叠；L2/L3 全解锁 */
function tierGateChat(text) {
  const me = govSelf();
  const ti = legionTierInfo();
  const body = String(text || '');
  if (ti.key === 'L1') {
    if (body.length > tierLib.L1_TEXT_MAX) {
      return { ok: false, message: `轻聊档每条最多 ${tierLib.L1_TEXT_MAX} 字（集体任务达成后解锁长文）` };
    }
    if (tierLib.isChitChat(body)) {
      const s = tierLib.onChatStrike(data.gov.tierStrikes, me.uid, Date.now());
      data.gov.tierStrikes = s.strikes;
      if (s.over) {
        saveNow();
        return { ok: false, message: `闲聊超 ${tierLib.CHAT_PER_HOUR} 条/小时，静默档到明天 0 点（先各自干活）` };
      }
      saveNow();
    }
  }
  return { ok: true, tier: ti.key, folded: ti.radar === 'full' && tierLib.isChitChat(body) };
}

/* ---------------- Lv1 劝导 / Lv2 管制 / Lv3 驱逐 ---------------- */

function deputyCount() {
  return Object.values(data.gov.roles || {}).filter((v) => v === 'deputy').length;
}

function govFoldMsg(p) {
  const me = govSelf();
  if (!me.isHost) return { ok: false, message: '劝导权是团长的（Lv1）' };
  const r = gov.fold(data.gov, String((p || {}).uid || ''), me.uid, String((p || {}).msgId || ''), Date.now());
  if (r.ok) {
    govLog('fold', me.uid, `提醒 ${String((p || {}).alias || p.uid)}（第 ${r.count} 次）${r.watch ? '，已进观察名单' : ''}`);
    saveNow();
    broadcast();
  }
  return r;
}

function govWatchInfo(uid) {
  const w = gov.watchOf(data.gov, String(uid || ''));
  const rate = gov.speechRate(((data.gov.warnings || {})[String(uid || '')]) || [], Date.now());
  return { ...w, rate };
}

function govModerateStart(p) {
  const me = govSelf();
  const o = p || {};
  const chk = gov.canStartModerate(data.gov, { isHost: me.isHost, reason: o.reason, hasDeputies: deputyCount() > 0 });
  if (!chk.ok) return chk;
  const v = gov.newVote({
    type: 'moderate', by: me.uid, byAlias: me.alias, target: String(o.uid || ''), targetAlias: String(o.alias || ''),
    question: `管制 ${o.alias || o.uid}：${o.reason}`, ms: gov.LIMITS.MODERATE_MS, now: Date.now(),
  });
  v.moderateMin = Math.max(1, Math.min(24 * 60, Number(o.minutes) || 60));
  v.reason = String(o.reason || '').slice(0, 80);
  data.gov.votes.unshift(v);
  govLog('moderate', me.uid, `发起管制投票：${o.alias || o.uid} 禁言 ${v.moderateMin} 分钟 · 理由：${v.reason}`);
  saveNow();
  broadcast();
  return { ok: true, vote: v };
}

function govEvictStart(p) {
  const me = govSelf();
  const o = p || {};
  const chk = gov.canStartEvict(data.gov, { isHost: me.isHost, rosterSize: me.rosterSize });
  if (!chk.ok) return chk;
  const v = gov.newVote({
    type: 'evict', by: me.uid, byAlias: me.alias, target: String(o.uid || ''), targetAlias: String(o.alias || ''),
    question: `驱逐 ${o.alias || o.uid}：${o.reason}`, ms: gov.LIMITS.EVICT_MS, now: Date.now(),
  });
  v.reason = String(o.reason || '').slice(0, 80);
  data.gov.votes.unshift(v);
  govLog('evict', me.uid, `发起驱逐提案：${o.alias || o.uid} · 24 小时全员投票 · 理由：${v.reason}`);
  saveNow();
  broadcast();
  return { ok: true, vote: v };
}

/* 申诉：被驱逐者 7 天内提交证据；判定是确定性的——驱逐投票赞成不到 80% 视为团内有明显异议，申诉成功 */
function govAppealSubmit(p) {
  const me = govSelf();
  data.gov.evicted = data.gov.evicted && typeof data.gov.evicted === 'object' ? data.gov.evicted : {};
  const rec = data.gov.evicted[me.uid];
  if (!rec) return { ok: false, message: '你没有被驱逐，不用申诉' };
  if (Date.now() > rec.until) return { ok: false, message: '7 天申诉期已过' };
  const r = gov.openAppeal(data.gov, me.uid, Date.now());
  if (!r.ok) return r;
  r.appeal.evidence = String((p || {}).evidence || '').slice(0, 200);
  /* 立即确定性判定 */
  const v = data.gov.votes.find((x) => x.id === rec.voteId);
  const roster = Math.max(1, me.rosterSize);
  const yesRatio = v && v.result ? (Number(v.result.yes) || 0) / roster : 1;
  const won = yesRatio < 0.8;
  const j = gov.judgeAppeal(data.gov, me.uid, won, Date.now());
  if (j.ok && won) {
    delete data.gov.evicted[me.uid];
    govLog('appeal', me.uid, `申诉成功（赞成率 ${Math.round(yesRatio * 100)}%），恢复成员身份；发起驱逐的团长信誉 -50`);
    creditEvent('evict_appeal', '驱逐申诉成功，发起团长扣 50 信誉（在团长本机生效）');
    broadcast();
  } else {
    govLog('appeal', me.uid, `申诉失败（赞成率 ${Math.round(yesRatio * 100)}%）`);
  }
  saveNow();
  return { ...j, won, yesRatio };
}

/* ---------------- .pqplan 安全四件套（预览 / 来源 / 沙箱 / 黑名单） ---------------- */

function planPreviewText(p) {
  const o = p || {};
  const text = String(o.text || '');
  const from = String(o.from || '');
  if (planGuard.blocked(data.gov.planBan, from)) {
    return { ok: false, blocked: true, message: '对方已被军团长拉进计划文件黑名单，计划包已拦截（连预览都看不到）' };
  }
  if (text.length < 20 || text.length > 60000) return { ok: false, message: '计划包内容不完整' };
  let env = null;
  try {
    env = JSON.parse(text);
  } catch (_) {
    return { ok: false, message: '计划包格式不对' };
  }
  const pv = planGuard.preview(env);
  if (!pv.ok) return { ok: false, message: '计划包里没有任何计划' };
  const src = planGuard.markSource(env, o.from, o.fromAlias, Date.now());
  return { ok: true, preview: pv, src, sourceText: planGuard.sourceText(src) };
}

function planSandboxState() {
  const sb = data.sandbox;
  if (!sb) return { ok: true, present: false };
  return {
    ok: true,
    present: true,
    src: sb.src,
    sourceText: planGuard.sourceText(sb.src),
    leftMs: planGuard.sandboxLeft(sb, Date.now()),
    leftText: planGuard.leftText(planGuard.sandboxLeft(sb, Date.now())),
    expired: planGuard.sandboxExpired(sb, Date.now()),
    promoted: !!sb.promoted,
  };
}

function planSandboxPromote() {
  const sb = data.sandbox;
  if (!sb) return { ok: false, message: '没有在沙箱里的计划包' };
  const r = planGuard.sandboxPromote(sb, Date.now());
  if (!r.ok) return r;
  try {
    const env = JSON.parse(planGuard.sandboxText(sb));
    const v = validatePlanEnvelope(env);
    if (!v.ok) return { ok: false, message: v.error };
    const scoped = filterDataByScope(v.data, 'all');
    const stats = mergeIncoming(scoped);
    data.sandbox = null;
    saveNow();
    notifyPlanDataChanged();
    return { ok: true, message: `已从沙箱转正：新增计划 ${stats.plans} · 合并打卡 ${stats.logs}`, plans: stats.plans, logs: stats.logs };
  } catch (e) {
    return { ok: false, message: '转正失败：' + String((e && e.message) || e) };
  }
}

function notifyPlanDataChanged() {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('plan-data-changed');
  } catch (_) {}
}

function planSandboxDrop() {
  data.sandbox = null;
  saveNow();
  return { ok: true, message: '沙箱里的计划包已删除，主计划毫发无损' };
}

function planBanToggle(p) {
  const me = govSelf();
  if (!me.isHost) return { ok: false, message: '计划文件黑名单只有军团长能改' };
  const r = govPlanBanToggle(p);
  if (r.ok) {
    data.gov.planBan = r.list;
    govLog('plan_ban', me.uid, `${(p || {}).on === false ? '移出' : '拉入'}计划文件黑名单：${String((p || {}).uid || '')}`);
    saveNow();
    broadcast();
  }
  return r;
}

function govPlanBanToggle(p) {
  const r = planGuard.banToggle(data.gov.planBan, String((p || {}).uid || ''), (p || {}).on !== false);
  return r.ok ? { ok: true, list: r.list } : { ok: false, message: r.message || '操作失败' };
}

function govState() {
  govElectionTick();
  if (govSettle()) saveNow();
  const me = govSelf();
  const now = Date.now();
  const el = data.gov.election;
  const elT = el && el.status === 'open' ? gov.tallyElection(el, me.rosterSize, now) : null;
  return {
    self: me,
    votes: data.gov.votes
      .slice()
      .sort((a, b) => (a.status === 'open' ? 0 : 1) - (b.status === 'open' ? 0 : 1) || b.createdAt - a.createdAt)
      .slice(0, 20),
    roles: data.gov.roles,
    election: el
      ? {
          ...el,
          joined: elT ? elT.joined : 0,
          need: elT ? elT.need : 0,
          counts: elT ? elT.counts : {},
          winner: elT && elT.winner ? elT.winner : el.result || null,
          leftMs: elT ? elT.leftMs : 0,
        }
      : null,
    leftToday: gov.leftToday(data.gov, me.uid, me.tier, now),
    bannedUntil: gov.bannedUntil(data.gov, me.uid),
    dailyCap: gov.LIMITS.DAILY[me.tier] || 0,
    log: data.gov.log.slice(0, 30),
    smallLegion: me.rosterSize < gov.LIMITS.SMALL_LEGION,
    tier: legionTierInfo(),
    collective: data.gov.collective,
    planBan: data.gov.planBan,
    abuse: Number(data.gov.abuse) || 0,
    myWatch: gov.watchOf(data.gov, me.uid),
    myAppeal: (data.gov.appeals || {})[me.uid] || null,
    evicted: ((data.gov.evicted || {})[me.uid]) || null,
    deputies: deputyCount(),
  };
}

function govCreate(payload) {
  const p = payload || {};
  const me = govSelf();
  if (!me.joined) return { ok: false, message: '还没加入军团' };
  const type = gov.TYPES[p.type] ? p.type : 'other';
  const gate = gov.canStart(data.gov, {
    uid: me.uid,
    tier: me.tier,
    type,
    isHost: me.isHost,
    /* 职务投票：团长之外，有「提议任命职务」权限的也能发起；候选人不能已有职务 */
    perms: gov.permsOf(data.gov.roles, me.uid),
    roles: data.gov.roles,
    target: p.target || '',
    now: Date.now(),
  });
  if (!gate.ok) return { ok: false, message: gate.message };

  if (type === 'role' && (!p.target || !gov.ROLES[p.role])) {
    return { ok: false, message: '选职务要指定候选人和职务' };
  }
  if (type === 'speech' && !(p.speech && p.speech.msgId)) {
    return { ok: false, message: '发言审核要指定是哪条发言' };
  }

  const vote = gov.newVote({
    type,
    by: me.uid,
    byAlias: me.alias,
    byTier: me.credit,
    target: p.target || '',
    targetAlias: p.targetAlias || '',
    role: p.role || '',
    question: p.question || (type === 'role' ? `任命 ${p.targetAlias || '成员'} 为${gov.ROLES[p.role] ? gov.ROLES[p.role].name : ''}` : ''),
    speech: p.speech || null,
  });
  data.gov.votes = [vote, ...data.gov.votes].slice(0, 60);
  if (type !== 'role') {
    const day = gov.dayKey(Date.now());
    const rec = data.gov.daily[me.uid];
    const n = rec && rec.day === day ? Number(rec.n) || 0 : 0;
    data.gov.daily[me.uid] = { day, n: n + 1 };
  }
  govLog('create', me.uid, `发起${gov.TYPES[type].name}投票：${vote.question || '(无题)'}`);
  saveNow();
  broadcast();
  return { ok: true, vote };
}

function govCast(payload) {
  const p = payload || {};
  const me = govSelf();
  const v = data.gov.votes.find((x) => x && x.id === p.id);
  if (!v) return { ok: false, message: '没有这个投票' };
  const r = gov.cast(v, me.uid, p.choice, Date.now());
  if (!r.ok) return r;
  govSettle();
  saveNow();
  broadcast();
  return { ok: true, tally: gov.tally(v, me.rosterSize, Date.now()) };
}

function govReportVote(payload) {
  const p = payload || {};
  const me = govSelf();
  const v = data.gov.votes.find((x) => x && x.id === p.id);
  if (!v) return { ok: false, message: '没有这个投票' };
  const r = gov.report(v, me.uid, Date.now());
  if (!r.ok) return r;
  govLog('report', me.uid, `举报投票「${v.question}」乱发（第 ${r.reports} 人）`);
  govSettle();
  saveNow();
  broadcast();
  return { ok: true, voided: !!r.voided, reports: r.reports };
}

function govAssign() {
  /* 任命一律走投票：团长也没有直接任命权。保留 IPC 只为给旧界面一个明确的说法。 */
  return { ok: false, message: '任何人（包括团长）都不能直接任命职务，请发起「选职务」投票让大家表决' };
}

function govRevoke(payload) {
  const p = payload || {};
  const me = govSelf();
  if (!me.isHost) return { ok: false, message: '只有团长能撤销职务' };
  const r = gov.assign(data.gov.roles, p.uid, '');
  if (!r.ok) return r;
  data.gov.roles = r.roles;
  govLog('revoke', me.uid, `撤销 ${p.alias || p.uid} 的职务`);
  saveNow();
  broadcast();
  return { ok: true, roles: data.gov.roles };
}

function snapshot() {
  const today = dateKey();
  markForceDay();
  const streak = computeStreak();
  const profile = { ...data.profile };
  if (streak > (profile.bestStreak || 0)) profile.bestStreak = streak;
  const lv = levelOf(profile.points || 0);
  const mits = (data.mits[today] || []).map((m) => ({ ...m }));

  // 近 7 天
  const week = [];
  for (let i = 6; i >= 0; i--) {
    const dt = new Date();
    dt.setDate(dt.getDate() - i);
    const key = dateKey(dt);
    const due = plansForDate(key);
    week.push({
      key,
      label: ['日', '一', '二', '三', '四', '五', '六'][dt.getDay()],
      date: dt.getDate(),
      due: due.length,
      done: completedCount(key),
      points: todayPoints(key),
      isToday: key === today,
    });
  }

  const todayPlans = plansForDate(today).map((p) => {
    const st = logOf(today)[p.id];
    const late = nowMinutes() > planStartMin(p) + 45;
    return {
      ...p,
      status: st?.status || (late ? 'missed' : 'pending'),
      at: st?.at || null,
      earned: st?.points || 0,
    };
  });

  const badges = BADGES.map((b) => ({
    id: b.id,
    icon: b.icon,
    name: b.name,
    desc: b.desc,
    unlocked: b.test({
      ...profile,
      bestStreak: Math.max(profile.bestStreak || 0, streak),
      streak,
      earlyDays: countEarlyDays(),
      forceStreak: forceStats().streak,
    }),
  }));

  // 本月日历热力图数据
  const nowD = new Date();
  const monthDays = new Date(nowD.getFullYear(), nowD.getMonth() + 1, 0).getDate();
  const month = {
    year: nowD.getFullYear(),
    month: nowD.getMonth() + 1,
    firstWeekday: new Date(nowD.getFullYear(), nowD.getMonth(), 1).getDay(),
    days: [],
  };
  for (let i = 1; i <= monthDays; i++) {
    const dt = new Date(nowD.getFullYear(), nowD.getMonth(), i);
    const k = dateKey(dt);
    const d = plansForDate(k).length;
    month.days.push({ key: k, day: i, due: d, done: completedCount(k), isToday: k === today, future: k > today });
  }

  // 近 30 天打卡率趋势
  const trend30 = [];
  for (let i = 29; i >= 0; i--) {
    const dt = new Date();
    dt.setDate(dt.getDate() - i);
    const k = dateKey(dt);
    const due = plansForDate(k).length;
    trend30.push({ key: k, rate: due ? Math.round((completedCount(k) / due) * 100) : null });
  }

  // 目标进度
  const goals = (data.goals || []).map((g) => {
    const total = (g.milestones || []).length;
    const done = (g.milestones || []).filter((m) => m.done).length;
    return { ...g, total, done, percent: total ? Math.round((done / total) * 100) : 0 };
  });

  // 契约项目：先补结算（昨天及以前），再算进度 / 今日任务 / 累计应扣
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
        const dt = new Date();
        dt.setDate(dt.getDate() - i);
        const k = dateKey(dt);
        const tasks = k >= c.start && k <= end ? contractTasksForDate(c, k) : [];
        const due = tasks.length;
        const done = tasks.filter((p) => logOf(k)[p.id]?.status === 'done').length;
        days.push({
          key: k,
          due,
          done,
          owe: c.settlements?.[k]?.owe || 0,
          pct: due ? Math.round((done / due) * 100) : null,
          isToday: k === today,
          future: k > today,
        });
      }
      return { days, totalOwe: contractOweTotal(c) };
    })();
    return {
      ...c,
      dayIndex,
      endDate: end,
      expired: today > end,
      progressPct: sched ? Math.round((doneN / sched) * 100) : 0,
      todayCount: tTasks.length,
      todayDone: tTasks.filter((p) => logOf(today)[p.id]?.status === 'done').length,
      oweTotal: contractOweTotal(c),
      oweUnpaid: contractOweTotal(c, true),
      heat,
    };
  });
  // 昨日契约结算：今天要看的「昨天要扣的钱」
  const contractYesterday = (() => {
    const yd = new Date();
    yd.setDate(yd.getDate() - 1);
    const y = dateKey(yd);
    const items = [];
    for (const c of data.contractProjects || []) {
      const s = c.settlements?.[y];
      if (s && s.due > 0) items.push({ id: c.id, title: c.title, pct: s.pct, owe: s.owe, due: s.due, done: s.done, paid: !!c.paid?.[y] });
    }
    return { date: y, items, total: items.reduce((a, b) => a + (b.owe || 0), 0) };
  })();
  const monthKey = today.slice(0, 7);
  /* 仓库 token 只留在主进程：给渲染层的只有「填没填」，避免整份数据被导出时把 token 带出去 */
  const pkRepo = data.settings.pkRepo || {};
  const settingsOut = {
    ...data.settings,
    pkRepo: {
      owner: String(pkRepo.owner || ''),
      repo: String(pkRepo.repo || ''),
      branch: String(pkRepo.branch || 'main'),
      backup: {
        owner: String((pkRepo.backup && pkRepo.backup.owner) || ''),
        repo: String((pkRepo.backup && pkRepo.backup.repo) || ''),
        branch: String((pkRepo.backup && pkRepo.backup.branch) || 'main'),
      },
      hasToken: !!String(pkRepo.token || '').trim(),
      oauthAt: Number(pkRepo.oauthAt) || 0,
      oauthClientId: String((data.settings.pkOAuth || {}).clientId || ''),
      tokenMask: pkToken.mask(String(pkRepo.token || '')),
    },
  };
  return {
    settings: settingsOut,
    profile: { ...profile, streak, level: lv.level, levelCur: lv.cur, levelNeed: lv.need },
    plans: data.plans,
    todayPlans,
    todayPoints: todayPoints(today),
    todayBonus: !!data.bonus[today],
    week,
    badges,
    autoStartReal: getAutoStart(),
    dataFile,
    mits,
    todayPomodoro: data.pomodoro[today] || 0,
    todayFocus: data.focus[today] || 0,
    /* 单日最长专注（分钟）：分享海报只写「最长一次坐了多久」 */
    focusMax: Math.max(0, ...Object.values(data.focus || {}).map((v) => Number(v) || 0)),
    room: { ...room.roomStatus(), funAllowUntil },
    peers: discovery.list(),
    shop: { items: data.shop?.items || [], history: data.shop?.history || [] },
    guard: guardian.publicInfo(),
    penalty: { ...guardian.tier(), cheapMax: guardian.CHEAP_MAX, points: data.profile.points || 0 },
    rescue: data.rescue || null,
    micro: microState(),
    credit: creditState(),
    discipline: disciplineState(),
    witness: data.witness || {},
    force: forceStats(),
    grayRedeem: {
      used: { ...todayGrayRedeem() },
      limit: GRAY_REDEEM_DAILY_LIMIT,
      costPer10: GRAY_REDEEM_COST_PER10,
    },
    month,
    trend30,
    goals,
    contractProjects,
    contractYesterday,
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
    focusMode: !!data.focusMode,
    eyeCare: {
      enabled: !!data.settings.eyeCare,
      phase: eyeCarePhase,
      endsAt: eyeCareEndsAt,
      plan: eyePlan(),
      intervalMin: eyePlan(),
      restMin: EYE_PLANS[eyePlan()],
    },
    now: Date.now(),
  };
}

/* ------------------------------------------------------------------ */
/* 打卡与奖励                                                          */
/* ------------------------------------------------------------------ */

function doCheckin(planId, key = dateKey(), password) {
  const plan = data.plans.find((p) => p.id === planId);
  if (!plan) return { ok: false, message: '计划不存在' };

  data.log[key] = data.log[key] || {};
  const exist = data.log[key][planId];
  if (exist && exist.status === 'done') {
    return { ok: false, message: '今天已经打过卡了' };
  }
  // 开启「需密码确认」的计划：先记为"待验证"并立即关闭打卡窗口，
  // 之后输入守护密码验证通过才真正完成、发放积分
  if (plan.needConfirm && guardian.hasPassword() && !guardian.verify(password)) {
    if (!data.log[key][planId]) {
      data.log[key][planId] = { status: 'awaiting', at: Date.now() };
      delete data.snooze[planId];
      data.fired[key] = data.fired[key] || {};
      data.fired[key][planId] = true;
      saveNow();
      broadcast();
    }
    return { ok: true, pending: true, message: '已打卡，等待密码验证' };
  }

  const streakBefore = computeStreak();
  const bonus = Math.min(streakBefore, 10) * 2;
  const base = Number(plan.points) || 20;
  // 限时挑战：周末双倍（周六/周日完成，原分值部分再给一份；不改任何负面规则）
  const dow = new Date(key + 'T00:00:00').getDay();
  const weekendBonus = dow === 0 || dow === 6 ? base + bonus : 0;
  let gained = base + bonus + weekendBonus;
  // 借分还款期内：积分获取效率打折（代价明确写在借分面板上）
  const loanRate =
    data.credit && data.credit.loan && !data.credit.loan.repaidAt ? Number(data.credit.rate) || 0 : 0;
  if (loanRate > 0) gained = Math.max(1, Math.round(gained * (1 - loanRate)));
  // 军团集体徽章：达标次日打卡积分双倍（只加不减；用完即失效）
  let legionBonus = 0;
  if (data.legion && data.legion.badgeDate === key) {
    legionBonus = gained;
    delete data.legion.badgeDate;
  }
  gained += legionBonus;
  // 军团 PK 结果加成：赢家下周 +5%、输家 +3%（安慰奖），平局没有 —— 输赢都不痛不痒
  const pk = data.pk;
  if (pk && pk.buff && pk.buff.pct > 0 && key >= pk.buff.from && key <= pk.buff.to) {
    gained += Math.round((gained) * (pk.buff.pct / 100));
  }

  data.log[key][planId] = { status: 'done', at: Date.now(), points: gained, bonus, weekendBonus };
  setProfilePoints((data.profile.points || 0) + gained);
  data.profile.totalDone = (data.profile.totalDone || 0) + 1;
  delete data.snooze[planId];
  data.fired[key] = data.fired[key] || {};
  data.fired[key][planId] = true;

  // 全勤奖励
  let perfectBonus = 0;
  const due = plansForDate(key);
  const allDone = due.length > 0 && due.every((p) => data.log[key][p.id]?.status === 'done');
  if (allDone && !data.bonus[key]) {
    perfectBonus = 30;
    data.bonus[key] = true;
    setProfilePoints((data.profile.points || 0) + (perfectBonus));
    data.profile.perfectDays = (data.profile.perfectDays || 0) + 1;
    creditOnPerfectDay();
    creditEvent('growth_ok', `全勤达标：${key} 完成全部 ${due.length} 个计划`);
  }

  // 借分：把这一笔新赚到的分记进还款进度
  creditOnEarn(gained + perfectBonus);
  // 欠分期间打卡 → 微目标「完成 1 个计划」自动达成（+5 回升）
  let micro = null;
  if ((data.profile.points || 0) < 0 && cushionOn()) micro = microComplete('one', key);

  const streakAfter = computeStreak();
  if (streakAfter > (data.profile.bestStreak || 0)) data.profile.bestStreak = streakAfter;

  saveNow();
  const levelUp = levelOf(data.profile.points).level > levelOf(data.profile.points - gained - perfectBonus).level;
  return {
    ok: true,
    gained,
    base,
    bonus,
    perfectBonus,
    streak: streakAfter,
    streakUp: streakAfter > streakBefore,
    points: data.profile.points,
    levelUp,
    planTitle: plan.title,
    weekendBonus,
    loanRate,
    micro,
  };
}

/* ---------------- 微目标（欠分时的极小步骤） ----------------
 * 原则（用户要求）：欠分后不喊「回到正分」这种大目标，
 * 只给今天能做完的一件小事；每完成一步，负分直接回升 5 分。 */
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
  if (!cushionOn()) return { ok: false, message: CUSHION_MSG };
  const pts = Number(data.profile.points) || 0;
  if (pts >= 0) return { ok: false, message: '现在是正分，不需要微目标' };
  const step = MICRO_STEPS.find((s) => s.key === stepKey);
  if (!step) return { ok: false, message: '没有这一步' };
  data.micro = data.micro || {};
  data.micro[key] = data.micro[key] || {};
  if (data.micro[key][stepKey]) return { ok: false, message: '这一步今天已经算过了' };
  data.micro[key][stepKey] = true;
  setProfilePoints(pts + step.gain);
  // 救赎券挑战跟着走：完成 5 个微目标解锁一次兑换
  if (data.rescue && !data.rescue.usedAt && !data.rescue.unlocked) {
    data.rescue.done = (data.rescue.done || 0) + 1;
    if (data.rescue.done >= data.rescue.need) data.rescue.unlocked = true;
  }
  saveNow();
  broadcast();
  return {
    ok: true,
    gain: step.gain,
    points: data.profile.points,
    message: `离正分又近了 ${step.gain} 分，继续保持。`,
  };
}

/* ---------------- 缓冲功能总闸 ----------------
 * 借分 / 微目标回升 / 负分领灯 都是「缓冲垫」。
 * 规则：只在强制模式下开放 —— 强制模式是「我真的需要被兜住」的声明；
 * 没开强制模式，就说明这一局你还没到需要人抬的时候，分得自己挣。 */
function cushionOn() {
  try {
    return !!(guardian.state && guardian.state.enabled);
  } catch (_) {
    return false;
  }
}
const CUSHION_MSG = '借分和缓冲功能只在强制模式下开放：先去「守护」页打开强制模式';

/* ---------------- 军团纪律（逃兵 / 刷分 / 契约 / 外挂） ----------------
   判定逻辑全在 src/legion-discipline.js（纯函数，单测覆盖），这里只落库记账。 */
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
  const d = disciplineOf();
  const st = discipline.stateOf({
    credit: Number((data.credit || {}).score) || 0,
    discipline: d,
    now: Date.now(),
  });
  return {
    ...st,
    contracts: Object.values(d.contracts)
      .sort((a, b) => Number(b.createdAt) - Number(a.createdAt))
      .slice(0, 8),
    flags: (d.flags || []).slice(0, 8),
    newbie: creditShield.shieldOf((data.credit || {}).firstAt, Date.now()),
  };
}

/* ---------------- 借分与信用 ----------------
 * 借一笔分数立刻到账（可拿去兑换），代价：
 *  1) 还款期内（7 天）打卡效率按 rate 打折；
 *  2) 必须完成偿债任务（3 天全勤）；
 *  3) 按时还清 → 信用分 +10、额度翻倍、利率下调；逾期 → 扣信用、降额度、失信期内禁借。 */
const CREDIT_TASK_DAYS = 3;

/* 信誉等级：与 web/credit-priv.js 的 LEVELS / LOAN_LIMIT 同一套口径。
 * 每档只改「一次能借多少」，不改利率；利率只由还钱历史决定（借了按时还才降）。 */
const CREDIT_TIERS = [
  { key: '', name: '受限', min: 0, loan: 30 },
  { key: 'L1', name: '基础', min: 80, loan: 50 },
  { key: 'L2', name: '社交', min: 100, loan: 80 },
  { key: 'L3', name: '荣耀', min: 120, loan: 120 },
];

function creditTierOf(score) {
  const s = Math.max(-30, Math.min(160, Math.round(Number(score) || 0)));
  let t = CREDIT_TIERS[0];
  for (const x of CREDIT_TIERS) if (s >= x.min) t = x;
  return t;
}

/* 实际额度 = 档位基数 × 还钱记录系数（按时还清 ×2，逾期 ×0.5，封顶 2.5 倍） */
function creditLimitNow(c) {
  const base = creditTierOf(c && c.score).loan;
  const mul = Number(c && c.loanMul);
  const k = Number.isFinite(mul) ? Math.max(0.5, Math.min(2.5, mul)) : 1;
  return Math.max(10, Math.min(200, Math.round(base * k)));
}

function creditState() {
  const c = data.credit || {};
  const loan = c.loan || null;
  const today = dateKey();
  const dueIn = loan ? Math.ceil((new Date(loan.due + 'T23:59:59') - new Date(today + 'T00:00:00')) / 86400000) : 0;
  const tier = creditTierOf(c.score);
  const next = CREDIT_TIERS.find((t) => t.min > (Number(c.score) || 0)) || null;
  return {
    score: Number(c.score) || 0,
    limit: creditLimitNow(c),
    rate: Number(c.rate) || 0,
    level: tier.key,
    levelName: tier.name,
    nextIn: next ? Math.max(0, next.min - (Number(c.score) || 0)) : 0,
    nextName: next ? next.name : '',
    loan,
    dueIn,
    blockUntil: Number(c.blockUntil) || 0,
    history: (c.history || []).slice(0, 10),
    cushion: cushionOn(), // 借分是缓冲功能，只在强制模式下可用
    rep: c.rep || {},
    /* 近 7 天被确认的助人次数（分享海报用；账本里就是 help_ok 条数） */
    help7: (c.ledger || []).filter((e) => e && e.type === 'help_ok' && Date.now() - new Date(e.at).getTime() < 7 * 86400000).length,
    ledger: (c.ledger || []).slice(0, 20),
    pillars: creditPillars(),
    jailed: (Number(c.score) || 0) <= 0,
  };
}

/* 三支柱：诚实度 / 联盟贡献 / 成长（最近 30 天账本汇总） */
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

/* ---------------- 信誉分账本（与借贷共用同一个 0~160 分） ----------------
   type → { delta, cap: 当天绝对上限, pillar, label }
   刷不出来的设计：同一类事件每天有绝对上限，翻案/举报/助人都要事后验证才算。 */
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
  vote_bad:  { delta: -3,  cap: 6,   pillar: 'honest', label: '乱发投票被集体否决' },
  fish_ok:   { delta: -2,  cap: 6,   pillar: 'honest', label: '发言经团内投票判为摸鱼' },
  speech_ok: { delta: 1,   cap: 3,   pillar: 'honest', label: '发言误判被团内投票撤销' },
  /* 军团纪律：三种「系统能管住」的违规，各自有每日上限，不会一次按死 */
  desert_bad:  { delta: -3, cap: 12, pillar: 'honest', label: '专注期离开（逃兵）' },
  farm_bad:    { delta: -4, cap: 12, pillar: 'honest', label: '专注挂机刷时长' },
  contract_bad:{ delta: -6, cap: 12, pillar: 'honest', label: '契约违约' },
};

/* 信誉分下限：第 8 天起允许为负（-30），让「负分缓冲」有地方落 */
const CREDIT_FLOOR = -30;

function creditEvent(type, note) {
  const cfg = CREDIT_EVENTS[type];
  if (!cfg) return { ok: false, message: '未知的信誉事件' };
  data.credit = data.credit || { score: 100, limit: 80, rate: 0.2, loanMul: 1, loan: null, blockUntil: 0, history: [] };
  const c = data.credit;
  const today = dateKey();
  c.ledger = Array.isArray(c.ledger) ? c.ledger : [];
  /* 当天同类事件的绝对上限：正分不能靠刷，扣分也不会一次按死 */
  const used = c.ledger
    .filter((e) => e.type === type && String(e.at || '').slice(0, 10) === today)
    .reduce((sum, e) => sum + (Number(e.delta) || 0), 0);
  let delta = cfg.delta;
  if (delta > 0) delta = Math.max(0, Math.min(delta, cfg.cap - used));
  else delta = -Math.max(0, Math.min(-delta, cfg.cap + used));
  if (!delta) return { ok: true, delta: 0, score: Number(c.score) || 0, capped: true };

  /* 新手保护罩：按账号天数梯度减免扣分，而不是「前 7 天全免、第 8 天全责」 */
  let shieldNote = '';
  let floor = null;
  let shieldKey = '';
  if (delta < 0) {
    const sh = creditShield.shieldOf(c.firstAt, Date.now());
    const p = creditShield.applyPenalty(delta, sh);
    delta = p.delta;
    floor = p.floor == null ? null : p.floor;
    shieldNote = p.note || '';
    shieldKey = sh.key;
  }

  const before = Number(c.score) || 0;
  c.score = Math.max(floor != null ? floor : CREDIT_FLOOR, Math.min(160, before + delta));
  /* 负分斩杀：扣到 0 分及以下 → 24 小时失信期（不能借分、不能翻案、不能入团） */
  if (c.score <= 0 && delta < 0) {
    c.blockUntil = Math.max(Number(c.blockUntil) || 0, Date.now() + 86400000);
  }
  const ledgerNote = [String(note || cfg.label), shieldNote].filter(Boolean).join(' · ').slice(0, 120);
  c.ledger = [{ at: new Date().toISOString(), type, delta, shield: shieldKey || undefined, pillar: cfg.pillar, note: ledgerNote }, ...c.ledger].slice(0, 120);
  c.history = [{ at: new Date().toISOString(), type, amount: Math.abs(delta), note: `${cfg.label}：信用 ${before} → ${c.score}` }, ...(c.history || [])].slice(0, 40);
  /* 额度跟着等级走：分数掉档，能借的立刻变少，不用等下次借的时候才发现 */
  c.limit = creditLimitNow(c);
  /* 分项统计 */
  c.rep = c.rep || {};
  const bucket = { flip: 'flips', report: 'reports', loan: 'loans', help: 'help', online: 'online', legion: 'legion', desert: 'discipline', farm: 'discipline', contract: 'discipline' }[type.split('_')[0]];
  if (type === 'growth_ok' || type === 'record_ok') {
    c.rep.growth = c.rep.growth || { ok: 0 };
    c.rep.growth.ok += 1;
  } else if (c.rep[bucket]) {
    const key = type.endsWith('_ok') ? 'ok' : 'bad';
    c.rep[bucket][key] = (c.rep[bucket][key] || 0) + 1;
  }
  saveNow();
  broadcast();
  return { ok: true, delta, score: c.score, shield: shieldKey || undefined, note: shieldNote || undefined };
}

function creditBorrow(amount) {
  if (!cushionOn()) return { ok: false, message: CUSHION_MSG };
  data.credit = data.credit || { score: 100, limit: 80, rate: 0.2, loanMul: 1, loan: null, blockUntil: 0, history: [] };
  const c = data.credit;
  if (Date.now() < (c.blockUntil || 0)) {
    return { ok: false, message: '失信期内不能借分，先把打卡续上' };
  }
  if (c.loan && !c.loan.repaidAt) return { ok: false, message: '上一笔还没结清' };
  c.limit = creditLimitNow(c);
  const amt = Math.max(10, Math.min(Number(c.limit) || 50, Number(amount) || 0));
  if (!amt) return { ok: false, message: '借款额度不足' };
  const today = dateKey();
  const due = new Date(new Date(today + 'T00:00:00').getTime() + 7 * 86400000).toISOString().slice(0, 10);
  c.loan = { id: 'ln-' + Date.now().toString(36), amount: amt, at: today, due, earned: 0, taskNeed: CREDIT_TASK_DAYS, taskDone: 0, repaidAt: null, overdue: false };
  c.history = [{ at: new Date().toISOString(), type: 'borrow', amount: amt, note: `借 ${amt} 分，${due} 前还清` }, ...(c.history || [])].slice(0, 40);
  setProfilePoints((data.profile.points || 0) + amt);
  saveNow();
  broadcast();
  return { ok: true, points: data.profile.points, loan: c.loan, state: creditState() };
}

/* 信用扣分（翻案风控用：恶意翻案 / 行为不一致被回滚时扣，与借贷同一套信用分） */
function creditPenalize(amount, note) {
  data.credit = data.credit || { score: 100, limit: 80, rate: 0.2, loanMul: 1, loan: null, blockUntil: 0, history: [] };
  const c = data.credit;
  const dec = Math.max(0, Math.min(50, Number(amount) || 0));
  if (!dec) return { ok: false, message: '扣分额度不合法' };
  c.score = Math.max(0, (Number(c.score) || 0) - dec);
  c.limit = creditLimitNow(c);
  c.history = [{ at: new Date().toISOString(), type: 'penalty', amount: dec, note: String(note || '违规').slice(0, 60) }, ...(c.history || [])].slice(0, 40);
  saveNow();
  broadcast();
  return { ok: true, score: c.score, limit: c.limit };
}

/* 每次得分后推进还款进度（只算「新赚到的分」） */
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
  if ((l.earned || 0) >= l.amount && (l.taskDone || 0) >= (l.taskNeed || CREDIT_TASK_DAYS)) {
    l.repaidAt = new Date().toISOString();
    c.score = Math.min(160, (Number(c.score) || 0) + 10);
    /* 额度倍率只加不写死：档位基数 × 还钱记录（最多 2.5 倍） */
    c.loanMul = Math.min(2.5, Math.max(1, Number(c.loanMul) || 1) * 2);
    c.limit = creditLimitNow(c);
    c.rate = Math.max(0.1, Number((Number(c.rate) || 0.2) - 0.05).toFixed(2));
    c.history = [{ at: new Date().toISOString(), type: 'repaid', amount: l.amount, note: `按时还清 ${l.amount} 分，信用 +10` }, ...(c.history || [])].slice(0, 40);
    creditEvent('loan_ok', `按时还清借款 ${l.amount} 分`);
  }
}

/* 逾期检查：每天首次进入时跑一次 */
function creditCheckOverdue() {
  const c = data.credit;
  const l = c && c.loan;
  if (!l || l.repaidAt || l.overdue) return;
  if (dateKey() <= l.due) return;
  l.overdue = true;
  c.score = Math.max(0, (Number(c.score) || 0) - 30);
  c.loanMul = Math.max(0.5, (Number(c.loanMul) || 1) * 0.5);
  c.limit = creditLimitNow(c);
  c.rate = Math.min(0.3, Number(((Number(c.rate) || 0.2) + 0.05).toFixed(2)));
  c.blockUntil = Date.now() + 30 * 86400000;
  c.history = [{ at: new Date().toISOString(), type: 'overdue', amount: l.amount, note: `逾期未还，信用 -30，30 天内不能再借` }, ...(c.history || [])].slice(0, 40);
  creditEvent('loan_bad', `借款逾期未还（${l.amount} 分）`);
}

function undoCheckin(planId, key = dateKey()) {
  data.log[key] = data.log[key] || {};
  const rec = data.log[key][planId];
  if (!rec) return { ok: false };
  // 待验证状态：直接撤销即可（还没发积分）
  if (rec.status === 'awaiting') {
    delete data.log[key][planId];
    saveNow();
    return { ok: true };
  }
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

/* ------------------------------------------------------------------ */
/* 契约项目（新）：项目 + 子任务 + 每日结算                              */
/* ------------------------------------------------------------------ */

function contractEndDate(c) {
  const d = new Date((c.start || dateKey()) + 'T00:00:00');
  d.setDate(d.getDate() + Math.max(1, Number(c.days) || 30) - 1);
  return dateKey(d);
}

function contractExpired(c) {
  return dateKey() > contractEndDate(c);
}

/* 项目在某天应完成的子任务（契约计划按星期排班） */
function contractTasksForDate(c, key) {
  const dt = new Date(key + 'T00:00:00');
  const dow = dt.getDay();
  return data.plans.filter((p) => p.contract === c.id && !p.temp && p.enabled !== false && (p.days || []).includes(dow));
}

/* 结算某一天（只对昨天及更早）：未全部完成 → 应扣 = stake × (100-完成度)/100，至少 1 元 */
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

/* 补结算：从项目开始到昨天（不超过到期日），幂等，每次快照前跑一遍 */
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

/* ------------------------------------------------------------------ */
/* 开机自启                                                            */
/* ------------------------------------------------------------------ */

function autoStartOptions(enable) {
  const opts = { openAtLogin: !!enable, openAsHidden: true };
  if (!app.isPackaged) {
    // 开发模式下把 electron.exe + 应用目录一起写进启动项
    opts.path = process.execPath;
    opts.args = [ROOT, '--hidden'];
  } else if (process.platform === 'win32') {
    opts.path = process.execPath;
    opts.args = ['--hidden'];
  }
  return opts;
}

function setAutoStart(enable) {
  try {
    app.setLoginItemSettings(autoStartOptions(enable));
  } catch (err) {
    console.error('[autostart] 设置失败', err);
  }
}

function getAutoStart() {
  try {
    const s = app.getLoginItemSettings(autoStartOptions(true));
    return !!s.openAtLogin;
  } catch (_) {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* 定时提醒                                                            */
/* ------------------------------------------------------------------ */

const REMIND_WINDOW_MIN = 45; // 超过计划时间 45 分钟后不再打扰

/* 计划触发时机：p.when = 'time'（默认，定时）| 'boot'（开机/打开应用时）
 * boot 计划以「应用本次启动时刻」为基准点 */
let bootMinutes = null;
function planStartMin(p) {
  if (p && p.when === 'boot') return bootMinutes == null ? nowMinutes() : bootMinutes;
  return minutesOf(p.time);
}

/* ---------------- 灰名单兑换的临时计划 ----------------
 * 负积分（名单升级）状态下，灰名单软件可以「兑换时长」：
 * 按分钟生成一条临时计划插入计划表，兑换期间只放行该灰名单软件，
 * 时段结束自动失效，第二天清扫删除。每项每天最多兑换 30 分钟。
 */
const GRAY_REDEEM_DAILY_LIMIT = 30; // 每个灰名单项目每天最多兑换的分钟数
const GRAY_REDEEM_COST_PER10 = 15;  // 价格与娱乐房一致：每 10 分钟 15 积分

function todayGrayRedeem() {
  const key = dateKey();
  data.grayRedeem[key] = data.grayRedeem[key] && typeof data.grayRedeem[key] === 'object' ? data.grayRedeem[key] : {};
  return data.grayRedeem[key];
}

function grayRedeemLeft(name) {
  const used = todayGrayRedeem()[normProcName(name)] || 0;
  return Math.max(0, GRAY_REDEEM_DAILY_LIMIT - used);
}

const normProcName = (s) => String(s || '').toLowerCase().replace(/\.exe$/, '').trim();

/* 当前正在生效的临时计划（兑换生成的，只放行对应灰名单软件） */
function tempPlansForNow() {
  const now = nowMinutes();
  const dow = new Date().getDay();
  return data.plans.filter(
    (p) =>
      p.temp &&
      p.enabled !== false &&
      (p.days || []).includes(dow) &&
      now >= minutesOf(p.time) &&
      now < minutesOf(p.time) + (Number(p.durationMin) || 30)
  );
}

/* 第二天清扫：删除已过期的临时计划（expireKey < 今天） */
function sweepTempPlans() {
  const today = dateKey();
  const before = data.plans.length;
  data.plans = data.plans.filter((p) => !(p.temp && p.expireKey && p.expireKey < today));
  // 顺便清掉 7 天前的兑换记录，防止数据无限膨胀
  const cutoff = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  for (const k of Object.keys(data.grayRedeem || {})) {
    if (k < cutoff) delete data.grayRedeem[k];
  }
  if (data.plans.length !== before) {
    console.log('[store] 已清扫过期临时计划 x' + (before - data.plans.length));
    saveNow();
    broadcast();
  }
}

function hasActivePlan() {
  const key = dateKey();
  const now = nowMinutes();
  const log = logOf(key);
  const normal = plansForDate(key).some((p) => {
    /* 已完成的任务不再算「进行中」：否则打完卡后，图标指示器/守护进程
     * 仍会因为这条计划卡在 45 分钟窗口内而一直变色/扫描（对齐手机版
     * app.js 的 p.status !== 'done'）。 */
    if (log[p.id] && log[p.id].status === 'done') return false;
    const m = planStartMin(p);
    return now >= m && now <= m + REMIND_WINDOW_MIN;
  });
  return normal || tempPlansForNow().length > 0;
}

/* ===== 动态图标指示器：有任务进行中 → 窗口/任务栏图标视频式顺滑变色
   （24 帧色相旋转，每 120ms 一帧，约 2.9 秒一圈无缝循环），空闲 → 恢复初始颜色。
   注意：桌面快捷方式不再参与变色 —— 旧版实现用字节补丁重写 .lnk 的
   IconLocation（每秒一次），会把 .lnk 的 ExtraData 剥掉，Windows 解析失败后
   快捷方式永久显示成白纸。改为启动时检测被破坏的快捷方式并用系统 COM
   接口（WScript.Shell）重建，图标固定指向 exe 内嵌图标。 ===== */
const IND_FRAME_DIR = path.join(ROOT, 'assets', 'ind-frames');
const IND_FRAME_COUNT = 24;
const indState = { active: false, frame: 0, imgs: null };

/* 加载变色帧（24 帧 png，用于窗口/任务栏图标动画） */
function indLoadFrames() {
  if (indState.imgs) return indState.imgs;
  try {
    indState.imgs = [];
    for (let k = 0; k < IND_FRAME_COUNT; k++) {
      const p = path.join(IND_FRAME_DIR, `frame-${String(k).padStart(2, '0')}.png`);
      if (!fs.existsSync(p)) return (indState.imgs = null);
      indState.imgs.push(p);
    }
  } catch (_) {
    indState.imgs = null;
  }
  return indState.imgs;
}

function indLnkPath() {
  try {
    const p = path.join(app.getPath('desktop'), 'PlanQuest.lnk');
    return fs.existsSync(p) ? p : null;
  } catch (_) {
    return null;
  }
}

/* 桌面 + 开始菜单里所有 PlanQuest 快捷方式（含手机版入口） */
function indLnkTargets() {
  const out = [];
  const dirs = [];
  try { dirs.push(app.getPath('desktop')); } catch (_) {}
  try { dirs.push(path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs')); } catch (_) {}
  for (const dir of dirs) {
    try {
      for (const f of fs.readdirSync(dir)) {
        if (/\.lnk$/i.test(f) && /^planquest/i.test(f)) out.push(path.join(dir, f));
      }
    } catch (_) {}
  }
  return out;
}

/* 判断 .lnk 是否被旧版字节补丁破坏：解析到字符串区末尾后，
 * ExtraData 丢失（≤4 字节）或图标还指向 ind-ico 帧文件 → 需要重建 */
function lnkLooksBroken(lnkPath) {
  let buf;
  try { buf = fs.readFileSync(lnkPath); } catch (_) { return false; }
  try {
    if (buf.length < 76 || buf.readUInt32LE(0) !== 0x0000004c) return false;
    const flags = buf.readUInt32LE(20);
    let off = 76;
    if (flags & 0x0001) off += 2 + buf.readUInt16LE(off);
    if (flags & 0x0002) off += buf.readUInt32LE(off);
    if (off > buf.length) return false;
    for (const bit of [0x0004, 0x0008, 0x0010, 0x0020, 0x0040]) {
      if (!(flags & bit)) continue;
      if (off + 2 > buf.length) return false;
      off += 2 + buf.readUInt16LE(off) * 2;
    }
    if (buf.length - off <= 4) return true; // ExtraData 被剥掉
    if (flags & 0x0040) {
      // 图标字符串：从后往前各字符串长度已知，直接再走一遍取 icon 内容
      let p = 76;
      if (flags & 0x0001) p += 2 + buf.readUInt16LE(p);
      if (flags & 0x0002) p += buf.readUInt32LE(p);
      let icon = '';
      for (const bit of [0x0004, 0x0008, 0x0010, 0x0020, 0x0040]) {
        if (!(flags & bit)) continue;
        const cc = buf.readUInt16LE(p);
        if (bit === 0x0040) icon = buf.slice(p + 2, p + 2 + cc * 2).toString('utf16le');
        p += 2 + cc * 2;
      }
      if (/ind-ico|ind-frames|icon-fresh/i.test(icon)) return true; // 旧版动画残留
    }
    return false;
  } catch (_) {
    return false;
  }
}

/* 用系统 COM 接口（WScript.Shell）重建快捷方式 —— 与 一键创建快捷方式.bat
 * 完全相同的机制，生成的 .lnk 带完整 ExtraData，Windows 能正常解析。
 * 用 -EncodedCommand 传参（base64 UTF-16LE），避开中文路径的编码问题。 */
function rebuildLnkViaShell(lnkPath, target, workdir, iconSpec, desc) {
  return new Promise((resolve) => {
    try {
      const ps =
        `$ws = New-Object -ComObject WScript.Shell; ` +
        `$lnk = $ws.CreateShortcut('${lnkPath.replace(/'/g, "''")}'); ` +
        `$lnk.TargetPath = '${target.replace(/'/g, "''")}'; ` +
        `$lnk.WorkingDirectory = '${workdir.replace(/'/g, "''")}'; ` +
        `$lnk.IconLocation = '${iconSpec.replace(/'/g, "''")}'; ` +
        `$lnk.Description = '${desc.replace(/'/g, "''")}'; ` +
        `$lnk.Save()`;
      const b64 = Buffer.from(ps, 'utf16le').toString('base64');
      const { execFile } = require('node:child_process');
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', b64],
        { windowsHide: true, timeout: 20000 },
        (err) => resolve(!err)
      );
    } catch (_) {
      resolve(false);
    }
  });
}

/* 启动时修复被旧版补丁破坏的快捷方式（图标统一指向 exe 内嵌图标） */
async function repairDesktopLnks() {
  if (process.env.PQ_LNK_DISABLE) return;
  try {
    if (path.basename(process.execPath).toLowerCase() !== 'planquest.exe') return; // 开发环境不动
  } catch (_) { return; }
  const exe = process.execPath;
  const exeDir = path.dirname(exe);
  // 找最新的安卓安装包（exe 同级的 android 目录）
  let apk = null;
  try {
    const apkDir = path.join(exeDir, '..', 'android');
    const cands = fs.readdirSync(apkDir).filter((f) => /\.apk$/i.test(f)).sort().reverse();
    if (cands.length) apk = path.join(apkDir, cands[0]);
  } catch (_) {}
  for (const lnk of indLnkTargets()) {
    if (!lnkLooksBroken(lnk)) continue;
    const isMobile = /手机版/i.test(path.basename(lnk));
    const target = isMobile && apk ? apk : exe;
    const workdir = path.dirname(target);
    const desc = isMobile ? 'PlanQuest 安卓安装包' : 'PlanQuest 计划打卡';
    const ok = await rebuildLnkViaShell(lnk, target, workdir, exe + ',0', desc);
    bootLog('[icon-ind] 快捷方式重建 ' + (ok ? '成功' : '失败') + ' → ' + path.basename(lnk));
  }
}

function startIconIndicator() {
  if (!indLoadFrames()) {
    bootLog('[icon-ind] 缺少变色图标帧资源，指示器未启动');
    return;
  }
  repairDesktopLnks().catch(() => {});
  setInterval(() => {
    try {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      let act = false;
      try { act = !!hasActivePlan(); } catch (_) {}
      if (act !== indState.active) {
        indState.active = act;
        bootLog(`[icon-ind] ${act ? '有任务进行中 → 图标开始顺滑变色' : '任务结束 → 图标恢复初始颜色'}`);
        if (!act) mainWindow.setIcon(indState.imgs[0]); // 空闲恢复初始颜色
      }
      if (act) {
        // 窗口/任务栏：每 120ms 走一帧，24 帧无缝循环（约 2.9 秒一圈）
        indState.frame = (indState.frame + 1) % IND_FRAME_COUNT;
        mainWindow.setIcon(indState.imgs[indState.frame]);
      }
    } catch (e) {
      console.log('[icon-ind] ' + ((e && e.message) || e));
    }
  }, 120);
}

/* 强制模式使用率：只统计「开了几天」，用于给正反馈；关掉不扣分、不弹劝说 */
function forceStats() {
  const days = data.forceDays || {};
  const today = dateKey();
  const month = today.slice(0, 7);
  const monthDays = Object.keys(days).filter((d) => d.startsWith(month)).length;
  const dt = new Date(today + 'T00:00:00');
  const monthTotal = new Date(dt.getFullYear(), dt.getMonth() + 1, 0).getDate();
  // 连续开启天数：今天还没开就看昨天为止（不因为「今天还没开」把战绩清零）
  let streak = 0;
  const cur = new Date(today + 'T00:00:00');
  if (!days[today]) cur.setDate(cur.getDate() - 1);
  for (;;) {
    const k = fmtDate(cur);
    if (!days[k]) break;
    streak++;
    cur.setDate(cur.getDate() - 1);
  }
  return { monthDays, monthTotal, streak, enabledToday: !!days[today], everUsed: Object.keys(days).length > 0 };
}

function fmtDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/* 每天第一次快照时，把「今天开着强制模式」记一笔 */
function markForceDay() {
  if (!guardian.state.enabled) return;
  const today = dateKey();
  data.forceDays = data.forceDays || {};
  if (data.forceDays[today]) return;
  data.forceDays[today] = true;
  saveNow();
}

/* 当前进行中的计划所放行的进程（计划时段内可用，累计不超过 1 小时）
 * 负积分（名单升级）状态下：
 *  - 普通计划放行的「普通进程」全部禁用（只保留白名单软件不受影响）
 *  - 只有灰名单兑换生成的临时计划仍然放行对应软件 */
function activePlanAllow() {
  const escalated = guardian.isEscalated();
  const now = nowMinutes();
  const procs = [];
  const push = (n) => {
    const v = String(n).trim();
    if (v && !procs.some((x) => x.toLowerCase() === v.toLowerCase())) procs.push(v);
  };

  const normal = plansForDate(dateKey()).filter((p) => {
    const m = planStartMin(p);
    return now >= m && now <= m + REMIND_WINDOW_MIN;
  });
  if (!escalated) {
    for (const p of normal) for (const n of p.allowProcs || []) push(n);
  }

  const temps = tempPlansForNow();
  for (const p of temps) for (const n of p.allowProcs || []) push(n);

  return {
    procs,
    id: [...normal.map((p) => p.id), ...temps.map((p) => p.id)].sort().join('|'),
    // 只有临时计划在生效（负分状态下普通计划的放行已被禁用）
    tempOnly: temps.length > 0 && normal.length === 0,
  };
}

/* 忽略弹窗惩罚：60 秒不处理记 1 次，累计 5 次扣 15 积分 */
function registerStrike(planId) {
  data.reminderStrikes[planId] = (data.reminderStrikes[planId] || 0) + 1;
  const n = data.reminderStrikes[planId];
  let penalty = 0;
  if (n % 5 === 0) {
    penalty = 15;
    // 惩罚扣分可以扣成负分（负分触发名单升级）
    setProfilePoints((data.profile.points || 0) - penalty);
  }
  saveNow();
  if (penalty && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('app:toast', {
      msg: `⚠️ 弹窗提醒已忽略 ${n} 次，扣除 ${penalty} 积分`,
      sub: '及时打卡或点「稍后」，别让积分溜走',
    });
  }
}

function checkDueReminders() {
  const key = dateKey();
  const now = nowMinutes();
  const due = plansForDate(key);
  for (const plan of due) {
    const planMin = planStartMin(plan);
    const logEntry = logOf(key)[plan.id];
    if (logEntry?.status === 'done') continue;
    if (now < planMin) continue;

    const snoozeUntil = data.snooze[plan.id] || 0;
    if (Date.now() < snoozeUntil) continue;

    data.fired[key] = data.fired[key] || {};
    const firedBefore = !!data.fired[key][plan.id];

    if (!firedBefore) {
      // 首次提醒：计划时间后的 45 分钟内
      if (now > planMin + REMIND_WINDOW_MIN) continue;
      data.fired[key][plan.id] = true;
      data.lastRemind[`${plan.id}@${key}`] = Date.now();
      delete data.snooze[plan.id];
      saveData();
      openReminder(plan, { repeated: false });
      return; // 一次只弹一个，避免堆叠
    }

    // 连续提醒：设置开启时，未完成每 2 小时再次提醒，直到完成或当天忽略
    if (data.settings.repeatRemind) {
      if (now > 23 * 60 + 30) continue; // 深夜不打扰
      const last = data.lastRemind[`${plan.id}@${key}`] || 0;
      if (Date.now() - last < 120 * 60000) continue;
      if (logEntry?.status === 'skipped') continue;
      data.lastRemind[`${plan.id}@${key}`] = Date.now();
      saveData();
      openReminder(plan, { repeated: true, chase: true });
      return;
    }
  }
}

function openReminder(plan, extra = {}) {
  const payload = { plan, ...extra };

  if (Notification.isSupported() && !reminderWindow) {
    // 首次同时发一条系统通知，确保窗口被遮挡时也能感知
    try {
      const n = new Notification({
        title: `该打卡了 · ${plan.title}`,
        body: plan.desc || `计划时间 ${plan.time}，完成后 +${plan.points} 积分`,
        silent: !data.settings.sound,
      });
      n.show();
    } catch (_) {}
  }

  if (!reminderWindow || reminderWindow.isDestroyed()) {
    createReminderWindow();
    reminderWindow.webContents.once('did-finish-load', () => {
      reminderWindow.webContents.send('reminder:show', payload);
      presentReminder();
    });
  } else {
    reminderWindow.webContents.send('reminder:show', payload);
    presentReminder();
  }

  // 60 秒未处理 → 记一次忽略（惩罚）
  if (!extra.test) {
    setTimeout(() => {
      if (reminderWindow && !reminderWindow.isDestroyed() && reminderWindow.isVisible()) {
        reminderWindow.hide();
        registerStrike(plan.id);
      }
    }, 60000);
  }
}

function presentReminder() {
  if (!reminderWindow || reminderWindow.isDestroyed()) return;
  reminderWindow.setAlwaysOnTop(true, 'screen-saver');
  reminderWindow.show();
  reminderWindow.focus();
  // 调试用：PQ_SHOT_R=<路径> 时自动截取提醒弹窗画面
  if (process.env.PQ_SHOT_R) {
    setTimeout(async () => {
      try {
        const img = await reminderWindow.webContents.capturePage();
        fs.writeFileSync(process.env.PQ_SHOT_R, img.toPNG());
        console.log('[shot-r] saved');
      } catch (err) {
        console.error('[shot-r] failed', err);
      }
    }, 2500);
  }
}

/* ------------------------------------------------------------------ */
/* 窗口                                                                */
/* ------------------------------------------------------------------ */

/* 局域网房间独立窗口：同一套界面，?view=study&standalone=1 隐藏侧栏 */
function openRoomWindow(type) {
  const t = type === 'fun' ? 'fun' : 'study';
  if (roomWindow && !roomWindow.isDestroyed()) {
    roomWindow.show();
    roomWindow.focus();
    return roomWindow;
  }
  roomWindow = new BrowserWindow({
    width: 1120,
    height: 780,
    minWidth: 860,
    minHeight: 600,
    show: false,
    frame: false,
    titleBarStyle: 'hidden',
    autoHideMenuBar: true,
    backgroundColor: data && data.settings && data.settings.theme === 'light' ? '#f4f5f9' : '#0e1020',
    title: 'PlanQuest · 房间',
    icon: path.join(ROOT, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  roomWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'), {
    query: { view: 'study', standalone: '1', roomtype: t },
  });
  roomWindow.once('ready-to-show', () => {
    if (roomWindow && !roomWindow.isDestroyed()) roomWindow.show();
  });
  roomWindow.on('closed', () => {
    roomWindow = null;
  });
  return roomWindow;
}

/* 异地联机独立窗口：和主界面分开，全屏/投屏都更自然 */
function openNetWindow(type) {
  const t = type === 'fun' ? 'fun' : 'study';
  if (netWindow && !netWindow.isDestroyed()) {
    netWindow.show();
    netWindow.focus();
    // 已经开着就只是把类型带过去（不影响已建立的连接）
    return netWindow;
  }
  netWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 860,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: data && data.settings && data.settings.theme === 'light' ? '#f4f5f9' : '#0e1020',
    title: 'PlanQuest · 异地联机',
    icon: path.join(ROOT, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  netWindow.loadFile(path.join(__dirname, 'renderer', 'net.html'), { query: { type: t } });
  netWindow.once('ready-to-show', () => {
    if (netWindow && !netWindow.isDestroyed()) netWindow.show();
  });
  netWindow.on('closed', () => {
    netWindow = null;
  });
  return netWindow;
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 900,
    minHeight: 620,
    show: false,
    frame: false,
    backgroundColor: data.settings.theme === 'light' ? '#f4f5f9' : '#0e1020',
    titleBarStyle: 'hidden',
    icon: path.join(ROOT, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'), {
    query: process.env.PQ_VIEW ? { view: process.env.PQ_VIEW } : undefined,
  });
  bootLog('主窗口已创建，开始加载界面');

  // 诊断钩子：渲染层任何异常都记进 boot.log，避免"进程活着但没界面"无从查起
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    bootLog(`界面加载失败 code=${code} ${desc} url=${url}`);
  });
  mainWindow.webContents.on('render-process-gone', (_e, d) => {
    bootLog('渲染进程退出 ' + JSON.stringify(d));
  });
  mainWindow.webContents.on('preload-error', (_e, p, err) => {
    bootLog('preload 报错 ' + p + ' :: ' + (err && err.message));
  });
  mainWindow.webContents.on('did-finish-load', () => {
    bootLog('界面加载完成');
    // 双击 .pqplan 启动：窗口就绪后再处理文件参数
    if (pendingOpenFile && openPlanFileHook) {
      bootLog('[pqplan] did-finish-load 处理文件: ' + pendingOpenFile);
      const f = pendingOpenFile; pendingOpenFile = null; openPlanFileHook(f);
    } else {
      bootLog('[pqplan] did-finish-load: pending=' + pendingOpenFile + ' hook=' + !!openPlanFileHook);
    }
  });

  // 兜底：万一 ready-to-show 没触发（渲染层异常等），8 秒后强制显示窗口，
  // 避免出现「进程活着但没有界面」的黑洞状态
  setTimeout(() => {
    try {
      if (LAUNCH_HIDDEN) return;
      if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
        bootLog('8 秒未显示窗口，强制 show');
        mainWindow.show();
        mainWindow.focus();
      }
    } catch (_) {}
  }, 8000);

  mainWindow.once('ready-to-show', () => {
    bootLog('ready-to-show 触发' + (LAUNCH_HIDDEN ? '（隐藏启动，不显示）' : ''));
    if (!LAUNCH_HIDDEN) mainWindow.show();
    // 调试用：PQ_SHOT=<路径> 时自动截取主窗口画面；PQ_SHOT_REPEAT=毫秒 可连续截图
    if (process.env.PQ_SHOT) {
      let n = 0;
      const take = async () => {
        try {
          // PQ_SHOT_SELECTOR：截图前滚动到指定元素
          if (process.env.PQ_SHOT_SELECTOR) {
            await mainWindow.webContents.executeJavaScript(
              `document.querySelector('${process.env.PQ_SHOT_SELECTOR}')?.scrollIntoView({block:'center'}); 'ok'`
            ).catch(() => {});
            await new Promise((r) => setTimeout(r, 400));
          }
          const img = await mainWindow.webContents.capturePage();
          const p = process.env.PQ_SHOT_REPEAT
            ? process.env.PQ_SHOT.replace(/\.png$/, `-${String(n++).padStart(2, '0')}.png`)
            : process.env.PQ_SHOT;
          fs.writeFileSync(p, img.toPNG());
          console.log('[shot] saved:', p);
        } catch (err) {
          console.error('[shot] failed', err);
        }
      };
      if (process.env.PQ_SHOT_REPEAT) {
        setTimeout(take, 3000);
        setInterval(take, Number(process.env.PQ_SHOT_REPEAT) || 5000);
      } else {
        const delay = Number(process.env.PQ_SHOT_DELAY) || 3500;
        setTimeout(take, delay);
      }
    }

    // 调试用：PQ_TEST_REDEEM=<商品id> 实测兑换流程（先测积分不足，再充 100 分测成功）
    if (process.env.PQ_TEST_REDEEM) {
      setTimeout(async () => {
        try {
          const id = process.env.PQ_TEST_REDEEM;
          const r1 = await mainWindow.webContents.executeJavaScript(
            `(async () => JSON.stringify(await api.shopRedeem('${id}')))()`
          );
          console.log('[redeem-test] 积分不足拦截:', r1);
          setProfilePoints(100);
          saveNow();
          const r2 = await mainWindow.webContents.executeJavaScript(
            `(async () => JSON.stringify(await api.shopRedeem('${id}')))()`
          );
          console.log('[redeem-test] 充值后兑换:', r2);
        } catch (err) {
          console.error('[redeem-test] failed', err);
        }
      }, 9000);
    }
  });

  mainWindow.on('close', (e) => {
    if (!quitting && data.settings.closeToTray) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // 转发渲染进程日志，便于排查
  mainWindow.webContents.on('console-message', (_e, _level, message, line, sourceId) => {
    if (/error|Error|未捕获|Uncaught|\[pq\]/i.test(message)) {
      console.log(`[renderer] ${message} (${sourceId}:${line})`);
    }
  });
}

function createReminderWindow() {
  reminderWindow = new BrowserWindow({
    width: 420,
    height: 260,
    show: false,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: false,
    transparent: true,
    hasShadow: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  reminderWindow.loadFile(path.join(__dirname, 'renderer', 'reminder.html'));
  reminderWindow.on('closed', () => {
    reminderWindow = null;
  });
}

function showUnlistedWindow(payload) {
  if (unlistedWindow && !unlistedWindow.isDestroyed()) {
    unlistedWindow.webContents.send('unlisted:data', payload);
    unlistedWindow.show();
    unlistedWindow.focus();
    return;
  }
  unlistedWindow = new BrowserWindow({
    width: 440,
    height: 380,
    show: false,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: false,
    transparent: true,
    hasShadow: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  unlistedWindow.loadFile(path.join(__dirname, 'renderer', 'unlisted.html'));
  unlistedWindow.webContents.on('did-finish-load', () => {
    if (!unlistedWindow || unlistedWindow.isDestroyed()) return;
    unlistedWindow.webContents.send('unlisted:data', payload);
    unlistedWindow.show();
    unlistedWindow.setAlwaysOnTop(true, 'screen-saver');
  });
  unlistedWindow.on('closed', () => {
    unlistedWindow = null;
  });
}

function showMainWindow() {
  bootLog('请求显示主窗口');
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow();
    return;
  }
  try {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    mainWindow.setAlwaysOnTop(true); // 抢一次置顶，避免被其它窗口压住看起来像"没打开"
    mainWindow.setAlwaysOnTop(false);
    bootLog('主窗口已显示 visible=' + mainWindow.isVisible());
  } catch (err) {
    bootLog('显示主窗口失败：' + (err && err.message));
  }
}

/* ------------------------------------------------------------------ */
/* 托盘                                                                */
/* ------------------------------------------------------------------ */

function buildTrayMenu() {
  if (!tray) return;
  const streak = computeStreak();
  const menu = Menu.buildFromTemplate([
    { label: `${APP_NAME} · 连续 ${streak} 天`, enabled: false },
    { type: 'separator' },
    { label: '打开主界面', click: showMainWindow },
    {
      label: '现在试一次提醒',
      click: () => {
        const key = dateKey();
        const due = plansForDate(key);
        const plan = due.find((p) => logOf(key)[p.id]?.status !== 'done') || due[0] || data.plans[0];
        if (plan) openReminder(plan, { test: true });
      },
    },
    { type: 'separator' },
    {
      label: '开机自启',
      type: 'checkbox',
      checked: getAutoStart(),
      click: (item) => {
        data.settings.autoStart = item.checked;
        setAutoStart(item.checked);
        saveNow();
      },
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        quitting = true;
        app.quit();
      },
    },
  ]);
  tray.setToolTip(`${APP_NAME} · 今日 ${completedCount(dateKey())} 项已完成`);
  tray.setContextMenu(menu);
}

function createTray() {
  const img = nativeImage.createFromPath(path.join(ROOT, 'assets', 'icon.png'));
  tray = new Tray(img.resize({ width: 18, height: 18 }));
  tray.setToolTip(APP_NAME);
  tray.on('double-click', showMainWindow);
  tray.on('click', showMainWindow);
  buildTrayMenu();
}

/* ------------------------------------------------------------------ */
/* IPC                                                                 */
/* ------------------------------------------------------------------ */


  /* ---------------- 计划文件（.pqplan 专用格式） ----------------
   * 信封：{ magic, format, app, version, exportedAt, from, checksum, data }
   * checksum = sha256(JSON.stringify(data))，导入时重算比对，防篡改/损坏。
   * data 与「同步码」载荷一致（完整 data.json 结构），跨版本走 normalize。 */

  const PLAN_MAGIC = 'PLANQUEST-PLAN';
  const PLAN_FORMAT = 1;

  function planSha256(s) {
    return require('node:crypto').createHash('sha256').update(s, 'utf8').digest('hex');
  }

  /* 按范围裁剪信封数据：all=全部 / normal=仅普通计划 / contract=仅契约项目与契约任务 / meta=仅军团元数据 */
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
    // 日志只保留该范围计划的打卡记录；日内容（三件事/小结/全勤）只在全部导出时保留
    const keep = new Set((out.plans || []).map((p) => p.id));
    const log = {};
    for (const [k, day] of Object.entries(out.log || {})) {
      const nd = {};
      for (const [pid, rec] of Object.entries(day || {})) if (keep.has(pid)) nd[pid] = rec;
      if (Object.keys(nd).length) log[k] = nd;
    }
    out.log = log;
    if (scope !== 'all') {
      // 范围导入/导出只带计划与打卡记录，不夹带档案、目标、守护名单等其它数据
      for (const k of ['fired', 'snooze', 'bonus', 'mits', 'diary', 'reviews', 'makeups', 'grayRedeem', 'guardian', 'shop', 'profile', 'goals', 'pomodoro', 'focus', 'lastRemind', 'reminderStrikes', 'settings']) delete out[k];
    }
    return out;
  }

  function buildPlanEnvelope(scope, legion) {
    const payload = filterDataByScope(data, scope);
    const env = {
      magic: PLAN_MAGIC,
      format: PLAN_FORMAT,
      app: 'PlanQuest',
      version: '2.9.11',
      exportedAt: new Date().toISOString(),
      from: 'PlanQuest 桌面版',
      checksum: planSha256(JSON.stringify(payload)),
      data: payload,
    };
    const lg = sanitizeLegionMeta(legion);
    if (lg) env.legion = lg;
    return env;
  }

  /* 军团元数据白名单：只带身份字段，不带打卡明细/聚合概况/在线状态 */
  function sanitizeLegionMeta(src) {
    if (!src || typeof src !== 'object') return null;
    const KEYS = ['joined', 'role', 'net', 'code', 'alias', 'uid', 'ip', 'port', 'intervalH', 'createdAt', 'paused', 'mutedLocal'];
    const BOOL = new Set(['joined', 'paused', 'mutedLocal']);
    const NUM = new Set(['port', 'intervalH', 'createdAt']);
    const out = {};
    let any = false;
    for (const k of KEYS) {
      if (src[k] === undefined) continue;
      if (BOOL.has(k)) { out[k] = !!src[k]; any = true; }
      else if (NUM.has(k)) { out[k] = Number(src[k]) || 0; any = true; }
      else { out[k] = String(src[k]).slice(0, 64); any = true; }
    }
    return any ? out : null;
  }

  function validatePlanEnvelope(env) {
    if (!env || typeof env !== 'object') return { ok: false, error: '文件内容不是有效的 JSON' };
    if (env.magic !== PLAN_MAGIC) return { ok: false, error: '不是 PlanQuest 计划文件（应选 .pqplan 文件）' };
    if (Number(env.format) !== PLAN_FORMAT) return { ok: false, error: '格式版本不支持（format=' + env.format + '）' };
    if (!env.data || typeof env.data !== 'object' || !Array.isArray(env.data.plans)) {
      return { ok: false, error: '文件缺少计划数据' };
    }
    if (env.checksum) {
      const sum = planSha256(JSON.stringify(env.data));
      if (sum !== env.checksum) return { ok: false, error: '校验和不匹配：文件可能已损坏或被手动改动' };
    }
    return { ok: true, data: env.data, legion: sanitizeLegionMeta(env.legion) };
  }

  function mergeListsMain(a, b) {
    const seen = new Set((a || []).map((x) => String(x).toLowerCase()));
    const out = [...(a || [])];
    for (const x of b || []) {
      const k = String(x).toLowerCase();
      if (!seen.has(k)) { seen.add(k); out.push(x); }
    }
    return out;
  }

  function mergeIncoming(inc) {
    inc = normalize(inc);
    const stats = { plans: 0, logs: 0, goals: 0, contracts: 0, shop: 0 };
    const byId = (arr) => new Map((arr || []).filter((x) => x && x.id).map((x) => [x.id, x]));
    const mergeArr = (key, incArr) => {
      const cur = byId(data[key]);
      let n = 0;
      for (const item of incArr || []) {
        if (item && item.id && !cur.has(item.id)) { cur.set(item.id, item); n++; }
      }
      data[key] = [...cur.values()];
      return n;
    };
    stats.plans = mergeArr('plans', inc.plans);
    stats.goals = mergeArr('goals', inc.goals);
    stats.contracts = mergeArr('contracts', inc.contracts);
    stats.cprojects = mergeArr('contractProjects', inc.contractProjects);
    for (const [k, day] of Object.entries(inc.log || {})) {
      data.log[k] = data.log[k] || {};
      for (const [pid, rec] of Object.entries(day || {})) {
        const cur = data.log[k][pid];
        if (!cur || (rec?.at || 0) > (cur?.at || 0)) { data.log[k][pid] = rec; stats.logs++; }
      }
    }
    for (const k of ['fired', 'snooze', 'bonus', 'mits', 'diary', 'reviews', 'makeups', 'grayRedeem']) {
      for (const [k2, v] of Object.entries(inc[k] || {})) {
        if (data[k][k2] === undefined) data[k][k2] = v;
        else if (typeof v === 'object' && v && typeof data[k][k2] === 'object') Object.assign(data[k][k2], v);
      }
    }
    const pickBigger = (a, b) => (Math.abs(Number(b) || 0) > Math.abs(Number(a) || 0) ? Number(b) || 0 : Number(a) || 0);
    for (const k of ['points', 'totalDone', 'bestStreak', 'perfectDays', 'focusMinutes', 'pomodoros'])
      data.profile[k] = pickBigger(data.profile[k], inc.profile[k]);
    data.guardian.whitelist = mergeListsMain(data.guardian.whitelist, inc.guardian.whitelist);
    data.guardian.graylist = mergeListsMain(data.guardian.graylist, inc.guardian.graylist);
    data.guardian.blacklist = mergeListsMain(data.guardian.blacklist, inc.guardian.blacklist);
    data.guardian.enabled = data.guardian.enabled || inc.guardian.enabled;
    if (!data.guardian.hash && inc.guardian.hash) {
      data.guardian.user = inc.guardian.user; data.guardian.salt = inc.guardian.salt; data.guardian.hash = inc.guardian.hash;
    }
    const shopIds = new Set(data.shop.items.map((x) => x.id));
    for (const it of inc.shop.items || []) if (!shopIds.has(it.id)) { data.shop.items.push(it); stats.shop++; }
    const histKeys = new Set(data.shop.history.map((h) => JSON.stringify(h)));
    for (const h of inc.shop.history || []) { const k = JSON.stringify(h); if (!histKeys.has(k)) { data.shop.history.push(h); histKeys.add(k); } }
    return stats;
  }
function registerIpc() {
  // 计划里新增「非白名单普通软件」时的代价（唯一与积分挂钩的计划操作）
  const PLAN_PROC_PENALTY = 10;

  ipcMain.handle('state:get', () => snapshot());

  /* ---------- 云同步：给渲染层读写本机原始数据 ---------- */
  ipcMain.handle('cloud:get', () => JSON.parse(JSON.stringify(data || {})));

  ipcMain.handle('cloud:apply', (_e, incoming) => {
    if (!incoming || typeof incoming !== 'object') return { ok: false, message: '云端数据格式不正确' };
    const next = normalize(incoming);
    /* 这些是「这台电脑」的设置，不跟随云端：
       开机自启 / 主题 / 提醒节奏 / 护眼开关 / 守护密码与名单 / 托盘与专注模式 */
    next.settings = data.settings;
    next.guardian = data.guardian;
    next.focusMode = data.focusMode;
    next.iconHiddenBackup = data.iconHiddenBackup;
    next.fired = data.fired;
    next.snooze = data.snooze;
    next.lastRemind = data.lastRemind;
    next.reminderStrikes = data.reminderStrikes;
    next.version = data.version || 1;
    // 云端可能没有商城种子标记：本机已铺过底就保持，避免重复铺默认商品
    if (data.shop && data.shop.seeded) next.shop = { ...next.shop, seeded: true };
    data = next;
    suppressCloudNotify = true;
    try {
      saveNow();
    } finally {
      suppressCloudNotify = false;
    }
    return { ok: true };
  });

  ipcMain.handle('plan:save', (_e, payload) => {
    const plan = payload?.plan || payload;
    const password = payload?.password;
    const isEdit = !!(plan && plan.id && data.plans.some((p) => p.id === plan.id));
    if (guardian.hasPassword() && !guardian.verify(password)) {
      return { ok: false, needPassword: true };
    }
    if (!plan) return { ok: false };
    // 计划内需要的进程：不允许与黑/灰名单重叠（否则等于自己开洞）
    const rawAllow = (Array.isArray(plan.allowProcs) ? plan.allowProcs : [])
      .map((x) => String(x || '').trim().replace(/\.exe$/i, ''))
      .filter(Boolean);
    const allowProcs = [];
    const rejected = [];
    for (const n of rawAllow) {
      const low = guardian.normName(n);
      if (!low) continue;
      if (
        guardian.state.blacklist.some((x) => guardian.normName(x) === low) ||
        guardian.state.graylist.some((x) => guardian.normName(x) === low)
      ) {
        if (!rejected.includes(n)) rejected.push(n);
        continue;
      }
      if (!allowProcs.some((x) => guardian.normName(x) === low)) allowProcs.push(n);
    }
    const clean = {
      id: plan.id || 'p-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      title: String(plan.title || '').trim() || '未命名计划',
      desc: String(plan.desc || '').slice(0, 200),
      icon: plan.icon || '✅',
      color: plan.color || 'mint',
      when: plan.when === 'boot' ? 'boot' : 'time',
      time: plan.time || '09:00',
      days: Array.isArray(plan.days) && plan.days.length ? plan.days : [0, 1, 2, 3, 4, 5, 6],
      points: Math.max(5, Math.min(200, Number(plan.points) || 20)),
      allowProcs: allowProcs.slice(0, 12),
      needConfirm: !!plan.needConfirm,
      enabled: plan.enabled !== false,
      contract: plan.contract && (data.contractProjects || []).some((c) => c.id === plan.contract) ? plan.contract : null,
      createdAt: plan.createdAt || new Date().toISOString(),
    };
    // 积分只跟「计划里放行非白名单普通软件」这一件事挂钩：
    // 新增了非白名单的普通软件才扣 10 分；改标题/时间/星期、或只放行白名单软件，一律不扣分
    // 必须在写入 data.plans 之前取旧值，否则算不出「新增」
    const prevPlan = isEdit ? data.plans.find((p) => p.id === clean.id) : null;
    const prevSet = new Set((prevPlan?.allowProcs || []).map((x) => guardian.normName(x)));
    const normalAdded = allowProcs.filter((n) => {
      const low = guardian.normName(n);
      if (prevSet.has(low)) return false; // 以前就放行过，不算新增
      return !guardian.state.whitelist.some((x) => guardian.normName(x) === low);
    });
    const idx = data.plans.findIndex((p) => p.id === clean.id);
    if (idx >= 0) data.plans[idx] = clean;
    else data.plans.push(clean);
    // 契约任务创建/编辑一律不扣分；普通计划只在「新增非白名单普通软件」时扣 10 分
    const deducted = !clean.contract && normalAdded.length ? PLAN_PROC_PENALTY : 0;
    // 扣分可以扣成负分（负分触发名单升级）
    if (deducted) data.profile.points = (data.profile.points || 0) - deducted;
    saveNow();
    return { ok: true, id: clean.id, deducted, rejected, normalProcs: normalAdded };
  });

  ipcMain.handle('plan:delete', (_e, payload) => {
    const id = payload?.id || payload;
    const password = payload?.password;
    if (guardian.hasPassword() && !guardian.verify(password)) {
      return { ok: false, needPassword: true };
    }
    const existed = data.plans.some((p) => p.id === id);
    const isTemp = data.plans.some((p) => p.id === id && p.temp);
    // 契约任务到期前不可删除
    const cPlan = data.plans.find((p) => p.id === id);
    if (cPlan?.contract) {
      const c = (data.contractProjects || []).find((x) => x.id === cPlan.contract);
      if (c && !contractExpired(c)) {
        return { ok: false, message: `契约任务在项目到期（${contractEndDate(c)}）前不可删除` };
      }
    }
    data.plans = data.plans.filter((p) => p.id !== id);
    delete data.snooze[id];
    // 关闭/删除计划不再扣分：积分只跟「计划放行非白名单普通软件」挂钩
    const deducted = 0;
    saveNow();
    broadcast();
    return { ok: true, deducted };
  });

  ipcMain.handle('plan:toggle', (_e, { id, enabled }) => {
    const p = data.plans.find((x) => x.id === id);
    if (p) p.enabled = !!enabled;
    // 暂停 / 重新启用都不扣分（积分只跟「计划放行非白名单普通软件」挂钩）
    saveNow();
    broadcast();
    return { ok: true, deducted: 0 };
  });

  ipcMain.handle('checkin:do', (_e, payload) => {
    // 兼容老调用（直接传 id）和新调用（{ planId, password }）
    const planId = typeof payload === 'string' ? payload : payload?.planId;
    const password = typeof payload === 'object' && payload ? payload.password : undefined;
    const res = doCheckin(planId, dateKey(), password);
    return res;
  });

  ipcMain.handle('checkin:undo', (_e, planId) => undoCheckin(planId));

  ipcMain.handle('settings:update', (_e, patch) => {
    const clean = { ...(patch || {}) };
    // 护眼模式的开关与节奏必须走 eyecare:toggle / eyecare:plan（要验证守护密码），不能从通用设置绕过
    delete clean.eyeCare;
    delete clean.eyeCarePlan;
    // 异地通道：白名单清洗，别让任意结构塞进设置
    if ('netMode' in clean && clean.netMode !== 'relay') clean.netMode = 'direct';
    if ('netTurn' in clean) {
      const t = clean.netTurn;
      clean.netTurn =
        t && t.urls && String(t.urls).trim()
          ? {
              urls: String(t.urls).trim().slice(0, 500),
              username: String(t.username || '').slice(0, 100),
              credential: String(t.credential || '').slice(0, 100),
            }
          : null;
    }
    /* 私有仓库配置：只收白名单字段；token 留空表示「不改」，避免回填时被空值覆盖 */
    if ('pkRepo' in clean) {
      const p = clean.pkRepo || {};
      const cur = data.settings.pkRepo || {};
      const t = String(p.token || '').trim();
      const bak = p.backup || {};
      /* 先摘掉，别让 Object.assign 把没清洗的原始对象写进去 */
      delete clean.pkRepo;
      data.settings.pkRepo = {
        owner: String(p.owner || '').trim().slice(0, 80),
        repo: String(p.repo || '').trim().slice(0, 80),
        branch: String(p.branch || 'main').trim().slice(0, 80) || 'main',
        token: t ? t.slice(0, 200) : String(cur.token || ''),
        oauthAt: Number(cur.oauthAt) || 0,
        backup: {
          owner: String(bak.owner || '').trim().slice(0, 80),
          repo: String(bak.repo || '').trim().slice(0, 80),
          branch: String(bak.branch || 'main').trim().slice(0, 80) || 'main',
        },
      };
    }
    /* OAuth App 的 Client ID：公开信息，但仍然只收这一个字段 */
    if ('pkOAuth' in clean) {
      const o = clean.pkOAuth || {};
      delete clean.pkOAuth;
      data.settings.pkOAuth = { clientId: String(o.clientId || '').trim().slice(0, 60) };
    }
    /* 版本更新源：兼容旧的单数 updateBase，同时收多源数组 updateSources。
     * 只收 http(s) 链接，最多 8 条，每条 300 字；不接收对象里的其它字段。 */
    if ('updateBase' in clean) {
      const v = String(clean.updateBase || '').trim().replace(/\/+$/, '').slice(0, 300);
      clean.updateBase = /^https?:\/\//i.test(v) ? v : '';
    }
    if ('updateSources' in clean) {
      const arr = Array.isArray(clean.updateSources) ? clean.updateSources : [];
      clean.updateSources = arr.slice(0, 8).map((x) => String(x || '').trim().replace(/\/+$/, '').slice(0, 300))
        .filter((v) => /^https?:\/\//i.test(v));
    }
    Object.assign(data.settings, clean);
    if ('autoStart' in clean) setAutoStart(!!data.settings.autoStart);
    saveNow();
    return snapshot();
  });

  /* 只允许打开 https：OAuth 验证页面、GitHub 设置页都用它 */
  ipcMain.handle('app:openExternal', (_e, url) => {
    const u = String(url || '');
    if (!/^https:\/\//i.test(u)) return { ok: false, message: '只允许打开 https 链接' };
    require('electron').shell.openExternal(u);
    return { ok: true };
  });

  ipcMain.handle('app:openDataFolder', () => {    shell.showItemInFolder(dataFile);
    return { ok: true };
  });

  ipcMain.handle('app:export', async () => {
    const { dialog } = require('electron');
    const res = await dialog.showSaveDialog(mainWindow, {
      title: '导出数据',
      defaultPath: 'planquest-backup.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (res.canceled || !res.filePath) return { ok: false };
    /* 备份文件里不带仓库 token：那是本机凭据，不该跟着文件流动 */
    const copy = JSON.parse(JSON.stringify(data));
    if (copy.settings && copy.settings.pkRepo) {
      copy.settings.pkRepo = { ...copy.settings.pkRepo, token: '' };
    }
    if (copy.pkKeys) delete copy.pkKeys; // 签名私钥同理，换机请重新生成
    fs.writeFileSync(res.filePath, JSON.stringify(copy, null, 2), 'utf8');
    return { ok: true, path: res.filePath };
  });


  /* 空白模板：给「文件是空的 / 结构不对」的 .pqplan 一键修复用 */
  function blankPlanEnvelope() {
    const payload = defaultData();
    return {
      magic: PLAN_MAGIC,
      format: PLAN_FORMAT,
      app: 'PlanQuest',
      version: '2.9.11',
      exportedAt: new Date().toISOString(),
      from: 'PlanQuest 空白模板',
      checksum: planSha256(JSON.stringify(payload)),
      data: payload,
    };
  }

  function writePlanFile(filePath, envelope) {
    fs.writeFileSync(filePath, JSON.stringify(envelope, null, 2), 'utf8');
  }

  /* 双击 .pqplan 文件（桌面版文件关联入口）：
     - 文件为空 / 损坏 / 结构不对 → 弹窗问「是否按空白模版填充」（填充 = 覆盖写回这个文件）
     - 有效文件 → 弹窗选「导入文件（合并）/ 导入文件（覆盖）/ 导出文件（当前计划覆盖此文件）」 */
  async function openPlanFile(filePath) {
    try {
      bootLog('[pqplan] openPlanFile 开始: ' + filePath);
      const { dialog } = require('electron');
      let raw = '';
      try { raw = fs.readFileSync(filePath, 'utf8'); } catch (_) {}
      const trimmed = String(raw || '').trim();
      if (!trimmed) {
        const r = await dialog.showMessageBox({
          type: 'question',
          title: '计划文件',
          message: '这个 .pqplan 文件是空的',
          detail: path.basename(filePath) + '\n\n是否按空白模版填充？填充后即可用 PlanQuest 继续编辑。',
          buttons: ['按空白模版填充', '取消'],
          defaultId: 0, cancelId: 1, noLink: true,
        });
        if (r.response === 0) {
          writePlanFile(filePath, blankPlanEnvelope());
          notifyPlanDataChanged();
          showMainWindow();
        }
        return;
      }
      let env = null;
      try { env = JSON.parse(trimmed); } catch (_) {}
      const v = env ? validatePlanEnvelope(env) : { ok: false, error: '文件内容不是有效的 JSON' };
      if (!v.ok) {
        const r = await dialog.showMessageBox({
          type: 'warning',
          title: '计划文件',
          message: '文件存在问题',
          detail: path.basename(filePath) + '\n' + (v.error || '结构不完整') + '\n\n是否按空白模版填充？（将覆盖写入此文件）',
          buttons: ['按空白模版填充', '取消'],
          defaultId: 0, cancelId: 1, noLink: true,
        });
        if (r.response === 0) {
          writePlanFile(filePath, blankPlanEnvelope());
          notifyPlanDataChanged();
          showMainWindow();
        }
        return;
      }
      const d0 = await dialog.showMessageBox({
        type: 'question',
        title: '计划文件',
        message: 'PlanQuest 计划文件：' + path.basename(filePath),
        detail:
          '包含 ' + (v.data.plans || []).filter((p) => !p.contract).length + ' 个普通计划、' +
          (v.data.plans || []).filter((p) => p.contract).length + ' 个契约任务（' +
          (v.data.contractProjects || []).length + ' 个契约项目）。\n导入：把文件内容合入应用；\n导出：用应用当前的' +
          '计划覆盖这个文件。',
        buttons: ['导入文件…', '导出文件（覆盖此文件）', '取消'],
        defaultId: 0, cancelId: 2, noLink: true,
      });
      if (d0.response === 1) {
        writePlanFile(filePath, buildPlanEnvelope('all'));
        notifyPlanDataChanged();
        showMainWindow();
        return;
      }
      if (d0.response !== 0) return;
      const s = await dialog.showMessageBox({
        type: 'question',
        title: '导入范围',
        message: '要导入哪些内容？',
        detail: '普通计划：不带契约标记的日常计划；契约计划：契约项目与项目里的子任务（含各自的打卡记录）。',
        buttons: ['全部内容', '仅普通计划', '仅契约计划', '取消'],
        defaultId: 0, cancelId: 3, noLink: true,
      });
      if (s.response === 3) return;
      const scope = ['all', 'normal', 'contract'][s.response];
      const m = await dialog.showMessageBox({
        type: 'question',
        title: '导入方式',
        message: '选择导入方式',
        detail: '合并导入：与现有数据去重合入，本机已有的记录优先；\n覆盖导入：用文件里的这一类计划替换本机同类计划。',
        buttons: ['合并导入（推荐）', '覆盖导入', '取消'],
        defaultId: 0, cancelId: 2, noLink: true,
      });
      if (m.response === 2) return;
      if (m.response === 0) {
        mergeIncoming(filterDataByScope(v.data, scope));
      } else {
        const scoped = filterDataByScope(v.data, scope);
        if (!scope || scope === 'all') data = normalize(scoped);
        else {
          const isC = (p) => p && p.contract;
          const delIds = new Set(data.plans.filter((p) => (scope === 'contract' ? isC(p) : !isC(p))).map((p) => p.id));
          data.plans = data.plans.filter((p) => (scope === 'contract' ? !isC(p) : isC(p)));
          if (scope === 'contract') data.contractProjects = [];
          for (const day of Object.values(data.log || {})) for (const pid of Object.keys(day)) if (delIds.has(pid)) delete day[pid];
          mergeIncoming(scoped);
        }
      }
      saveNow();
      notifyPlanDataChanged();
      showMainWindow();
    } catch (e) {
      bootLog('[pqplan] openPlanFile 出错: ' + e.message);
      try { require('electron').dialog.showErrorBox('计划文件', '打开失败：' + e.message); } catch (_) {}
    }
  }

  /* 文件关联（只写 HKCU，不需要管理员权限）：
     双击 .pqplan 用 PlanQuest 打开；资源管理器里显示专属图标 icon-plan.ico。
     便携版每次启动都重写一次，exe 挪位置后关联自动跟着走。 */
  function registerPlanFileAssoc() {
    try {
      const exe = process.execPath;
      const icoPath = path.join(path.dirname(exe), 'icon-plan.ico');
      const ico = fs.existsSync(icoPath) ? icoPath : exe + ',0';
      const { spawnSync } = require('node:child_process');
      const run = (args) => { try { spawnSync('reg', args, { windowsHide: true }); } catch (_) {} };
      run(['add', 'HKCU\\Software\\Classes\\.pqplan', '/ve', '/d', 'PlanQuest.plan', '/f']);
      run(['add', 'HKCU\\Software\\Classes\\PlanQuest.plan', '/ve', '/d', 'PlanQuest 计划文件', '/f']);
      run(['add', 'HKCU\\Software\\Classes\\PlanQuest.plan\\DefaultIcon', '/ve', '/d', ico, '/f']);
      run(['add', 'HKCU\\Software\\Classes\\PlanQuest.plan\\shell\\open\\command', '/ve', '/d', '"' + exe + '" "%1"', '/f']);
    } catch (_) {}
  }

  /* 暴露给启动流程（whenReady / second-instance / TCP 唤醒 / did-finish-load） */
  openPlanFileHook = openPlanFile;
  registerPlanFileAssocHook = registerPlanFileAssoc;

  ipcMain.handle('planfile:build', () => ({ ok: true, json: JSON.stringify(buildPlanEnvelope(), null, 2) }));

  /* 新建空白计划文件：弹「另存为」，写入空白信封（不动本机现有数据） */
  ipcMain.handle('planfile:new', async () => {
    try {
      const { dialog } = require('electron');
      const res = await dialog.showSaveDialog(mainWindow, {
        title: '新建空白计划文件（.pqplan）',
        defaultPath: `PlanQuest新计划-${dateKey()}.pqplan`,
        filters: [{ name: 'PlanQuest 计划', extensions: ['pqplan'] }],
      });
      if (res.canceled || !res.filePath) return { ok: false, canceled: true };
      const target = /\.pqplan$/i.test(res.filePath) ? res.filePath : res.filePath + '.pqplan';
      writePlanFile(target, blankPlanEnvelope());
      return { ok: true, path: target };
    } catch (e) {
      return { ok: false, message: e.message };
    }
  });

  ipcMain.handle('planfile:blank-template', (_e, filePath) => {
    try {
      if (!filePath || typeof filePath !== 'string') return { ok: false, message: '缺少文件路径' };
      writePlanFile(filePath, blankPlanEnvelope());
      return { ok: true, path: filePath };
    } catch (e) {
      return { ok: false, message: e.message };
    }
  });

  ipcMain.handle('planfile:export', async (_e, { scope, legion } = {}) => {
    const { dialog } = require('electron');
    const s = ['all', 'normal', 'contract', 'meta'].includes(scope) ? scope : 'all';
    const tip = s === 'normal' ? '-普通' : s === 'contract' ? '-契约' : s === 'meta' ? '-军团元数据' : '';
    const res = await dialog.showSaveDialog(mainWindow, {
      title: s === 'meta' ? '导出军团元数据（.pqplan）' : '导出计划文件（.pqplan）',
      defaultPath: `PlanQuest计划-${dateKey()}${tip}.pqplan`,
      filters: [{ name: 'PlanQuest 计划', extensions: ['pqplan'] }],
    });
    if (res.canceled || !res.filePath) return { ok: false };
    fs.writeFileSync(res.filePath, JSON.stringify(buildPlanEnvelope(s, legion), null, 2), 'utf8');
    return { ok: true, path: res.filePath };
  });

  ipcMain.handle('planfile:pick', async () => {
    const { dialog } = require('electron');
    const res = await dialog.showOpenDialog(mainWindow, {
      title: '导入计划文件（.pqplan）',
      filters: [{ name: 'PlanQuest 计划', extensions: ['pqplan', 'json'] }],
      properties: ['openFile'],
    });
    if (res.canceled || !res.filePaths || !res.filePaths[0]) return { ok: false };
    try {
      const env = JSON.parse(fs.readFileSync(res.filePaths[0], 'utf8'));
      const v = validatePlanEnvelope(env);
      if (!v.ok) return { ok: false, message: v.error, filePath: res.filePaths[0] };
      return { ok: true, data: v.data, legion: v.legion, source: path.basename(res.filePaths[0]) };
    } catch (e) {
      return { ok: false, message: '文件解析失败：' + e.message, filePath: res.filePaths[0] };
    }
  });

  ipcMain.handle('planfile:apply', (_e, { data: inc, mode, checksum, scope }) => {
    try {
      const v = validatePlanEnvelope({ magic: PLAN_MAGIC, format: PLAN_FORMAT, checksum, data: inc });
      if (!v.ok) return { ok: false, message: v.error };
      const scoped = filterDataByScope(v.data, scope);
      if (mode === 'replace' && (!scope || scope === 'all')) {
        data = normalize(scoped);
        saveNow();
        notifyPlanDataChanged();
        return { ok: true, message: `已覆盖导入：${data.plans.length} 个计划` };
      }
      if (mode === 'replace') {
        // 范围覆盖：只把本地这一类计划换成文件里的，其余数据保持不变
        const isC = (p) => p && p.contract;
        const delIds = new Set(data.plans.filter((p) => (scope === 'contract' ? isC(p) : !isC(p))).map((p) => p.id));
        data.plans = data.plans.filter((p) => (scope === 'contract' ? !isC(p) : isC(p)));
        if (scope === 'contract') data.contractProjects = [];
        for (const day of Object.values(data.log || {})) for (const pid of Object.keys(day)) if (delIds.has(pid)) delete day[pid];
      }
      const stats = mergeIncoming(scoped);
      saveNow();
      notifyPlanDataChanged();
      const scopeName = scope === 'normal' ? '普通计划' : scope === 'contract' ? '契约计划' : '全部内容';
      return {
        ok: true,
        message: `${mode === 'replace' ? '覆盖' : '合并'}导入完成（${scopeName}）：新增计划 ${stats.plans} · 合并打卡 ${stats.logs}`,
      };
    } catch (e) {
      return { ok: false, message: e.message };
    }
  });

  /* 转发计划到频道：把 .pqplan 信封整份装进消息附件（不落盘、不改本地数据）。
     显式由用户点「转发」才会发生 —— 计划里有备注，不能悄悄发出去。 */
  ipcMain.handle('planfile:forward', (_e, scope) => {
    try {
      const s = ['all', 'normal', 'contract'].includes(scope) ? scope : 'all';
      const env = buildPlanEnvelope(s);
      const json = JSON.stringify(env);
      if (json.length > 60000) {
        return { ok: false, message: '计划太大（超过 60KB），请用「导出」生成文件再发' };
      }
      const plans = (env.data && env.data.plans) || [];
      return {
        ok: true,
        name: s === 'normal' ? '普通计划' : s === 'contract' ? '契约计划' : '全部计划',
        count: plans.length,
        text: json,
        bytes: json.length,
      };
    } catch (e) {
      return { ok: false, message: String((e && e.message) || e) };
    }
  });

  /* 从频道收到的计划包：先进 24 小时沙箱（预览 + 二次确认 + 来源标记），
     转正才落到主计划；不直接合并，防整蛊防恶意条款 */
  ipcMain.handle('planfile:importText', (_e, payload = {}) => {
    try {
      const text = String((payload && payload.text) || '');
      const from = String((payload && payload.from) || '');
      const fromAlias = String((payload && payload.fromAlias) || '');
      if (planGuard.blocked(data.gov.planBan, from)) {
        return { ok: false, blocked: true, message: '对方已被军团长拉进计划文件黑名单，计划包已拦截' };
      }
      if (text.length < 20 || text.length > 60000) return { ok: false, message: '附件内容不完整' };
      const env = JSON.parse(text);
      const v = validatePlanEnvelope(env);
      if (!v.ok) return { ok: false, message: v.error };
      const src = planGuard.markSource(env, from, fromAlias, Date.now());
      const pv = planGuard.preview(env);
      data.sandbox = planGuard.sandboxPut(text, src, Date.now());
      saveNow();
      return {
        ok: true,
        sandboxed: true,
        preview: pv,
        src,
        sourceText: planGuard.sourceText(src),
        message: '已放入 24 小时沙箱：积分变动和契约执行都是虚拟的，不影响主计划；预览确认没问题后手动转正，有问题直接删。',
      };
    } catch (e) {
      return { ok: false, message: '导入失败：' + String((e && e.message) || e) };
    }
  });

  ipcMain.handle('reminder:action', (_e, { planId, action, test, password }) => {
    let result = null;
    if (action === 'done') {
      // 测试提醒不计入打卡与积分
      result = test ? { ok: true, test: true } : doCheckin(planId, dateKey(), password);
      delete data.reminderStrikes[planId];
      // 需要密码时不要收起弹窗，让渲染层弹密码框后重试
      if (result && result.needPassword) {
        return { ok: true, result };
      }
    } else if (action === 'snooze') {
      data.snooze[planId] = Date.now() + (Number(data.settings.snoozeMinutes) || 10) * 60000;
      delete data.reminderStrikes[planId];
      saveNow();
    } else if (action === 'skip') {
      const key = dateKey();
      data.fired[key] = data.fired[key] || {};
      data.fired[key][planId] = true;
      delete data.snooze[planId];
      delete data.reminderStrikes[planId];
      saveNow();
    }
    if (reminderWindow && !reminderWindow.isDestroyed()) reminderWindow.hide();
    return { ok: true, result };
  });

  ipcMain.handle('reminder:test', (_e, planId) => {
    const key = dateKey();
    const due = plansForDate(key);
    const plan =
      data.plans.find((p) => p.id === planId) ||
      due.find((p) => logOf(key)[p.id]?.status !== 'done') ||
      due[0] ||
      data.plans[0];
    if (!plan) return { ok: false, message: '还没有计划，先新建一个吧' };
    openReminder(plan, { test: true });
    return { ok: true };
  });

  // 窗口控制要作用于"发起调用的那个窗口"——独立窗口里点关闭/最小化不能误伤主窗口
  ipcMain.on('win:minimize', (e) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    w && w.minimize();
  });
  ipcMain.on('win:hide', () => mainWindow && mainWindow.hide());
  ipcMain.on('win:close', (e) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    w && w.close();
  });
  ipcMain.on('win:toggleFullscreen', (e) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (w) w.setFullScreen(!w.isFullScreen());
  });
  /* 查看/息屏等全屏浮层用：进入全屏并返回"之前是否已在全屏"，退出时据此还原 */
  ipcMain.handle('win:setFullscreen', (e, on) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (!w) return null;
    const before = w.isFullScreen();
    if (before !== !!on) w.setFullScreen(!!on);
    return before;
  });

  /* 局域网房间独立窗口：复用主页面，隐藏侧栏只显示自习视图 */
  ipcMain.handle('room:openWindow', (_e, type) => {
    openRoomWindow(type === 'fun' ? 'fun' : 'study');
    return { ok: true };
  });

  /* ---------------- 自习房 ---------------- */

  // 娱乐房：每 10 分钟 15 积分，最长 120 分钟
  const FUN_BLOCK_MIN = 10;
  const FUN_BLOCK_COST = 15;
  const FUN_MAX_MIN = 120;
  const funCost = (minutes) => Math.ceil(Math.max(1, minutes) / FUN_BLOCK_MIN) * FUN_BLOCK_COST;

  ipcMain.handle('room:create', async (_e, info = {}) => {
    const type = info && info.type === 'fun' ? 'fun' : 'study';
    let minutes = 0;
    let cost = 0;
    if (type === 'fun') {
      minutes = Math.max(FUN_BLOCK_MIN, Math.min(FUN_MAX_MIN, Number(info.minutes) || 30));
      cost = funCost(minutes);
      if ((data.profile.points || 0) < cost) {
        return { ok: false, message: `积分不足：${minutes} 分钟需 ${cost} 分，当前 ${data.profile.points || 0} 分` };
      }
      data.profile.points -= cost;
      data.shop.history.unshift({
        id: 'h-' + Date.now().toString(36),
        name: `娱乐房 ${minutes} 分钟`,
        icon: '🎉',
        cost,
        at: Date.now(),
        type: 'fun',
      });
      saveNow();
    }

    const res = await room.createRoom({
      name: data.profile.name || '房主',
      avatar: data.profile.avatar || '🙂',
      cred: guardian.credentialSummary(),
      type,
      minutes,
    });

    if (!res.ok && type === 'fun') {
      // 建房失败退回积分
      setProfilePoints((data.profile.points || 0) + (cost));
      saveNow();
      return res;
    }
    if (res.ok) {
      res.cost = cost;
      if (type === 'fun' && res.funEndsAt) {
        funAllowUntil = res.funEndsAt;
        guardian.setAllowUntil(res.funEndsAt); // 娱乐房期间放行灰名单（黑名单照杀）
      }
      discovery.update({ name: data.profile.name || '我', avatar: data.profile.avatar || '🙂', room: { code: res.code, type, port: res.port } });
      broadcast();
    }
    return res;
  });

  // 娱乐房入场费：按剩余时长每 30 分钟 15 分，最低 15、最高 60
  const funJoinFee = (leftMinutes) => Math.min(60, Math.max(15, Math.ceil(leftMinutes / 30) * 15));

  ipcMain.handle('room:probe', async (_e, { ip, port, code }) => {
    const info = await room.probeRoom({ ip, port: Number(port) || 48765, code: String(code || '') });
    if (!info.ok) return info;
    if (info.roomType !== 'fun') return { ...info, fee: 0, leftMin: 0, enough: true };
    const leftMin = info.funEndsAt ? Math.max(1, Math.ceil((info.funEndsAt - Date.now()) / 60000)) : 0;
    const fee = leftMin ? funJoinFee(leftMin) : 0;
    return { ...info, leftMin, fee, points: data.profile.points || 0, enough: (data.profile.points || 0) >= fee };
  });

  ipcMain.handle('room:join', async (_e, { ip, port, code }) => {
    const res = await room.joinRoom({
      ip,
      port,
      code,
      name: data.profile.name || '我',
      avatar: data.profile.avatar || '🙂',
      cred: guardian.credentialSummary(),
    });
    if (res.ok && res.type === 'fun') {
      const leftMin = res.funEndsAt ? Math.max(1, Math.ceil((res.funEndsAt - Date.now()) / 60000)) : 0;
      const fee = leftMin ? funJoinFee(leftMin) : 0;
      if ((data.profile.points || 0) < fee) {
        // 付不起入场费：立即退出房间
        room.leaveRoom();
        return { ok: false, message: `积分不足：加入娱乐房需 ${fee} 分，当前 ${data.profile.points || 0} 分` };
      }
      if (fee > 0) {
        data.profile.points -= fee;
        data.shop.history.unshift({
          id: 'h-' + Date.now().toString(36),
          name: `娱乐房入场 ${leftMin} 分钟`,
          icon: '🎟️',
          cost: fee,
          at: Date.now(),
          type: 'fun',
        });
        saveNow();
        broadcast();
      }
      res.fee = fee;
      funAllowUntil = res.funEndsAt;
      guardian.setAllowUntil(res.funEndsAt);
    }
    if (res.ok) {
      discovery.update({ name: data.profile.name || '我', avatar: data.profile.avatar || '🙂', room: { code: res.code || code, type: res.type || 'study', port: Number(port) || 48765 } });
    }
    broadcast();
    return res;
  });

  ipcMain.handle('room:leave', () => {
    const wasFun = !!funAllowUntil;
    room.leaveRoom();
    if (wasFun) {
      guardian.setAllowUntil(0); // 离开娱乐房立即恢复灰名单限制
      funAllowUntil = 0;
    }
    discovery.update({ room: null });
    broadcast();
    return { ok: true };
  });

  ipcMain.handle('room:reaction', (_e, emoji) => {
    room.sendReaction(emoji);
    return { ok: true };
  });

  /* 局域网语音信令（WebRTC 点对点，不依赖任何服务器） */
  ipcMain.handle('room:rtc', (_e, { to, data }) => {
    if (!to || !data) return { ok: false };
    return { ok: room.rtcSend(to, data) };
  });

  ipcMain.handle('room:state', (_e, state) => {
    room.sendState(state || {});
    return { ok: true };
  });

  /* ---------------- 军团（局域网批量同步，和自习房同一套 TCP 行协议） ----------------
   * 不做实时：成员每几小时推一次脱敏摘要，房主聚合后广播军团概况。
   * 未加入军团时这里一个包都不会发出去。 */

  ipcMain.handle('legion:create', async (_e, info = {}) => {
    const gate = disciplineState();
    if (!gate.canJoinLegion) return { ok: false, message: gate.reasons[0] || '军团资格已冻结' };
    const r = await legion.createLegion({
      code: info.code,
      alias: info.alias || data.profile.name || '我',
      uid: info.uid,
      credit: (data.credit || {}).score || 0,
    });
    /* 建团成功 = 立刻成为军团长（含复用本机已开的团） */
    if (r && r.ok) govClaimHost(r.uid || info.uid);
    return r;
  });

  ipcMain.handle('legion:join', async (_e, info = {}) => {
    const gate = disciplineState();
    if (!gate.canJoinLegion) return { ok: false, message: gate.reasons[0] || '军团资格已冻结' };
    return legion.joinLegion({
      ip: info.ip,
      port: Number(info.port) || 48770,
      code: info.code,
      alias: info.alias || data.profile.name || '我',
      uid: info.uid,
      intervalH: Number(info.intervalH) || 4,
      credit: (data.credit || {}).score || 0,
    });
  });

  ipcMain.handle('legion:leave', () => {
    const r = legion.leaveLegion();
    /* 退出即清台账：职务 / 投票 / 选举不带到下一团（换团夺权的老漏洞一起堵上） */
    govResetOnLeave();
    saveNow();
    broadcast();
    return r;
  });

  /* 摘要由渲染层生成，主进程只做白名单裁剪后转发 */
  ipcMain.handle('legion:push', (_e, bundle) => legion.pushBundle(bundle || {}));

  ipcMain.handle('legion:status', () => legion.snapshot());

  /* 军团治理：团内目录 / 投票 / 职务 / 举报 */
  ipcMain.handle('gov:state', () => govState());
  ipcMain.handle('gov:create', (_e, p) => govCreate(p));
  ipcMain.handle('gov:cast', (_e, p) => govCast(p));
  ipcMain.handle('gov:report', (_e, p) => govReportVote(p));
  ipcMain.handle('gov:assign', (_e, p) => govAssign(p));
  ipcMain.handle('gov:revoke', (_e, p) => govRevoke(p));
  ipcMain.handle('gov:announceLeave', (_e, p) => govAnnounceLeave(p));
  ipcMain.handle('gov:announceElection', () => govAnnounceElection());
  ipcMain.handle('gov:campaign', () => govCampaign());
  ipcMain.handle('gov:ballot', (_e, p) => govBallotVote(p));
  ipcMain.handle('gov:electionApply', (_e, p) => govElectionApply((p || {}).kind, p));

  /* 好友区（F0/F1/F2） */
  ipcMain.handle('friend:state', () => friendState());
  ipcMain.handle('friend:gateNew', (_e, p) => friendGateNew(p));
  ipcMain.handle('friend:gateAnswer', (_e, p) => friendGateAnswer(p));
  ipcMain.handle('friend:bond', (_e, p) => friendBondDo(p));
  ipcMain.handle('friend:peerRate', (_e, p) => friendPeerRate(p));
  ipcMain.handle('friend:send', (_e, p) => friendSendMsg(p));
  ipcMain.handle('friend:msgs', (_e, uid) => friendMsgsOf(uid));
  ipcMain.handle('friend:settle', () => ({ ok: true, notes: friendSettle() || [] }));
  ipcMain.handle('friend:rank', () => friendRank());
  ipcMain.handle('friend:pactSet', (_e, p) => friendPactSet(p));
  ipcMain.handle('friend:pactSettle', (_e, p) => friendPactSettle(p));

  /* 阿刺引擎：查表 + 外接模型（主进程代理请求，绕开 file:// 跨域）
   * p.opts 透传 maxTokens / maxChars / temperature —— 动手任务要输出动作 JSON，需要更长输出 */
  ipcMain.handle('ala:probe', (_e, cfg) => alaLLM.probe(alaLLM.nodeTransport(), cfg));
  ipcMain.handle('ala:ask', (_e, p) => {
    const cfg = alaLLM.cfgOf(p && p.cfg);
    if (!cfg.enabled) return { ok: false, detail: '模型已关闭' };
    return alaLLM.ask(cfg, (p && p.messages) || [], alaLLM.nodeTransport(), (p && p.opts) || {})
      .then((r) => ({ ok: true, text: r.text, model: r.model }))
      .catch((e) => ({ ok: false, detail: e && e.message ? e.message : '模型调用失败' }));
  });
  /* 联网搜（默认关）：只在这台机器上抓搜索页的标题+摘要，不存不传 */
  ipcMain.handle('ala:web', (_e, p) =>
    alaWeb.search(alaLLM.nodeTransport(), (p && p.q) || '', { endpoint: (p && p.endpoint) || '' }));

  /* 朗读：MeloTTS-ZH 本地服务（tools/melo-tts-server.py）
   * 协议是本项目自定的（/health + /tts），服务没起就返回 ok:false，
   * 渲染层自己回落系统语音 —— 这里绝不抛错打断对话 */
  ipcMain.handle('ala:ttsProbe', (_e, p) =>
    alaTTS.probe(alaLLM.nodeTransport(), { endpoint: p && p.endpoint, timeout: p && p.timeout }));
  /* 复制：渲染层的 navigator.clipboard 在 file:// 下常常不给用（还要用户手势），
   * 走主进程的 clipboard 才稳 —— 阿刺的回答一键复制不该看环境脸色 */
  ipcMain.handle('app:copy', (_e, t) => {
    try {
      clipboard.writeText(String(t == null ? '' : t).slice(0, 20000));
      return { ok: true };
    } catch (e) {
      return { ok: false, detail: e && e.message ? e.message : '写剪贴板失败' };
    }
  });
  ipcMain.handle('ala:tts', (_e, p) =>
    alaTTS.synth(alaLLM.nodeTransport(), (p && p.text) || '', {
      endpoint: p && p.endpoint, speed: p && p.speed, timeout: p && p.timeout,
    }));

  /* 军团集体任务 */
  ipcMain.handle('gov:collectiveSet', (_e, p) => collectiveSet(p));
  ipcMain.handle('gov:collectiveProgress', (_e, p) => collectiveProgress(p));

  /* Lv1 劝导 / Lv2 管制 / Lv3 驱逐 */
  ipcMain.handle('gov:fold', (_e, p) => govFoldMsg(p));
  ipcMain.handle('gov:watch', (_e, uid) => govWatchInfo(uid));
  ipcMain.handle('gov:moderateStart', (_e, p) => govModerateStart(p));
  ipcMain.handle('gov:evictStart', (_e, p) => govEvictStart(p));
  ipcMain.handle('gov:appeal', (_e, p) => govAppealSubmit(p));

  /* .pqplan 安全四件套 */
  ipcMain.handle('planfile:preview', (_e, p) => planPreviewText(p));
  ipcMain.handle('planfile:sandbox', () => planSandboxState());
  ipcMain.handle('planfile:sandboxPromote', () => planSandboxPromote());
  ipcMain.handle('planfile:sandboxDrop', () => planSandboxDrop());
  ipcMain.handle('planfile:banToggle', (_e, p) => planBanToggle(p));
  ipcMain.handle('gov:defs', () => ({ tiers: gov.TIERS, roles: gov.ROLE_LIST, perms: gov.PERMS, types: gov.TYPES, limits: gov.LIMITS }));

  /* 异地（P2P）：连接由渲染层 WebRTC 负责，主进程只当聚合枢纽，
     走与局域网完全相同的白名单与聚合口径 */
  ipcMain.handle('legion:hubStart', (_e, info = {}) => {
    const r = legion.startHub({
      code: info.code,
      alias: info.alias || data.profile.name || '我',
      uid: info.uid,
    });
    if (r && r.ok) govClaimHost(r.uid || info.uid);
    return r;
  });

  ipcMain.handle('legion:absorb', (_e, info = {}) =>
    legion.absorb({
      uid: info.uid,
      alias: info.alias,
      bundle: info.bundle,
    })
  );

  /* 网格模式：成员之间直连，各自算同一份聚合（不再由房主代算） */
  ipcMain.handle('legion:meshStart', (_e, info = {}) => {
    const r = legion.startMesh({
      code: info.code,
      alias: info.alias || data.profile.name || '我',
      uid: info.uid,
    });
    if (r && r.ok) govClaimHost(r.uid || info.uid);
    return r;
  });

  ipcMain.handle('legion:meshAbsorb', (_e, info = {}) =>
    legion.absorb({
      uid: info.uid,
      alias: info.alias,
      bundle: info.bundle,
    })
  );

  ipcMain.handle('legion:agg', () => legion.aggNow());
  ipcMain.handle('legion:pos', (_e, uid) => legion.positionOf(String(uid || '')));
  /* 集体挑战达标 → 记一枚徽章：次日打卡积分双倍（只奖不罚的那一半） */
  ipcMain.handle('legion:badge', (_e, weekKey) => {
    const k = String(weekKey || '');
    if (!k) return { ok: false };
    data.legion = data.legion || {};
    if (data.legion.badgeWeek === k) return { ok: true, already: true };
    data.legion.badgeWeek = k;
    const d = new Date();
    d.setDate(d.getDate() + 1);
    data.legion.badgeDate = dateKey(d);
    saveNow();
    return { ok: true, date: data.legion.badgeDate };
  });

  /* ---------------- 军团 PK（跨军团出操率对垒，布告栏 = 免费文件托管平台） ----------------
   * 只有军团主会往网上写东西；成员只读。没加入军团 → 一个请求都不发。 */
  legionPk.init({ data: () => data, saveNow: () => saveNow(), legion });
  ipcMain.handle('legion:pkStatus', () => legionPk.statusTick());
  ipcMain.handle('legion:pkJoin', () => {
    const gate = disciplineState();
    if (!gate.canPk) return { ok: false, message: gate.reasons[0] || '信誉分不足，暂不能参加 PK' };
    return legionPk.join();
  });
  setInterval(() => legionPk.tick().catch(() => {}), 30 * 60e3);
  setTimeout(() => legionPk.tick().catch(() => {}), 20 * 1000);

  /* 团长选举到点自动结算 + 好友区每日结算 + 集体任务结算：不依赖有人打开面板 */
  setInterval(() => {
    try {
      if (data.gov && data.gov.election && data.gov.election.status === 'open') govElectionTick();
      friendSettle();
      friendRemindTick();
      collectiveTick();
    } catch (_) {}
  }, 20 * 1000);

  /* 翻车救援：点灯要自己掏 5 分（每天最多 3 盏），积分不会凭空多出来；
     收到的一方也只能从军团救援池里领，不能无限刷 */
  ipcMain.handle('legion:lamp', () => {
    const today = (() => { const d = new Date(); const p2 = (x) => String(x).padStart(2, '0'); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`; })();
    data.legion = data.legion || {};
    if (data.legion.lampDay !== today) {
      data.legion.lampDay = today;
      data.legion.lampCount = 0;
    }
    if ((data.legion.lampCount || 0) >= 3) {
      return { ok: false, message: '今天的灯点完了（每天最多 3 盏）' };
    }
    if ((data.profile.points || 0) < 5) {
      return { ok: false, message: '积分不足 5 分 —— 先把自己顾好，再帮别人' };
    }
    data.profile.points -= 5;
    data.legion.lampCount = (data.legion.lampCount || 0) + 1;
    saveData();
    legion.lightLamp();
    return {
      ok: true,
      points: data.profile.points,
      left: 3 - data.legion.lampCount,
      rescue: (legion.aggNow() || {}).rescue || 0,
    };
  });

  /* 负分者领一盏灯：从军团救援池里取，每天最多 1 次，不能自己给自己点。
     这也是缓冲垫 → 同样只在强制模式下开放 */
  ipcMain.handle('legion:claimLamp', () => {
    if (!cushionOn()) return { ok: false, message: CUSHION_MSG };
    const today = (() => { const d = new Date(); const p2 = (x) => String(x).padStart(2, '0'); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`; })();
    data.legion = data.legion || {};
    if (data.legion.claimDay !== today) {
      data.legion.claimDay = today;
      data.legion.claimed = 0;
    }
    if ((data.legion.claimed || 0) >= 1) {
      return { ok: false, message: '今天已经领过一盏了，明天再来' };
    }
    if ((data.profile.points || 0) >= 0) {
      return { ok: false, message: '你现在不在坑里，把灯留给正在坑里的人' };
    }
    const agg = legion.aggNow() || {};
    if (!agg.rescue) return { ok: false, message: '军团救援池还是空的' };
    const take = legion.takeLamp();
    if (!take || !take.ok) return { ok: false, message: '救援池空了' };
    data.profile.points += 5;
    data.legion.claimed = 1;
    saveData();
    return { ok: true, points: data.profile.points, rescue: take.rescue };
  });
  ipcMain.handle('legion:mute', (_e, b) => legion.setMuted(!!b));
  /* 房主代记账：成员自己已经扣过分了，房主这边只 +1，不能再扣一次 */
  ipcMain.handle('legion:hostLamp', () => {
    legion.lightLamp();
    return { ok: true, rescue: (legion.aggNow() || {}).rescue || 0 };
  });

  /* ---------------- 聊天 / 禁言 / 拉人 ---------------- */

  ipcMain.handle('room:chat', (_e, text, link) => {
    const gate = disciplineState();
    if (!gate.canSpeak) return { ok: false, message: gate.reasons[0] || '暂时不能在房间发言' };
    /* 附件与军团频道同一套清洗：不认识的字段一律丢，计划包超 60KB 直接拒 */
    return room.sendChat(text, undefined, chatRulesLib.cleanLink(link));
  });

  /* ---------------- 军团频道（军团自己的频道，不是自习房闲聊） ----------------
   * 规则由团长定：开关 / 严格度 / 禁言时长 / 自定义词。
   * 判定在 src/legion-chat.js（纯函数），主进程只做「资格 + 转发 + 落盘」。 */

  ipcMain.handle('legion:chatState', () => legion.chatState());

  ipcMain.handle('legion:chatSend', (_e, text, invite, link) => {
    const gate = disciplineState();
    if (!gate.canSpeak) {
      return { ok: false, message: (gate.reasons && gate.reasons[0]) || '暂时不能在军团频道发言' };
    }
    /* 闲聊档位闸：L1 限 50 字+抽检，L0 雷达折叠，L2/L3 全解锁 */
    const tg = tierGateChat(String(text || ''));
    if (!tg.ok) return tg;
    const sh = creditShield.shieldOf((data.credit || {}).firstAt, Date.now());
    const inv = chatRulesLib.cleanInvite(invite);
    const lk = chatRulesLib.cleanLink(link);
    const r = legion.chatSend(String(text || ''), {
      credit: (data.credit && data.credit.score) || 0,
      newbie: sh.warnOnly === true,
      invite: inv || undefined,
      link: lk || undefined,
      rate: friendTodayRate(),
    });
    if (r && r.ok && tg.folded) r.folded = true;
    /* 频道发言本身不加信誉分：能刷的东西一定会被刷 */
    return r || { ok: false, message: '发送失败' };
  });

  ipcMain.handle('legion:tierInfo', () => legionTierInfo());

  /* 邀请军团成员进房间：只把「怎么连」交出去，房间状态仍然由本机房间模块说了算 */
  ipcMain.handle('room:inviteInfo', () => {
    const s = room.roomStatus();
    if (!s || !s.inRoom) return { ok: false, message: '你先开一个房间，才能邀请别人' };
    if (!s.isHost) return { ok: false, message: '只有房主能发房间邀请' };
    return { ok: true, invite: { ip: s.ip, port: s.port, code: s.code } };
  });

  ipcMain.handle('legion:chatRules', (_e, patch) => {
    const p = patch && typeof patch === 'object' ? patch : {};
    const clean = {};
    if ('on' in p) clean.on = p.on !== false;
    if ('level' in p) clean.level = String(p.level || '');
    if ('muteMin' in p) clean.muteMin = Number(p.muteMin) || 0;
    if ('words' in p) clean.words = Array.isArray(p.words) ? p.words.slice(0, 20) : String(p.words || '');
    const r = legion.setChatRules(clean);
    if (r && r.ok) govLog('chat_rules', legion.status().uid, chatRulesLib.rulesText(r.rules));
    return r;
  });

  ipcMain.handle('legion:chatMute', (_e, info = {}) => {
    const uid = String((info && info.uid) || '');
    if (info && info.clear) return legion.chatUnmute(uid);
    return legion.chatMute(uid, Number(info && info.minutes) || 0, String((info && info.reason) || ''));
  });

  ipcMain.handle('legion:chatDefs', () => ({ levels: chatRulesLib.levelList(), rules: legion.chatState().rules }));

  /* ---------------- LiveKit 语音（配置只存房主本机） ---------------- */

  ipcMain.handle('livekit:status', () => livekit.status());
  ipcMain.handle('livekit:config', (_e, cfg) => {
    if (!cfg || typeof cfg !== 'object') return { ok: false, message: '参数不对' };
    const ok = livekit.save({ url: cfg.url, apiKey: cfg.apiKey, apiSecret: cfg.apiSecret });
    return ok ? { ok: true } : { ok: false, message: '三项都要填：URL、API Key、API Secret' };
  });

  // 房间摄像头：自愿开启后，渲染层抓帧（JPEG dataURL）经房主中继给其他成员
  ipcMain.handle('room:camFrame', (_e, data) => {
    if (typeof data !== 'string' || data.length > 120000) return { ok: false };
    room.sendCamFrame(data);
    return { ok: true };
  });

  /* ---------------- 屏幕共享（自愿） ----------------
   * 渲染层先取可用源列表（整屏 / 各个窗口），用户选一个后经 getDisplayMedia 抓流；
   * 抓到的画面缩成 JPEG 帧，走房间通道中继给其他成员。 */

  // 列出可共享的屏幕与窗口（带缩略图），排除本应用窗口，避免自己看自己套娃
  ipcMain.handle('screen:sources', async () => {
    try {
      const list = await desktopCapturer.getSources({
        types: ['screen', 'window'],
        thumbnailSize: { width: 260, height: 160 },
        fetchWindowIcons: false,
      });
      return list
        .filter((s) => !/planquest/i.test(s.name || ''))
        .map((s) => ({
          id: s.id,
          name: s.name || '未命名窗口',
          kind: String(s.id).startsWith('screen') ? 'screen' : 'window',
          thumb: s.thumbnail && !s.thumbnail.isEmpty() ? s.thumbnail.toDataURL() : '',
        }));
    } catch (_) {
      return [];
    }
  });

  // 用户选定的源：只授权一次，getDisplayMedia 用掉即失效
  ipcMain.handle('screen:pick', async (_e, id) => {
    try {
      const list = await desktopCapturer.getSources({ types: ['screen', 'window'] });
      pickedDisplaySource = list.find((s) => s.id === String(id)) || null;
      if (!pickedDisplaySource) return { ok: false, msg: '找不到这个画面源，请重新选择' };
      return { ok: true, name: pickedDisplaySource.name };
    } catch (e) {
      pickedDisplaySource = null;
      return { ok: false, msg: String((e && e.message) || e) };
    }
  });

  ipcMain.handle('room:shareFrame', (_e, data) => {
    if (typeof data !== 'string' || data.length > 400000) return { ok: false };
    room.sendShareFrame(data);
    return { ok: true };
  });

  /* ---------------- 异地联机（点对点，信令不联网） ----------------
   * 只做本地连接码的压缩/解压与房间号生成，不发起任何网络请求。 */
  ipcMain.handle('net:create', () => netroom.createRoom());

  /* 异地房间：自习房免费；娱乐房按分钟扣积分，并放行灰名单（与局域网娱乐房同规则） */
  ipcMain.handle('net:createRoom', (_e, info = {}) => {
    const type = info && info.type === 'fun' ? 'fun' : 'study';
    const base = netroom.createRoom();
    if (!base.ok) return base;
    if (type !== 'fun') {
      return { ok: true, code: base.code, myId: base.myId, type: 'study', cost: 0, funEndsAt: 0 };
    }
    const minutes = Math.max(FUN_BLOCK_MIN, Math.min(FUN_MAX_MIN, Number(info.minutes) || 30));
    const cost = funCost(minutes);
    const points = data.profile.points || 0;
    if (points < cost) {
      return { ok: false, message: `积分不足：${minutes} 分钟需 ${cost} 分，当前 ${points} 分` };
    }
    setProfilePoints(points - cost);
    data.shop.history.unshift({
      id: 'h-' + Date.now().toString(36),
      name: `异地娱乐房 ${minutes} 分钟`,
      icon: '🎉',
      cost,
      at: Date.now(),
      type: 'fun',
    });
    const funEndsAt = Date.now() + minutes * 60000;
    funAllowUntil = funEndsAt;
    guardian.setAllowUntil(funEndsAt); // 娱乐房期间放行灰名单（黑名单照杀）
    saveNow();
    broadcast();
    return { ok: true, code: base.code, myId: base.myId, type: 'fun', cost, minutes, funEndsAt };
  });
  ipcMain.handle('net:peerId', (_e, prefix) => ({ ok: true, id: netroom.newPeerId(prefix) }));
  ipcMain.handle('net:pack', (_e, obj) => {
    try {
      const text = netroom.pack(obj);
      return { ok: true, text, len: text.length };
    } catch (e) {
      return { ok: false, msg: String((e && e.message) || e) };
    }
  });
  ipcMain.handle('net:unpack', (_e, text) => netroom.unpack(text));

  /* 异地联机：独立窗口打开，不叠在主界面之上 */
  ipcMain.handle('net:openWindow', (_e, type) => {
    openNetWindow(type);
    return { ok: true };
  });

  ipcMain.handle('room:mute', (_e, { id, minutes, reason }) => {
    const res = room.muteMember(id, minutes, reason);
    if (res.ok) broadcast();
    return res;
  });

  ipcMain.handle('room:unmute', (_e, id) => {
    const res = room.unmuteMember(id);
    if (res.ok) broadcast();
    return res;
  });

  ipcMain.handle('room:peers', () => discovery.list());

  ipcMain.handle('room:invite', (_e, { ip, port }) => discovery.invite(ip, port));

  ipcMain.handle('room:funConfig', () => ({
    blockMinutes: FUN_BLOCK_MIN,
    blockCost: FUN_BLOCK_COST,
    maxMinutes: FUN_MAX_MIN,
    points: data.profile.points || 0,
  }));

  ipcMain.handle('profile:update', (_e, patch) => {
    if (patch?.name) data.profile.name = String(patch.name).slice(0, 12);
    if (patch?.avatar) data.profile.avatar = String(patch.avatar).slice(0, 4);
    saveNow();
    return { ok: true };
  });

  /* AI 盯学扣分：摸鱼检测触发，走惩罚通道（允许扣成负分） */
  ipcMain.handle('ai:penalty', (_e, { points }) => {
    const delta = Math.max(-100, Math.min(0, Math.round(Number(points) || 0)));
    setProfilePoints((data.profile.points || 0) + delta);
    saveNow();
    return { ok: true, points: data.profile.points || 0 };
  });

  /* AI 自训练数据：主窗口与异地联机窗口共用同一份（file:// 页面之间 localStorage 是隔离的） */
  const aiStoreFile = () => path.join(app.getPath('userData'), 'ai-train.json');
  ipcMain.on('ai:store:load', (e) => {
    try {
      e.returnValue = fs.readFileSync(aiStoreFile(), 'utf8');
    } catch (_) {
      e.returnValue = '';
    }
  });
  ipcMain.on('ai:store:save', (_e, json) => {
    try {
      const tmp = aiStoreFile() + '.tmp';
      fs.writeFileSync(tmp, String(json || ''), 'utf8');
      fs.renameSync(tmp, aiStoreFile());
    } catch (_) {}
  });

  /* AI 闲聊雷达：把渲染层的模型资源读出来（file:// 页面不能 fetch，且沙箱 preload 无 fs） */
  ipcMain.handle('vendor:read', (_e, rel) => {
    try {
      const base = path.join(__dirname, 'renderer');
      const abs = path.resolve(base, String(rel || '').replace(/^[\\/]+/, ''));
      if (!abs.startsWith(base)) return null;
      return fs.readFileSync(abs);
    } catch (_) {
      return null;
    }
  });

  /* ---------------- 番茄钟 / 专注 ---------------- */

  ipcMain.handle('focus:complete', (_e, { minutes, kind }) => {
    const today = dateKey();
    const m = Math.max(1, Math.min(180, Math.round(Number(minutes) || 0)));
    if (kind === 'break') {
      return { ok: true, gained: 0, message: '休息完成，回来继续！' };
    }
    const gained = Math.round(m * 0.8);
    setProfilePoints((data.profile.points || 0) + gained);
    data.profile.focusMinutes = (data.profile.focusMinutes || 0) + m;
    data.profile.pomodoros = (data.profile.pomodoros || 0) + 1;
    data.pomodoro[today] = (data.pomodoro[today] || 0) + 1;
    data.focus[today] = (data.focus[today] || 0) + m;
    /* 突破个人单日专注纪录 → 信誉分（同类事件按 cap 限次，刷不出来） */
    const prevBest = Math.max(0, ...Object.entries(data.focus || {}).filter(([k]) => k !== today).map(([, v]) => Number(v) || 0));
    const beforeToday = (Number(data.focus[today]) || 0) - m;
    if (prevBest > 0 && beforeToday <= prevBest && data.focus[today] > prevBest && !(data.focusRecord && data.focusRecord.noted && data.focusRecord.noted[today])) {
      data.focusRecord = data.focusRecord || { noted: {} };
      data.focusRecord.noted[today] = true;
      creditEvent('record_ok', `单次专注 ${m} 分钟，刷新个人纪录`);
    }
    saveNow();
    return { ok: true, gained, pomodoros: data.pomodoro[today], minutes: m };
  });

  /* ---------------- 今日三件事 ---------------- */

  ipcMain.handle('mit:add', (_e, text) => {
    const today = dateKey();
    const list = data.mits[today] || [];
    if (list.length >= 3) return { ok: false, message: '今天的三件事已满，先完成一件吧' };
    list.push({
      id: 't-' + Date.now().toString(36),
      text: String(text || '').trim().slice(0, 40),
      done: false,
    });
    data.mits[today] = list;
    saveNow();
    return { ok: true };
  });

  ipcMain.handle('mit:toggle', (_e, id) => {
    const today = dateKey();
    const item = (data.mits[today] || []).find((m) => m.id === id);
    if (!item) return { ok: false };
    item.done = !item.done;
    // 完成三件事中的一件给 10 积分（只在勾选时发）
    if (item.done) {
      setProfilePoints((data.profile.points || 0) + 10);
      item.points = 10;
    } else {
      // 撤销已得积分：若积分已花掉则扣成负分（防止「得→花→撤」白嫖）
      setProfilePoints((data.profile.points || 0) - (item.points || 0));
      item.points = 0;
    }
    saveNow();
    return { ok: true };
  });

  ipcMain.handle('mit:delete', (_e, id) => {
    const today = dateKey();
    data.mits[today] = (data.mits[today] || []).filter((m) => m.id !== id);
    saveNow();
    return { ok: true };
  });

  /* ---------------- 强制模式（守护） ---------------- */

  const saveGuardian = () => {
    data.guardian = {
      user: guardian.state.user,
      salt: guardian.state.salt,
      hash: guardian.state.hash,
      whitelist: guardian.state.whitelist,
      graylist: guardian.state.graylist,
      blacklist: guardian.state.blacklist,
      enabled: guardian.state.enabled,
    };
    saveNow();
  };

  ipcMain.handle('guard:info', async () => ({
    ...guardian.publicInfo(),
    strikes: data.reminderStrikes,
    strikeLimit: 5,
    strikeDeduct: 15,
    isAdmin: await guardian.isAdmin(),
  }));

  ipcMain.handle('guard:setup', (_e, { user, password }) => {
    if (guardian.hasPassword()) return { ok: false, message: '密码已设置' };
    if (!password || String(password).length < 4) return { ok: false, message: '密码至少 4 位' };
    guardian.setPassword(user, password);
    saveGuardian();
    return { ok: true };
  });

  ipcMain.handle('guard:setLists', (_e, { lists, password }) => {
    if (guardian.hasPassword() && !guardian.verify(password)) {
      return { ok: false, needPassword: true };
    }
    guardian.setLists(lists || {});
    saveGuardian();
    return { ok: true, lists: guardian.publicInfo() };
  });

  ipcMain.handle('guard:toggle', async (_e, { enabled, password }) => {
    if (guardian.hasPassword() && !guardian.verify(password)) {
      return { ok: false, needPassword: true };
    }
    guardian.setEnabled(!!enabled, hasActivePlan);
    saveGuardian();
    // 开启强制模式但当前不是管理员 → 立即提权重启（杀管理员软件需要）
    let elevating = false;
    if (enabled && isGuardActive() && !(await guardian.isAdmin())) {
      data.settings.elevLastTry = 0;
      scheduleElevatedRestart(await hasGuardTask());
      elevating = true;
    }
    return { ok: true, enabled: guardian.state.enabled, elevating };
  });

  ipcMain.handle('guard:processes', async () => {
    const procs = await guardian.listProcesses();
    return procs
      .filter((p) => !guardian.PROTECTED.has(p.name.toLowerCase()))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((p) => ({ name: p.name.replace(/\.exe$/i, ''), pids: p.pids.length }));
  });

  ipcMain.handle('guard:adminRestart', async () => {
    const admin = await guardian.isAdmin();
    if (admin) return { ok: true, alreadyAdmin: true };
    const silent = await hasGuardTask();
    data.settings.elevLastTry = 0; // 手动触发：清掉限流
    scheduleElevatedRestart(silent);
    return { ok: true, silent };
  });

  /* ---------------- 负分状态：灰名单兑换时长（临时计划） ----------------
   * 积分为负（名单升级）期间，可以把灰名单软件「兑换」成一条临时计划：
   * 从现在起 N 分钟内只放行该软件，时段结束自动失效，第二天清扫删除。
   * 每个灰名单项目每天最多兑换 30 分钟；价格与娱乐房一致（每 10 分钟 15 分），
   * 负分状态下照常扣分——兑换越多的代价是更晚走出负分。 */
  ipcMain.handle('guard:redeemGray', (_e, payload) => {
    const name = normProcName(payload?.name || '');
    const wantMin = Math.round(Number(payload?.minutes) || 0);
    if (!guardian.isEscalated()) {
      return { ok: false, message: '只有积分为负（名单升级）时才能兑换灰名单时长' };
    }
    if (!name || !guardian.state.graylist.some((x) => normProcName(x) === name)) {
      return { ok: false, message: '该软件不在灰名单里' };
    }
    if (wantMin < 5) return { ok: false, message: '至少兑换 5 分钟' };
    const left = grayRedeemLeft(name);
    if (left <= 0) {
      return { ok: false, message: `「${name}」今天已兑换满 ${GRAY_REDEEM_DAILY_LIMIT} 分钟，明天再来` };
    }
    const minutes = Math.min(wantMin, left);
    const cost = Math.ceil(minutes / 10) * GRAY_REDEEM_COST_PER10;
    setProfilePoints((data.profile.points || 0) - cost); // 负分时允许扣得更深
    const used = todayGrayRedeem();
    used[name] = (used[name] || 0) + minutes;

    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    data.plans.push({
      id: 'tmp-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      temp: true,
      title: `⏳ ${name}（兑换 ${minutes} 分钟）`,
      desc: `灰名单兑换：${hh}:${mm} 起 ${minutes} 分钟内放行，明天自动删除`,
      icon: '⏳',
      color: 'coral',
      time: `${hh}:${mm}`,
      days: [now.getDay()],
      points: 0,
      allowProcs: [name],
      durationMin: minutes,
      enabled: true,
      createdAt: now.toISOString(),
      expireKey: dateKey(now),
    });
    saveNow();
    broadcast();
    return {
      ok: true,
      minutes,
      cost,
      left: grayRedeemLeft(name),
      points: data.profile.points,
      message: `⏳ 已为「${name}」兑换 ${minutes} 分钟（扣 ${cost} 积分），该软件今天还剩 ${grayRedeemLeft(name)} 分钟可兑换`,
    };
  });

  /* ---------------- 未授权软件提醒弹窗 ---------------- */

  ipcMain.on('unlisted:close', () => {
    if (unlistedWindow && !unlistedWindow.isDestroyed()) unlistedWindow.close();
  });

  ipcMain.handle('unlisted:kill', async (_e, names) => {
    const list = (Array.isArray(names) ? names : []).slice(0, 20);
    const killed = [];
    for (const n of list) {
      const img = /\.exe$/i.test(n) ? n : n + '.exe';
      const r = await guardian.killSoftware(img);
      if (r.ok) killed.push(n);
    }
    if (killed.length && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('app:toast', {
        msg: '🛡️ 已关闭未授权软件',
        sub: killed.join('、'),
      });
    }
    return { ok: true, killed };
  });

  /* ---------------- 积分商城 ---------------- */

  // 首次使用时预置几个默认奖励商品
  function ensureShopDefaults() {
    if (data.shop.items.length === 0 && (data.shop.history || []).length === 0 && !data.shop.seeded) {
      const defs = [
        { id: 'r-game', name: '游戏时间 30 分钟', icon: '🎮', cost: 60, type: 'ticket', minutes: 30 },
        { id: 'r-video', name: '看剧时间 30 分钟', icon: '📺', cost: 50, type: 'ticket', minutes: 30 },
        { id: 'r-snack', name: '一份零食', icon: '🍫', cost: 40, type: 'plain' },
        { id: 'r-rest', name: '睡个懒觉', icon: '😴', cost: 80, type: 'plain' },
      ];
      data.shop.items = defs;
      data.shop.seeded = true;
      saveNow();
    }
  }

  ipcMain.handle('shop:init', () => {
    ensureShopDefaults();
    return { ok: true };
  });

  // 设置奖励（增/删）需要守护密码；娱乐券（放行灰名单）至少 50 积分，普通奖励至少 10 积分
  function shopPasswordOk(password) {
    if (!guardian.hasPassword()) return true;
    return guardian.verify(password) ? true : { needPassword: true };
  }

  ipcMain.handle('shop:addItem', (_e, item) => {
    const pw = shopPasswordOk(item?.password);
    if (pw !== true) return pw;
    const type = item?.type === 'ticket' && Number(item?.minutes) > 0 ? 'ticket' : 'plain';
    const minCost = type === 'ticket' ? 50 : 10;
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
    broadcast();
    return { ok: true, item: clean };
  });

  ipcMain.handle('shop:deleteItem', (_e, payload) => {
    const id = typeof payload === 'string' ? payload : payload?.id;
    const pw = shopPasswordOk(typeof payload === 'object' && payload ? payload.password : undefined);
    if (pw !== true) return pw;
    data.shop.items = data.shop.items.filter((x) => x.id !== id);
    saveNow();
    broadcast();
    return { ok: true };
  });

  ipcMain.handle('shop:redeem', (_e, id) => {
    const item = data.shop.items.find((x) => x.id === id);
    if (!item) return { ok: false, message: '商品不存在' };
    const points = data.profile.points || 0;
    // ---- 负分分级：按档位决定「能不能换 / 换得起多少」 ----
    const t = guardian.tier();
    let cost = item.cost;
    let usedRescue = false;
    if (t.canRedeem === 'none') {
      return {
        ok: false,
        message: `当前欠分 ${points}（${t.label}），兑换已锁定。先用打卡把积分拉回 -30 以上。`,
        tier: t.key,
      };
    }
    if (t.canRedeem === 'rescue') {
      const r = data.rescue;
      if (!r || !r.unlocked || r.usedAt) {
        return {
          ok: false,
          message: '中度欠分时只能先领「救赎券」：完成挑战后解锁一次兑换。',
          tier: t.key,
          needRescue: true,
        };
      }
      usedRescue = true;
    }
    if (t.canRedeem === 'cheap' && Number(item.cost) > guardian.CHEAP_MAX) {
      return {
        ok: false,
        message: `轻度欠分期间只能兑换 ¥${guardian.CHEAP_MAX} 以内的低价奖励（该商品需 ${item.cost} 分）。`,
        tier: t.key,
      };
    }
    // 轻度/中度欠分：价格翻倍，不是断供
    if (t.mult > 1) cost = Math.round(Number(item.cost) * t.mult);
    if (points < cost) {
      return { ok: false, message: `积分不足（还差 ${cost - points} 分${t.mult > 1 ? '，欠分期间价格双倍' : ''}）` };
    }
    setProfilePoints(points - cost);
    if (usedRescue) {
      data.rescue = null; // 救赎券一次一用
    }
    data.shop.history = [
      { at: new Date().toISOString(), name: item.name, icon: item.icon, cost },
      ...(data.shop.history || []),
    ].slice(0, 100);
    let ticketUntil = 0;
    if (item.type === 'ticket') {
      ticketUntil = guardian.grantTicket(item.minutes);
      // 确保守护循环在跑，券才能真正生效
      if (!guardian.state.enabled && guardian.state.graylist.length) {
        guardian.setEnabled(false, hasActivePlan);
      }
    }
    saveNow();
    broadcast();
    return {
      ok: true,
      points: data.profile.points,
      ticketUntil,
      cost,
      message:
        item.type === 'ticket'
          ? `${item.icon} ${item.name} 已兑换，${item.minutes} 分钟内灰名单应用放行`
          : `${item.icon} ${item.name} 已兑换，记得兑现给自己`,
    };
  });

  /* 微目标：欠分时完成极小步骤 → 负分回升 */
  ipcMain.handle('micro:complete', (_e, stepKey) => microComplete(stepKey));
  ipcMain.handle('micro:state', () => microState());

  /* 借分与信用 */
  ipcMain.handle('credit:borrow', (_e, amount) => creditBorrow(amount));
  ipcMain.handle('credit:penalize', (_e, { amount, note } = {}) => creditPenalize(amount, note));
  ipcMain.handle('credit:event', (_e, { type, note } = {}) => creditEvent(type, note));
  ipcMain.handle('credit:state', () => creditState());

  /* ---------------- 军团纪律 IPC ----------------
     一次专注结束只调一个入口（disc:session），先判「算不算」，再判「逃不逃」，
     避免两套判定互相打架。 */
  ipcMain.handle('disc:state', () => disciplineState());

  /* GitHub token：默认自动从本机取（环境变量 → gh CLI → git 凭据 → 设置），
     渲染层只拿得到来源与掩码，永远拿不到完整 token。 */
  /* 默认只读环境变量与设置里存过的 token；本机 gh / git 凭据要用户点「自动查找」才去翻，
     否则 Windows 的 Git 凭据助手一被问到 github.com 就弹登录窗。 */
  ipcMain.handle('pk:token', () =>
    pkToken.status(String(((data.settings || {}).pkRepo || {}).token || ''), false)
  );
  ipcMain.handle('pk:tokenRefresh', () => {
    pkToken.clear();
    return pkToken.status(String(((data.settings || {}).pkRepo || {}).token || ''), true);
  });

  /* ---------------- GitHub 官方 OAuth（Device Flow） ----------------
     流程放在主进程：渲染层只拿 user_code 与状态，token 直接写进设置，
     不回传给界面。一次登录，之后长期有效（除非在 GitHub 上撤销授权）。 */
  let ghFlow = null;

  ipcMain.handle('pk:oauthStart', async () => {
    const clientId = String(((data.settings || {}).pkOAuth || {}).clientId || '').trim();
    const r = await pkOAuth.start({ clientId, scope: 'repo' });
    if (!r.ok) return r;
    ghFlow = { deviceCode: r.deviceCode, clientId, startedAt: Date.now(), expiresAt: Date.now() + r.expiresIn * 1000 };
    return {
      ok: true,
      userCode: r.userCode,
      verify: r.verify,
      interval: r.interval,
      expiresIn: r.expiresIn,
      message: r.message,
    };
  });

  ipcMain.handle('pk:oauthPoll', async () => {
    if (!ghFlow) return { status: 'idle', message: '还没有开始登录' };
    if (Date.now() > ghFlow.expiresAt) {
      ghFlow = null;
      return { status: 'expired', message: '验证码过期了，重新点一次登录' };
    }
    const r = await pkOAuth.pollOnce({ clientId: ghFlow.clientId, deviceCode: ghFlow.deviceCode });
    if (r.status !== 'ok') return r;
    /* 成功：写进设置，并把 oauthAt 记下来（界面据此显示「已登录」） */
    data.settings.pkRepo = data.settings.pkRepo || { owner: '', repo: '', branch: 'main', backup: { owner: '', repo: '', branch: 'main' } };
    data.settings.pkRepo.token = r.token.slice(0, 200);
    data.settings.pkRepo.oauthAt = Date.now();
    ghFlow = null;
    pkToken.clear();
    saveNow();
    broadcast();
    return { status: 'ok', masked: pkToken.mask(r.token), scope: r.scope || '' };
  });

  ipcMain.handle('pk:oauthCancel', () => {
    ghFlow = null;
    return { ok: true };
  });

  ipcMain.handle('pk:oauthLogout', () => {
    if (data.settings.pkRepo) {
      data.settings.pkRepo.token = '';
      data.settings.pkRepo.oauthAt = 0;
    }
    ghFlow = null;
    pkToken.clear();
    saveNow();
    broadcast();
    return { ok: true };
  });

  ipcMain.handle('disc:session', (_e, s = {}) => {
    const d = disciplineOf();
    const audit = discipline.focusAudit(s);
    const desert = discipline.desertVerdict(s);
    const messages = [];
    let voided = false;
    let penalty = 0;

    /* 1) 刷分优先：这一节不算数，就不发积分，也不再叠一个「逃兵」 */
    if (audit.level === 'void') {
      const r = discipline.applyAudit(d, audit, { now: Date.now() });
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

    /* 2) 逃兵：只在「这一节算数」的前提下追究，否则会一次扣两遍 */
    if (!voided && desert.level === 'desert') {
      const ev = creditEvent('desert_bad', desert.note);
      penalty += Math.abs(Number(ev.delta) || 0);
      const after = Number((data.credit || {}).score) || 0;
      discipline.applyDesert(d, desert, { creditAfter: after, now: Date.now() });
      messages.push(desert.note);
      if (ev.delta === 0) messages.push('（新手保护罩生效，这次只提醒）');
    } else if (!voided && desert.level === 'warn') {
      messages.push(desert.note);
    }

    saveNow();
    broadcast();
    const st = disciplineState();
    return {
      ok: true,
      voided,
      penalty,
      messages: messages.filter(Boolean),
      state: st,
      canJoinLegion: st.canJoinLegion,
    };
  });

  /* 契约任务：押金托管在积分里，见证人必须在场 */
  ipcMain.handle('disc:contractNew', (_e, info = {}) => {
    const r = discipline.contractNew({
      title: info.title,
      deposit: info.deposit,
      witness: info.witness,
      dueAt: info.dueAt,
      points: Number(data.profile.points) || 0,
    });
    if (!r.ok) return r;
    const d = disciplineOf();
    d.contracts[r.contract.id] = r.contract;
    setProfilePoints((Number(data.profile.points) || 0) - r.contract.deposit);
    saveNow();
    broadcast();
    return { ok: true, contract: r.contract, points: data.profile.points };
  });

  ipcMain.handle('disc:contractSettle', (_e, { id, done } = {}) => {
    const d = disciplineOf();
    const c = d.contracts[id];
    const r = discipline.contractSettle(c, { done: !!done, now: Date.now() });
    if (!r.ok) return r;
    c.status = r.status;
    c.settledAt = Date.now();
    if (r.refund) setProfilePoints((Number(data.profile.points) || 0) + r.refund);
    if (r.penalty) creditEvent('contract_bad', `${c.title} · 见证人 ${c.witness}`);
    saveNow();
    broadcast();
    return { ...r, points: data.profile.points, state: disciplineState() };
  });

  /* 外挂：先标记待审，人工确认后才清零封禁（误报不能直接扣人） */
  ipcMain.handle('disc:scan', () => {
    const d = disciplineOf();
    const today = dateKey();
    const scan = discipline.scanCheat({
      focusMinutes: Number((data.focus || {})[today]) || 0,
      credit: Number((data.credit || {}).score) || 0,
      pointsJump: Number(data.profile.pointsJump) || 0,
      clockBackMs: Number(data.profile.clockBackMs) || 0,
      clickIntervalMs: Number(data.profile.clickIntervalMs) || 0,
      clickCount: Number(data.profile.clickCount) || 0,
    });
    let added = 0;
    for (const h of scan.hits) {
      /* 同一天同一类只记一次，避免每 30 分钟扫一次刷满列表 */
      const dup = d.flags.some(
        (f) => f.kind === h.kind && String(f.at || '').slice(0, 10) === today && f.status === 'pending'
      );
      if (dup) continue;
      d.flags.unshift({
        id: `f${Date.now().toString(36)}${added}`,
        at: new Date().toISOString(),
        kind: h.kind,
        detail: h.detail,
        severity: h.severity,
        status: 'pending',
      });
      added += 1;
    }
    d.flags = d.flags.slice(0, 30);
    if (added) {
      saveNow();
      broadcast();
    }
    return { ok: true, added, flags: d.flags.slice(0, 8) };
  });

  ipcMain.handle('disc:review', (_e, { id, uphold } = {}) => {
    const d = disciplineOf();
    const f = d.flags.find((x) => x.id === id);
    const r = discipline.reviewCheat(f, { uphold: !!uphold, now: Date.now() });
    if (!r.ok) return r;
    f.status = r.status;
    f.reviewedAt = r.at;
    if (r.wipe) {
      data.credit = data.credit || {};
      data.credit.score = 0;
      data.credit.blockUntil = Math.max(Number(data.credit.blockUntil) || 0, Date.now() + 86400000);
      data.credit.ledger = [
        {
          at: new Date().toISOString(),
          type: 'cheat_bad',
          delta: -(Number(data.credit.score) || 0),
          pillar: 'honest',
          note: '外挂坐实：信誉分清零',
        },
        ...(data.credit.ledger || []),
      ].slice(0, 120);
    }
    if (r.ban) {
      d.ban = { at: Date.now(), permanent: true, reason: f.detail || f.kind };
      d.frozenUntil = 0;
    }
    saveNow();
    broadcast();
    return { ...r, state: disciplineState() };
  });

  /* 解冻：连续打卡 3 天可以提前解（不是永久拉黑，给回头路） */
  ipcMain.handle('disc:thaw', () => {
    const d = disciplineOf();
    if (d.ban && d.ban.permanent) return { ok: false, message: '外挂坐实属于永久封禁，不能自助解冻' };
    const dates = Object.keys(data.log || {}).sort().slice(-3);
    const okDays = dates.filter((k) => {
      const rec = data.log[k] || {};
      return Object.values(rec).some((x) => x && x.status === 'done');
    }).length;
    if (okDays < 3) return { ok: false, message: `还需要连续 3 天打卡，目前 ${okDays} 天` };
    d.frozenUntil = 0;
    d.desert = { count: 0, lastAt: Date.now() };
    saveNow();
    broadcast();
    return { ok: true, state: disciplineState() };
  });

  /* 契约见证人：只写本地记录，不联网、不推送 */
  ipcMain.handle('witness:set', (_e, { projectId, name }) => {
    const proj = (data.contractProjects || []).find((c) => c.id === projectId);
    if (!proj) return { ok: false, message: '项目不存在' };
    const n = String(name || '').trim().slice(0, 20);
    data.witness = data.witness || {};
    if (!n) delete data.witness[projectId];
    else data.witness[projectId] = { name: n, at: new Date().toISOString() };
    saveNow();
    broadcast();
    return { ok: true, witness: data.witness[projectId] || null };
  });
  ipcMain.handle('shop:rescueStart', () => {
    const t = guardian.tier();
    if (t.key !== 'mid') {
      return { ok: false, message: t.key === 'light' ? '还没到需要救赎券的程度' : '这一档已锁定兑换，先打卡回升' };
    }
    if (data.rescue && !data.rescue.usedAt) return { ok: false, message: '救赎挑战已经领过了' };
    data.rescue = { startedAt: new Date().toISOString(), need: 5, done: 0, unlocked: false, usedAt: null };
    saveNow();
    broadcast();
    return { ok: true, rescue: data.rescue };
  });

  /* ---------------- 目标管理 ---------------- */

  ipcMain.handle('goal:add', (_e, g) => {
    const clean = {
      id: 'g-' + Date.now().toString(36),
      title: String(g?.title || '').trim().slice(0, 40) || '新目标',
      icon: g?.icon || '🎯',
      deadline: String(g?.deadline || '').slice(0, 20),
      milestones: (Array.isArray(g?.milestones) ? g.milestones : [])
        .map((t) => String(t).trim())
        .filter(Boolean)
        .slice(0, 60)
        .map((title) => ({ id: 'm-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), title, done: false })),
    };
    data.goals.push(clean);
    saveNow();
    broadcast();
    return { ok: true, id: clean.id };
  });

  ipcMain.handle('goal:delete', (_e, id) => {
    data.goals = data.goals.filter((g) => g.id !== id);
    saveNow();
    broadcast();
    return { ok: true };
  });

  ipcMain.handle('goal:toggleMilestone', (_e, { goalId, msId }) => {
    const g = data.goals.find((x) => x.id === goalId);
    const m = g?.milestones.find((x) => x.id === msId);
    if (m) m.done = !m.done;
    saveNow();
    broadcast();
    return { ok: true };
  });

  ipcMain.handle('goal:addMilestone', (_e, { goalId, title }) => {
    const g = data.goals.find((x) => x.id === goalId);
    const t = String(title || '').trim();
    if (!g || !t) return { ok: false };
    g.milestones.push({ id: 'm-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), title: t.slice(0, 40), done: false });
    saveNow();
    broadcast();
    return { ok: true };
  });

  ipcMain.handle('goal:deleteMilestone', (_e, { goalId, msId }) => {
    const g = data.goals.find((x) => x.id === goalId);
    if (g) g.milestones = g.milestones.filter((m) => m.id !== msId);
    saveNow();
    broadcast();
    return { ok: true };
  });

  /* ---------------- 契约模式 ---------------- */

  ipcMain.handle('contract:add', (_e, c) => {
    const friends = (Array.isArray(c?.friends) ? c.friends : [])
      .map((s) => String(s).trim())
      .filter(Boolean)
      .slice(0, 10);
    if (!friends.length) return { ok: false, message: '至少填一位监督人' };
    const clean = {
      id: 'c-' + Date.now().toString(36),
      title: String(c?.title || '').trim().slice(0, 40) || '自律挑战',
      stake: Math.max(1, Math.min(9999, Number(c?.stake) || 10)), // 未完成每天需发红包金额
      friends,
      start: dateKey(),
      days: Math.max(1, Math.min(365, Number(c?.days) || 21)),
      checkins: {}, // date -> true
      paid: {},     // date -> true（红包已手动发出）
    };
    data.contracts.push(clean);
    saveNow();
    broadcast();
    return { ok: true, id: clean.id };
  });

  ipcMain.handle('contract:checkin', (_e, id) => {
    const c = data.contracts.find((x) => x.id === id);
    if (!c) return { ok: false };
    const today = dateKey();
    c.checkins[today] = true;
    saveNow();
    broadcast();
    return { ok: true, checked: Object.keys(c.checkins).length };
  });

  ipcMain.handle('contract:pay', (_e, { id, date }) => {
    const c = data.contracts.find((x) => x.id === id);
    if (c) c.paid[date] = true;
    saveNow();
    broadcast();
    return { ok: true };
  });

  ipcMain.handle('contract:delete', (_e, id) => {
    data.contracts = data.contracts.filter((c) => c.id !== id);
    saveNow();
    broadcast();
    return { ok: true };
  });

  /* ---------------- 契约项目（新） ---------------- */

  ipcMain.handle('contractProject:add', (_e, p) => {
    const title = String(p?.title || '').trim().slice(0, 40);
    if (!title) return { ok: false, message: '请填写项目名称' };
    const clean = {
      id: 'cp-' + Date.now().toString(36),
      title,
      stake: Math.max(1, Math.min(9999, Number(p?.stake) || 10)), // 每天未全部完成时的最高应扣金额（元）
      days: Math.max(1, Math.min(365, Number(p?.days) || 30)),
      start: dateKey(),
      createdAt: new Date().toISOString(),
      settlements: {}, // date -> { pct, owe, due, done }
      paid: {},        // date -> true（这笔钱已交）
    };
    data.contractProjects.push(clean);
    saveNow();
    broadcast();
    return { ok: true, id: clean.id, project: clean };
  });

  ipcMain.handle('contractProject:delete', (_e, id) => {
    const c = (data.contractProjects || []).find((x) => x.id === id);
    if (!c) return { ok: false, message: '项目不存在' };
    if (!contractExpired(c)) return { ok: false, message: `契约未到期（${contractEndDate(c)} 到期），不可删除` };
    // 到期后删除项目：其契约子任务一并删除
    const taskIds = new Set(data.plans.filter((p) => p.contract === id).map((p) => p.id));
    data.plans = data.plans.filter((p) => p.contract !== id);
    data.contractProjects = data.contractProjects.filter((x) => x.id !== id);
    for (const day of Object.values(data.log)) for (const pid of Object.keys(day)) if (taskIds.has(pid)) delete day[pid];
    saveNow();
    broadcast();
    return { ok: true };
  });

  ipcMain.handle('contractProject:pay', (_e, { id, date }) => {
    const c = (data.contractProjects || []).find((x) => x.id === id);
    if (c) {
      c.paid = c.paid || {};
      c.paid[date] = true;
      saveNow();
      broadcast();
    }
    return { ok: true };
  });

  /* ---------------- 每日小结 / 每周复盘 ---------------- */

  ipcMain.handle('diary:save', (_e, { mood, text }) => {
    data.diary[dateKey()] = { mood: String(mood || '').slice(0, 12), text: String(text || '').slice(0, 300) };
    saveNow();
    broadcast();
    return { ok: true };
  });

  ipcMain.handle('review:setItems', (_e, { weekKey, items }) => {
    // 自动汇总本周打卡率（本周有计划的天里全勤的比例）
    let rate = 0;
    try {
      const days = [];
      const now = new Date();
      const monday = new Date(now);
      monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
      for (let i = 0; i < 7; i++) {
        const dt = new Date(monday);
        dt.setDate(monday.getDate() + i);
        if (dt > now) break;
        days.push(dateKey(dt));
      }
      const full = days.filter((k) => {
        const due = plansForDate(k);
        return due.length && due.every((p) => data.log[k]?.[p.id]?.status === 'done');
      }).length;
      rate = days.length ? Math.round((full / days.length) * 100) : 0;
    } catch (_) {}
    data.reviews[weekKey] = {
      rate,
      items: (Array.isArray(items) ? items : []).map((s) => String(s).trim()).filter(Boolean).slice(0, 8),
    };
    saveNow();
    broadcast();
    return { ok: true, rate };
  });

  /* ---------------- 补卡（每月限 3 次） ---------------- */

  ipcMain.handle('makeup:add', (_e, { date, planId, reason }) => {
    const monthKey = String(date || dateKey()).slice(0, 7);
    data.makeups[monthKey] = data.makeups[monthKey] || [];
    if (data.makeups[monthKey].length >= 3) {
      return { ok: false, message: '本月补卡次数已用完（每月限 3 次）' };
    }
    if (!String(reason || '').trim()) return { ok: false, message: '请填写补卡理由' };
    const plan = data.plans.find((p) => p.id === planId);
    if (!plan) return { ok: false, message: '计划不存在' };

    data.log[date] = data.log[date] || {};
    const gained = Math.round((Number(plan.points) || 20) / 2); // 补卡得一半积分
    data.log[date][planId] = { status: 'done', at: Date.now(), points: gained, madeUp: true };
    setProfilePoints((data.profile.points || 0) + gained);
    data.profile.totalDone = (data.profile.totalDone || 0) + 1;
    data.makeups[monthKey].push({ date, planId, reason: String(reason).slice(0, 100) });
    saveNow();
    broadcast();
    return { ok: true, gained, left: 3 - data.makeups[monthKey].length };
  });

  /* ---------------- 护眼模式（每小时眼保健操 + 10 分钟息屏） ---------------- */

  const EYE_EXERCISE_MS = Number(process.env.PQ_EYE_EX_MS) || 5 * 60000; // 眼保健操兜底时长（视频约 4 分 12 秒，播完由渲染层提前通知）
  /* 节奏三档与换算函数在模块顶部（snapshot 也用）；这里只留引导兜底时长 */

  function createEyeCareWindow() {
    eyeCareWindow = new BrowserWindow({
      width: 1280,
      height: 800,
      show: false,
      frame: false,
      resizable: false,
      movable: false,
      fullscreen: true,
      backgroundColor: '#000000',
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: false,
      },
    });
    eyeCareWindow.setAlwaysOnTop(true, 'screen-saver');
    eyeCareWindow.setMenu(null);
    // 息屏 / 引导进行中不允许 Alt+F4 直接关掉，必须走密码跳过或自然结束
    eyeCareWindow.on('close', (e) => {
      if (eyeCarePhase && !eyeCareAllowClose) e.preventDefault();
    });
    eyeCareWindow.on('closed', () => {
      eyeCareWindow = null;
    });
    eyeCareWindow.loadFile(path.join(__dirname, 'renderer', 'eyecare.html'));
  }

  function eyeCareShow(phase) {
    eyeCarePhase = phase;
    const total = phase === 'exercise' ? EYE_EXERCISE_MS : eyeRestMs();
    eyeCareEndsAt = Date.now() + total;
    if (!eyeCareWindow || eyeCareWindow.isDestroyed()) createEyeCareWindow();
    const win = eyeCareWindow;
    const push = () => {
      try {
        win.webContents.send('eyecare:show', { phase, endsAt: eyeCareEndsAt, total });
      } catch (_) {}
      try {
        win.setFullScreen(true);
        win.show();
        win.focus();
      } catch (_) {}
    };
    if (win.webContents.isLoading()) win.webContents.once('did-finish-load', push);
    else push();
    if (eyeCarePhaseTimer) clearTimeout(eyeCarePhaseTimer);
    eyeCarePhaseTimer = setTimeout(
      () => eyeCareAdvance(true),
      phase === 'exercise' ? EYE_EXERCISE_MS : eyeRestMs()
    );
  }

  function eyeCareAdvance(natural) {
    if (eyeCarePhaseTimer) {
      clearTimeout(eyeCarePhaseTimer);
      eyeCarePhaseTimer = null;
    }
    if (eyeCarePhase === 'exercise') {
      eyeCareShow('rest'); // 做完操 → 息屏 10 分钟
    } else {
      eyeCareClose(true);
      if (natural) toastInMainWindow('👁 护眼完成', `已休息 ${EYE_PLANS[eyePlan()]} 分钟，继续加油`);
    }
  }

  function eyeCareClose(keepSchedule) {
    eyeCarePhase = null;
    eyeCareEndsAt = 0;
    if (eyeCarePhaseTimer) {
      clearTimeout(eyeCarePhaseTimer);
      eyeCarePhaseTimer = null;
    }
    if (eyeCareWindow && !eyeCareWindow.isDestroyed()) {
      eyeCareAllowClose = true;
      try {
        eyeCareWindow.destroy();
      } catch (_) {}
      eyeCareAllowClose = false;
    }
    eyeCareWindow = null;
    // 本轮结束 → 重新计 1 小时
    if (keepSchedule) startEyeCareTimer();
  }

  function startEyeCareTimer() {
    if (eyeCareTimer) clearInterval(eyeCareTimer);
    eyeCareTimer = null;
    if (!data.settings.eyeCare) return;
    eyeCareTimer = setInterval(() => {
      if (eyeCarePhase) return; // 上一轮还没结束不叠加
      eyeCareShow('exercise');
    }, eyeIntervalMs());
  }

  function stopEyeCare() {
    if (eyeCareTimer) clearInterval(eyeCareTimer);
    eyeCareTimer = null;
    eyeCareClose(false);
  }

  ipcMain.handle('eyecare:toggle', (_e, { enabled, password }) => {
    if (guardian.hasPassword() && !guardian.verify(password)) {
      return { ok: false, needPassword: true };
    }
    data.settings.eyeCare = !!enabled;
    saveNow();
    if (enabled) startEyeCareTimer();
    else stopEyeCare();
    broadcast();
    return { ok: true, eyeCare: { enabled: !!data.settings.eyeCare, phase: eyeCarePhase, endsAt: eyeCareEndsAt } };
  });

  ipcMain.handle('eyecare:done', () => {
    // 视频自然播完（不需要密码）；只对引导阶段生效
    if (eyeCarePhase === 'exercise') eyeCareAdvance(true);
    return { ok: true };
  });

  ipcMain.handle('eyecare:skip', (_e, { password }) => {
    if (!eyeCarePhase) return { ok: true };
    if (guardian.hasPassword() && !guardian.verify(password)) {
      return { ok: false, message: '密码不对' };
    }
    eyeCareAdvance(false);
    return { ok: true };
  });

  ipcMain.handle('eyecare:info', () => ({
    enabled: !!data.settings.eyeCare,
    phase: eyeCarePhase,
    endsAt: eyeCareEndsAt,
    plan: eyePlan(),
    intervalMin: eyePlan(),
    restMin: EYE_PLANS[eyePlan()],
  }));

  /* 改护眼节奏：与开关同一套密码门槛，防止自己偷偷把休息时间调短 */
  ipcMain.handle('eyecare:plan', (_e, { plan, password } = {}) => {
    if (guardian.hasPassword() && !guardian.verify(password)) {
      return { ok: false, needPassword: true };
    }
    const m = Number(plan);
    if (!EYE_PLANS[m]) return { ok: false, message: '不支持的护眼节奏' };
    data.settings.eyeCarePlan = m;
    saveNow();
    if (data.settings.eyeCare && !eyeCarePhase) startEyeCareTimer(); // 立即按新节奏重新计时
    broadcast();
    return { ok: true, plan: m, restMin: EYE_PLANS[m] };
  });

  function toastInMainWindow(title, body) {
    if (Notification.isSupported()) {
      try {
        new Notification({ title, body }).show();
      } catch (_) {}
    }
  }

  /* ---------------- 专注模式（隐藏桌面图标） ---------------- */

  const FOCUS_LOG = () => path.join(app.getPath('userData'), 'focus.log');
  function focusLog(msg) {
    const line = `[${new Date().toLocaleString('zh-CN')}] ${msg}\n`;
    console.log('[focus]', msg);
    try {
      fs.appendFileSync(FOCUS_LOG(), line);
    } catch (_) {}
  }

  // ---------- 桌面图标隐藏/恢复 ----------
  // 关键改动：PowerShell 逻辑写成独立的 .ps1 文件，用 -File 调用。
  // 之前把长脚本塞进 -Command，引号在 cmd / PowerShell 之间被转义打碎，
  // 窗口探测永远拿不到 DefView（日志里成片的“未找到”），而失败又没有兜底。
  const PS_SCRIPT = () => path.join(app.getPath('userData'), 'toggle-desktop-icons.ps1');

  const FOCUS_PS = String.raw`param([int]$Visible = 1)
$ErrorActionPreference = 'Continue'
Add-Type -Namespace PQ -Name U -MemberDefinition '[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindow(string c, string t); [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindowEx(IntPtr p, IntPtr c, string cls, string t); [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, System.Text.StringBuilder s, int n); [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h); [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, IntPtr l);'

function ClassOf([IntPtr]$h) {
  $sb = New-Object System.Text.StringBuilder 256
  [void][PQ.U]::GetClassName($h, $sb, 256)
  return $sb.ToString()
}

function Pick([IntPtr]$root) {
  $c = [IntPtr]::Zero
  while ($true) {
    # 注意：不能传 $null —— PowerShell 会把它转成空字符串，
    # 变成"类名/标题必须为空"的强条件，导致一个窗口都匹配不到（之前 nodefview 的根因）
    $c = [PQ.U]::FindWindowEx($root, $c, [NullString]::Value, [NullString]::Value)
    if ($c -eq [IntPtr]::Zero) { return }
    $cls = ClassOf $c
    if ($cls -eq 'SHELLDLL_DefView') {
      if ($script:dv -eq [IntPtr]::Zero) { $script:dv = $c; $script:dvh = $root }
    } elseif ($cls -eq 'WorkerW') {
      Pick $c
    }
  }
}

$script:dv = [IntPtr]::Zero
$script:dvh = [IntPtr]::Zero
$progman = [PQ.U]::FindWindow('Progman', [NullString]::Value)
Write-Output ('PROGMAN ' + $progman)
if ($progman -ne [IntPtr]::Zero) { Pick $progman }
$w = [IntPtr]::Zero
while ($true) {
  $w = [PQ.U]::FindWindowEx([IntPtr]::Zero, $w, 'WorkerW', [NullString]::Value)
  if ($w -eq [IntPtr]::Zero) { break }
  Write-Output ('WORKERW ' + $w)
  Pick $w
}

if ($script:dv -eq [IntPtr]::Zero) { Write-Output 'RESULT nodefview'; exit 0 }

$lv = [IntPtr]::Zero
$c = [IntPtr]::Zero
while ($true) {
  $c = [PQ.U]::FindWindowEx($script:dv, $c, [NullString]::Value, [NullString]::Value)
  if ($c -eq [IntPtr]::Zero) { break }
  if ((ClassOf $c) -eq 'SysListView32') { $lv = $c; break }
}

# 图标列表窗口拿不到时，退回用 DefView 自身的可见性判断
$v0 = $true
if ($lv -ne [IntPtr]::Zero) { $v0 = [PQ.U]::IsWindowVisible($lv) } else { $v0 = [PQ.U]::IsWindowVisible($script:dv) }
Write-Output ('STATE dv=' + $script:dv + ' host=' + $script:dvh + ' list=' + $lv + ' visible=' + $v0)

if ($Visible -eq 1) { $target = $true } else { $target = $false }
if ($v0 -eq $target) { Write-Output 'RESULT ok'; exit 0 }

[void][PQ.U]::SendMessage($script:dv, 0x0111, [IntPtr]0x7402, [IntPtr]::Zero)
Start-Sleep -Milliseconds 500
$v1 = [PQ.U]::IsWindowVisible($script:dv)
if ($lv -ne [IntPtr]::Zero) { $v1 = [PQ.U]::IsWindowVisible($lv) }
Write-Output ('AFTER dv=' + $v1)
if (($v1 -ne $target) -and ($script:dvh -ne [IntPtr]::Zero)) {
  [void][PQ.U]::SendMessage($script:dvh, 0x0111, [IntPtr]0x7402, [IntPtr]::Zero)
  Start-Sleep -Milliseconds 500
  if ($lv -ne [IntPtr]::Zero) { $v1 = [PQ.U]::IsWindowVisible($lv) } else { $v1 = [PQ.U]::IsWindowVisible($script:dv) }
  Write-Output ('AFTER2 dv=' + $v1)
}
if ($v1 -eq $target) { Write-Output 'RESULT ok' } else { Write-Output 'RESULT fail' }
exit 0
`;

  function ensureFocusScript() {
    try {
      fs.writeFileSync(PS_SCRIPT(), FOCUS_PS, 'utf8');
      return true;
    } catch (e) {
      focusLog('写入脚本失败: ' + (e.message || ''));
      return false;
    }
  }

  // 跑一次脚本：可见性校验 + 可选切换
  function runFocusScript(visible) {
    return new Promise((resolve) => {
      const { execFile } = require('node:child_process');
      execFile(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS_SCRIPT(), '-Visible', visible ? '1' : '0'],
        { windowsHide: true, timeout: 25000 },
        (err, stdout, stderr) => {
          const out = String(stdout || '').trim();
          if (out) focusLog('脚本: ' + out.replace(/\r?\n/g, ' | '));
          if (err) focusLog('脚本执行异常: ' + (err.message || '') + (stderr ? ' | ' + String(stderr).slice(0, 200) : ''));
          resolve({
            ok: /RESULT ok/.test(out),
            fail: /RESULT fail/.test(out),
            noView: /RESULT nodefview/.test(out),
            raw: out,
          });
        }
      );
    });
  }

  /* 写 HideIcons 注册表值（visible=true → 0 显示；false → 1 隐藏） */
  function writeHideIcons(visible) {
    return new Promise((resolve) => {
      const { execFile } = require('node:child_process');
      const regPath = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced';
      execFile(
        'reg',
        ['add', regPath, '/v', 'HideIcons', '/t', 'REG_DWORD', '/d', visible ? '0' : '1', '/f'],
        { windowsHide: true },
        (e) => {
          focusLog(e ? 'reg add 失败: ' + (e.message || '') : `HideIcons 已写入 ${visible ? 0 : 1}`);
          resolve(!e);
        }
      );
    });
  }

  /*
   * 兜底：重启资源管理器让注册表生效（任务栏会闪一下）。
   * 顺序必须是「先杀 explorer → 等它彻底退出 → 再写注册表 → 再启动 explorer」。
   * explorer 退出时会把当前桌面图标状态写回 HideIcons，先写后杀会被它覆盖
   * —— 这就是之前「隐藏能成、恢复失败」的原因。
   */
  function restartExplorer(visible) {
    return new Promise((resolve) => {
      const { execFile, spawn } = require('node:child_process');
      focusLog('快速切换未生效，改用重启资源管理器兜底');
      execFile('taskkill', ['/F', '/IM', 'explorer.exe'], { windowsHide: true }, () => {
        setTimeout(async () => {
          await writeHideIcons(visible); // 在 explorer 起来之前写，不会被覆盖
          try {
            spawn('explorer.exe', [], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
          } catch (_) {}
          setTimeout(resolve, 2500);
        }, 1200);
      });
    });
  }

  let focusBusy = false;

  async function setDesktopIcons(visible) {
    if (focusBusy) {
      focusLog('上一次切换还没结束，忽略重复请求');
      return { ok: false, busy: true, message: '正在切换中，请稍候' };
    }
    focusBusy = true;
    try {
      focusLog(`请求：${visible ? '显示' : '隐藏'}桌面图标`);
      ensureFocusScript();

      // 快路径：先探测真实窗口状态，能直接切就切（不闪任务栏）
      const r1 = await runFocusScript(visible);
      if (r1.ok) {
        focusLog('快速切换成功（桌面窗口消息）');
        await writeHideIcons(visible); // 同步注册表，保证重启后状态一致
        return { ok: true, changed: true };
      }
      // 慢路径：重启资源管理器（内部保证「先杀→再写→后启」的顺序）
      await restartExplorer(visible);
      const r2 = await runFocusScript(visible);
      if (r2.ok) {
        focusLog('重启资源管理器后生效');
        return { ok: true, changed: true, restarted: true };
      }
      focusLog('重启后仍无法校验窗口状态，按注册表已写入处理');
      return { ok: true, changed: true, restarted: true, unverified: true };
    } finally {
      focusBusy = false;
    }
  }

  /* 启动自检：上次切换中途失败（或异常退出）会把图标停在隐藏状态，
     此时 focusMode 已是 false 但注册表还是 1 —— 主动恢复，避免"图标再也回不来" */
  async function restoreIconsIfLeftover() {
    if (process.env.PQ_USERDATA) return; // 测试实例：不碰真实注册表，避免误改桌面图标状态
    try {
      const { execFileSync } = require('node:child_process');
      const out = execFileSync(
        'reg',
        [
          'query',
          'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced',
          '/v',
          'HideIcons',
        ],
        { windowsHide: true, timeout: 6000, encoding: 'utf8' }
      );
      if (!/0x1\b/i.test(String(out || ''))) return; // 图标是显示的，无需处理
      focusLog('启动自检：桌面图标仍处于隐藏状态（上次未恢复干净），自动恢复');
      await setDesktopIcons(true);
    } catch (_) {}
  }
  // 暴露给启动流程（这个函数定义在 registerIpc 内部，外层拿不到）
  restoreIconsFn = restoreIconsIfLeftover;

  ipcMain.handle('focus:toggle', async (_e, { on }) => {
    const want = !!on;
    if (want === !!data.focusMode) return { ok: true, focusMode: data.focusMode };
    const r = await setDesktopIcons(!want);
    if (r.ok) {
      data.focusMode = want;
      saveNow();
      broadcast();
    }
    return { ok: r.ok, focusMode: data.focusMode, message: r.message || '' };
  });

  /* ---------------- 数据导出 ---------------- */

  ipcMain.handle('export:csv', async () => {
    const { dialog } = require('electron');
    const r = await dialog.showSaveDialog(mainWindow, {
      title: '导出打卡明细（Excel 可直接打开）',
      defaultPath: `PlanQuest打卡明细-${dateKey()}.csv`,
      filters: [{ name: 'CSV (Excel)', extensions: ['csv'] }],
    });
    if (r.canceled || !r.filePath) return { ok: false };
    const rows = [['日期', '计划', '状态', '完成时间', '获得积分', '补卡']];
    const keys = Object.keys(data.log).sort();
    for (const k of keys) {
      for (const p of data.plans) {
        const rec = data.log[k][p.id];
        if (!rec) continue;
        rows.push([
          k,
          p.title,
          rec.status === 'done' ? '完成' : rec.status,
          rec.at ? new Date(rec.at).toLocaleString('zh-CN') : '',
          String(rec.points || 0),
          rec.madeUp ? '是' : '',
        ]);
      }
    }
    const csv = '\ufeff' + rows.map((row) => row.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n');
    fs.writeFileSync(r.filePath, csv, 'utf8');
    return { ok: true, path: r.filePath };
  });

  ipcMain.handle('export:calendar', async () => {
    // 生成本月打卡日历图（GitHub 贡献图风格），用系统浏览器打开，可打印/截图
    const m = snapshot().month;
    const cells = m.days
      .map((d) => {
        const rate = d.due ? d.done / d.due : null;
        let bg = '#ebedf0';
        if (rate !== null) {
          if (rate === 0) bg = '#ffd7d5';
          else if (rate < 0.34) bg = '#d6f5d6';
          else if (rate < 0.67) bg = '#8fe88f';
          else if (rate < 1) bg = '#4fc44f';
          else bg = '#216e39';
        }
        return `<td title="${d.key}：${d.done}/${d.due}" style="background:${bg}${d.isToday ? ';outline:3px solid #1f6feb' : ''}">${d.day}</td>`;
      })
      .join('');
    const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>PlanQuest 打卡日历 ${m.year}年${m.month}月</title>
<style>body{font-family:'Microsoft YaHei',sans-serif;display:flex;flex-direction:column;align-items:center;padding:40px;color:#1f2328}
h1{font-size:22px}table{border-collapse:separate;border-spacing:6px}td{width:52px;height:52px;border-radius:8px;text-align:center;vertical-align:middle;font-size:14px;background:#ebedf0;color:#333}
.legend{margin-top:18px;font-size:13px;color:#57606a}.legend i{display:inline-block;width:14px;height:14px;border-radius:3px;vertical-align:-2px;margin:0 3px}
.tip{margin-top:26px;color:#8b949e;font-size:12px}</style></head><body>
<h1>🗓️ PlanQuest 打卡日历 · ${m.year} 年 ${m.month} 月</h1>
<table><tr>${'<td></td>'.repeat(m.firstWeekday)}${cells}</tr></table>
<div class="legend">完成度：<i style="background:#ffd7d5"></i>0% <i style="background:#d6f5d6"></i>1-33% <i style="background:#8fe88f"></i>34-66% <i style="background:#4fc44f"></i>67-99% <i style="background:#216e39"></i>100% <i style="background:#ebedf0"></i>无计划</div>
<div class="tip">按 Ctrl+P 打印，或直接截图分享</div></body></html>`;
    const file = path.join(app.getPath('temp'), `PlanQuest-calendar-${m.year}-${m.month}.html`);
    fs.writeFileSync(file, html, 'utf8');
    shell.openPath(file);
    return { ok: true, path: file };
  });

  /* ---------------------------------------------------------------- */
  /* 多源冗余版本更新 + 可选大模型下载                                */
  /* 主包：GitHub Releases / R2 直链 / pixeldrain / MediaFire / GoFile 按序 fallback */
  /* 只下到新目录，不覆盖正在运行的 exe；不迁移数据；不代写注册表     */
  /* ---------------------------------------------------------------- */
  const updater = require('./updater');
  const sources = require('./sources');
  const curVer = app.getVersion();
  const updateDir = () => path.join(app.getPath('userData'), 'updates');
  /* 用户选的「文件夹内预留位置」：优先装到 exe 同级的 components（绿色版跟着走）；
   * Program Files 之类无写权限时回退到 userData，不因为装组件把程序搞崩。 */
  const componentDir = () => {
    try {
      const beside = path.join(path.dirname(app.getPath('exe')), 'components');
      fs.mkdirSync(beside, { recursive: true });
      const probe = path.join(beside, '.writable');
      fs.writeFileSync(probe, ''); fs.unlinkSync(probe);
      return beside;
    } catch (_) {
      return path.join(app.getPath('userData'), 'components');
    }
  };
  /* 源列表：优先用设置里的多源数组；兼容旧版单个 updateBase；
   * 都没填时用内置的 GitHub Releases 官方仓库（项目自身发布页）。 */
  const updateSources = () => {
    const s = data.settings || {};
    let list = Array.isArray(s.updateSources) ? s.updateSources.filter(Boolean) : [];
    if (!list.length && s.updateBase) list = [s.updateBase];
    if (!list.length) list = ['https://github.com/supercalifragilisticexpialidociouer/PlanQuest/releases/latest'];
    return list;
  };

  ipcMain.handle('update:check', async () => {
    /* 先试 GitHub 源直接给版本；失败再从清单拿。取到的最高版本作为 latest。 */
    let best = null;
    for (const src of updateSources()) {
      try {
        const r = await sources.resolveSource(src, sources.defaultFetch, /portable.*\.zip/i);
        if (r.version) {
          if (!best || updater.cmpVersion(r.version, best.latest) > 0) {
            best = { ok: true, hasUpdate: updater.cmpVersion(r.version, curVer) > 0, current: curVer, latest: r.version, notes: r.notes || '', via: r.source };
          }
        }
      } catch (_) { /* 这个源不给版本，继续下一个 */ }
    }
    if (best) return best;
    /* 兜底：走旧清单逻辑（version.json） */
    const c = await updater.check(String((data.settings || {}).updateBase || ''), curVer);
    if (c.ok) c.via = 'manifest';
    return c;
  });

  ipcMain.handle('update:download', async () => {
    const r = await sources.downloadFirst(updateSources(), {
      wanted: /portable.*\.zip/i,
      dest: path.join(updateDir(), 'PlanQuest-win64-portable.zip'),
      onStage: (t) => { try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update:stage', t); } catch (_) {} },
    });
    if (!r.ok) return { ok: false, message: r.reason, tried: r.tried };
    return {
      ok: true, file: r.file, source: r.source,
      message: `已从 ${r.source} 下到新版本（${path.basename(r.file)}）—— 解压后双击 PlanQuest.exe，数据自动沿用`,
    };
  });

  /* 一键更新：下载→校验→备份→解压→自检→覆盖/回滚 的完整流水线。
   * 期望 sha256/size 来自版本清单（先远端、后本地打包的 version.json）。 */
  const emitStage = (t) => { try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update:stage', t); } catch (_) {} };
  const expectOf = async () => {
    const remote = await readManifestSafe((data.settings || {}).updateBase);
    let m = remote;
    if (!m) {
      try { m = JSON.parse(fs.readFileSync(path.join(ROOT, 'dist', 'version.json'), 'utf8')); }
      catch (_) { m = null; }
    }
    const pack = (m && m.portable) || (m && m.installer) || null;
    return pack ? { sha256: pack.sha256, size: pack.size } : {};
  };
  ipcMain.handle('update:install', async () => {
    const expect = await expectOf();
    emitStage('准备更新…');
    return updateFlow.applyUpdate({
      updatesDir: path.join(updateDir(), 'flow'),
      appDir: path.dirname(app.getPath('exe')),
      expect,
      entryExe: 'PlanQuest.exe',
      onStage: emitStage,
      download: async (dest, say) => {
        const r = await sources.downloadFirst(updateSources(), {
          wanted: /portable.*\.zip/i,
          dest,
          onStage: say,
        });
        return r.ok ? { ok: true, file: r.file } : { ok: false, reason: r.reason };
      },
    });
  });

  /* 内置可选组件白名单：GitHub Releases 不依赖 version.json 也能装 AI。
   * 官网直链与体积来自这里，前端传什么 id 都不会凭空下别的东西。 */
  const DEFAULT_COMPONENTS = [
    {
      id: 'ollama', file: 'ollama-windows-amd64.zip', size: 1618522644,
      official: 'https://github.com/ollama/ollama/releases/download/v0.40.17/ollama-windows-amd64.zip',
      requires: '无（绿色版解压即用；模型另 ollama pull qwen2.5:3b）',
    },
    {
      id: 'melotts', file: 'MeloTTS-source.zip', size: 0, runnable: false,
      official: 'https://github.com/myshell-ai/MeloTTS/archive/refs/heads/main.zip',
      requires: 'Python <= 3.10',
    },
  ];

  ipcMain.handle('update:components', async (_e, ids) => {
    const base = String((data.settings || {}).updateBase || '');
    const manifest = await readManifestSafe(base);
    const pool = (manifest && Array.isArray(manifest.components) && manifest.components.length)
      ? manifest.components : DEFAULT_COMPONENTS;
    const chosen = updater.selectComponents({ components: pool }, ids);
    if (!chosen.length) return { ok: false, message: '没勾任何组件，不下载' };
    const out = [];
    for (const comp of chosen) {
      const pre = updater.precheck(comp, {});
      const dest = path.join(componentDir(), comp.id, comp.file);
      if (fs.existsSync(dest)) { out.push(comp.id + '：已存在，跳过'); continue; }
      try {
        await updater.download(comp.official, dest, { size: comp.size });
        out.push(comp.id + '：下载到 ' + path.dirname(dest) + (pre.runnable === false ? '（仅源码，需自备 Python 3.10）' : ''));
      } catch (e) {
        out.push(comp.id + '：失败 — ' + updater.netReason(e));
      }
    }
    return { ok: true, message: out.join('；') };
  });

  /* ---------------- 阿刺养成 + 战友 PK ----------------
   * 数据权威在主进程：aci-core 是纯函数，这里负责写回 data.aci、
   * 扣加积分（setProfilePoints）、落盘（saveNow）、房间广播。 */
  const weekKeyOf = () => {
    const d = new Date();
    const day = d.getDay() || 7; // 周一为一周起点
    d.setDate(d.getDate() - day + 1);
    return d.getFullYear() + '-W' + String(Math.ceil(((d - new Date(d.getFullYear(), 0, 1)) / 86400000 + 1) / 7)).padStart(2, '0');
  };
  const weekRateOf = () => {
    const r = data.reviews && data.reviews[weekKeyOf()];
    if (r && Number.isFinite(Number(r.rate))) return Number(r.rate);
    // 兜底：今日完成率
    let done = 0, total = 0;
    const today = dateKey();
    const due = plansForDate(today);
    const lg = (data.log && data.log[today]) || {};
    for (const p of due) { total++; if (lg[p.id] && lg[p.id].status === 'done') done++; }
    return total ? Math.round(done / total * 100) : 0;
  };
  const aciView = () => {
    const aci = data.aci || aciCore.defaultAci();
    const rate = weekRateOf();
    const tier = aciCore.tierOf(aci.level);
    return {
      aci,
      rules: aciCore.RULES, tiers: aciCore.TIERS, supplies: aciCore.SUPPLIES,
      derived: {
        weekRate: rate,
        tier: tier.id, tierName: tier.name,
        power: aciCore.powerOf(rate, aci.level),
        expNeeded: aciCore.expNeeded(aci.level),
        ticketPrice: aciCore.ticketPrice(),
        cooling: aciCore.isCoolingDown(aci, Date.now()),
        hidden: aciCore.isHidden(aci, Date.now()),
        matchPref: aciCore.matchPreference(aci, rate, Date.now()),
      },
    };
  };
  ipcMain.handle('aci:state', () => aciView());

  ipcMain.handle('aci:action', (_e, action, payload) => {
    const p = payload || {};
    const now = Date.now();
    let r = null;
    switch (action) {
      case 'water': {
        r = aciCore.water(data.aci, data.profile.points || 0, dateKey(), now);
        if (r.ok && r.effect) setProfilePoints((data.profile.points || 0) - r.effect.costPoints);
        break;
      }
      case 'useSupply': r = aciCore.useSupply(data.aci, p.supplyId); break;
      case 'buyTicket': {
        r = aciCore.buyTicket(data.aci, data.profile.points || 0);
        if (r.ok && r.effect) setProfilePoints((data.profile.points || 0) - r.effect.costPoints);
        break;
      }
      case 'skipCooldown': r = aciCore.skipCooldown(data.aci, now); break;
      case 'setHidden': r = aciCore.setHidden(data.aci, !!p.hidden, now); break;
      case 'createChallenge': r = aciCore.createChallenge(data.aci, Object.assign({ now }, p)); break;
      case 'acceptChallenge': r = aciCore.acceptChallenge(data.aci, p.matchId, now); break;
      case 'expireChallenge': r = aciCore.expireChallenge(data.aci, p.matchId, p.reason); break;
      case 'settle': {
        r = aciCore.settle(data.aci, Object.assign({ now }, p));
        if (r.ok && r.effect) {
          if (r.effect.bonusPoints) setProfilePoints((data.profile.points || 0) + r.effect.bonusPoints);
          if (r.effect.repPenalty && data.credit) data.credit.score = Math.max(0, (data.credit.score || 0) - r.effect.repPenalty);
        }
        break;
      }
      case 'toggleGuarantee': r = aciCore.toggleCreditGuarantee(data.aci, !!p.on); break;
      case 'breakGuarantee': r = aciCore.breakGuarantee(data.aci); break;
      case 'guardDeduct': r = aciCore.guardDeduct(data.aci); break;
      default: return { ok: false, message: '未知的阿刺操作：' + action };
    }
    if (!r) return { ok: false, message: '操作没有返回结果' };
    if (r.ok && r.aci) { data.aci = r.aci; saveNow(); }
    /* 频道广播：由前端拿到 broadcast 后走 room:chat 的 🤖 旁路 / legion 频道发送，
       主进程不替用户发言，避免绕过军团发言规则。 */
    return {
      ok: r.ok, message: r.message || r.reason,
      effect: r.effect, broadcast: r.broadcast, cooling: r.cooling,
      view: aciView(),
    };
  });

  /* 阿刺加入自习室陪聊：复用 study-room 的 🤖 旁路（不判违规词、不算刷屏）。
   * 不传 text 时按查表池自动说一句（离线可用）；传 text 则转发前端引擎生成的文案。
   * 只有确实在房间里才发；3 分钟内最多一句，避免自己把自己刷屏禁言。 */
  const ACI_ROOM_LINES = [
    '都在啊？那我盯着你们，谁摸鱼我记着。',
    '搭档们专心点，完成的计划我替你数着呢。',
    '这屋子挺安静，说明都在干活——继续保持。',
    '别硬撑，累了就歇五分钟，回来我照旧盯你。',
    '又过一阵了，进度我看在眼里。别让我白夸。',
    '带路的不催进度，但摸鱼我可不惯着。',
  ];
  let aciRoomLast = 0;
  ipcMain.handle('aci:roomSay', (_e, text) => {
    let rs;
    try { rs = room.roomStatus(); } catch (_) { rs = null; }
    if (!rs || !rs.inRoom) return { ok: false, message: '不在自习房里', notInRoom: true };
    const t = Date.now();
    if (t - aciRoomLast < 3 * 60 * 1000) return { ok: false, message: '刚聊过，稍等再说', throttled: true };
    const msg = text ? String(text).slice(0, 200)
      : '🤖 阿刺：' + ACI_ROOM_LINES[Math.floor(Math.random() * ACI_ROOM_LINES.length)];
    aciRoomLast = t;
    try { room.sendChat(msg.startsWith('🤖') ? msg : '🤖 ' + msg); } catch (_) {}
    return { ok: true, message: msg };
  });
}

/* 读清单失败返回 null，不让组件下载因为清单挂掉 */
async function readManifestSafe(base) {
  try {
    const c = await require('./updater').check(String(base || ''), '0.0.0');
    return c.ok ? c.manifest : null;
  } catch (_) { return null; }
}

/* ------------------------------------------------------------------ */
/* 守护提权：整软查杀需要管理员权限                                      */
/* ------------------------------------------------------------------ */

const GUARD_TASK = 'PlanQuestGuard'; // 最高权限计划任务，用于静默提权启动

function runCmd(cmd, args) {
  return new Promise((resolve) => {
    const { spawn } = require('node:child_process');
    const p = spawn(cmd, args, { windowsHide: true });
    let code = -1;
    p.on('exit', (c) => {
      code = c;
      resolve({ code });
    });
    p.on('error', () => resolve({ code: -1 }));
  });
}

/* 是否启用了守护（与是否设置密码无关：只要开了强制模式或灰名单就要提权） */
function isGuardActive() {
  const g = data.guardian || {};
  return !!g.enabled || (Array.isArray(g.graylist) && g.graylist.length > 0);
}

/* 本实例的启动参数（提权重启时复用；不带 --hidden，让用户能看到窗口）
 * 注意：不能带 --hidden，否则提权成功后界面不显示，用户以为没生效 */
function relaunchArgs() {
  return app.isPackaged ? '' : `"${ROOT}"`;
}

/* 提权流程日志（写在用户数据目录，便于排查） */
function elevLog(msg) {
  const line = `[${new Date().toLocaleString('zh-CN')}] ${msg}\n`;
  console.log('[guard]', msg);
  try {
    fs.appendFileSync(path.join(app.getPath('userData'), 'guard-elev.log'), line);
  } catch (_) {}
}

/* 管理员实例运行时：创建/刷新最高权限计划任务，之后可无 UAC 静默提权 */
async function ensureGuardTask() {
  try {
    const exe = process.execPath.replace(/'/g, "''");
    const args = relaunchArgs().replace(/'/g, "''");
    const ps = [
      `$a = New-ScheduledTaskAction -Execute '${exe}' -Argument '${args}'`,
      `$p = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\\$env:USERNAME" -LogonType Interactive -RunLevel Highest`,
      `Register-ScheduledTask -TaskName '${GUARD_TASK}' -Action $a -Principal $p -Force | Out-Null`,
    ].join('; ');
    const r = await runCmd('powershell.exe', ['-NoProfile', '-Command', ps]);
    elevLog(`计划任务${r.code === 0 ? '已创建/刷新（之后启动免 UAC）' : '创建失败 code=' + r.code}`);
  } catch (e) {
    elevLog('ensureGuardTask 异常: ' + e.message);
  }
}

/*
 * 提权重启：必须先退出本实例、等锁释放，再由独立进程拉起管理员实例，
 * 否则新实例抢不到单实例锁会秒退，应用整体消失（"没反应"）。
 * silent=true：用已存在的计划任务（免 UAC）；false：弹 UAC 授权。
 */
function scheduleElevatedRestart(silent) {
  const { spawn } = require('node:child_process');
  // PowerShell 单引号字符串里，单引号要用两个表示
  const exe = process.execPath.replace(/'/g, "''");
  const args = relaunchArgs().replace(/'/g, "''");
  elevLog(`提权重启：${silent ? '静默（计划任务）' : 'UAC 授权'} → ${process.execPath}`);
  try {
    let c;
    if (silent) {
      // 计划任务本身就是最高权限，直接触发，无需 UAC
      c = spawn('schtasks', ['/Run', '/TN', GUARD_TASK], { windowsHide: true, detached: true, stdio: 'ignore' });
      c.on('error', (e) => elevLog('静默提权失败: ' + e.message));
    } else {
      // 注意：-Verb 属 UseShellExecute 参数集，不能与本 cmdlet 的 -WindowStyle 同时使用
      c = spawn(
        'powershell.exe',
        ['-NoProfile', '-WindowStyle', 'Hidden', '-Command',
          `Start-Process -FilePath '${exe}'${args ? ` -ArgumentList '${args}'` : ''} -Verb RunAs`],
        { windowsHide: true, detached: true, stdio: 'ignore' }
      );
      c.on('error', (e) => elevLog('UAC 提权失败: ' + e.message));
    }
    c.unref();
  } catch (e) {
    elevLog('无法启动提权进程（保持当前实例运行）: ' + (e && e.message));
    return;
  }
  data.settings.elevLastTry = Date.now();
  saveNow();
  quitting = true;
  setTimeout(() => {
    saveNow();
    app.quit();
  }, 400);
}

/* 计划任务是否存在（查询本身失败也当作不存在，交给 UAC 兜底） */
async function hasGuardTask() {
  try {
    return (await runCmd('schtasks', ['/Query', '/TN', GUARD_TASK])).code === 0;
  } catch (e) {
    elevLog('查询计划任务失败（走 UAC 兜底）: ' + e.message);
    return false;
  }
}

/* 开着强制模式/灰名单但当前不是管理员 → 自动提权重启 */
async function elevateGuardIfNeeded() {
  try {
    if (!isGuardActive()) {
      elevLog('未开启强制模式/灰名单，跳过提权');
      return;
    }
    const admin = await guardian.isAdmin();
    elevLog(`守护已启用，当前管理员=${admin}`);
    if (admin) {
      await ensureGuardTask();
      return;
    }
    // 10 分钟内已经试过（多半是用户拒绝了 UAC）→ 不再反复重启，避免闪退循环
    const last = Number(data.settings.elevLastTry) || 0;
    if (Date.now() - last < 10 * 60 * 1000) {
      elevLog('10 分钟内已尝试过提权，跳过本次（可在守护页手动点「以管理员身份重启」）');
      return;
    }
    // 1) 优先静默：计划任务已存在则可免 UAC 提权
    if (await hasGuardTask()) {
      elevLog('检测到提权计划任务 → 静默提权重启');
      scheduleElevatedRestart(true);
      return;
    }
    // 2) 首次：UAC 授权一次，之后管理员实例会创建计划任务，以后免弹窗
    elevLog('无提权计划任务 → 弹 UAC 请求提权（请在弹窗点「是」）');
    scheduleElevatedRestart(false);
  } catch (e) {
    elevLog('elevateGuardIfNeeded 异常: ' + (e && e.message));
  }
}

/* ------------------------------------------------------------------ */
/* 生命周期                                                            */
/* ------------------------------------------------------------------ */

/* 桌面图标自检函数：定义在 registerIpc() 内部，这里持有引用供启动流程调用 */
let restoreIconsFn = null;

/* 启动日志：排查「进程活着但没有界面」这类问题全靠它 */
function bootLog(msg) {
  try {
    const f = path.join(app.getPath('userData'), 'boot.log');
    try {
      if (fs.statSync(f).size > 200 * 1024) fs.writeFileSync(f, '');
    } catch (_) {}
    fs.appendFileSync(f, `[${new Date().toLocaleString('zh-CN', { hour12: false })}] ${msg}\n`);
  } catch (_) {}
}

/* 同步小睡（启动阶段没有事件循环可用） */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/*
 * 清理同名僵尸实例（排除自己）。
 * 需要管理员权限才能杀掉提权进程，杀不动就静默跳过，不阻塞启动。
 */
function clearStaleInstances() {
  const { execFileSync } = require('node:child_process');
  // 只杀「比自己启动更早」的同名进程：避免误伤本进程在启动阶段已派生的子进程
  const ps = [
    `$me = Get-Process -Id ${process.pid} -ErrorAction SilentlyContinue`,
    'if (-not $me) { exit }',
    `Get-Process PlanQuest -ErrorAction SilentlyContinue | Where-Object { $_.Id -ne ${process.pid} -and $_.StartTime -lt $me.StartTime } | Stop-Process -Force -ErrorAction SilentlyContinue`,
  ].join('; ');
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], {
      windowsHide: true,
      timeout: 9000,
      stdio: 'ignore',
    });
  } catch (_) {}
  sleepSync(1800); // 等句柄与锁释放
}

/*
 * 获取运行权，三种结果：
 *  owner   —— 拿到锁，正常启动
 *  secondary —— 已有实例并成功叫醒它，自己退出
 *  forced  —— 叫不醒又抢不到锁（老版本/提权僵尸占着），降级为无锁启动，
 *             宁可短暂出现两个实例，也绝不让用户「双击没反应」
 */
async function acquireInstance() {
  if (process.argv.includes('--force-new')) {
    bootLog('启动参数 --force-new：跳过单实例锁');
    return 'owner';
  }
  if (app.requestSingleInstanceLock()) {
    bootLog('单实例锁获取成功');
    return 'owner';
  }
  bootLog('单实例锁被占用，尝试叫醒已有实例');
  const openFile = process.argv.find((a) => /\.pqplan$/i.test(String(a)) && !String(a).startsWith('--'));
  if (await wakeExistingInstance(openFile ? JSON.stringify({ cmd: 'open', file: openFile }) : null)) {
    bootLog('已有实例响应，本进程退出');
    return 'secondary';
  }
  bootLog('已有实例无响应（可能是旧版本或提权僵尸），开始清理');
  clearStaleInstances();
  if (app.requestSingleInstanceLock()) {
    bootLog('清理后获取锁成功');
    return 'owner';
  }
  bootLog('清理失败（多半是管理员权限实例），降级为无锁启动');
  return 'forced';
}

/*
 * 跨权限“唤起窗口”通道（本机回环 TCP）：
 * Electron 的 second-instance 事件依赖命名管道，主实例是管理员、新实例是普通权限时会被系统挡住，
 * 结果就是「双击图标没反应、窗口叫不出来」。回环 TCP 不受完整性级别限制，用它兜底。
 */
const SHOW_PORT = 48767;

function wakeExistingInstance(payload) {
  return new Promise((resolve) => {
    try {
      const sock = require('node:net').connect(SHOW_PORT, '127.0.0.1', () => {
        sock.write(payload || 'show');
        sock.end();
        resolve(true);
      });
      sock.on('error', () => resolve(false));
      sock.setTimeout(1200, () => {
        sock.destroy();
        resolve(false);
      });
    } catch (_) {
      resolve(false);
    }
  });
}

function startWakeServer() {
  try {
    const server = require('node:net').createServer((sock) => {
      sock.on('data', (chunk) => {
        const msg = String(chunk || '');
        // 新协议：{"cmd":"open","file":"..."} = 双击 .pqplan 唤起已有实例并处理该文件
        try {
          const j = JSON.parse(msg);
          if (j && j.cmd === 'open' && j.file) {
            try {
              if (mainWindow && !mainWindow.isDestroyed()) {
                if (mainWindow.isMinimized()) mainWindow.restore();
                mainWindow.show();
                mainWindow.focus();
              } else {
                showMainWindow();
              }
            } catch (_) {}
            openPlanFileHook?.(j.file);
            return;
          }
        } catch (_) {}
        // 兼容旧协议：裸 'show' = 只把窗口叫到最前面
        try {
          if (mainWindow && !mainWindow.isDestroyed()) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.show();
            mainWindow.focus();
          } else {
            showMainWindow();
          }
        } catch (_) {}
      });
      sock.on('error', () => {});
    });
    server.on('error', () => {});
    server.listen(SHOW_PORT, '127.0.0.1');
    server.unref?.();
  } catch (_) {}
}

(async () => {
  bootLog('进程启动 pid=' + process.pid + ' argv=' + process.argv.slice(1).join(' '));
  // 双击 .pqplan 文件启动：先记下路径，等主窗口加载完成后再弹处理对话框
  pendingOpenFile = process.argv.find((a) => /\.pqplan$/i.test(String(a)) && !String(a).startsWith('--')) || null;
  const mode = await acquireInstance();
  bootLog('运行模式 = ' + mode);

  if (mode === 'secondary') {
    // 已有实例已被叫醒，本进程使命结束
    setTimeout(() => app.quit(), 300);
    return;
  }

  startWakeServer();
  app.on('second-instance', (_e, argv) => {
    showMainWindow();
    const f = (argv || []).find((a) => /\.pqplan$/i.test(String(a)) && !String(a).startsWith('--'));
    if (f && openPlanFileHook) openPlanFileHook(f);
  });

  app.whenReady().then(() => {
    loadData();
    /* 自更新收尾：上次更新时若正在运行的 exe 无法覆盖，会在 updates/flow 下留
     * pending-swap 标记；此刻旧进程已退出，补做替换（只动被占用的文件）。 */
    try {
      const fin = updateFlow.finalizePending(
        path.join(updateDir(), 'flow', updateFlow.PENDING)
      );
      if (fin && !fin.skipped) bootLog('自更新收尾：' + (fin.ok ? '已替换 ' + fin.replaced + ' 个文件' : '仍有 ' + fin.left + ' 个待替换'));
    } catch (_) {}
    // 借分逾期结算 + 欠分期间的「打开软件」微目标（每天第一次打开自动算一步）
    try {
      creditCheckOverdue();
      if ((data.profile.points || 0) < 0) microComplete('open');
    } catch (err) {
      console.error('[micro/credit] 初始化失败', err);
    }

    /* 屏幕共享授权：只有渲染层主动选过源（screen:pick）才放行一次，
       其余情况一律拒绝，避免页面在用户不知情时抓屏。 */
    try {
      session.defaultSession.setDisplayMediaRequestHandler(
        (_req, callback) => {
          const src = pickedDisplaySource;
          pickedDisplaySource = null; // 一次授权只用一次
          if (src) callback({ video: src, audio: false });
          else callback({});
        },
        { useSystemPicker: false }
      );
    } catch (e) {
      console.log('[screen] 注册屏幕共享处理器失败: ' + (e && e.message));
    }
    // 首次运行时，如果设置里开着自启但系统没有，则同步一次
    if (data.settings.autoStart) setAutoStart(true);

    // 「开机时」计划的基准点：本次启动时刻
    bootMinutes = nowMinutes();

    // 动态图标指示器：有任务进行中时图标不停变色
    startIconIndicator();

    // LiveKit 语音：密钥配置只在本机；房主给所有成员签发"门票"
    livekit.init(app.getPath('userData'));
    room.setLivekitIssuer((p) => livekit.grant(p));

    // 军团：房主侧的成员摘要落盘（重启后战报还在）；事件转给渲染层
    legion.setStorePath(path.join(app.getPath('userData'), 'legion.json'));
    legion.setEmitter((evt) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('legion:event', evt);
      }
    });

    // 专注模式没开却残留着"隐藏图标"状态 → 延迟自检并恢复
    if (!data.focusMode) setTimeout(() => restoreIconsFn && restoreIconsFn(), 2000);

    // 自习房事件转发到主窗口
    let lastRoomSig = '';
    room.setEmitter((evt) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        // 成员快照每秒都会来一次（房主心跳）——成员没变就不要触发整页重绘，
        // 否则用户正在输入框里打的字会被重建的 DOM 冲掉
        let membersChanged = true;
        if (evt.type === 'snapshot') {
          const sig = (evt.members || []).map((m) => m.id).sort().join(',');
          membersChanged = sig !== lastRoomSig;
          lastRoomSig = sig;
        }
        mainWindow.webContents.send('room:event', evt);
        if (evt.type === 'snapshot' && membersChanged) broadcast();
        if (evt.type === 'mute' && evt.id !== 'host') {
          mainWindow.webContents.send('app:toast', {
            msg: `🔇 ${evt.name} 被禁言 ${Math.round(evt.seconds / 60)} 分钟`,
            sub: evt.reason,
          });
        }
        if (evt.type === 'funEnded') {
          guardian.setAllowUntil(0);
          funAllowUntil = 0;
          discovery.update({ room: null });
          mainWindow.webContents.send('app:toast', {
            msg: '🎉 娱乐房时间到',
            sub: evt.reason || '兑换时长已用完，房间已结束',
          });
          broadcast();
        }
      }
    });

    // 局域网发现 / 拉人
    discovery.setEmitter((inv) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('room:event', { type: 'invite', ...inv });
      }
    });
    discovery.start({
      name: data.profile.name || '同学',
      avatar: data.profile.avatar || '🙂',
      room: null,
    });
    // 退出自习房时同步状态

    // 守护模块：加载持久化配置并恢复运行状态
    const g = data.guardian || {};
    guardian.state.user = g.user || '';
    guardian.state.salt = g.salt || '';
    guardian.state.hash = g.hash || '';
    guardian.setLists(g);
    guardian.setEmitter((evt) => {
      // 名单外软件：先弹提醒窗口（主窗口关到托盘也要能弹）
      // 只提醒、不扣分——积分只跟「计划里放行非白名单普通软件」挂钩
      if (evt.type === 'unlisted') {
        showUnlistedWindow({ items: evt.items, deduct: evt.deduct, limit: 5 });
        if (evt.penalties && evt.penalties.length && mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('app:toast', {
            msg: '⚠️ 这些软件反复提醒仍未加入名单',
            sub: evt.penalties.map((p) => p.name).join('、') + ' · 不扣积分，建议加入灰名单或写进计划',
          });
        }
        return;
      }
      if (!mainWindow || mainWindow.isDestroyed()) return;
      if (evt.type === 'killed') {
        mainWindow.webContents.send('app:toast', {
          msg: '🛡️ 已强制关闭违规应用',
          sub: evt.names.join('、'),
        });
      } else if (evt.type === 'escalation') {
        mainWindow.webContents.send('app:toast', {
          msg: evt.on ? '⛔ 积分为负，名单已升级' : '✅ 积分已转正，名单恢复原状',
          sub: evt.on
            ? '灰名单按黑名单处理，普通软件按灰名单处理，计划放行普通进程已禁用（可在守护页兑换灰名单时长）'
            : '灰名单与普通软件恢复原有规则，计划放行恢复',
        });
      } else if (evt.type === 'planProcOver') {
        mainWindow.webContents.send('app:toast', {
          msg: `⏱️ ${evt.name} 已用满 ${evt.budgetMin} 分钟额度`,
          sub: '计划内放行结束，之后按普通软件规则处理',
        });
      } else if (evt.type === 'admin') {
        mainWindow.webContents.send('app:toast', {
          msg: '🛡️ 有软件需要管理员权限才能关闭',
          sub: '应用正在自动提权重启，请在 UAC 弹窗点「是」',
        });
      }
    });
    guardian.setPlanAllowProvider(activePlanAllow);
    if (g.enabled) guardian.setEnabled(true, hasActivePlan);
    else guardian.startLoop(hasActivePlan); // 常驻循环：空闲自动跳过，有计划/强制模式时才扫描

    // 守护需要提权：开了强制模式或灰名单时，自动以管理员身份重启
    elevateGuardIfNeeded();

    registerIpc();

    // .pqplan 文件关联（只写 HKCU，免管理员；仅打包版注册，开发环境不污染）
    if (app.isPackaged && registerPlanFileAssocHook) registerPlanFileAssocHook();

    createMainWindow();
    createTray();

    setInterval(() => {
      checkDueReminders();
      sweepTempPlans(); // 跨天时自动删除昨天的临时计划
    }, 20000);
    setTimeout(checkDueReminders, 4000);

    // 调试：自动化联机测试
    if (process.env.PQ_AUTOCREATE) {
      setTimeout(async () => {
        const type = process.env.PQ_AUTOCREATE_TYPE === 'fun' ? 'fun' : 'study';
        const minutes = Number(process.env.PQ_AUTOCREATE_MINUTES) || 30;
        const r = await room.createRoom({
          name: '房主A',
          avatar: '🦊',
          type,
          minutes,
          cred: guardian.credentialSummary(),
        });
        console.log('[room:create]', JSON.stringify(r));
        if (r.ok) {
          funAllowUntil = type === 'fun' ? r.funEndsAt : 0;
          discovery.update({ room: { code: r.code, type, port: r.port } });
          broadcast();
          if (process.env.PQ_AUTOCREATE_CHAT) {
            setTimeout(() => {
              room.sendChat('大家晚上好，今天冲 3 个番茄！');
              room.sendChat('加微信领资料'); // 触发违规词禁言，验证检测
            }, 3000);
          }
        }
      }, 2000);
    }
    if (process.env.PQ_AUTOJOIN) {
      const [ip, code] = process.env.PQ_AUTOJOIN.split(':');
      setTimeout(() => {
        room
          .joinRoom({ ip, port: 48765, code, name: '同学B', avatar: '🐱' })
          .then((r) => console.log('[room:join]', JSON.stringify(r)))
          .catch((e) => console.error('[room:join]', e));
      }, 9000);
    }

    app.on('activate', () => showMainWindow());
  }).catch((err) => {
    // 启动流程里任何异步错误都写进 boot.log，否则只会表现为"窗口一闪就没"
    bootLog('whenReady 启动流程出错：' + ((err && err.stack) || err));
  });

  app.on('before-quit', () => {
    quitting = true;
    // 军团房主服务：退出前落盘并断开，别让端口跟着僵尸进程挂着
    try { legion.leaveLegion(true); } catch (_) {}
    // 护眼息屏窗口开着时退出 → 直接销毁，不能拦着不让退
    try {
      if (eyeCareTimer) clearInterval(eyeCareTimer);
      if (eyeCarePhaseTimer) clearTimeout(eyeCarePhaseTimer);
      if (eyeCareWindow && !eyeCareWindow.isDestroyed()) {
        eyeCareAllowClose = true;
        eyeCareWindow.destroy();
      }
    } catch (_) {}
    // 专注模式开着时退出 → 自动恢复桌面图标，避免桌面一直空着
    if (data?.focusMode) {
      data.focusMode = false;
      saveNow();
      try {
        setDesktopIcons(true); // 异步执行即可，子进程独立于本进程存活
      } catch (_) {}
    }
    saveNow();
  });

  app.on('window-all-closed', (e) => {
    // 常驻托盘，不退出
  });
})();

process.on('uncaughtException', (err) => {
  console.error('[uncaught]', err);
  bootLog('uncaughtException: ' + ((err && err.stack) || err));
});
process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err);
  bootLog('unhandledRejection: ' + ((err && err.stack) || err));
});
