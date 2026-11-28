/* aci-perk.js —— 阿刺「皮肤利弊」+ 数值心情 + 「顶罪」核心（双端 UMD 同源，无 DOM）
 *
 * 设计硬约束（产品口径）：
 *  1. 顶罪是阿刺自作主张。这里故意不导出任何 requestCover / forceCover /
 *     setCoverEnabled / setProbability 之类的入口，decideCover 只由「系统即将
 *     扣分」的内部路径调用，ctx 里即使塞 force/cover/request 也一律忽略。
 *     用户不能在设置里开关、不能在聊天里点名、界面上也不摆概率数字当承诺。
 *  2. 心情是数值（默认 3，范围 −10~+10），有明确的升降/恢复事件表；
 *     顶罪概率 = 基础 25% + 心情 × 5%，钳在 10%~70%。
 *     换算下来：心情 9 → 70%（好）、3 → 40%（一般）、−3 → 10%（差）。
 *  3. 每次扣分事件：全局冷却 → 每日上限 → 周 3 / 月 10 → 能量 → R(0~100)。
 *     命中后扣能量 50、好感略降、重置冷却；无论顶不顶，台词随心情变。
 *  4. 皮肤 id 与 aci-skin.js / buddy3d.js 完全一致（改别名不改建模）：
 *     cactus 青刺 / hedgehog 萌球 / rose 怒刺红 / chestnut 枯木 / porcupine 幻影蓝
 */
(function (root, factory) {
  var mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  if (root) root.PQPerk = mod;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  function num(v, d) { var n = Number(v); return isFinite(n) ? n : (d || 0); }
  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
  function pick(a, rng) {
    if (!Array.isArray(a) || !a.length) return '';
    var r = typeof rng === 'function' ? rng() : Math.random();
    return a[clamp(Math.floor(r * a.length), 0, a.length - 1)];
  }
  function fill(s, vars) {
    return String(s == null ? '' : s).replace(/\{(\w+)\}/g, function (_, k) {
      return Object.prototype.hasOwnProperty.call(vars || {}, k) ? String(vars[k]) : '{' + k + '}';
    });
  }
  function dayKeyOf(at) {
    var d = new Date(num(at, Date.now()));
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  /* ============ 规则常量 ============ */
  var RULES = {
    PROB: { good: 0.70, normal: 0.40, bad: 0.10 }, // 三档参考值（数值心情换算后正好落在这）
    WEEK_LIMIT: 3,
    MONTH_LIMIT: 10,
    ENERGY_PER_SIN: 50,   // 顶一次扣阿刺 50 点协作能量
    FAVOR_DROP: 3,        // 好感略降
    WEEK_MS: 7 * 86400000,
    MONTH_MS: 30 * 86400000,
    SLUMP_DAYS: 3,        // 怒刺红：连续三天不打卡锁功能
    SLUMP_LOCK_MS: 86400000,
    DEMOTE_STEP: 1,       // 枯木：覆盖文件直接降 1 级
  };

  /* 数值心情：默认 3（= 概率 40% 的「一般」），范围 −10 ~ +10 */
  var MOOD = {
    DEFAULT: 3, MIN: -10, MAX: 10,
    BASE_PROB: 0.25, PER_POINT: 0.05, PROB_MIN: 0.10, PROB_MAX: 0.70,
    COOLDOWN_MS: 30 * 60 * 1000,  // 全局冷却：两次顶罪之间至少 30 分钟
    DAY_LIMIT: 1,                 // 每日上限：一天最多替你扛 1 次
    INTERACT_THROTTLE_MS: 10 * 60 * 1000, // 互动微量提升的最小间隔
    REMIND_THROTTLE_MS: 60 * 60 * 1000,   // 忽略提醒扣分的最小间隔
    DELTA: {
      checkin: 1,            // 按时完成每日计划 +1
      interact: 0.2,         // 聊天 / 投喂协作能量：微量
      challenge: 3,          // 完成阿刺提出的挑战：较大提升
      noLogin2Days: -1,      // 连续两天未登录
      overwrite: -2,         // 删除 / 覆盖 .pqplan（严重违规）
      idle48h: -0.5,         // 超过 48 小时不互动：每 24h 缓慢衰减
      ignoreReminder: -1,    // 无视阿刺的提醒
      dailyRecover: 1,       // 每天凌晨自动恢复（仅当前为负）
      apology: 2,            // 真诚道歉：一次性恢复（仅当前为负，补到 0 封顶）
    },
    STREAK_BONUS: { 3: 2, 7: 3, 14: 5, 30: 8 }, // 连续打卡额外加成（每档只给一次）
  };

  /* ============ 五套皮肤利弊 ============ */
  var SKILLS = {
    cactus: {
      id: 'cactus', alias: '青刺 / 灰刺', role: '极速 · 带路型', emoji: '🌵',
      pros: ['经验获取 +10%', '带路导航最快', '日常打卡响应极速'],
      cons: ['耗水翻倍（浇水次数需求大）', '协作能量容易清零', '一言不合就「拔刺」', '覆盖文件时扣积分翻倍'],
      taunt: '选我？你那点毅力够我扎几次的？极速带路，你拖后腿我可真动手。',
      style: 'speed',
      mods: {
        expMul: 1.10, waterCostMul: 2, energyDrainMul: 2,
        navSpeed: 1.35, checkinResponse: 0.6, prickChance: 0.35,
        overwritePointsMul: 2, delayShield: 0, arenaMul: 1,
        initialFavor: 0, shareMul: 1, energyCapMul: 1, capAtLevel: 0,
        doubleExpChance: 0, skinUpkeep: 0, nagForce: 0,
        slumpLockDays: 0, overwriteDemote: false, favorSwing: 1,
        jumpFx: false, showBonus: 1, navBias: 0, rareExpressions: false,
      },
    },
    hedgehog: {
      id: 'hedgehog', alias: '膨化萌球', role: '话少 · 直硬', emoji: '🦔',
      pros: ['初始好感高', '生气 / 撒娇表情包收藏率极高（社交分享 +）', '受击（拖延）减免 20%'],
      cons: ['移动 / 带路慢', '经验值 −15%', '不能真「动手」（竞技场胜率低）'],
      taunt: '就爱我这圆脸？行，看着萌，扎你的时候可别哭。反正我跑得慢，你拖吧，我慢慢扎。',
      style: 'blunt',
      mods: {
        expMul: 0.85, waterCostMul: 1, energyDrainMul: 1,
        navSpeed: 0.6, checkinResponse: 1.5, prickChance: 0.1,
        overwritePointsMul: 1, delayShield: 0.20, arenaMul: 0.8,
        initialFavor: 12, shareMul: 1.25, energyCapMul: 1, capAtLevel: 0,
        doubleExpChance: 0, skinUpkeep: 0, nagForce: 0,
        slumpLockDays: 0, overwriteDemote: false, favorSwing: 1,
        jumpFx: false, showBonus: 1, navBias: 0, rareExpressions: false,
      },
    },
    rose: {
      id: 'rose', alias: '怒刺红', role: '竞技场 · 会动手', emoji: '🌹',
      pros: ['竞技场伤害 / 胜率 +20%', '拖延提醒最狠（强制弹窗）', '覆盖文件扣积分 +50%（护主狂魔）'],
      cons: ['日常聊天毒舌过度，容易「劝退」', '连续三天不打卡就锁死功能', '耗能量极大'],
      taunt: '选我？你最好别摆烂，我动手可不轻。你删档一次，我记你一辈子，积分扣到负。',
      style: 'fierce',
      mods: {
        expMul: 1, waterCostMul: 1, energyDrainMul: 2,
        navSpeed: 1, checkinResponse: 1, prickChance: 0.5,
        overwritePointsMul: 1.50, delayShield: 0, arenaMul: 1.20,
        initialFavor: 0, shareMul: 1, energyCapMul: 1, capAtLevel: 0,
        doubleExpChance: 0, skinUpkeep: 0, nagForce: 1,
        slumpLockDays: 3, overwriteDemote: false, favorSwing: 1.5,
        jumpFx: false, showBonus: 1, navBias: 0, rareExpressions: false,
      },
    },
    chestnut: {
      id: 'chestnut', alias: '枯木 / 金贵', role: '生个气 · 傲娇', emoji: '🌰',
      pros: ['被动「金贵」：精心养护，一旦满级协作能量上限 +30%', '表情「不外传」稀有度拉满'],
      cons: ['生长极慢（经验 −30%）', '极易「生气」（好感波动大）', '覆盖文件直接降级'],
      taunt: '气给你看了，收藏好。想养我？你那点耐心够吗？删我计划？我直接枯给你看。',
      style: 'proud',
      mods: {
        expMul: 0.70, waterCostMul: 1, energyDrainMul: 1,
        navSpeed: 0.85, checkinResponse: 1, prickChance: 0.2,
        overwritePointsMul: 1, delayShield: 0, arenaMul: 0.95,
        initialFavor: 0, shareMul: 1, energyCapMul: 1.30, capAtLevel: 100,
        doubleExpChance: 0, skinUpkeep: 0, nagForce: 0,
        slumpLockDays: 0, overwriteDemote: true, favorSwing: 2,
        jumpFx: false, showBonus: 1, navBias: 0, rareExpressions: true,
      },
    },
    porcupine: {
      id: 'porcupine', alias: '幻影蓝', role: '跳一跳 · 自命不凡', emoji: '🐗',
      pros: ['跳跃 / 动画特效华丽', '社交展示（新芽段 / 段位）加分', '偶尔「恩赐」双倍经验'],
      cons: ['极度自恋，日常提醒「本刺肯为你离地」', '实际带路偏差大', '耗积分维持皮肤特效'],
      taunt: '本刺肯为你离地，你这辈子受过这恩赐吗？特效费积分，你穷的话趁早换皮。',
      style: 'lofty',
      mods: {
        expMul: 1, waterCostMul: 1, energyDrainMul: 1,
        navSpeed: 0.9, checkinResponse: 1, prickChance: 0.15,
        overwritePointsMul: 1, delayShield: 0, arenaMul: 1,
        initialFavor: 0, shareMul: 1.2, energyCapMul: 1, capAtLevel: 0,
        doubleExpChance: 0.12, skinUpkeep: 5, nagForce: 0,
        slumpLockDays: 0, overwriteDemote: false, favorSwing: 1,
        jumpFx: true, showBonus: 1.2, navBias: 0.35, rareExpressions: false,
      },
    },
  };

  /* ============ 第二版：分皮肤个性化心情系统 ============
   * 用户「换成这个模式」规格：每套皮肤独立的心境初值 / 升降事件 / 凌晨恢复 / 等级命名 /
   * 顶罪冷却 / 日限 / 基础概率 / 心情修正表 / 特殊机制 / 顶罪后台词。皮肤 id 与建模一致。
   * 只描述"数值与规则"，情绪外壳由 styleLine 负责；顶罪硬约束（用户不可规定）保持不变。 */
  var SKIN_MOOD = {
    cactus: {
      id: 'cactus', name: '仙人掌（经典款）', tag: '毒舌有分寸、认死理、嘴硬心软',
      init: 55, min: 0, max: 100,
      up: { completedAll: 4, streak7: 6, acceptedCriticism: 3 },
      down: { missedCore: 5, overwrote: 12, arguedBack: 4 },
      recover: { below: 55, delta: 3 },
      levels: [[80, '高效'], [40, '平稳'], [0, '低效']],
      cover: {
        cooldownH: 7, dayLimit: 2, base: 0.22,
        mod: [[85, 0.08], [60, 0.03], [35, 0], [15, -0.05], [0, -0.10]],
        lines: ['哼，顺手而已。别指望我下次还帮你。'], after: '沉默扛下，然后继续毒舌',
      },
    },
    rose: {
      id: 'rose', name: '玫瑰（带刺的花）', tag: '优雅地刻薄、花式阴阳、记仇也记好',
      init: 45, min: 0, max: 100,
      up: { completedAll: 3, praised: 6, consistentWeek: 8 },
      down: { missedPlan: 2, overwrote: 20, criticized: 12 },
      recover: { below: 45, delta: 2 },
      levels: [[70, '舒坦'], [30, '一般'], [0, '扎手']],
      cover: {
        cooldownH: 8, dayLimit: 1, base: 0.18, floor: 0.01, cap: 0.40,
        mod: [[90, 0.15], [70, 0.05], [40, -0.02], [20, -0.10], [0, -0.18]],
        memoryWeight: 0.003,
        lines: ['哎呀，这积分扣得真难看，本玫瑰帮你挡了一下。记得你欠我一次哦~'],
        after: '阴阳怪气地邀功',
      },
    },
    hedgehog: {
      id: 'hedgehog', name: '刺猬（熟了才黏）', tag: '先说狠话、再偷偷心软、熟了很黏',
      init: 40, min: 0, max: 100, familiarityInit: 0,
      up: { completedAll: 2, interactedFam: 3, fam50Mood: 1, streak14Fam: 10 },
      down: { missedPlan: 4, overwrote: 15, ignored3Fam: 8, fam20Mood: 3 },
      recover: { below: 40, delta: 2 },
      levels: [[75, '黏人'], [40, '别扭'], [0, '炸毛']],
      cover: {
        cooldownH: 6, dayLimit: 2, baseByFam: [[70, 0.32], [40, 0.20]], baseFallback: 0.10,
        mod: [[80, 0.10], [50, 0.03], [25, -0.05], [0, -0.12]],
        linesEarly: ['哼，自己犯的错自己受。'], linesLate: ['今天要不要我帮你挡雷？……当我没说！'],
        after: '嘴上不承认，但偷偷做了',
      },
    },
    chestnut: {
      id: 'chestnut', name: '板栗（外壳坚硬，实在）', tag: '不绕弯、爱算账、说到做到',
      init: 50, min: 0, max: 100, debtInit: 0,
      up: { completedAll: 3, repaidDebt: 10, honest: 5 },
      down: { missedPlan: 3, overwrote: 10, defaultedDebt: 20 },
      recover: { below: 50, delta: 2 },
      levels: [[75, '硬气'], [35, '稳妥'], [0, '毛躁']],
      cover: {
        cooldownH: 5, dayLimit: 2, base: 0.28,
        mod: [[80, 0.07], [50, 0.02], [25, -0.05], [0, -0.10]],
        debtDays: 3,
        lines: ['帮你扛了。记账：未来3天必须打卡，少一天我扎你。'],
        after: '明码标价，说到做到',
      },
    },
    porcupine: {
      id: 'porcupine', name: '豪猪（生人勿近）', tag: '不哄、不惯、不服就干',
      init: 35, min: 0, max: 100,
      up: { provedWorth: 8, respected: 5, longStreak21: 10 },
      down: { missedAny: 6, overwrote: 25, coddled: 10, inactive1: 8 },
      recover: { below: 35, delta: 1 },
      levels: [[70, '勉强'], [35, '冷淡'], [0, '炸刺']],
      cover: {
        cooldownH: 10, dayLimit: 1, weeklyLimit: 2, base: 0.12,
        mod: [[85, 0.10], [60, 0.03], [35, -0.05], [15, -0.12], [0, -0.10]],
        lines: ['……啧，麻烦。'], after: '极其不屑，懒得解释', silent: true,
      },
    },
  };

  function skinProfile(skin) { return SKIN_MOOD[String(skin || '')] || null; }
  function skinIds() { return Object.keys(SKIN_MOOD); }
  function skinMoodInit(skin) { var p = skinProfile(skin); return p ? p.init : MOOD.DEFAULT; }
  function clampTo(v, lo, hi) { return clamp(num(v, lo), lo, hi); }
  function normalizeSkinMoodMap(raw) {
    var o = {};
    if (raw && typeof raw === 'object') {
      for (var k in raw) if (Object.prototype.hasOwnProperty.call(raw, k)) o[k] = clampTo(raw[k], 0, 100);
    }
    skinIds().forEach(function (id) { if (o[id] == null) o[id] = skinMoodInit(id); });
    return o;
  }
  function skinMoodOf(sin, skin) {
    var map = normalizeSkinMoodMap(normalizeSin(sin).skinMood);
    return map[skin] == null ? skinMoodInit(skin) : map[skin];
  }
  function skinMoodLevel(skin, mood) {
    var p = skinProfile(skin);
    if (!p) { var b = moodBandOf(mood); return b === 'good' ? '不错' : b === 'bad' ? '很差' : '一般'; }
    var m = num(mood, p.init);
    for (var i = 0; i < p.levels.length; i++) if (m >= p.levels[i][0]) return p.levels[i][1];
    return p.levels[p.levels.length - 1][1];
  }
  function skinModOf(cfg, mood) {
    var mod = 0;
    for (var i = 0; i < cfg.mod.length; i++) if (mood >= cfg.mod[i][0]) { mod = cfg.mod[i][1]; break; }
    return mod;
  }
  function skinBaseProb(cfg, sin) {
    if (cfg.baseByFam) {
      var fam = clampTo(normalizeSin(sin).familiarity, 0, 100);
      for (var i = 0; i < cfg.baseByFam.length; i++) if (fam >= cfg.baseByFam[i][0]) return cfg.baseByFam[i][1];
      return cfg.baseFallback || 0.10;
    }
    return cfg.base || 0.20;
  }
  /* AI 人设提示词段落：只说「外形 + 性情 + 当前心境」，不泄露任何数值/概率/机制 */
  function personaText(skin, level) {
    var p = skinProfile(skin);
    if (!p) return '';
    var lv = level || skinMoodLevel(skin, skinMoodInit(skin));
    var hint = { '高效': '效率正高，语气可以松半分，但骨子里还是毒舌。', '平稳': '按你现在的性子说话。',
      '低效': '有点不爽，话可以更冲一点，但别过火。', '舒坦': '心情不错，阴阳怪气的功夫正好。',
      '扎手': '记着仇呢，说话带刺也正常。', '黏人': '跟人熟了，嘴上嫌弃其实黏得很。',
      '别扭': '半熟不熟，先嘴硬再说。', '炸毛': '生人勿近，别指望好脸色。',
      '硬气': '说到做到，账算得清。', '稳妥': '不绕弯，按规矩来。', '毛躁': '脾气上来了，别惹。',
      '勉强': '勉强给点好脸，别得寸进尺。', '冷淡': '懒得哄人，也不惯着。', '炸刺': '浑身是刺，谁碰扎谁。' };
    return '【当前外形与性情】你现在是「' + p.name + '」，' + p.tag + '。'
      + '说话的方式、脾气都要随这副外形变，别用别的性子回话。'
      + (hint[lv] ? '此刻心境：' + lv + '——' + hint[lv] : '');
  }

  var DEFAULT_MODS = {
    expMul: 1, waterCostMul: 1, energyDrainMul: 1, navSpeed: 1, checkinResponse: 1,
    prickChance: 0, overwritePointsMul: 1, delayShield: 0, arenaMul: 1,
    initialFavor: 0, shareMul: 1, energyCapMul: 1, capAtLevel: 0,
    doubleExpChance: 0, skinUpkeep: 0, nagForce: 0, slumpLockDays: 0,
    overwriteDemote: false, favorSwing: 1, jumpFx: false, showBonus: 1,
    navBias: 0, rareExpressions: false,
  };

  function getSkill(id) { return SKILLS[String(id || '')] || null; }

  /* 倍率总出口：满级才给「金贵」能量上限 */
  function modsFor(skin, ctx) {
    var s = getSkill(skin), c = ctx || {};
    var m = Object.assign({}, DEFAULT_MODS, s ? s.mods : {});
    m.skin = s ? s.id : '';
    m.alias = s ? s.alias : '';
    m.style = s ? s.style : 'speed';
    if (m.capAtLevel && num(c.aciLevel, 1) < m.capAtLevel) m.energyCapMul = 1;
    m.energyCap = Math.round(100 * m.energyCapMul);
    return m;
  }

  function prosCons(skin) {
    var s = getSkill(skin);
    return s ? { alias: s.alias, role: s.role, emoji: s.emoji, pros: s.pros.slice(), cons: s.cons.slice(), taunt: s.taunt }
      : { alias: '', role: '', emoji: '🌵', pros: [], cons: [], taunt: '' };
  }

  /* 覆盖惩罚按皮肤塑形：扣积分倍率 / 拖延减免 / 直接降级 / 三天摆烂锁 */
  function shapePlan(plan, skin, ctx) {
    var m = modsFor(skin, ctx), p = Object.assign({}, plan || {}), c = ctx || {};
    var raw = num(p.pointsCut, 0);
    p.pointsCut = Math.max(0, Math.round(raw * m.overwritePointsMul * (1 - m.delayShield)));
    p.pointsCutRaw = raw;
    if (m.overwriteDemote) {
      p.demote = true;
      p.demoteTarget = Math.max(1, num(c.aciLevel, 1) - RULES.DEMOTE_STEP);
    }
    p.energyCut = Math.max(0, Math.round(num(p.energyCut, 0) * m.energyDrainMul));
    p.expCut = Math.max(0, Math.round(num(p.expCut, 0) * (m.expMul < 1 ? 1.15 : 1)));
    p.slumpLockDays = m.slumpLockDays;
    return { plan: p, mods: m, scaled: p.pointsCut !== raw };
  }

  /* ============ 台词 ============ */
  var LINES = {
    cover: [
      '等等，这{cut}分我替他出了。就当……今天心情好。',
      '（抬手挡在前面）这{cut}分别记他头上了，记我账上。本刺今天高兴，别问为什么。',
      '（笑眯眯）扣他？先问过我没有。这{cut}分我出了，就当赏你今天还没彻底摆烂。',
    ],
    coverBadTail: '下不为例，再有下次你自己扛。',
    quota: [
      '兄弟，我真扛不动了，你自己惹的事自己擦屁股。',
      '你以为我是你爹啊？自己拉的屎自己擦。',
    ],
    noEnergy: '（摊手）本刺今日能量见底，想扛也扛不动。自己惹的，自己擦。',
    cooldown: '（慢悠悠）刚替你扛过，本刺还没缓过来。这回自己擦。',
    daily: '今天已经替你出过一次头了，剩下的自己扛。',
    /* 聊天里求他顶罪：不承诺、不接单、不给开关 */
    plea: [
      '求我？（斜眼笑）本刺扛不扛，自己说了算，你跪着喊也没用。',
      '想让我替你擦？行啊——等我心情好。什么时候好？不告诉你。',
      '这事儿不用你操心。该我出手时我自己会动，轮不到你点名。',
    ],
    systemNotice: '检测到违规操作，扣除 {cut} 积分。',
    coverToast: '扣分 0 · 阿刺自己跳出来扛了',
    moodUp: {
      streak: '连着 {n} 天没掉链子？行，本刺心情 +{bonus}，赏你的。',
      challenge: '（挑眉）我出的挑战你居然真赢了，心情 +3，勉强记你一功。',
      recover: '（打了个哈欠）睡一觉，本刺心情自己回一点，别得意。',
    },
    moodDown: {
      noLogin: '两天不见人影？本刺心情 −1，别指望我替你说话。',
      overwrite: '又删档？逃兵行为，本刺心情 −2，记着呢。',
      ignore: '喊你你不应，心情 −1，自己掂量。',
    },
    apology: {
      ok: '（哼，慢慢抬眼）行，本刺姑且信你这一回，心情给你补回来。别再有下次。',
      calm: '（斜眼笑）没生气也来道歉？行吧，这份心意本刺收下了。',
      repeat: '今天已经道过歉了，省省吧，本刺不听第二遍。',
    },
  };

  /* 心情台词：无论顶不顶罪，都按当前心情档变 */
  var MOOD_LINES = {
    good: {
      noCover: '（心情不错，抬了抬刺）这回本刺懒得动手，你自己扛，别怪我没提醒。',
      tail: '（挑眉）今天心情好，说话都客气点。',
    },
    normal: {
      noCover: '（斜眼）这次不关我事，自己惹的自己擦。',
      tail: '（面无表情）账记着呢，别装。',
    },
    bad: {
      noCover: '（冷着脸）自己拉的屎自己擦，别看我。',
      tail: '（刺全竖着）别惹我，今天脾气差。',
    },
  };

  /* ============ 心情 + 顶罪账本 ============ */
  function defaultSin() {
    return {
      v: 2, week: '', month: '', weekUsed: 0, monthUsed: 0,
      total: 0, lastAt: 0, lastReason: '', history: [],
      skinLockUntil: 0,   // 怒刺红：连续三天摆烂的功能锁
      slumpDay: '',       // 同一天只判一次「摆烂降级 / 顶罪」
      energy: 100, favor: 0,   // 网页 / 安卓端没有 aci 对象，能量与好感记这里
      /* 数值心情账本 */
      mood: MOOD.DEFAULT, moodUpdatedAt: 0,
      lastLoginAt: 0, lastLoginDay: '', lastInteractAt: 0, lastCheckinDay: '',
      lastMoodGainAt: 0, lastRemindMoodAt: 0,
      lastCoverAt: 0, coverDay: '', coverDayUsed: 0,
      lastRecoveryDay: '', lastNoLoginDay: '', lastIdleDay: '', lastApologyDay: '',
      streakMilestones: [], moodLog: [],
      /* 第二版：分皮肤心情账本（0~100），与旧 mood（−10~+10）并存互不干扰 */
      skin: '',                 // 当前生效皮肤 id
      skinMood: normalizeSkinMoodMap({}), // { cactus:55, rose:45, ... }
      familiarity: 0,           // 刺猬亲密度 0~100
      historicalScore: 0,       // 玫瑰记忆分 −20~+20
      debtDays: 0,              // 板栗债务：需补打卡天数
      lastSkinTalks: {},        // 每日互动计数（刺猬 familiar+ / 幻影蓝赞美）
      skinRecoverDay: '',       // 各皮肤凌晨恢复的结算日（幂等）
      skinMoodLog: [],          // 分皮肤心情变动日志（平衡监控用）
      telemetry: [],            // 顶罪判定遥测（纯本地，供平衡性微调，不上传不外显）
    };
  }
  function normalizeSin(raw) {
    var d = defaultSin(), s = (raw && typeof raw === 'object') ? raw : {};
    var out = {
      v: 2,
      week: String(s.week || ''), month: String(s.month || ''),
      weekUsed: clamp(Math.floor(num(s.weekUsed, 0)), 0, 1e6),
      monthUsed: clamp(Math.floor(num(s.monthUsed, 0)), 0, 1e6),
      total: clamp(Math.floor(num(s.total, 0)), 0, 1e9),
      lastAt: num(s.lastAt, 0), lastReason: String(s.lastReason || ''),
      history: Array.isArray(s.history) ? s.history.slice(-60) : [],
      skinLockUntil: num(s.skinLockUntil, 0),
      slumpDay: String(s.slumpDay || ''),
      energy: clamp(Math.floor(num(s.energy, 100)), 0, 1e6),
      favor: clamp(Math.floor(num(s.favor, 0)), -999, 999),
      mood: Math.round(clamp(num(s.mood, MOOD.DEFAULT), MOOD.MIN, MOOD.MAX) * 10) / 10,
      moodUpdatedAt: num(s.moodUpdatedAt, 0),
      lastLoginAt: num(s.lastLoginAt, 0), lastLoginDay: String(s.lastLoginDay || ''),
      lastInteractAt: num(s.lastInteractAt, 0),
      lastCheckinDay: String(s.lastCheckinDay || ''),
      lastMoodGainAt: num(s.lastMoodGainAt, 0), lastRemindMoodAt: num(s.lastRemindMoodAt, 0),
      lastCoverAt: num(s.lastCoverAt, 0),
      coverDay: String(s.coverDay || ''), coverDayUsed: clamp(Math.floor(num(s.coverDayUsed, 0)), 0, 1e6),
      lastRecoveryDay: String(s.lastRecoveryDay || ''),
      lastNoLoginDay: String(s.lastNoLoginDay || ''),
      lastIdleDay: String(s.lastIdleDay || ''), lastApologyDay: String(s.lastApologyDay || ''),
      streakMilestones: Array.isArray(s.streakMilestones) ? s.streakMilestones.slice(-8).map(function (x) { return Math.floor(num(x, 0)); }) : [],
      moodLog: Array.isArray(s.moodLog) ? s.moodLog.slice(-60) : [],
      /* 第二版分皮肤字段：老数据缺失自动补初值 */
      skin: String(s.skin || ''),
      skinMood: normalizeSkinMoodMap(s.skinMood),
      familiarity: clamp(Math.floor(num(s.familiarity, 0)), 0, 100),
      historicalScore: clamp(Math.floor(num(s.historicalScore, 0)), -20, 20),
      debtDays: clamp(Math.floor(num(s.debtDays, 0)), 0, 365),
      lastSkinTalks: (s.lastSkinTalks && typeof s.lastSkinTalks === 'object') ? s.lastSkinTalks : {},
      skinRecoverDay: String(s.skinRecoverDay || ''),
      skinMoodLog: Array.isArray(s.skinMoodLog) ? s.skinMoodLog.slice(-120) : [],
      telemetry: Array.isArray(s.telemetry) ? s.telemetry.slice(-400) : [],
    };
    return out;
  }
  function weekKey(at) {
    var d = new Date(num(at, Date.now()));
    var day = d.getDay() || 7;
    d.setDate(d.getDate() - day + 1);
    return d.getFullYear() + '-W' + String(Math.ceil(((d - new Date(d.getFullYear(), 0, 1)) / 86400000 + 1) / 7)).padStart(2, '0');
  }
  function monthKey(at) {
    var d = new Date(num(at, Date.now()));
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  }
  function quotaOf(sin, at) {
    var s = normalizeSin(sin), t = num(at, Date.now());
    var wk = weekKey(t), mk = monthKey(t);
    var wu = s.week === wk ? s.weekUsed : 0;
    var mu = s.month === mk ? s.monthUsed : 0;
    return {
      week: wk, month: mk, weekUsed: wu, monthUsed: mu,
      weekLeft: Math.max(0, RULES.WEEK_LIMIT - wu),
      monthLeft: Math.max(0, RULES.MONTH_LIMIT - mu),
      exhausted: wu >= RULES.WEEK_LIMIT || mu >= RULES.MONTH_LIMIT,
    };
  }
  /* 对外只给「他扛过几次 + 心情」，不给概率、不给开关、不给 mood 档位概率
   * 第二版：传 skin 时额外给该皮肤的心情值 / 等级 / 亲密度 / 记忆分 / 债务（都不含概率） */
  function publicSin(sin, at, skin) {
    var q = quotaOf(sin, at), s = normalizeSin(sin), b = moodBandOf(s.mood);
    var label = b === 'good' ? '心情不错' : b === 'bad' ? '脾气很差' : '一般';
    var out = {
      total: s.total, lastAt: s.lastAt,
      weekLeft: q.weekLeft, monthLeft: q.monthLeft,
      mood: s.mood, moodLabel: label, moodBand: b,
      note: '扛不扛、什么时候扛，本刺自己说了算。',
    };
    var sk = String(skin || s.skin || '');
    if (skinProfile(sk)) {
      var sm = skinMoodOf(s, sk);
      out.skin = sk;
      out.skinMood = sm;
      out.skinMoodLevel = skinMoodLevel(sk, sm);
      out.skinMoodName = skinProfile(sk).name;
      out.skinTag = skinProfile(sk).tag;
      if (sk === 'hedgehog') out.familiarity = s.familiarity;
      if (sk === 'rose') out.historicalScore = s.historicalScore;
      if (sk === 'chestnut') out.debtDays = s.debtDays;
    }
    return out;
  }

  /* ============ 第二版：分皮肤心情升降 / 顶罪 ============
   * 与旧统一心情并存：ctx.skin 指向某套皮肤时走这里；不传 skin 时全部旧行为照旧。
   * 顶罪顺序仍是 冷却 → 日上限 → 周限 → 能量 → R(0~100) < finalProb；
   * ctx 里 force/request/cover 一律忽略——他不受规定。 */
  function skinMoodBand(skin, mood) {
    var p = skinProfile(skin);
    if (!p) return moodBandOf(mood);
    var lv = num(mood, p.init);
    var t0 = p.levels[0][0], t1 = p.levels[1][0];
    return lv >= t0 ? 'good' : lv >= t1 ? 'normal' : 'bad';
  }
  /* 单条皮肤心情事件。event 用第二版规格名（completedAll/streak7/overwrote 等）。
   * 返回 { sin, delta, mood, level, band, reason, line }。 */
  function applySkinMood(sin, skin, event, ctx, at) {
    var p = skinProfile(skin);
    if (!p) return null;
    var s = normalizeSin(sin), c = ctx || {}, t = num(at, Date.now()), day = dayKeyOf(t);
    var map = normalizeSkinMoodMap(s.skinMood);
    var before = map[skin] == null ? p.init : map[skin];
    var delta = 0, reason = String(event || ''), line = '', evt = String(event || '');
    var talkDay = s.lastSkinTalks && s.lastSkinTalks[day] ? s.lastSkinTalks[day] : {};

    if (evt === 'completedAll') { delta = p.up.completedAll || 0; }
    else if (evt === 'streak7') { delta = p.up.streak7 || 0; }
    else if (evt === 'acceptedCriticism') { delta = p.up.acceptedCriticism || 0; }
    else if (evt === 'praisedACI') {
      if (num(talkDay.praise, 0) < 1) { delta = p.up.praised || 0; talkDay.praise = num(talkDay.praise, 0) + 1; }
    } else if (evt === 'consistentWeek') { delta = p.up.consistentWeek || 0; }
    else if (evt === 'interactedDaily' || evt === 'interact') {
      if (num(talkDay.interact, 0) < 3) { talkDay.interact = num(talkDay.interact, 0) + 1; }
      s.familiarity = clamp(Math.floor(s.familiarity + num(p.up.interactedFam, 0)), 0, 100);
    } else if (evt === 'streak14') { s.familiarity = clamp(Math.floor(s.familiarity + num(p.up.streak14Fam, 0)), 0, 100); }
    else if (evt === 'repaidDebt') { delta = p.up.repaidDebt || 0; s.debtDays = Math.max(0, s.debtDays - 1); }
    else if (evt === 'honestBehavior') { delta = p.up.honest || 0; }
    else if (evt === 'provedWorth') { delta = p.up.provedWorth || 0; }
    else if (evt === 'respectedBoundaries') { delta = p.up.respected || 0; }
    else if (evt === 'longStreak21') { delta = p.up.longStreak21 || 0; }
    /* 下降 */
    else if (evt === 'missedCorePlan') { delta = -(p.down.missedCore || 0); }
    else if (evt === 'missedPlan' || evt === 'missedAnyPlan') { delta = -(p.down.missedPlan != null ? p.down.missedPlan : p.down.missedAny || 0); }
    else if (evt === 'overwrotePlanFile' || evt === 'overwrite') { delta = -(p.down.overwrote || 0); }
    else if (evt === 'arguedBack') { delta = -(p.down.arguedBack || 0); }
    else if (evt === 'criticizedACI') { delta = -(p.down.criticized || 0); }
    else if (evt === 'defaultedDebt') { delta = -(p.down.defaultedDebt || 0); s.debtDays = Math.min(7, s.debtDays + 1); }
    else if (evt === 'coddledACI') { delta = -(p.down.coddled || 0); }
    else if (evt === 'ignoredForDays') { s.familiarity = clamp(Math.floor(s.familiarity - num(p.down.ignored3Fam, 0)), 0, 100); }
    else if (evt === 'inactiveDays' || evt === 'noLogin') {
      var days = Math.max(1, Math.floor(num(c.days, 1)));
      var per = p.down.inactive1 != null ? p.down.inactive1 : (p.down.missedAny || 0);
      delta = -per * days;
    }
    /* 玫瑰记忆分：屡犯按历史分追加扣分 */
    if (skin === 'rose' && c.repeatedOffense && s.historicalScore > 0) delta -= Math.min(6, Math.ceil(s.historicalScore / 5));
    /* 刺猬：熟了稳定 +1，陌生期易不高兴 −3 */
    if (skin === 'hedgehog') {
      if (p.up.fam50Mood && s.familiarity >= 50 && delta > 0) delta += p.up.fam50Mood;
      if (p.down.fam20Mood && s.familiarity < 20) delta -= p.down.fam20Mood;
    }
    /* 玫瑰：批评她记小本本，夸她记好 */
    if (skin === 'rose' && evt === 'criticizedACI') s.historicalScore = clamp(s.historicalScore - 2, -20, 20);
    if (skin === 'rose' && evt === 'praisedACI') s.historicalScore = clamp(s.historicalScore + 1, -20, 20);

    var now = clamp(Math.round(before + delta), p.min, p.max);
    map[skin] = now;
    s.skin = skin;
    var talks = Object.assign({}, s.lastSkinTalks || {});
    talks[day] = talkDay;
    s.lastSkinTalks = talks;
    if (delta) {
      s.skinMoodLog = s.skinMoodLog.concat([{ at: t, skin: skin, event: evt, delta: delta, from: before, to: now }]).slice(-120);
    }
    s.skinMood = map;
    return {
      sin: s, delta: now - before, mood: now, level: skinMoodLevel(skin, now),
      band: skinMoodBand(skin, now), reason: reason, line: line, skin: skin,
    };
  }
  /* 各皮肤凌晨自然恢复：仅在低于该皮肤阈值时 +delta，同日幂等 */
  function skinDailyRecover(sin, at) {
    var s = normalizeSin(sin), t = num(at, Date.now()), day = dayKeyOf(t);
    if (s.skinRecoverDay === day) return { sin: s, applied: [] };
    var map = normalizeSkinMoodMap(s.skinMood), applied = [];
    skinIds().forEach(function (skin) {
      var p = skinProfile(skin);
      if (!p || !p.recover) return;
      var m = map[skin] == null ? p.init : map[skin];
      if (m < p.recover.below) {
        var to = clamp(Math.round(m + p.recover.delta), p.min, p.max);
        map[skin] = to;
        applied.push({ skin: skin, from: m, to: to, delta: to - m });
        s.skinMoodLog = s.skinMoodLog.concat([{ at: t, skin: skin, event: 'dailyRecover', delta: to - m, from: m, to: to }]).slice(-120);
      }
    });
    s.skinMood = map;
    s.skinRecoverDay = day;
    return { sin: s, applied: applied };
  }
  /* 第二版顶罪判定：先于统一 decideCover 调用（ctx.skin 存在时）。算法顺序不变。 */
  function decideSkinCover(sin, ctx, rng) {
    var c = ctx || {}, skin = c.skin, p = skinProfile(skin);
    if (!p) return null;
    var cfg = p.cover, at = num(c.at, Date.now()), s = normalizeSin(sin), q = quotaOf(s, at);
    var mood = skinMoodOf(s, skin), band = skinMoodBand(skin, mood);
    var prob = clamp(skinBaseProb(cfg, s) + skinModOf(cfg, mood), 0.01, 0.95);
    if (cfg.memoryWeight) prob = clamp(prob + num(s.historicalScore, 0) * cfg.memoryWeight, cfg.floor || 0.01, cfg.cap || 0.95);
    var cut = Math.max(0, Math.round(num(c.pointsCut, 0)));
    var day = dayKeyOf(at), dayUsed = s.coverDay === day ? s.coverDayUsed : 0;
    var weeklyLimit = cfg.weeklyLimit || RULES.WEEK_LIMIT;
    var cooldownMs = num(cfg.cooldownH, 7) * 3600000;
    var cooldownLeft = Math.max(0, (s.lastCoverAt || 0) + cooldownMs - at);
    var base = {
      covered: false, band: band, mood: mood, level: skinMoodLevel(skin, mood), skin: skin,
      prob: prob, cut: cut, energyCost: 0, favorDrop: 0, roll: 0,
      weekLeft: Math.max(0, weeklyLimit - (s.week === q.week ? s.weekUsed : 0)),
      monthLeft: q.monthLeft,
      dayLeft: Math.max(0, num(cfg.dayLimit, 1) - dayUsed), cooldownLeft: cooldownLeft,
      reason: '', line: '', moodLine: (MOOD_LINES[band] || MOOD_LINES.normal).tail,
      toast: '', quota: q,
    };
    function finish(reason, line) { return Object.assign(base, { reason: reason, line: line || '' }); }
    if (cut <= 0) return finish('nocut');
    if (cooldownLeft > 0) return finish('cooldown', LINES.cooldown);
    if (dayUsed >= num(cfg.dayLimit, 1)) return finish('daily', LINES.daily);
    if ((s.week === q.week ? s.weekUsed : 0) >= weeklyLimit || q.monthUsed >= RULES.MONTH_LIMIT) return finish('quota', pick(LINES.quota, rng));
    if (num(c.energy, 0) < RULES.ENERGY_PER_SIN) return finish('energy', LINES.noEnergy);
    var roll = (typeof rng === 'function' ? rng() : Math.random()) * 100;
    base.roll = Math.round(roll * 100) / 100;
    if (!(roll < prob * 100)) return finish('mood', (MOOD_LINES[band] || MOOD_LINES.normal).noCover);
    var lines = cfg.lines || [];
    var line = fill(pick(lines, rng), { cut: cut });
    if (skin === 'chestnut' && cfg.debtDays) line += '（欠我 ' + cfg.debtDays + ' 天打卡，记账了）';
    return Object.assign(base, {
      covered: true, reason: 'covered', line: line, mood: 'smirk',
      energyCost: RULES.ENERGY_PER_SIN, favorDrop: RULES.FAVOR_DROP,
      toast: cfg.silent ? '' : LINES.coverToast, debtDays: (skin === 'chestnut' ? num(cfg.debtDays, 0) : 0),
    });
  }
  /* 分皮肤顶罪命中后：额外处理板栗债务 / 玫瑰记忆分 */
  function commitSkinCover(sin, decision, at) {
    var s = normalizeSin(sin), d = decision || {}, t = num(at, Date.now());
    if (d.covered && d.skin === 'chestnut' && num(d.debtDays, 0)) {
      s.debtDays = Math.min(14, s.debtDays + num(d.debtDays, 0));
    }
    return s;
  }

  /* ============ 本地遥测：顶罪平衡性监控（纯本地，不上传、不外显、不给开关） ============
   * 每次判定记一条：{ at, skin, reason, band, roll, prob, covered }。
   * 只在内部 decideSkinCover / decideCover 命中后由调用方可选记录；默认不记录，
   * 由 main.js 的 maybeCover 统一写一条，避免重复。报表给出各皮肤有效命中率。 */
  function recordCover(sin, decision, at) {
    var s = normalizeSin(sin), d = decision || {};
    if (!d.reason) return s;
    var rec = {
      at: num(at, Date.now()), skin: String(d.skin || s.skin || ''),
      reason: String(d.reason || ''), band: String(d.band || ''),
      roll: num(d.roll, 0), prob: Math.round(num(d.prob, 0) * 1000) / 1000,
      covered: !!d.covered,
    };
    s.telemetry = s.telemetry.concat([rec]).slice(-400);
    return s;
  }
  /* 平衡性报表：按皮肤汇总命中率 / 冷却·超限·能量拦截占比 / 心情档分布。
   * 这是给开发者微调参数看的，界面不展示、接口不对外暴露概率承诺。 */
  function balanceReport(sin) {
    var s = normalizeSin(sin), rows = s.telemetry || [];
    var bySkin = {};
    rows.forEach(function (r) {
      var k = r.skin || '(统一)';
      if (!bySkin[k]) bySkin[k] = { skin: k, trials: 0, eligible: 0, covered: 0, reasons: {}, bands: {}, rollSum: 0, probSum: 0 };
      var b = bySkin[k];
      b.trials += 1;
      b.reasons[r.reason] = (b.reasons[r.reason] || 0) + 1;
      if (r.band) b.bands[r.band] = (b.bands[r.band] || 0) + 1;
      if (r.reason === 'mood' || r.reason === 'covered') {
        b.eligible += 1; b.rollSum += num(r.roll, 0); b.probSum += num(r.prob, 0);
        if (r.covered) b.covered += 1;
      }
    });
    var out = [];
    Object.keys(bySkin).forEach(function (k) {
      var b = bySkin[k];
      out.push({
        skin: b.skin,
        trials: b.trials,
        eligible: b.eligible,
        covered: b.covered,
        hitRate: b.eligible ? Math.round((b.covered / b.eligible) * 1000) / 10 : 0,
        avgRoll: b.eligible ? Math.round((b.rollSum / b.eligible) * 10) / 10 : 0,
        avgProb: b.eligible ? Math.round((b.probSum / b.eligible) * 1000) / 10 : 0,
        blocked: b.trials - b.eligible,
        reasons: b.reasons, bands: b.bands,
      });
    });
    out.sort(function (a, b) { return b.trials - a.trials; });
    return { total: rows.length, skins: out };
  }

  /* ============ 心情升降 ============ */
  function moodBandOf(mood) {
    var m = num(mood, MOOD.DEFAULT);
    if (m >= 6) return 'good';
    if (m <= -3) return 'bad';
    return 'normal';
  }
  /* 兼容老调用：传 ctx 对象时按表现推断，传数字时直接分档 */
  function moodBand(ctxOrMood) {
    if (ctxOrMood && typeof ctxOrMood === 'object') {
      var c = ctxOrMood;
      if (c.mood != null) return moodBandOf(c.mood);
      if (c.disappointed || c.deserter || num(c.lowDays, 0) >= 3 ||
          num(c.weekRate, 0) < 35 || num(c.favor, 0) < -10) return 'bad';
      if (num(c.weekRate, 0) >= 75 && num(c.recentChats, 0) >= 3 &&
          num(c.favor, 0) >= 0 && num(c.lowDays, 0) === 0 && !c.slumpLocked) return 'good';
      return 'normal';
    }
    return moodBandOf(ctxOrMood);
  }
  function coverProb(mood) {
    return clamp(MOOD.BASE_PROB + num(mood, MOOD.DEFAULT) * MOOD.PER_POINT, MOOD.PROB_MIN, MOOD.PROB_MAX);
  }
  function clampMood(m) { return Math.round(clamp(num(m, MOOD.DEFAULT), MOOD.MIN, MOOD.MAX) * 10) / 10; }

  /* 单个心情事件。返回 { sin, delta, mood, band, reason, line } */
  function applyMood(sin, event, ctx, at) {
    var s = normalizeSin(sin), c = ctx || {}, t = num(at, Date.now());
    var day = dayKeyOf(t), before = s.mood, delta = 0, reason = '', line = '';
    if (event === 'checkin') {
      delta = MOOD.DELTA.checkin;
      s.lastCheckinDay = day; s.lastInteractAt = t;
      var st = Math.floor(num(c.streak, 0));
      var bonus = MOOD.STREAK_BONUS[st] || 0;
      if (bonus && s.streakMilestones.indexOf(st) < 0) {
        delta += bonus; s.streakMilestones.push(st);
        reason = 'streak' + st;
        line = fill(LINES.moodUp.streak, { n: st, bonus: bonus });
      }
    } else if (event === 'interact') {
      s.lastInteractAt = t;
      if (t - (s.lastMoodGainAt || 0) >= MOOD.INTERACT_THROTTLE_MS) {
        delta = MOOD.DELTA.interact; s.lastMoodGainAt = t;
      }
      reason = 'interact';
    } else if (event === 'challenge') {
      delta = MOOD.DELTA.challenge; s.lastInteractAt = t;
      reason = 'challenge'; line = LINES.moodUp.challenge;
    } else if (event === 'noLogin') {
      if (num(c.days, 0) >= 2 && s.lastNoLoginDay !== day) {
        delta = MOOD.DELTA.noLogin2Days; s.lastNoLoginDay = day;
        reason = 'noLogin'; line = LINES.moodDown.noLogin;
      }
    } else if (event === 'overwrite') {
      delta = MOOD.DELTA.overwrite; reason = 'overwrite'; line = LINES.moodDown.overwrite;
    } else if (event === 'idle') {
      var h = num(c.hours, 0);
      if (h >= 48 && s.lastIdleDay !== day) {
        var steps = clamp(Math.floor((h - 48) / 24) + 1, 1, 4);
        delta = -Math.min(2, Math.abs(MOOD.DELTA.idle48h) * steps);
        s.lastIdleDay = day; reason = 'idle';
      }
    } else if (event === 'ignoreReminder') {
      if (t - (s.lastRemindMoodAt || 0) >= MOOD.REMIND_THROTTLE_MS) {
        delta = MOOD.DELTA.ignoreReminder; s.lastRemindMoodAt = t;
        reason = 'ignore'; line = LINES.moodDown.ignore;
      }
    } else if (event === 'dailyRecover') {
      /* 只在为负时恢复，且补到 0 封顶，不会「恢复」成正心情 */
      if (s.mood < 0) {
        delta = Math.min(MOOD.DELTA.dailyRecover, -s.mood);
        line = LINES.moodUp.recover;
      }
      s.lastRecoveryDay = day; reason = 'dailyRecover';
    } else if (event === 'apology') {
      if (s.lastApologyDay === day) {
        line = LINES.apology.repeat; reason = 'apologyRepeat';
      } else {
        s.lastApologyDay = day;
        if (s.mood < 0) {
          delta = Math.min(MOOD.DELTA.apology, -s.mood);
          line = LINES.apology.ok;
        } else { line = LINES.apology.calm; }
        reason = 'apology';
      }
    } else if (event === 'login') {
      s.lastLoginAt = t; reason = 'login';
    }
    s.mood = clampMood(before + delta);
    s.moodUpdatedAt = t;
    if (delta) s.moodLog = s.moodLog.concat([{ at: t, event: String(event || ''), delta: delta, from: before, to: s.mood }]).slice(-60);
    return {
      sin: s, delta: Math.round((s.mood - before) * 10) / 10,
      mood: s.mood, band: moodBandOf(s.mood), reason: reason, line: line,
    };
  }

  /* 凌晨恢复：跨了几天就补几天（只在当前为负时 +1/天），幂等 */
  function dailySettle(sin, at) {
    var s = normalizeSin(sin), t = num(at, Date.now()), day = dayKeyOf(t), applied = [];
    var last = s.lastRecoveryDay ? Date.parse(s.lastRecoveryDay + 'T00:00:00') : 0;
    var cur = Date.parse(day + 'T00:00:00');
    if (last && isFinite(last) && isFinite(cur) && cur > last) {
      var days = Math.min(30, Math.floor((cur - last) / 86400000));
      for (var i = 0; i < days; i++) {
        if (s.mood < 0) { s.mood = clampMood(Math.min(0, s.mood + MOOD.DELTA.dailyRecover)); applied.push(1); }
      }
    }
    s.lastRecoveryDay = day;
    if (applied.length) s.moodUpdatedAt = t;
    return { sin: s, applied: applied };
  }

  /* 启动 / 读状态时结算：未登录、48h 不互动、凌晨恢复。幂等，可反复调。 */
  function bootSettle(sin, ctx, at) {
    var s = normalizeSin(sin), t = num(at, Date.now()), c = ctx || {}, events = [];
    var day = dayKeyOf(t);
    /* 同一天只结算一次登录态：前端每次轮询 / 每次读 aci:state 都调到这里，
     * 若每调一次就刷新 lastLoginAt，会导致 saveNow 高频写盘。 */
    if (s.lastLoginDay !== day) {
      var lastLogin = s.lastLoginAt || 0;
      if (lastLogin) {
        var days = Math.floor((t - lastLogin) / 86400000);
        if (days >= 2) {
          var r = applyMood(s, 'noLogin', { days: days }, t);
          s = r.sin; if (r.delta) events.push(r);
        }
      }
      var lastInteract = s.lastInteractAt || 0;
      var idleH = lastInteract ? (t - lastInteract) / 3600000 : 0;
      if (idleH >= 48) {
        var r2 = applyMood(s, 'idle', { hours: idleH }, t);
        s = r2.sin; if (r2.delta) events.push(r2);
      }
      s.lastLoginAt = t;
      s.lastLoginDay = day;
    }
    var d = dailySettle(s, t);
    s = d.sin;
    if (d.applied.length) events.push({ event: 'dailyRecover', delta: d.applied.length, line: LINES.moodUp.recover });
    return { sin: s, events: events };
  }

  /* ============ 顶罪判定 ============
   * 顺序硬性固定：冷却 → 每日上限 → 周/月限额 → 能量 → R(0~100) < 25%+心情修正。
   * ctx 里任何 force / cover / request / probability 字段一律被忽略——他不受规定。 */
  function decideCover(sin, ctx, rng) {
    var c = ctx || {}, at = num(c.at, Date.now());
    var s = normalizeSin(sin), q = quotaOf(s, at);
    var band = moodBandOf(s.mood), prob = coverProb(s.mood);
    var cut = Math.max(0, Math.round(num(c.pointsCut, 0)));
    var day = dayKeyOf(at);
    var dayUsed = s.coverDay === day ? s.coverDayUsed : 0;
    var cooldownLeft = Math.max(0, (s.lastCoverAt || 0) + MOOD.COOLDOWN_MS - at);
    var base = {
      covered: false, band: band, mood: s.mood, prob: prob, cut: cut,
      energyCost: 0, favorDrop: 0, roll: 0,
      weekLeft: q.weekLeft, monthLeft: q.monthLeft,
      dayLeft: Math.max(0, MOOD.DAY_LIMIT - dayUsed), cooldownLeft: cooldownLeft,
      reason: '', line: '', moodLine: (MOOD_LINES[band] || MOOD_LINES.normal).tail,
      toast: '', quota: q,
    };
    function finish(reason, line) {
      return Object.assign(base, { reason: reason, line: line || '' });
    }
    if (cut <= 0) return finish('nocut');
    if (cooldownLeft > 0) return finish('cooldown', LINES.cooldown);
    if (dayUsed >= MOOD.DAY_LIMIT) return finish('daily', LINES.daily);
    if (q.exhausted) return finish('quota', pick(LINES.quota, rng));
    if (num(c.energy, 0) < RULES.ENERGY_PER_SIN) return finish('energy', LINES.noEnergy);
    var roll = (typeof rng === 'function' ? rng() : Math.random()) * 100;
    base.roll = Math.round(roll * 100) / 100;
    if (!(roll < prob * 100)) {
      return finish('mood', (MOOD_LINES[band] || MOOD_LINES.normal).noCover);
    }
    var line = fill(pick(LINES.cover, rng), { cut: cut });
    if (band === 'bad') line += LINES.coverBadTail;
    return Object.assign(base, {
      covered: true, reason: 'covered', line: line, mood: 'smirk',
      energyCost: RULES.ENERGY_PER_SIN, favorDrop: RULES.FAVOR_DROP,
      toast: LINES.coverToast,
    });
  }

  /* 命中后记账（周 / 月 / 日 / 总 / 冷却 / 历史），心情账本完整保留 */
  function commitCover(sin, decision, at) {
    var s = normalizeSin(sin), t = num(at, Date.now());
    var q = quotaOf(s, t), d = decision || {}, day = dayKeyOf(t);
    var dayUsed = s.coverDay === day ? s.coverDayUsed : 0;
    return Object.assign({}, s, {
      week: q.week, month: q.month,
      weekUsed: q.weekUsed + (d.covered ? 1 : 0),
      monthUsed: q.monthUsed + (d.covered ? 1 : 0),
      total: s.total + (d.covered ? 1 : 0),
      lastAt: t, lastReason: String(d.reason || ''),
      lastCoverAt: d.covered ? t : s.lastCoverAt,
      coverDay: day, coverDayUsed: dayUsed + (d.covered ? 1 : 0),
      history: s.history.concat(d.covered ? [{ at: t, cut: num(d.cut, 0), band: String(d.band || ''), roll: num(d.roll, 0) }] : []).slice(-60),
    });
  }

  /* 怒刺红：连续 N 天没打卡 → 锁死换皮 / 养成 24 小时 */
  function applySlump(sin, ctx, at) {
    var s = normalizeSin(sin), c = ctx || {}, t = num(at, Date.now());
    var days = Math.floor(num(c.missedDays, 0));
    var need = num(c.slumpLockDays, RULES.SLUMP_DAYS);
    if (need > 0 && days >= need) s.skinLockUntil = Math.max(s.skinLockUntil, t + RULES.SLUMP_LOCK_MS);
    return s;
  }
  function isSlumpLocked(sin, at) { return normalizeSin(sin).skinLockUntil > num(at, Date.now()); }
  function slumpLeft(sin, at) { return Math.max(0, normalizeSin(sin).skinLockUntil - num(at, Date.now())); }
  function slumpLine(skin, rng) {
    var s = getSkill(skin);
    if (s && s.id === 'rose') return '（刺全竖着）连着三天不打卡？行，门锁了，钥匙我吞了。明天再来说话。';
    return pick([
      '（笑眯眯）连着几天不见人影，本刺懒得替你动。门锁着，自己反省。',
      '别点了，功能歇着呢。等你想起来打卡再说。',
    ], rng);
  }

  /* ============ 分皮肤说话风格 ============
   * 只加「语气壳」，不改数字、不改事实、不动结论；幂等。 */
  var STYLE = {
    speed: { mark: '（斜眼笑）', tail: '别拖，本刺带路不等人。', swap: [[/本刺/g, '本刺'], [/挺/g, '够']] },
    blunt: { mark: '', tail: '嗯。', cut: true },
    fierce: { mark: '（刺全竖起来）', tail: '再摆烂我真动手。' },
    proud: { mark: '（慢慢抬眼）', tail: '哼，本刺金贵。' },
    lofty: { mark: '（离地半寸）', tail: '这叫恩赐，收好。' },
  };
  function styleLine(text, skin, kind) {
    var body = String(text == null ? '' : text);
    if (!body || kind === 'raw') return body;
    if (body.length > 260) return body;
    var s = getSkill(skin);
    if (!s) return body;
    var cfg = STYLE[s.style] || STYLE.speed;
    if (cfg.mark && body.indexOf(cfg.mark) === 0) return body;
    if (cfg.tail && body.indexOf(cfg.tail) >= 0) return body;
    var out = body;
    if (cfg.cut) {
      out = out.replace(/（[^）]{1,24}）/g, '').replace(/[~～…]+/g, '');
      out = out.replace(/[。！？!?]+$/, '') + '。';
      return out + ' ' + cfg.tail;
    }
    if (cfg.mark) out = cfg.mark + out;
    if (cfg.tail) out = out.replace(/[。！？!?]?$/, function (m) { return m || ''; }) + ' ' + cfg.tail;
    return out;
  }

  function pleaLine(rng) { return pick(LINES.plea, rng); }
  function quotaLine(rng) { return pick(LINES.quota, rng); }
  function taunt(skin) { var s = getSkill(skin); return s ? s.taunt : ''; }

  return {
    RULES: RULES, MOOD: MOOD, SKILLS: SKILLS, LINES: LINES, MOOD_LINES: MOOD_LINES,
    getSkill: getSkill, modsFor: modsFor, prosCons: prosCons, shapePlan: shapePlan,
    defaultSin: defaultSin, normalizeSin: normalizeSin, publicSin: publicSin,
    quotaOf: quotaOf, weekKey: weekKey, monthKey: monthKey, dayKeyOf: dayKeyOf,
    moodBand: moodBand, moodBandOf: moodBandOf, coverProb: coverProb,
    applyMood: applyMood, dailySettle: dailySettle, bootSettle: bootSettle,
    decideCover: decideCover, commitCover: commitCover,
    applySlump: applySlump, isSlumpLocked: isSlumpLocked, slumpLeft: slumpLeft,
    slumpLine: slumpLine, styleLine: styleLine, pleaLine: pleaLine,
    quotaLine: quotaLine, taunt: taunt, fill: fill, pick: pick,
    /* 第二版分皮肤个性化心情 / 顶罪 / AI 人设 */
    SKIN_MOOD: SKIN_MOOD, skinProfile: skinProfile, skinIds: skinIds,
    skinMoodInit: skinMoodInit, skinMoodOf: skinMoodOf, skinMoodLevel: skinMoodLevel,
    skinMoodBand: skinMoodBand, applySkinMood: applySkinMood, skinDailyRecover: skinDailyRecover,
    decideSkinCover: decideSkinCover, commitSkinCover: commitSkinCover, personaText: personaText,
    recordCover: recordCover, balanceReport: balanceReport,
    /* 故意不导出：requestCover / forceCover / setCoverEnabled / setProbability */
  };
});
