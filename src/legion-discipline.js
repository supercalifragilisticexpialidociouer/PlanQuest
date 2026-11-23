/* PlanQuest · 军团纪律引擎
 *
 * 把「五类可以被系统约束的人」写成可判定的规则，而不是喊口号：
 *
 *   逃兵     专注期间切出去刷视频 → 失焦累计 + 进程守护命中 → 扣分累积
 *            欠分到 -10 → 冻结军团参与资格（打卡可提前解冻，不是永久拉黑）
 *   刷分狗   挂机刷时长 → 行为一致性检测（每 5 分钟桶里有没有输入）
 *            连续 3 个空桶判定「本次不计分」，累计 2 次开始扣信誉
 *   喷子     辱骂/引战 → 禁言（chat-mod）+ 举报扣分
 *            信誉 < 60 失去军团发言权，< 40 失去 PK 资格
 *   鸽子精   契约任务要有见证人 + 押金，违约没收押金并扣分
 *   外挂     数据异常（越界/时间跳变/模拟点击特征）→ 标记待人工审核
 *            坐实 → 信誉清零 + 永久封禁军团功能
 *
 * 这个模块只做「判定」，落库由调用方决定（主进程写 data.discipline，
 * 测试里写普通对象）。所有函数都不读全局状态，方便单测。
 */
'use strict';

const MIN = 60e3;
const DAY = 86400e3;

const LIMITS = {
  /* 逃兵 */
  awayWarnMs: 30e3,        // 单次离开超过 30 秒先提醒
  awayDesertMs: 90e3,      // 单次离开超过 90 秒算逃
  leavesDesert: 2,         // 或一节课里切出去 2 次
  desertPenalty: 3,        // 逃一次扣 3 分（受新手保护罩折算）
  desertFreezeAt: -10,     // 信誉分到 -10 → 冻结军团资格
  freezeHours: 48,         // 冻结默认 48 小时，期间打卡 3 天可提前解

  /* 刷分 */
  bucketMs: 5 * MIN,       // 按 5 分钟切桶统计输入
  bucketEmptyLimit: 3,     // 连续 3 个空桶（15 分钟零操作）判挂机
  farmerVoidPenalty: 0,    // 第一次不计分不扣分，只作废
  farmerStrikePenalty: 4,  // 第 2 次起每次扣 4 分

  /* 喷子 */
  speakFloor: 60,          // 低于 60 不能军团发言
  pkFloor: 40,             // 低于 40 不能参与 PK
  joinFloor: -10,          // 低于 -10 冻结军团资格（与 desertFreezeAt 同源）

  /* 鸽子精 */
  depositMin: 10,          // 契约押金下限
  depositMax: 100,         // 上限（防止一把梭）
  contractGraceH: 12,      // 到期后给 12 小时宽限
  dovePenalty: 6,          // 违约扣 6 分

  /* 外挂 */
  cheatBan: true,          // 坐实即永久封禁军团功能
};

/* ---------------- 逃兵 ---------------- */

/**
 * 一段专注结束时调用。
 * @param {{minutes:number, awayMs:number, leaves:number, guardHits:number}} s
 *   awayMs   累计失焦时长（毫秒）
 *   leaves   切出去次数
 *   guardHits 进程守护命中的干扰进程次数（抖音/游戏等）
 */
function desertVerdict(s) {
  const away = Math.max(0, Number(s && s.awayMs) || 0);
  const leaves = Math.max(0, Number(s && s.leaves) || 0);
  const hits = Math.max(0, Number(s && s.guardHits) || 0);
  const minutes = Math.max(0, Number(s && s.minutes) || 0);

  /* 刚开 1 分钟就切走，不按逃兵算 —— 那是误触，不是逃 */
  if (minutes < 5) {
    return { level: 'ok', penalty: 0, note: '', awayMs: away, leaves, guardHits: hits };
  }
  const hard = away >= LIMITS.awayDesertMs || leaves >= LIMITS.leavesDesert || hits >= 2;
  const soft = !hard && (away >= LIMITS.awayWarnMs || leaves >= 1 || hits >= 1);

  if (hard) {
    /* 逃得越久扣得越多，但单次封顶 3 倍，避免一次误判把人打死 */
    const factor = Math.min(3, 1 + Math.floor(away / (5 * MIN)) + Math.max(0, hits - 1));
    return {
      level: 'desert',
      penalty: LIMITS.desertPenalty * factor,
      note: `专注期间离开 ${Math.round(away / 1000)} 秒、切出 ${leaves} 次${
        hits ? `、检测到 ${hits} 次干扰进程` : ''
      }。这一节算逃兵，扣 ${LIMITS.desertPenalty * factor} 分。`,
      awayMs: away,
      leaves,
      guardHits: hits,
    };
  }
  if (soft) {
    return {
      level: 'warn',
      penalty: 0,
      note: `刚才切出去了 ${Math.round(away / 1000)} 秒。专注模式是为了保护你自己，下次别切了。`,
      awayMs: away,
      leaves,
      guardHits: hits,
    };
  }
  return { level: 'ok', penalty: 0, note: '', awayMs: away, leaves, guardHits: hits };
}

/* ---------------- 刷分狗（行为一致性） ---------------- */

/**
 * @param {{minutes:number, focusMs:number, buckets:number[], mouseMoves:number,
 *          keyPresses:number, windowSwitches:number}} s
 *   buckets  每个 5 分钟桶内的输入事件数（长度不必匹配，短的按 0 补）
 *   focusMs  窗口处于前台的累计时长
 */
function focusAudit(s) {
  const minutes = Math.max(0, Number(s && s.minutes) || 0);
  const focusMs = Math.max(0, Number(s && s.focusMs) || 0);
  const mouse = Math.max(0, Number(s && s.mouseMoves) || 0);
  const keys = Math.max(0, Number(s && s.keyPresses) || 0);
  const swaps = Math.max(0, Number(s && s.windowSwitches) || 0);
  const buckets = Array.isArray(s && s.buckets) ? s.buckets.map((n) => Math.max(0, Number(n) || 0)) : [];

  /* 少于 15 分钟的短专注不做判定：样本太少，误伤成本高于作弊成本 */
  if (minutes < 15) return { level: 'ok', reason: '', detail: '', strikes: 0 };

  const need = Math.ceil((minutes * MIN) / LIMITS.bucketMs);
  const arr = buckets.slice(0, need);
  while (arr.length < need) arr.push(0);

  /* 最长连续空桶 */
  let run = 0;
  let worst = 0;
  for (const n of arr) {
    if (n === 0) {
      run += 1;
      if (run > worst) worst = run;
    } else {
      run = 0;
    }
  }

  const ratio = minutes ? focusMs / (minutes * MIN) : 1;
  const totalInput = mouse + keys;

  /* 判定顺序：先看最硬的证据，再看软指标 */
  if (worst >= LIMITS.bucketEmptyLimit && totalInput <= 1) {
    return {
      level: 'void',
      reason: 'idle',
      detail: `连续 ${worst * 5} 分钟没有任何鼠标/键盘操作，这一节不计分。`,
      strikes: 1,
      worst,
      ratio,
    };
  }
  if (ratio < 0.5) {
    return {
      level: 'void',
      reason: 'background',
      detail: `这一节有 ${Math.round((1 - ratio) * 100)}% 的时间窗口不在前台，不计分。`,
      strikes: 1,
      worst,
      ratio,
    };
  }
  if (worst >= 2 || ratio < 0.75 || swaps > Math.max(3, minutes / 10)) {
    return {
      level: 'suspect',
      reason: 'weak',
      detail: '这一节的活跃度偏低，先记一次提醒；正常使用（翻页、敲键盘）不会触发。',
      strikes: 0,
      worst,
      ratio,
    };
  }
  return { level: 'ok', reason: '', detail: '', strikes: 0, worst, ratio };
}

/* ---------------- 喷子 / 杠精 ---------------- */

function speakVerdict({ credit, banned, newbieDay1 } = {}) {
  const c = Number(credit) || 0;
  if (banned) {
    return { canSpeak: false, canPk: false, reason: '账号已被封禁军团功能' };
  }
  if (newbieDay1) {
    /* 第 1 天只保护不惩罚：允许说话，但 scout 会在 UI 上提示 */
    return { canSpeak: true, canPk: false, reason: '' };
  }
  if (c < LIMITS.pkFloor) {
    return {
      canSpeak: false,
      canPk: false,
      reason: `信誉分 ${c}，低于 ${LIMITS.pkFloor}：先打卡把分挣回来，发言和 PK 都会恢复。`,
    };
  }
  if (c < LIMITS.speakFloor) {
    return {
      canSpeak: false,
      canPk: true,
      reason: `信誉分 ${c}，低于 ${LIMITS.speakFloor}：暂时不能在军团频道发言（PK 仍可参加）。`,
    };
  }
  return { canSpeak: true, canPk: true, reason: '' };
}

/* ---------------- 鸽子精（契约任务） ---------------- */

/**
 * 新建契约：押金从积分里托管，见证人必须存在（自己不能见证自己）。
 */
function contractNew({ title, deposit, witness, dueAt, points } = {}) {
  const d = Math.round(Number(deposit) || 0);
  const t = String(title || '').trim().slice(0, 40);
  if (!t) return { ok: false, message: '契约得写清楚做什么' };
  if (!witness) return { ok: false, message: '契约需要一位见证人，否则违约没人作证' };
  if (d < LIMITS.depositMin) return { ok: false, message: `押金至少 ${LIMITS.depositMin} 积分` };
  if (d > LIMITS.depositMax) return { ok: false, message: `押金最多 ${LIMITS.depositMax} 积分` };
  if (Number(points) < d) return { ok: false, message: `积分不够，当前 ${Number(points) || 0}` };
  const due = Number(dueAt);
  if (!Number.isFinite(due) || due <= Date.now()) return { ok: false, message: '截止时间要晚于现在' };
  return {
    ok: true,
    contract: {
      id: `c${Date.now().toString(36)}`,
      title: t,
      deposit: d,
      witness: String(witness).slice(0, 24),
      dueAt: due,
      createdAt: Date.now(),
      status: 'open',
    },
  };
}

/**
 * 结算契约。self 违约 → 押金没收（不进自己口袋）+ 扣分；完成 → 押金退还。
 */
function contractSettle(c, { done, now } = {}) {
  const t = Number(now) || Date.now();
  if (!c || c.status !== 'open') return { ok: false, message: '契约已经结算过了' };
  if (done) {
    return {
      ok: true,
      status: 'done',
      refund: Number(c.deposit) || 0,
      penalty: 0,
      message: `契约完成，押金 ${Number(c.deposit) || 0} 分退回。见证人 ${c.witness} 已记录。`,
    };
  }
  const late = t > Number(c.dueAt) + LIMITS.contractGraceH * 3600e3;
  if (!late) {
    return { ok: false, message: `还在宽限期内（到期后 ${LIMITS.contractGraceH} 小时），再坚持一下。` };
  }
  return {
    ok: true,
    status: 'failed',
    refund: 0,
    penalty: LIMITS.dovePenalty,
    message: `契约违约：押金 ${Number(c.deposit) || 0} 分没收，信誉分 -${LIMITS.dovePenalty}。`,
  };
}

/* ---------------- 外挂 ---------------- */

const CHEAT_RULES = [
  {
    id: 'focus_over_day',
    test: (d) => Number(d.focusMinutes) > 1440,
    detail: '单日专注超过 1440 分钟',
    severity: 'high',
  },
  {
    id: 'points_jump',
    test: (d) => Number(d.pointsJump) > 5000,
    detail: '积分单次跳变超过 5000',
    severity: 'high',
  },
  {
    id: 'clock_back',
    test: (d) => Number(d.clockBackMs) > 10 * MIN,
    detail: '系统时间被回拨',
    severity: 'mid',
  },
  {
    id: 'click_robot',
    test: (d) => Number(d.clickIntervalMs) > 0 && Number(d.clickIntervalMs) < 8 && Number(d.clickCount) > 200,
    detail: '点击间隔恒定小于 8ms，疑似模拟点击',
    severity: 'high',
  },
  {
    id: 'credit_over',
    test: (d) => Number(d.credit) > 160,
    detail: '信誉分超过上限 160',
    severity: 'mid',
  },
];

/** 扫描一次运行数据，返回需要人工审核的异常项 */
function scanCheat(d) {
  const hits = [];
  for (const r of CHEAT_RULES) {
    let bad = false;
    try {
      bad = !!r.test(d || {});
    } catch (_) {
      bad = false;
    }
    if (bad) hits.push({ kind: r.id, detail: r.detail, severity: r.severity });
  }
  return { ok: hits.length === 0, hits };
}

/**
 * 人工审核结论。坐实 → 信誉清零 + 永久封禁军团功能；
 * 误判 → 只清标记，不动分（不能因为一次误报就扣人）。
 */
function reviewCheat(flag, { uphold, now } = {}) {
  const t = Number(now) || Date.now();
  if (!flag) return { ok: false, message: '没有这条记录' };
  if (!uphold) return { ok: true, status: 'dismissed', wipe: false, ban: false, at: t };
  return {
    ok: true,
    status: 'upheld',
    wipe: true,
    ban: true,
    at: t,
    message: '已坐实：信誉分清零，军团功能永久封禁（打卡、个人计划不受影响）。',
  };
}

/* ---------------- 综合状态 ---------------- */

/**
 * 汇总一个人此刻在军团里能做什么。
 * @param {{credit:number, discipline:object, now:number}} ctx
 */
function stateOf({ credit, discipline, now } = {}) {
  const d = discipline || {};
  const t = Number(now) || Date.now();
  const c = Number(credit) || 0;
  const ban = d.ban && d.ban.permanent ? d.ban : null;
  const frozenUntil = Number(d.frozenUntil) || 0;
  const frozen = !ban && frozenUntil > t;

  const speak = speakVerdict({ credit: c, banned: !!ban });
  const reasons = [];
  if (ban) reasons.push('外挂坐实：军团功能永久封禁');
  if (frozen) {
    const h = Math.max(1, Math.ceil((frozenUntil - t) / 3600e3));
    reasons.push(`逃兵冻结中，还剩 ${h} 小时（连续打卡 3 天可提前解冻）`);
  }
  if (!speak.canSpeak && !frozen && !ban) reasons.push(speak.reason);

  return {
    credit: c,
    banned: !!ban,
    frozen,
    frozenUntil: frozen ? frozenUntil : 0,
    canJoinLegion: !ban && !frozen && c >= LIMITS.joinFloor,
    canSpeak: !ban && !frozen && speak.canSpeak,
    canPk: !ban && !frozen && speak.canPk,
    desertCount: Number(d.desert && d.desert.count) || 0,
    voidCount: Number(d.audits && d.audits.voidCount) || 0,
    openContracts: Object.values(d.contracts || {}).filter((x) => x && x.status === 'open').length,
    pendingFlags: (d.flags || []).filter((x) => x && x.status === 'pending').length,
    reasons,
    limits: LIMITS,
  };
}

/** 把逃兵结果落到状态上：扣分、计数、必要时冻结 */
function applyDesert(discipline, verdict, { creditAfter, now } = {}) {
  const d = discipline || {};
  const v = verdict || { level: 'ok', penalty: 0 };
  if (v.level !== 'desert') {
    return { discipline: d, penalty: 0, frozenUntil: Number(d.frozenUntil) || 0 };
  }
  const t = Number(now) || Date.now();
  const prev = d.desert || { count: 0, lastAt: 0 };
  d.desert = { count: (Number(prev.count) || 0) + 1, lastAt: t };
  const c = Number(creditAfter);
  let frozenUntil = Number(d.frozenUntil) || 0;
  if (Number.isFinite(c) && c <= LIMITS.desertFreezeAt) {
    frozenUntil = Math.max(frozenUntil, t + LIMITS.freezeHours * 3600e3);
    d.frozenUntil = frozenUntil;
  }
  return { discipline: d, penalty: v.penalty, frozenUntil };
}

/** 把刷分结果落到状态上：第 1 次只作废，第 2 次起扣分 */
function applyAudit(discipline, audit, { now } = {}) {
  const d = discipline || {};
  const a = audit || { level: 'ok' };
  if (a.level !== 'void') return { discipline: d, voided: false, penalty: 0 };
  const t = Number(now) || Date.now();
  const prev = d.audits || { voidCount: 0, lastAt: 0 };
  const n = (Number(prev.voidCount) || 0) + 1;
  d.audits = { voidCount: n, lastAt: t, lastReason: a.reason || '' };
  const penalty = n >= 2 ? LIMITS.farmerStrikePenalty : LIMITS.farmerVoidPenalty;
  return { discipline: d, voided: true, penalty, strikes: n };
}

const API = {
  LIMITS,
  CHEAT_RULES,
  desertVerdict,
  focusAudit,
  speakVerdict,
  contractNew,
  contractSettle,
  scanCheat,
  reviewCheat,
  stateOf,
  applyDesert,
  applyAudit,
};

/* 桌面（require）与网页/安卓（window）共用同一份规则，避免两套阈值各说各话 */
if (typeof module !== 'undefined' && module.exports) module.exports = API;
if (typeof window !== 'undefined') window.PQLegionDiscipline = API;
