'use strict';
/* ------------------------------------------------------------------ *
 * 阿刺养成 + 战友 PK 核心规则（主进程侧，纯逻辑，可单测，时间可注入）
 * 关系重塑：阿刺是战友/搭档，不是宠物。
 *   - 基础态永远可用（查表、毒舌、排计划提议等核心功能不收费、不消耗）；
 *   - 浇水 = 战术注入：消耗积分换「协作能量」，解锁强化态补给；
 *   - 不浇水不降级：只停止成长 + 阴阳怪气，不枯萎、不死亡。
 *
 * 升级链：想赢 PK → 阿刺属性强 → 升级 → 浇水 → 花积分 → 做计划赚积分。
 *
 * 全部数值集中在此，UI 只展示，不自己算。所有外部作用（扣积分、发消息）
 * 由调用方根据返回的 effect 执行，本模块不碰网络/磁盘/Electron。
 * ------------------------------------------------------------------ */

/* 皮肤表/语气/改名判定都在 aci-skin.js（同一份源码双端共用） */
const skinCore = require('./aci-skin');

/* ============ 规则常量 ============ */
const RULES = {
  POINTS_PER_ENERGY: 10,         // 10 积分 = 1 单位协作能量（一次浇水）—— 从 100 调低
  EXP_PER_WATER: 10,             // 每次浇水 +10 经验（10级→11级需110经验=11次浇水）
  SUPPLY_WEEKLY_LIMIT: 3,        // 强化态补给：阿刺自己启动的每周次数上限
  SUPPLY_AUTO_BASE: 0.15,        // 阿刺自己启动补给的基础概率（心情普通）
  SUPPLY_AUTO_GOOD_BONUS: 0.45,  // 心情好时的概率加成（0.15 → 0.60）
  SUPPLY_AUTO_BAD_PENALTY: 0.10, // 失望/生气时的概率惩罚（0.15 → 0.05）
  GUARANTEE_LEVEL_CAP: 5,        // 信用担保：每 5 级可多担保 1 次透支
  GUARANTEE_ENERGY_PER: 2,       // 信用担保：每 2 点能量可多担保 1 次透支
  EXP_PER_LEVEL: 10,             // 升级所需经验 = 当前等级 × 10
  MAX_LEVEL: 100,                // 阿刺等级上限（另见：用户等级满级 99，两者独立）
  TICKET_COST_PLANS: 5,          // 一张挑战券 = 完成 5 条计划的积分
  BASE_POINTS_PER_PLAN: 10,      // 完成一条计划基础积分（与 src/main.js doCheckin 口径一致）
  MAX_TICKETS: 3,                // 挑战券上限，不可累积超过 3 张
  DAILY_INITIATE: 1,             // 每日最多发起 1 次
  DAILY_ACCEPT: 2,               // 每日最多接受 2 次
  SAME_OPPONENT_COOLDOWN_MS: 48 * 3600 * 1000, // 同一对手 48h 内不可重复约战
  AFTER_MATCH_COOLDOWN_MS: 12 * 3600 * 1000,   // 赛后阿刺 12h 冷却
  COOLDOWN_SKIP_TICKETS: 1,      // 消耗 1 张挑战券立即解除冷却
  WIN_RATE_WEIGHT: 0.7,          // 胜负公式：完成率权重
  ACI_LEVEL_WEIGHT: 0.3,         // 胜负公式：阿刺等级系数权重
  MATCH_MIN_MS: 24 * 3600 * 1000,       // PK 时长下限 1 天
  MATCH_MAX_MS: 7 * 24 * 3600 * 1000,   // PK 时长上限 1 周
  MATCH_DEFAULT_DAYS: 3,               // 默认 PK 时长 3 天
  MATCH_WINDOW_MS: 30 * 1000,          // 匹配池等待 30 秒
  MATCH_EXPAND_MS: 30 * 1000,          // 30 秒未匹配到同段 → 扩段
  MATCH_CONFIRM_MS: 15 * 1000,         // 匹配成功 → 15 秒确认
  CHALLENGE_NO_RESPONSE_MS: 60 * 1000, // 发起后 60 秒未响应视为拒绝
  NOVICE_PROTECT_MATCHES: 3,     // 新芽段前 3 场失败不扣券
  LOSE_STREAK_PROTECT: 3,        // 连续 3 败触发连败保护
  HIDDEN_MS: 24 * 3600 * 1000,   // 隐身退出匹配池 24h
  RATE_TOLERANCE: 15,            // 同段完成率校准 ±15%
};

/* 段位（按阿刺等级） */
const TIERS = [
  { id: 'sprout', name: '新芽段', min: 1, max: 20, note: '新人保护区' },
  { id: 'grow',   name: '生长段', min: 21, max: 50, note: '主力区' },
  { id: 'lush',   name: '茂盛段', min: 51, max: 80, note: '进阶区' },
  { id: 'tall',   name: '参天段', min: 81, max: 100, note: '顶端区' },
];

/* 强化态补给（浇水解锁的高级功能）
 * points: 在积分商城兑换价；energy: 阿刺自己启动时消耗的能量。 */
const SUPPLIES = [
  { id: 'deepAnalysis', name: '深度分析', desc: '历史数据挖掘、趋势报告', points: 30, energy: 1 },
  { id: 'replyForMe',   name: '代回消息', desc: '好友区/军团里代拟并发送回复', points: 50, energy: 2 },
  { id: 'pkTactics',    name: 'PK 战术建议', desc: '针对对手数据的针对性策略', points: 30, energy: 1 },
  { id: 'defyGuard',    name: '抗命担保', desc: '替你扛一次不合理命令的后果', points: 80, energy: 3 },
  { id: 'forceReview',  name: '强制复盘', desc: '连续低完成率时弹窗复盘', points: 20, energy: 1 },
];

/* 战友特权（默认参数，状态在 aci.privileges） */
const PRIVILEGE_DEFAULTS = {
  disappointment: { enabled: true, thresholdRate: 40, thresholdDays: 3 }, // 失望模式：完成率<40% 连续3天
  forceReview:    { enabled: true, thresholdRate: 60, thresholdDays: 3 }, // 强制复盘：完成率<60% 连续3天
  deductGuard:    { enabled: true, charges: 0 },       // 代扣分：阿刺消耗能量替扛一次扣分
  creditGuarantee:{ enabled: true, active: false },   // 信用担保：替用户透支积分，赖账则阿刺降级
  defy:           { enabled: true, pending: null },   // 抗命机制：不合理命令弹确认框
  autoMute:       { enabled: true, muteMinutes: 30 }, // 主动禁言：人身攻击时切断对话30分钟
};

/* ============ 默认数据 ============ */
function defaultAci() {
  return {
    level: 1,
    exp: 0,
    energy: 0,          // 协作能量（浇水获得，消耗于强化态补给）
    waterCount: 0,      // 累计浇水次数
    waterDay: '',       // 上次浇水的日期 key
    tickets: 0,         // 挑战券 0~3
    supplies: {},       // 已解锁补给 id -> 解锁次数（积分商城兑换 + 自己启动）
    supplyWeek: { week: '', used: 0 }, // 阿刺自己启动补给的每周计数（满 3 次本周不再自动）
    privileges: JSON.parse(JSON.stringify(PRIVILEGE_DEFAULTS)),
    /* 身份：皮肤（五种带刺生物，只选一次）+ 名字（可改，但阿刺有权不接受） */
    identity: {
      skin: '',        // cactus/rose/hedgehog/chestnut/porcupine；空 = 还没选
      name: '阿刺',    // 初始名，改名前先问阿刺
      chosenAt: 0,     // 选定皮肤的时间戳
      renameCount: 0,  // 成功改名次数（改得越多越难再改）
    },
    mood: 'idle',       // 基础态心情：idle/happy/disappointed/angry/sad（驱动 3D 建模与互动意愿）
    disappointed: false,// 失望模式激活标志（连续摆烂触发）：样子改变 + 不太接受互动
    guaranteeLeft: 0,   // 信用担保剩余可透支次数（按阿刺自身等级/能量计算）
    pk: {
      day: '',                  // 频率计数的日期 key
      initiateToday: 0,
      acceptToday: 0,
      lastOpponent: {},         // opponentKey -> 上次对战时间戳
      cooldownUntil: 0,         // 赛后冷却到期时间戳
      hiddenUntil: 0,           // 隐身到期时间戳
      loseStreak: 0,            // 连续失败场数
      noviceLeft: RULES.NOVICE_PROTECT_MATCHES, // 新芽段剩余保护场数
      stats: { wins: 0, losses: 0, draws: 0, escapes: 0, total: 0 },
      matches: [],              // 历史挑战（含进行中）
    },
  };
}

/* 归一化：老数据缺字段补齐，嵌套对象逐层合并，数值兜底 */
function normalizeAci(raw) {
  const base = defaultAci();
  const a = (raw && typeof raw === 'object') ? raw : {};
  const out = {
    ...base, ...a,
    level: clampInt(a.level, 1, RULES.MAX_LEVEL, 1),
    exp: clampInt(a.exp, 0, 1e9, 0),
    energy: clampInt(a.energy, 0, 1e9, 0),
    waterCount: clampInt(a.waterCount, 0, 1e9, 0),
    tickets: clampInt(a.tickets, 0, RULES.MAX_TICKETS, 0),
    supplies: (a.supplies && typeof a.supplies === 'object') ? a.supplies : {},
    privileges: normalizePrivileges(a.privileges),
    identity: normalizeIdentity(a.identity),
    mood: typeof a.mood === 'string' ? a.mood : 'idle',
    disappointed: !!a.disappointed,
    guaranteeLeft: clampInt(a.guaranteeLeft, 0, 1e6, 0),
    supplyWeek: (a.supplyWeek && typeof a.supplyWeek === 'object')
      ? { week: String(a.supplyWeek.week || ''), used: clampInt(a.supplyWeek.used, 0, RULES.SUPPLY_WEEKLY_LIMIT, 0) }
      : { week: '', used: 0 },
  };
  const pk = (a.pk && typeof a.pk === 'object') ? a.pk : {};
  out.pk = {
    ...base.pk, ...pk,
    initiateToday: clampInt(pk.initiateToday, 0, 1e6, 0),
    acceptToday: clampInt(pk.acceptToday, 0, 1e6, 0),
    lastOpponent: (pk.lastOpponent && typeof pk.lastOpponent === 'object') ? pk.lastOpponent : {},
    loseStreak: clampInt(pk.loseStreak, 0, 1e6, 0),
    noviceLeft: clampInt(pk.noviceLeft, 0, RULES.NOVICE_PROTECT_MATCHES, RULES.NOVICE_PROTECT_MATCHES),
    cooldownUntil: Number(pk.cooldownUntil) || 0,
    hiddenUntil: Number(pk.hiddenUntil) || 0,
    stats: { ...base.pk.stats, ...(pk.stats && typeof pk.stats === 'object' ? pk.stats : {}) },
    matches: Array.isArray(pk.matches) ? pk.matches : [],
  };
  return out;
}

/* 身份归一化：皮肤必须是已知五种之一，名字兜底回「阿刺」 */
function normalizeIdentity(raw) {
  const r = (raw && typeof raw === 'object') ? raw : {};
  const skin = skinCore.get(String(r.skin || '')) ? String(r.skin) : '';
  let name = String(r.name == null ? '' : r.name).trim().slice(0, 8);
  if (!name) name = '阿刺';
  return {
    skin,
    name,
    chosenAt: Number(r.chosenAt) || 0,
    renameCount: clampInt(r.renameCount, 0, 99, 0),
  };
}

function normalizePrivileges(raw) {
  const d = PRIVILEGE_DEFAULTS;
  const r = (raw && typeof raw === 'object') ? raw : {};
  const one = (key) => ({ ...d[key], ...(r[key] && typeof r[key] === 'object' ? r[key] : {}) });
  return {
    disappointment: one('disappointment'), forceReview: one('forceReview'),
    deductGuard: one('deductGuard'), creditGuarantee: one('creditGuarantee'),
    defy: one('defy'), autoMute: one('autoMute'),
  };
}

function clampInt(v, lo, hi, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, Math.floor(n)));
}

/* ============ 身份：选皮肤 / 改名 / 重置 ============ */
function skinOf(aci) {
  return skinCore.get(normalizeAci(aci).identity.skin);
}
/* 还没选皮肤 → 阿刺是「未成形」状态，AI 助手不可用（产品硬门槛） */
function isIdentityLocked(aci) {
  return !normalizeAci(aci).identity.skin;
}

/* 选皮肤：只允许一次。已选过就按「合同签了就别想反悔」拒绝。 */
function chooseSkin(aci, skinId, now) {
  const a = normalizeAci(aci);
  const s = skinCore.get(String(skinId || ''));
  if (!s) return { ok: false, reason: '没有这种皮肤', aci: a };
  if (a.identity.skin) {
    return { ok: false, refused: true, reason: skinCore.requestSkinChange(a.identity.skin).reply, aci: a };
  }
  const next = {
    ...a,
    identity: { ...a.identity, skin: s.id, chosenAt: Number(now) || Date.now() },
    mood: 'happy',
  };
  return {
    ok: true,
    aci: next,
    message: skinCore.greeting(s.id, next.identity.name),
    skin: s.id,
  };
}

/* 改名：先让阿刺自己判断接不接受（心情/等级/被改次数都会影响） */
function evaluateCompanionName(aci, name, rng) {
  const a = normalizeAci(aci);
  const ev = skinCore.evaluateRename(a.identity.skin, name, {
    current: a.identity.name,
    mood: a.mood,
    level: a.level,
    disappointed: a.disappointed,
    renameCount: a.identity.renameCount,
    rng,
  });
  return ev;
}

function setCompanionName(aci, name, now) {
  const a = normalizeAci(aci);
  const clean = String(name == null ? '' : name).trim().replace(/\s+/g, ' ').slice(0, 8);
  if (!clean) return { ok: false, reason: '名字不能是空的', aci: a };
  const next = {
    ...a,
    identity: {
      ...a.identity,
      name: clean,
      renameCount: clampInt(a.identity.renameCount, 0, 99, 0) + 1,
    },
    mood: 'happy',
  };
  return {
    ok: true,
    aci: next,
    message: clean === '阿刺' ? '行，叫回「阿刺」。' : `以后就叫「${clean}」了。`,
  };
}

/* 换皮肤请求：永远拒绝，但给出唯一出路（reset）的说明 */
function requestCompanionSkinChange(aci, rng) {
  const a = normalizeAci(aci);
  const r = skinCore.requestSkinChange(a.identity.skin, { rng });
  return { ok: false, refused: true, message: r.reply, hint: r.hint, aci: a };
}

/* 重置：清空养成，回到未选皮肤状态（聊天记录由渲染层一并清掉） */
function resetCompanion(aci, rng) {
  const a = normalizeAci(aci);
  return {
    ok: true,
    aci: defaultAci(),
    message: skinCore.resetLine(a.identity.skin, rng),
    purgeChat: true,
    identityReset: true,
  };
}

/* ============ 浇水 / 能量 / 升级 ============ */
/* 浇水：消耗 100 积分 → +1 能量 +10 经验；经验满则升级（可连升）。
 * 不浇水不降级（本函数不碰 mood/存活）。
 * 返回 { ok, reason, aci, effect:{ costPoints, levelUps } } */
function water(aci, points, dayKey, now) {
  const a = normalizeAci(aci);
  const cost = RULES.POINTS_PER_ENERGY;
  if (Number(points) < cost) {
    return { ok: false, reason: `积分不够：浇水要 ${cost} 积分，当前 ${points}`, aci: a };
  }
  let level = a.level, exp = a.exp + RULES.EXP_PER_WATER, levelUps = 0;
  /* 升级所需经验 = 目标等级 × 10（需求例：10级→11级需 110 经验 = 11 次浇水）。
   * 所以从 level 升到 level+1 需要 (level+1)×10 经验。 */
  while (level < RULES.MAX_LEVEL && exp >= (level + 1) * RULES.EXP_PER_LEVEL) {
    exp -= (level + 1) * RULES.EXP_PER_LEVEL;
    level++;
    levelUps++;
  }
  if (level >= RULES.MAX_LEVEL) exp = 0; // 满级后经验不再累积
  const next = {
    ...a,
    level, exp,
    energy: a.energy + 1,
    waterCount: a.waterCount + 1,
    waterDay: dayKey || a.waterDay,
  };
  return {
    ok: true, aci: next,
    effect: { costPoints: cost, levelUps, level, exp },
    message: `浇水成功：消耗 ${cost} 积分，协作能量 +1，经验 +${RULES.EXP_PER_WATER}` +
      (levelUps ? `，阿刺升到 Lv.${level}！` : `（还差 ${(level + 1) * RULES.EXP_PER_LEVEL - exp} 经验升级）`),
  };
}

/* 使用一次强化态补给（消耗能量）。source: 'manual' 用户手动 | 'auto' 阿刺自己启动 */
function useSupply(aci, supplyId, opts) {
  const o = opts || {};
  const a = normalizeAci(aci);
  const s = SUPPLIES.find((x) => x.id === supplyId);
  if (!s) return { ok: false, reason: '没有这项补给', aci: a };
  if (a.disappointed && o.fromChat) {
    return { ok: false, reason: '阿刺现在失望透顶，懒得搭理你（它缓过来再说）', aci: a };
  }
  if (a.energy < s.energy) {
    return { ok: false, reason: `能量不够：${s.name} 要 ${s.energy} 点协作能量，当前 ${a.energy}`, aci: a };
  }
  /* 阿刺自己启动：受每周次数上限约束 */
  let supplyWeek = a.supplyWeek;
  if (o.source === 'auto') {
    supplyWeek = refreshSupplyWeek(supplyWeek, o.now);
    if (supplyWeek.used >= RULES.SUPPLY_WEEKLY_LIMIT) {
      return { ok: false, reason: `本周阿刺自己启动补给的次数用完了（每周最多 ${RULES.SUPPLY_WEEKLY_LIMIT} 次）`, aci: a };
    }
    supplyWeek = { ...supplyWeek, used: supplyWeek.used + 1 };
  }
  const next = {
    ...a,
    energy: a.energy - s.energy,
    supplies: { ...a.supplies, [s.id]: (a.supplies[s.id] || 0) + 1 },
    supplyWeek,
  };
  return {
    ok: true, aci: next,
    effect: { costEnergy: s.energy, source: o.source || 'manual' },
    message: o.source === 'auto'
      ? `阿刺自己启动了「${s.name}」（消耗 ${s.energy} 点能量，本周 ${supplyWeek.used}/${RULES.SUPPLY_WEEKLY_LIMIT} 次）`
      : `已启用「${s.name}」（消耗 ${s.energy} 点协作能量）`,
  };
}

/* 积分商城兑换强化态补给：花积分直接兑换一次使用资格（不消耗能量，能量留给阿刺自己启动时用） */
function redeemSupplyWithPoints(aci, supplyId, points) {
  const a = normalizeAci(aci);
  const s = SUPPLIES.find((x) => x.id === supplyId);
  if (!s) return { ok: false, reason: '没有这项补给', aci: a };
  if (Number(points) < s.points) {
    return { ok: false, reason: `积分不够：兑换「${s.name}」要 ${s.points} 积分，当前 ${points}`, aci: a };
  }
  const next = { ...a, supplies: { ...a.supplies, [s.id]: (a.supplies[s.id] || 0) + 1 } };
  return {
    ok: true, aci: next, effect: { costPoints: s.points, supplyId: s.id },
    message: `在积分商城兑换了「${s.name}」（消耗 ${s.points} 积分），阿刺已记下这项补给`,
  };
}

/* ISO 周 key（周一为起点），与 main.js weekKeyOf 口径一致 */
function weekKeyOf(now) {
  const d = new Date(now || Date.now());
  const day = (d.getDay() + 6) % 7; // 周一=0
  d.setDate(d.getDate() - day);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function refreshSupplyWeek(sw, now) {
  const key = weekKeyOf(now);
  if (sw && sw.week === key) return sw;
  return { week: key, used: 0 };
}

/* 阿刺自己启动补给的概率：心情好更大，失望/生气更小。roll 可注入便于测试（0~1）。 */
function autoSupplyChance(mood, disappointed) {
  if (disappointed) return Math.max(0.02, RULES.SUPPLY_AUTO_BASE - RULES.SUPPLY_AUTO_BAD_PENALTY);
  if (mood === 'happy' || mood === 'excited') return RULES.SUPPLY_AUTO_BASE + RULES.SUPPLY_AUTO_GOOD_BONUS;
  if (mood === 'angry' || mood === 'sad') return Math.max(0.02, RULES.SUPPLY_AUTO_BASE - RULES.SUPPLY_AUTO_BAD_PENALTY);
  return RULES.SUPPLY_AUTO_BASE;
}

/* 判断阿刺此刻是否会自己启动某项补给（不消耗，仅概率判定）。roll 0~1 可注入。
 * 返回 { trigger, chance, reason }，前端据此决定是否调 useSupply(source:'auto')。 */
function shouldAutoSupply(aci, mood, roll, now) {
  const a = normalizeAci(aci);
  const sw = refreshSupplyWeek(a.supplyWeek, now);
  if (sw.used >= RULES.SUPPLY_WEEKLY_LIMIT) {
    return { trigger: false, chance: 0, reason: '本周自动补给次数已用完' };
  }
  if (a.energy < 1) return { trigger: false, chance: 0, reason: '没有协作能量' };
  const chance = autoSupplyChance(mood || a.mood, a.disappointed);
  const r = (roll == null ? Math.random() : Number(roll));
  return {
    trigger: r < chance, chance,
    reason: r < chance ? `阿刺心情不错（${chance} 概率），主动启用强化态补给` : '这次没触发',
  };
}

/* 从当前等级升到下一级所需经验 = 目标等级 × 10（供 UI 显示进度） */
function expNeeded(level) {
  return (clampInt(level, 1, RULES.MAX_LEVEL, 1) + 1) * RULES.EXP_PER_LEVEL;
}

/* ============ 挑战券 ============ */
function ticketPrice() {
  return RULES.TICKET_COST_PLANS * RULES.BASE_POINTS_PER_PLAN; // 50 积分
}

/* 用积分兑换挑战券：一张 = 完成5条计划的积分 = 50 分，最多 3 张 */
function buyTicket(aci, points) {
  const a = normalizeAci(aci);
  if (a.tickets >= RULES.MAX_TICKETS) return { ok: false, reason: `挑战券最多 ${RULES.MAX_TICKETS} 张`, aci: a };
  const price = ticketPrice();
  if (Number(points) < price) return { ok: false, reason: `积分不够：一张挑战券要 ${price} 积分（= 完成 5 条计划）`, aci: a };
  const next = { ...a, tickets: a.tickets + 1 };
  return { ok: true, aci: next, effect: { costPoints: price }, message: `换来 1 张挑战券（消耗 ${price} 积分），现在有 ${next.tickets} 张` };
}

/* ============ 段位 / 完成率 / 战力 ============ */
function tierOf(level) {
  const lv = clampInt(level, 1, RULES.MAX_LEVEL, 1);
  return TIERS.find((t) => lv >= t.min && lv <= t.max) || TIERS[0];
}

function levelCoef(level) {
  return clampInt(level, 1, RULES.MAX_LEVEL, 1) / RULES.MAX_LEVEL * 100;
}

/* 综合战力 = 完成率×0.7 + 阿刺等级系数×0.3
 * 例：完成率80%，50级 → 80×0.7 + 50×0.3 = 71
 * 新人：100%完成率，1级 → 100×0.7 + 1×0.3 = 70.3 */
function powerOf(completionRate, level) {
  const rate = Math.min(100, Math.max(0, Number(completionRate) || 0));
  return Math.round((rate * RULES.WIN_RATE_WEIGHT + levelCoef(level) * RULES.ACI_LEVEL_WEIGHT) * 10) / 10;
}

/* ============ 频率 / 冷却 / 隐身 ============ */
function dayKeyOf(now) {
  const d = new Date(now || Date.now());
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function refreshDay(aci, now) {
  const a = normalizeAci(aci);
  const key = dayKeyOf(now);
  if (a.pk.day === key) return a;
  return { ...a, pk: { ...a.pk, day: key, initiateToday: 0, acceptToday: 0 } };
}

function isCoolingDown(aci, now) {
  return Number(aci.pk.cooldownUntil) > (now || Date.now());
}
function isHidden(aci, now) {
  return Number(aci.pk.hiddenUntil) > (now || Date.now());
}

/* 发起 PK 前的前置检查（不消耗任何东西） */
function canInitiate(aci, opponentKey, now) {
  const t = now || Date.now();
  const a = refreshDay(aci, t);
  if (a.tickets < 1) return { ok: false, reason: '没有挑战券，先去兑换（或做满 5 条计划）' };
  if (isHidden(a, t)) return { ok: false, reason: '隐身中，先退出隐身再发起' };
  if (isCoolingDown(a, t)) return { ok: false, reason: '阿刺赛后冷却中（12 小时），可用 1 张挑战券立即解除', cooling: true };
  if (a.pk.initiateToday >= RULES.DAILY_INITIATE) return { ok: false, reason: `今天发起次数已用完（每日最多 ${RULES.DAILY_INITIATE} 次）` };
  const last = opponentKey ? a.pk.lastOpponent[opponentKey] : 0;
  if (last && t - last < RULES.SAME_OPPONENT_COOLDOWN_MS) {
    return { ok: false, reason: '同一个对手 48 小时内不能重复约战' };
  }
  return { ok: true, aci: a };
}

/* 接受 PK 前检查 */
function canAccept(aci, opponentKey, now) {
  const t = now || Date.now();
  const a = refreshDay(aci, t);
  if (a.tickets < 1) return { ok: false, reason: '没有挑战券，无法应战' };
  if (isHidden(a, t)) return { ok: false, reason: '隐身中，无法应战' };
  if (a.pk.acceptToday >= RULES.DAILY_ACCEPT) return { ok: false, reason: `今天应战次数已用完（每日最多 ${RULES.DAILY_ACCEPT} 次）` };
  const last = opponentKey ? a.pk.lastOpponent[opponentKey] : 0;
  if (last && t - last < RULES.SAME_OPPONENT_COOLDOWN_MS) return { ok: false, reason: '同一个对手 48 小时内不能重复约战' };
  return { ok: true, aci: a };
}

/* 用挑战券解除赛后冷却 */
function skipCooldown(aci, now) {
  const a = normalizeAci(aci);
  const t = now || Date.now();
  if (!isCoolingDown(a, t)) return { ok: false, reason: '当前不在冷却期', aci: a };
  if (a.tickets < RULES.COOLDOWN_SKIP_TICKETS) return { ok: false, reason: '挑战券不够，解除冷却要 1 张', aci: a };
  const next = { ...a, tickets: a.tickets - RULES.COOLDOWN_SKIP_TICKETS, pk: { ...a.pk, cooldownUntil: 0 } };
  return { ok: true, aci: next, effect: { costTickets: RULES.COOLDOWN_SKIP_TICKETS }, message: '已用 1 张挑战券解除冷却' };
}

/* 隐身 24 小时（不影响好友约战） */
function setHidden(aci, hidden, now) {
  const a = normalizeAci(aci);
  const t = now || Date.now();
  const next = { ...a, pk: { ...a.pk, hiddenUntil: hidden ? t + RULES.HIDDEN_MS : 0 } };
  return { ok: true, aci: next, message: hidden ? '已隐身 24 小时（退出匹配池，好友约战不受影响）' : '已退出隐身' };
}

/* ============ 匹配池 ============ */
/* 生成匹配偏好：同段优先、完成率 ±15%、30 秒未匹配扩到相邻段 */
function matchPreference(aci, completionRate, now) {
  const a = normalizeAci(aci);
  const tier = tierOf(a.level);
  const rate = Math.min(100, Math.max(0, Number(completionRate) || 0));
  return {
    tier: tier.id, tierName: tier.name,
    rateMin: Math.max(0, rate - RULES.RATE_TOLERANCE),
    rateMax: Math.min(100, rate + RULES.RATE_TOLERANCE),
    waitMs: RULES.MATCH_WINDOW_MS,
    expandAfterMs: RULES.MATCH_EXPAND_MS,
    confirmMs: RULES.MATCH_CONFIRM_MS,
    hidden: isHidden(a, now),
  };
}

/* 相邻段位 id（用于扩段） */
function adjacentTiers(tierId) {
  const i = TIERS.findIndex((t) => t.id === tierId);
  const out = [];
  if (i > 0) out.push(TIERS[i - 1].id);
  if (i < TIERS.length - 1) out.push(TIERS[i + 1].id);
  return out;
}

/* 从候选对手里挑一个：同段优先 + 完成率校准；扩段时按相邻段。
 * candidates: [{ key, name, level, completionRate }]
 * allowExpanded: 是否允许相邻段（低段不会被高段主动挑战 → 只向下兼容） */
function pickOpponent(aci, myCompletionRate, candidates, opts) {
  const o = opts || {};
  const a = normalizeAci(aci);
  const myTier = tierOf(a.level);
  const rate = Math.min(100, Math.max(0, Number(myCompletionRate) || 0));
  const tiersAllowed = [myTier.id];
  if (o.allowExpanded) tiersAllowed.push(...adjacentTiers(myTier.id));
  const valid = (candidates || []).filter((c) => {
    if (!c || !c.key || c.key === o.selfKey) return false;
    const t = tierOf(c.level);
    if (tiersAllowed.indexOf(t.id) < 0) return false;
    // 跨段保护：低段不会被高段主动挑战（我方段位 index 小于对方 → 跳过对方）
    const myIdx = TIERS.indexOf(myTier); const theirIdx = TIERS.indexOf(t);
    if (t.id !== myTier.id && theirIdx < myIdx) return false; // 不高攀？见下解释
    return true;
  });
  if (!valid.length) return null;
  // 同段 + 完成率在校准区间的优先；否则同段；否则（扩段）相邻段且我方更高的
  const score = (c) => {
    const same = tierOf(c.level).id === myTier.id ? 0 : 1;
    const inCal = Math.abs((Number(c.completionRate) || 0) - rate) <= RULES.RATE_TOLERANCE ? 0 : 1;
    return same * 10 + inCal;
  };
  valid.sort((x, y) => score(x) - score(y));
  return valid[0];
}

/* ============ 发起挑战（含频道发布 + 时长）============ */
/* venue: local | room（自习房）| legion（军团频道）
 * durationDays: 1~7（1 天 ~ 1 周）
 * 返回 { ok, aci, match, message, effect:{ costTickets }, broadcast?:{venue,text} } */
function createChallenge(aci, opts) {
  const o = opts || {};
  const t = Number(o.now) || Date.now();
  const ck = canInitiate(aci, o.opponentKey, t);
  if (!ck.ok) return { ok: false, reason: ck.reason, cooling: !!ck.cooling, aci: normalizeAci(aci) };
  const a = ck.aci;
  const daysRaw = o.durationDays == null ? RULES.MATCH_DEFAULT_DAYS : Number(o.durationDays);
  if (!Number.isFinite(daysRaw) || daysRaw < 1 || daysRaw > 7) {
    return { ok: false, reason: 'PK 时长需在 1 天 ~ 1 周之间', aci: a };
  }
  const days = Math.floor(daysRaw);
  const durationMs = days * 24 * 3600 * 1000;
  if (durationMs < RULES.MATCH_MIN_MS || durationMs > RULES.MATCH_MAX_MS) {
    return { ok: false, reason: 'PK 时长需在 1 天 ~ 1 周之间', aci: a };
  }
  const venue = ['local', 'room', 'legion'].indexOf(o.venue) >= 0 ? o.venue : 'local';
  const match = {
    id: 'pk-' + t.toString(36) + Math.random().toString(36).slice(2, 5),
    opponentKey: o.opponentKey || '',
    opponentName: o.opponentName || '',
    venue,
    durationDays: days,
    createdAt: t,
    expiresAt: t + durationMs,
    state: o.opponentKey ? 'pending' : 'matching', // 好友约战直接 pending，否则进匹配池
    confirmBy: t + RULES.MATCH_CONFIRM_MS,
    respondBy: t + RULES.CHALLENGE_NO_RESPONSE_MS,
    result: null,
  };
  const next = {
    ...a,
    tickets: a.tickets - 1,
    pk: {
      ...a.pk,
      initiateToday: a.pk.initiateToday + 1,
      matches: [match, ...a.pk.matches].slice(0, 50),
    },
  };
  const venueText = { local: '本地', room: '自习房', legion: '军团频道' }[venue];
  const out = {
    ok: true, aci: next, match,
    effect: { costTickets: 1 },
    message: `已发出挑战券（${venueText}，${days} 天有效），消耗 1 张券。剩 ${next.tickets} 张。`,
  };
  if (venue === 'room' || venue === 'legion') {
    /* pq://pk?m=<matchId>&t=<时间戳>&n=<发起人>&d=<天数> —— 聊天里渲染成按钮，点击自动匹配 */
    const pkLink = 'pq://pk?m=' + encodeURIComponent(match.id)
      + '&t=' + t + '&n=' + encodeURIComponent(o.challengerName || '搭档')
      + '&d=' + days + '&r=' + Math.round(powerOf(o.challengerRate == null ? 70 : o.challengerRate, a.level));
    out.broadcast = {
      venue,
      text: `🤖 阿刺代【${o.challengerName || '搭档'}】发出 PK 挑战券！${days} 天内有效，${o.opponentName ? '指定对手：' + o.opponentName + '。' : '谁来都应。'}点下面的链接直接应战 → ${pkLink}`,
      link: pkLink,
      matchId: match.id,
    };
  }
  return out;
}

/* 接受挑战：消耗 1 张券，进入 active */
function acceptChallenge(aci, matchId, now) {
  const t = Number(now) || Date.now();
  const a = normalizeAci(aci);
  const match = a.pk.matches.find((m) => m.id === matchId);
  if (!match) return { ok: false, reason: '找不到这场挑战', aci: a };
  if (match.state !== 'pending' && match.state !== 'matching') return { ok: false, reason: '这场挑战不接受了', aci: a };
  if (t > match.expiresAt) return { ok: false, reason: '挑战已过期', aci: a };
  const ck = canAccept(a, match.opponentKey, t);
  if (!ck.ok) return { ok: false, reason: ck.reason, aci: a };
  const matches = a.pk.matches.map((m) => m.id === matchId ? { ...m, state: 'active', acceptedAt: t } : m);
  const next = {
    ...a,
    tickets: a.tickets - 1,
    pk: {
      ...a.pk,
      acceptToday: a.pk.acceptToday + 1,
      lastOpponent: { ...a.pk.lastOpponent, [match.opponentKey || match.id]: t },
      matches,
    },
  };
  return { ok: true, aci: next, effect: { costTickets: 1 }, message: '已应战！PK 开始，阿刺进入战斗状态。' };
}

/* 通过聊天里的 pq://pk 链接应战：对方发来的邀请，本地生成一场 active 对局并扣 1 张券。
 * inv: { matchId, name, rate, days, t } */
function acceptPkInvite(aci, inv, now) {
  const t = Number(now) || Date.now();
  const i = inv || {};
  const ck = canAccept(aci, i.matchId, t);
  if (!ck.ok) return { ok: false, reason: ck.reason, cooling: !!ck.cooling, aci: normalizeAci(aci) };
  const a = ck.aci;
  const days = Math.min(7, Math.max(1, Number(i.days) || 3));
  const match = {
    id: 'pk-' + t.toString(36) + Math.random().toString(36).slice(2, 5),
    inviteId: String(i.matchId || '').slice(0, 60),
    opponentKey: String(i.matchId || '').slice(0, 60),
    opponentName: String(i.name || '对手').slice(0, 16),
    venue: 'link',
    durationDays: days,
    createdAt: t,
    expiresAt: t + days * 24 * 3600 * 1000,
    state: 'active',
    acceptedAt: t,
    confirmBy: t + RULES.MATCH_CONFIRM_MS,
    respondBy: t + RULES.CHALLENGE_NO_RESPONSE_MS,
    result: null,
    rivalPower: Number(i.rate) || 0,
  };
  const next = {
    ...a,
    tickets: a.tickets - 1,
    pk: {
      ...a.pk,
      acceptToday: a.pk.acceptToday + 1,
      lastOpponent: { ...a.pk.lastOpponent, [match.opponentKey]: t },
      matches: [match, ...a.pk.matches].slice(0, 50),
    },
  };
  return {
    ok: true, aci: next, match, effect: { costTickets: 1 },
    message: `已应战【${match.opponentName}】的挑战券！PK 开始（对方战力 ${match.rivalPower}），阿刺进入战斗状态。`,
    autoLine: 'fight',
  };
}

/* 未响应 / 超时未确认：不消耗券（券在发起时已扣，这里返还） */
function expireChallenge(aci, matchId, reason) {
  const a = normalizeAci(aci);
  const match = a.pk.matches.find((m) => m.id === matchId);
  if (!match || !['pending', 'matching'].includes(match.state)) return { ok: false, reason: '挑战不在等待状态', aci: a };
  const matches = a.pk.matches.map((m) => m.id === matchId ? { ...m, state: 'expired', result: reason || 'no_response' } : m);
  // 发起方不消耗挑战券 → 返还 1 张（但不超过上限）
  const next = {
    ...a,
    tickets: Math.min(RULES.MAX_TICKETS, a.tickets + 1),
    pk: { ...a.pk, matches },
  };
  return { ok: true, aci: next, message: (reason === 'timeout' ? '匹配超时，已返还挑战券' : '对方未响应，已返还挑战券') };
}

/* ============ 结算 ============ */
/* settle(aci, {result, myRate, opponentKey, now})
 * result: win | lose | draw | escape
 * 胜：返还挑战券 + 额外积分（= 对手消耗的挑战券价值 = 50 分）
 * 负：券不返还；平：双方返还；逃跑：判负 + 扣信誉（effect 里标记）
 * 新芽段前3场失败不扣券；赛后 12h 冷却。 */
function settle(aci, opts) {
  const o = opts || {};
  const t = Number(o.now) || Date.now();
  const a = normalizeAci(aci);
  const result = ['win', 'lose', 'draw', 'escape'].indexOf(o.result) >= 0 ? o.result : 'lose';
  const inTier = tierOf(a.level).id === 'sprout';
  const pk = { ...a.pk };
  const stats = { ...pk.stats };
  let tickets = a.tickets;
  let bonusPoints = 0;
  let repPenalty = 0;
  let refundMsg = '';

  if (result === 'win') {
    tickets = Math.min(RULES.MAX_TICKETS, tickets + 1); // 返还
    bonusPoints = RULES.TICKET_COST_PLANS * RULES.BASE_POINTS_PER_PLAN; // 额外积分 = 对手券价值
    stats.wins++; refundMsg = '胜利：返还 1 张挑战券 + 额外 ' + bonusPoints + ' 积分';
    pk.loseStreak = 0;
  } else if (result === 'draw') {
    tickets = Math.min(RULES.MAX_TICKETS, tickets + 1); // 双方返还
    stats.draws++; refundMsg = '平局：返还 1 张挑战券';
    pk.loseStreak = 0;
  } else if (result === 'lose') {
    stats.losses++;
    if (inTier && pk.noviceLeft > 0) {
      pk.noviceLeft--;
      tickets = Math.min(RULES.MAX_TICKETS, tickets + 1); // 新手保护：不扣券
      refundMsg = '新芽段保护：本次失败不扣挑战券（剩 ' + pk.noviceLeft + ' 次保护）';
    } else {
      refundMsg = '失败：挑战券不返还';
    }
    pk.loseStreak++;
  } else { // escape
    stats.escapes++;
    repPenalty = 5; // 逃跑额外扣信誉分
    refundMsg = '逃跑判负：券不返还，额外扣 5 信誉分';
    pk.loseStreak++;
  }
  stats.total++;
  pk.stats = stats;
  pk.cooldownUntil = t + RULES.AFTER_MATCH_COOLDOWN_MS; // 赛后 12h 冷却
  if (o.opponentKey) pk.lastOpponent = { ...pk.lastOpponent, [o.opponentKey]: t };
  if (pk.loseStreak >= RULES.LOSE_STREAK_PROTECT) pk.loseStreak = RULES.LOSE_STREAK_PROTECT; // 标记触发连败保护

  const next = { ...a, tickets, pk };
  return {
    ok: true, aci: next,
    effect: { tickets, bonusPoints, repPenalty, cooldownUntil: pk.cooldownUntil, loseStreakProtect: pk.loseStreak >= RULES.LOSE_STREAK_PROTECT },
    message: refundMsg + '；阿刺进入 12 小时赛后冷却。',
  };
}

/* 连败保护：下一场优先匹配同段内完成率最低的对手 */
function useLoseStreakProtect(aci, candidates) {
  const a = normalizeAci(aci);
  if (a.pk.loseStreak < RULES.LOSE_STREAK_PROTECT) return null;
  const myTier = tierOf(a.level);
  const same = (candidates || []).filter((c) => c && tierOf(c.level).id === myTier.id);
  if (!same.length) return null;
  same.sort((x, y) => (Number(x.completionRate) || 0) - (Number(y.completionRate) || 0));
  return same[0];
}

/* ============ 战友特权 ============ */
/* 失望模式 / 强制复盘：按完成率与连续天数判断。lowDays: [{rate},...] 最近N天 */
function checkPrivilege(aci, id, lowDays) {
  const a = normalizeAci(aci);
  const p = a.privileges[id];
  if (!p || !p.enabled) return { active: false, reason: '未开启' };
  const days = Array.isArray(lowDays) ? lowDays : [];
  let streak = 0;
  for (let i = days.length - 1; i >= 0; i--) {
    if ((Number(days[i].rate) || 0) < p.thresholdRate) streak++;
    else break;
  }
  const active = streak >= p.thresholdDays;
  return {
    active,
    streak,
    reason: active ? `已触发：连续 ${streak} 天完成率低于 ${p.thresholdRate}%` : `未触发：连续低完成率 ${streak}/${p.thresholdDays} 天`,
  };
}

/* 代扣分：阿刺消耗能量替扛一次扣分/信誉损失（消耗 1 能量） */
function guardDeduct(aci) {
  const a = normalizeAci(aci);
  if (!a.privileges.deductGuard.enabled) return { ok: false, reason: '代扣分特权未开启', aci: a };
  if (a.energy < 1) return { ok: false, reason: '协作能量不足，无法代扣（先浇水）', aci: a };
  const next = { ...a, energy: a.energy - 1, privileges: { ...a.privileges, deductGuard: { ...a.privileges.deductGuard, charges: a.privileges.deductGuard.charges + 1 } } };
  return { ok: true, aci: next, message: '阿刺替你扛下了这次扣分（消耗 1 点协作能量）' };
}

/* 信用担保额度：按阿刺「自身情况」（等级 + 能量）决定，等级越高/能量越足，能担的越多。
 * 每 5 级 +1 次，每 2 点能量 +1 次，至少 1 次，最多随等级线性增长。 */
function guaranteeCapacity(aci) {
  const a = normalizeAci(aci);
  return 1 + Math.floor(a.level / RULES.GUARANTEE_LEVEL_CAP) + Math.floor(a.energy / RULES.GUARANTEE_ENERGY_PER);
}

/* 信用担保：阿刺按自身情况（等级+能量）决定能为你透支几次。 */
function toggleCreditGuarantee(aci, on) {
  const a = normalizeAci(aci);
  const g = a.privileges.creditGuarantee;
  if (on) {
    const cap = guaranteeCapacity(a);
    const next = {
      ...a,
      guaranteeLeft: cap,
      privileges: { ...a.privileges, creditGuarantee: { ...g, active: true, cap } },
    };
    return { ok: true, aci: next, effect: { cap }, message: `阿刺按自身情况（Lv.${a.level}、能量${a.energy}）为你担保，可透支 ${cap} 次` };
  }
  const next = { ...a, guaranteeLeft: 0, privileges: { ...a.privileges, creditGuarantee: { ...g, active: false } } };
  return { ok: true, aci: next, message: '已关闭信用担保' };
}
function breakGuarantee(aci) {
  const a = normalizeAci(aci);
  if (!a.privileges.creditGuarantee.active) return { ok: false, reason: '没有进行中的信用担保', aci: a };
  if (a.guaranteeLeft > 1) {
    /* 额度内：阿刺按自身情况扛下来，不降级，只消耗一次额度 */
    const next = { ...a, guaranteeLeft: a.guaranteeLeft - 1 };
    return { ok: true, aci: next, effect: { usedGuarantee: 1, downgraded: false }, message: `阿刺替你扛下了这次赖账（自身担保额度还剩 ${next.guaranteeLeft} 次）` };
  }
  /* 额度耗尽：阿刺扛不住了，降级并关闭担保 */
  const next = {
    ...a,
    guaranteeLeft: 0,
    level: Math.max(1, a.level - 1), exp: 0,
    privileges: { ...a.privileges, creditGuarantee: { ...a.privileges.creditGuarantee, active: false } },
  };
  return { ok: true, aci: next, effect: { usedGuarantee: 1, downgraded: true }, message: '阿刺的担保额度用尽，替你扛下了后果：等级 -1' };
}

/* 设置失望模式：由完成率连续低迷触发/解除。失望时 3D 造型变为蔫巴 + 不太接受互动。
 * on 时用 checkPrivilege 的结果，或由外部直接传入。 */
function setDisappointed(aci, on, reason) {
  const a = normalizeAci(aci);
  const next = {
    ...a,
    disappointed: !!on,
    mood: on ? 'disappointed' : (a.mood === 'disappointed' ? 'idle' : a.mood),
    privileges: {
      ...a.privileges,
      disappointment: { ...a.privileges.disappointment, active: !!on },
    },
  };
  return {
    ok: true, aci: next,
    message: on
      ? `阿刺进入失望模式：蔫了、话少、不太想搭理你（${reason || '完成率持续偏低'}）`
      : '阿刺缓过来了，恢复正常状态',
  };
}

/* 失望/静音时是否愿意互动：失望时大部分话不接，只回应"哄/道歉/醒醒"类唤醒词 */
function willingToInteract(aci, text) {
  const a = normalizeAci(aci);
  if (!a.disappointed) return { willing: true };
  const wake = /道歉|对不起|哄哄|别生气|醒醒|振作|我错了|补偿|加油|我会努力/.test(String(text || ''));
  return {
    willing: wake,
    reason: wake ? '' : '阿刺还在失望中，只想静静（说句道歉或哄哄它，它才搭理）',
  };
}

/* 抗命机制：不合理命令弹确认框劝阻（返回需确认，不直接执行） */
function defyCheck(aci, isUnreasonable) {
  const a = normalizeAci(aci);
  if (!a.privileges.defy.enabled || !isUnreasonable) return { needConfirm: false };
  return { needConfirm: true, reason: '这条命令不太合理，阿刺建议先确认：真的要这么做吗？' };
}

/* 主动禁言：情绪失控人身攻击时切断对话 30 分钟 */
function autoMute(aci, isAbusive, now) {
  const a = normalizeAci(aci);
  if (!a.privileges.autoMute.enabled || !isAbusive) return { muted: false, aci: a };
  const mins = a.privileges.autoMute.muteMinutes;
  return { muted: true, aci: a, until: (now || Date.now()) + mins * 60000, message: `检测到人身攻击，阿刺主动静音 ${mins} 分钟，冷静一下。` };
}

/* ============ 无障碍：基础态永远可用 ============ */
const CORE_FEATURES = ['查表', '毒舌', '排计划提议', '自习室陪聊'];
function isCoreFeature(feature) {
  return CORE_FEATURES.indexOf(feature) >= 0;
}

module.exports = {
  RULES, TIERS, SUPPLIES, PRIVILEGE_DEFAULTS, CORE_FEATURES,
  defaultAci, normalizeAci, water, useSupply, redeemSupplyWithPoints, expNeeded,
  weekKeyOf, refreshSupplyWeek, autoSupplyChance, shouldAutoSupply,
  ticketPrice, buyTicket, tierOf, levelCoef, powerOf,
  dayKeyOf, refreshDay, isCoolingDown, isHidden, canInitiate, canAccept, skipCooldown, setHidden,
  matchPreference, adjacentTiers, pickOpponent,
  createChallenge, acceptChallenge, acceptPkInvite, expireChallenge, settle, useLoseStreakProtect,
  checkPrivilege, guardDeduct, toggleCreditGuarantee, guaranteeCapacity, breakGuarantee,
  setDisappointed, willingToInteract, defyCheck, autoMute,
  skinOf, isIdentityLocked, chooseSkin, evaluateCompanionName, setCompanionName,
  requestCompanionSkinChange, resetCompanion, normalizeIdentity,
  isCoreFeature,
};
