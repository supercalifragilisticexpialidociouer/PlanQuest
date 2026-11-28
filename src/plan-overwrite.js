/* 覆盖合并惩罚核心（桌面 / 网页 / 安卓同源 UMD，无 DOM 依赖）
 *
 * 口径（需求基线）：
 *   1. 用新的 .pqplan 覆盖合并时，新增的计划按「普通新建计划」的扣分口径算，
 *      被覆盖掉的计划按「删除计划」的扣分口径算 —— 两处常量直接对齐
 *      src/main.js 的 plan:save(PLAN_PROC_PENALTY=10) 与 plan:delete(deducted=0)。
 *   2. 只是打开 .pqplan 编辑（mode='inspect'）→ 不扣分、不应用、不记账、不进审讯。
 *   3. 覆盖（mode='replace'）才走：阿刺审讯 → 基础扣分 → 阶梯扣刺 → 加密留痕 → 翻旧账。
 *   4. 合并（mode='merge'）只按新增计划扣基础分，不算逃兵、不升级阶梯。
 *
 * 阶梯「赎罪」（越删越狠）：
 *   第 1 次 -10% 积分 / -80 经验 / -2 协作能量 + 斜眼笑
 *   第 2 次 -30% 积分 / -160 经验 / -3 协作能量 + 翻白眼
 *   第 3 次+ -50% 积分 / -300 经验 / -5 协作能量 + Lv 掉回 1 新手 + 锁死换皮/养成 24h + 生气脸
 *
 * 本模块只做纯逻辑：真正的加密落盘、积分写入、UI 弹窗由各端适配器完成。
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.PQPlanOverwrite = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this), function () {
  'use strict';

  var RULES = {
    /* 与 plan:save / plan:delete 完全对齐：契约任务不扣；普通计划新增非白名单软件 -10；删计划 0 */
    NEW_PLAN_PROC_COST: 10,
    DELETE_PLAN_COST: 0,
    FIRST_RATE: 0.10,
    SECOND_RATE: 0.30,
    THIRD_RATE: 0.50,
    ENERGY_LOSS: [2, 3, 5],
    EXP_LOSS: [80, 160, 300],
    LOCK_FROM_TIER: 3,
    DEMOTE_FROM_TIER: 3,
    LOCK_MS: 24 * 3600 * 1000,
    VAULT_KEEP: 20,
    TAG: '逃兵',
  };

  function num(v, d) { var n = Number(v); return isFinite(n) ? n : (d || 0); }
  function clampInt(v, lo, hi, d) { return Math.max(lo, Math.min(hi, Math.round(num(v, d)))); }

  /* ============ 台词：表情负责娇，文案负责傲 ============
   * 标杆画面：举着胳膊笑眯眯的仙人掌，吐出一句能扎穿屏幕的话。 */
  var LINES = {
    /* 用户点名的那句，原样留着当「买路钱」开场 */
    buyRoad: '想跑？行，本刺肯让你覆盖，算你有点胆。扣你50积分，当买路钱。下次再敢删，我直接拔刺扎你屏幕。',
    interrogate: [
      '（笑眯眯举着胳膊）确认覆盖？你那点破计划我可都记着，删了也得挨扎。',
      '（把刺一根根立起来，嘴角还是往上翘）想拿新文件糊弄过去？行啊，先过我这关，删了也得挨扎。',
      '（歪着头，笑得特别甜）覆盖之前问一句：你是来改计划的，还是来当逃兵的？本刺两种都记着，删了也得挨扎。',
    ],
    tier1: [
      '（斜眼笑）第一次？本刺大发慈悲，扣你{cut}积分、{exp}经验当买路钱。下次再敢删，我直接拔根刺扎你屏幕，省得你连疼都懒得喊。',
      '（斜眼笑，胳膊还举着）头一回就当没看见。{cut}积分先放着，本刺记性好得很，别指望我装失忆。',
    ],
    tier2: [
      '（翻白眼）又来？你这人怎么跟仙人掌似的，动不动就拔自己根。扣{cut}积分、{exp}经验、{energy}点协作能量，脸呢？',
      '（翻白眼，笑得比刚才还甜）第二次了。{cut}积分、{exp}经验，我都替你记着。你倒挺会给自己找台阶，可惜台阶上有刺。',
    ],
    tier3: [
      '（生气脸，刺全竖着）第三次了。养成和换皮给你锁死 24 小时，Lv.{lv}/100 直接掉回新手。你再删，我就在你屏幕上原地爆炸，信不信？',
      '（笑眯眯地气到发红）行，本刺不拦你。{cut}积分、{exp}经验、{energy}点协作能量，等级打回 Lv.1，换皮养成关 24 小时。跑啊，接着跑。',
    ],
    boot: [
      '哟，这文件看着眼生啊。哦，原来是把 {date} 那堆烂尾计划给「覆盖」了？逃兵行为，扣 {cut} 积分、{exp} 经验。本刺替你记着呢，别想装失忆。',
      '（翻开小本本，笑眯眯）上次 {date} 你「覆盖」掉了 {removes} 个计划，本刺还替你收着尸呢。{cut} 积分、{exp} 经验，账没销，别想装失忆。',
    ],
    cancel: [
      '（笑眯眯把刺收回去）算你识相。这笔账本刺先挂着，别以为我忘了。',
      '（斜眼笑）不覆盖了？挺好，省得我今晚还得拔刺。下回想跑，提前打招呼。',
    ],
    frozen: [
      '（笑眯眯）换皮？养成？门锁着呢，钥匙我吞了。{left}小时后再来，急也没用。',
      '（举着胳膊，刺一根没少）第 {n} 次覆盖的账还没销，就想来换皮？{left}小时，自己蹲墙角数刺去。',
    ],
    inspect: '（斜眼笑）光看不应用？行吧，本刺今天不拔刺。文件随你翻，少拿它来糊弄我。',
    merge: '（斜眼笑）合进来了 {adds} 条新计划，按新建的规矩扣了 {cost} 积分。别急着谢，我记账比你还勤。',
  };

  /* 「只打开编辑」契约：不扣分、不应用、不记账、不进审讯，各端共用同一个结果 */
  const INSPECT_NOOP = { applied: false, deducted: 0, counted: false, message: '只打开编辑，不应用、不扣分' };
  function isInspect(mode) { return mode === 'inspect'; }
  function inspectResult() {
    return { ok: true, applied: false, deducted: 0, counted: false, message: INSPECT_NOOP.message, say: LINES.inspect, mood: 'sideeye' };
  }

  function fill(s, vars) {
    return String(s || '').replace(/\{(\w+)\}/g, function (_, k) {
      return Object.prototype.hasOwnProperty.call(vars || {}, k) ? String(vars[k]) : '{' + k + '}';
    });
  }
  function pick(arr, rng) {
    if (!Array.isArray(arr) || !arr.length) return '';
    var r = typeof rng === 'function' ? rng() : Math.random();
    return arr[Math.floor(Math.max(0, Math.min(0.999999, num(r, 0.5))) * arr.length)];
  }

  /* ============ 状态 ============ */
  function defaultState() {
    return {
      v: 1,
      count: 0,          // 累计「覆盖」次数（阶梯依据）
      lastAt: 0,
      lockUntil: 0,      // 换皮 / 养成冻结到期时间戳
      deserter: false,   // 逃兵标签
      tags: [],          // 每覆盖一笔账
      vault: [],         // 加密备份索引（密文另存，不进 data.json）
      pendingBoot: null, // 下次启动要翻的旧账（读一次即销）
    };
  }
  function normalizeState(raw) {
    var s = (raw && typeof raw === 'object') ? raw : {};
    return {
      v: 1,
      count: clampInt(s.count, 0, 1e9, 0),
      lastAt: num(s.lastAt, 0),
      lockUntil: num(s.lockUntil, 0),
      deserter: !!s.deserter,
      tags: Array.isArray(s.tags) ? s.tags.slice(-50) : [],
      vault: Array.isArray(s.vault) ? s.vault.slice(-RULES.VAULT_KEEP) : [],
      pendingBoot: (s.pendingBoot && typeof s.pendingBoot === 'object') ? s.pendingBoot : null,
    };
  }
  function publicState(raw, now) {
    var s = normalizeState(raw), t = num(now, Date.now());
    return {
      count: s.count, lastAt: s.lastAt, deserter: s.deserter,
      lockUntil: s.lockUntil, frozen: s.lockUntil > t, frozenLeft: Math.max(0, s.lockUntil - t),
      vaultCount: s.vault.length, tags: s.tags.slice(-8),
      nextTier: Math.min(3, s.count + 1),
      rules: {
        firstRate: RULES.FIRST_RATE, secondRate: RULES.SECOND_RATE, thirdRate: RULES.THIRD_RATE,
        expLoss: RULES.EXP_LOSS.slice(), energyLoss: RULES.ENERGY_LOSS.slice(),
        lockMs: RULES.LOCK_MS, tag: RULES.TAG,
      },
    };
  }
  function isFrozen(raw, now) { return normalizeState(raw).lockUntil > num(now, Date.now()); }
  function frozenLeft(raw, now) { return Math.max(0, normalizeState(raw).lockUntil - num(now, Date.now())); }

  /* ============ diff：谁算新增、谁算被覆盖掉 ============ */
  function inScope(p, scope) {
    if (!p || !p.id) return false;
    if (scope === 'normal') return !p.contract;
    if (scope === 'contract') return !!p.contract;
    return true;
  }
  function diffPlans(cur, inc, mode, scope) {
    var c = Array.isArray(cur) ? cur : [];
    var i = Array.isArray(inc) ? inc : [];
    var replace = mode === 'replace';
    var sc = (scope === 'normal' || scope === 'contract') ? scope : 'all';
    var incScoped = i.filter(function (p) { return inScope(p, sc); });
    var removed = [], kept = [], seen = Object.create(null), k;
    for (k = 0; k < c.length; k++) {
      var p = c[k];
      if (replace && inScope(p, sc)) removed.push(p);
      else { kept.push(p); if (p && p.id) seen[p.id] = 1; }
    }
    var added = [];
    for (k = 0; k < incScoped.length; k++) {
      var q = incScoped[k];
      if (q && q.id && !seen[q.id]) { added.push(q); seen[q.id] = 1; }
    }
    return {
      mode: replace ? 'replace' : 'merge', scope: sc,
      added: added, removed: removed, kept: kept,
      adds: added.length, removes: removed.length,
    };
  }

  /* ============ 基础扣分：新增按新建口径、覆盖掉按删除口径 ============ */
  function newPlanCost(plan, ctx) {
    if (!plan) return 0;
    if (plan.contract) return 0; // 契约任务创建/编辑一律不扣分
    var procs = Array.isArray(plan.allowProcs) ? plan.allowProcs : [];
    if (!procs.length) return 0;
    var norm = (ctx && typeof ctx.normProc === 'function') ? ctx.normProc : function (x) { return String(x || '').toLowerCase(); };
    var white = (ctx && Array.isArray(ctx.whitelist)) ? ctx.whitelist : [];
    var w = Object.create(null), j;
    for (j = 0; j < white.length; j++) w[norm(white[j])] = 1;
    for (j = 0; j < procs.length; j++) if (!w[norm(procs[j])]) return RULES.NEW_PLAN_PROC_COST;
    return 0;
  }
  function baseCost(diff, ctx) {
    var add = 0;
    diff.added.forEach(function (p) { add += newPlanCost(p, ctx || {}); });
    var del = diff.removed.length * RULES.DELETE_PLAN_COST;
    return { addCost: add, delCost: del, points: add + del, adds: diff.adds, removes: diff.removes };
  }

  /* ============ 阶梯方案 ============ */
  function tierOf(count) { return Math.min(3, clampInt(count, 0, 1e9, 0) + 1); }
  function assess(state, diff, ctx, now) {
    var st = normalizeState(state);
    var tier = tierOf(st.count);
    var rate = [0, RULES.FIRST_RATE, RULES.SECOND_RATE, RULES.THIRD_RATE][tier];
    var pts = Math.max(0, Math.round(num(ctx && ctx.points, 0)));
    var cut = pts > 0 ? Math.max(1, Math.round(pts * rate)) : 0;
    return {
      tier: tier, rate: rate, count: st.count + 1,
      pointsCut: cut,
      energyCut: RULES.ENERGY_LOSS[tier - 1],
      expCut: RULES.EXP_LOSS[tier - 1],
      lock: tier >= RULES.LOCK_FROM_TIER,
      lockMs: tier >= RULES.LOCK_FROM_TIER ? RULES.LOCK_MS : 0,
      demote: tier >= RULES.DEMOTE_FROM_TIER,
      mood: tier === 1 ? 'sideeye' : (tier === 2 ? 'eyeroll' : 'angry'),
    };
  }

  function varsFor(plan, diff, cost, ctx) {
    return {
      cut: plan.pointsCut, exp: plan.expCut, energy: plan.energyCut,
      adds: diff.adds, removes: diff.removes, cost: cost.points,
      n: plan.count, lv: num(ctx && ctx.aciLevel, 1),
      left: Math.max(1, Math.ceil(RULES.LOCK_MS / 3600000)),
      date: new Date(num(ctx && ctx.at, Date.now())).toLocaleDateString('zh-CN'),
    };
  }
  function verdict(plan, diff, cost, ctx, rng) {
    var vars = varsFor(plan, diff, cost, ctx);
    var pool = plan.tier === 1 ? LINES.tier1 : (plan.tier === 2 ? LINES.tier2 : LINES.tier3);
    return {
      say: fill(pick(pool, rng), vars),
      mood: plan.mood,
      toast: '第 ' + plan.count + ' 次覆盖 · 扣 ' + (plan.pointsCut + cost.points) + ' 积分 · ' +
        (plan.lock ? '换皮/养成锁死 24 小时' : '本刺记着呢'),
      tag: RULES.TAG,
      vars: vars,
    };
  }

  /* 审讯弹窗内容：确认才扣，取消啥事没有 */
  function interrogation(diff, plan, cost, ctx, rng) {
    var vars = varsFor(plan, diff, cost, ctx);
    var details = [
      '新增 ' + diff.adds + ' 个计划（按新建口径扣 ' + cost.addCost + ' 分）',
      '覆盖掉 ' + diff.removes + ' 个计划（按删除口径扣 ' + cost.delCost + ' 分）',
      '第 ' + plan.count + ' 次覆盖：再扣 ' + plan.pointsCut + ' 积分（' + Math.round(plan.rate * 100) + '%）、' +
        plan.expCut + ' 经验、' + plan.energyCut + ' 点协作能量',
      plan.demote ? 'Lv.' + vars.lv + '/100 直接掉回新手' : '等级暂且给你留着',
      plan.lock ? '换皮 / 养成功能锁死 24 小时' : '再删一次，本刺就不只是斜眼笑了',
      '旧计划不会真删，加密收尸，下次启动翻旧账',
    ];
    return {
      title: '阿刺审讯 · 确认覆盖？',
      lead: fill(pick(LINES.interrogate, rng), vars),
      buyRoad: LINES.buyRoad,
      details: details,
      confirm: '确认覆盖，挨扎',
      cancel: '取消，本刺记着',
      mood: plan.tier === 1 ? 'sideeye' : (plan.tier === 2 ? 'eyeroll' : 'angry'),
      vars: vars,
    };
  }

  /* ============ 记账 / 留痕 ============ */
  function commit(state, plan, diff, ctx, now) {
    var st = normalizeState(state), t = num(now, Date.now());
    st.count = st.count + 1;
    st.lastAt = t;
    st.deserter = true;
    if (plan.lock) st.lockUntil = Math.max(st.lockUntil, t + RULES.LOCK_MS);
    st.tags.push({
      at: t, tier: plan.tier, tag: RULES.TAG,
      cut: plan.pointsCut, exp: plan.expCut, energy: plan.energyCut,
      adds: diff.adds, removes: diff.removes, scope: diff.scope,
      demote: !!plan.demote, lock: !!plan.lock,
    });
    st.tags = st.tags.slice(-50);
    st.pendingBoot = {
      at: t, tier: plan.tier, cut: plan.pointsCut, exp: plan.expCut, energy: plan.energyCut,
      adds: diff.adds, removes: diff.removes, scope: diff.scope,
      demote: !!plan.demote, lock: !!plan.lock,
      removedTitles: diff.removed.slice(0, 6).map(function (p) { return String((p && p.title) || '未命名计划'); }),
    };
    return st;
  }

  /* 加密备份的「明文载荷」：旧计划一台不落，外加旧积分/等级快照。端侧负责 seal。 */
  function vaultPayload(d, diff, ctx, now) {
    return {
      v: 1, at: num(now, Date.now()), scope: diff.scope,
      plans: diff.removed.slice(),
      log: (d && d.log) || {},
      profile: {
        points: num(d && d.profile && d.profile.points, 0),
        totalDone: num(d && d.profile && d.profile.totalDone, 0),
      },
      aci: {
        level: num(d && d.aci && d.aci.level, 1),
        exp: num(d && d.aci && d.aci.exp, 0),
        energy: num(d && d.aci && d.aci.energy, 0),
      },
      titles: diff.removed.slice(0, 6).map(function (p) { return String((p && p.title) || '未命名计划'); }),
      source: (ctx && ctx.source) || '',
    };
  }
  function vaultIndex(payload, checksum) {
    return {
      at: payload.at, scope: payload.scope, n: payload.plans.length,
      titles: payload.titles, sha256: checksum || '', source: payload.source || '',
    };
  }
  function pushVault(state, entry) {
    var st = normalizeState(state);
    st.vault.push(entry);
    st.vault = st.vault.slice(-RULES.VAULT_KEEP);
    return st;
  }

  /* 把惩罚真正写进 profile / aci（双端共用，保证桌面与网页数值一致） */
  function penalize(d, plan, cost) {
    var before = {
      points: num(d && d.profile && d.profile.points, 0),
      level: num(d && d.aci && d.aci.level, 1),
      exp: num(d && d.aci && d.aci.exp, 0),
      energy: num(d && d.aci && d.aci.energy, 0),
    };
    if (d && d.profile) {
      d.profile.points = before.points - num(plan.pointsCut, 0) - num(cost && cost.points, 0);
    }
    if (d && d.aci) {
      var a = d.aci;
      a.energy = Math.max(0, before.energy - num(plan.energyCut, 0));
      a.exp = Math.max(0, before.exp - num(plan.expCut, 0));
      if (plan.demote) { a.level = 1; a.exp = 0; }
      a.mood = plan.tier >= 3 ? 'angry' : (plan.tier === 2 ? 'disappointed' : 'idle');
      a.disappointed = plan.tier >= 2 ? true : !!a.disappointed;
    }
    return {
      pointsBefore: before.points,
      pointsAfter: num(d && d.profile && d.profile.points, 0),
      levelBefore: before.level,
      levelAfter: num(d && d.aci && d.aci.level, 1),
      expBefore: before.exp, energyBefore: before.energy,
      pointsCut: num(plan.pointsCut, 0) + num(cost && cost.points, 0),
    };
  }

  /* 启动翻旧账：读一次即销账 */
  function takeBoot(state, rng) {
    var st = normalizeState(state), p = st.pendingBoot;
    if (!p) return { state: st, line: '', mood: '' };
    st.pendingBoot = null;
    var vars = {
      date: new Date(num(p.at, Date.now())).toLocaleDateString('zh-CN'),
      cut: num(p.cut, 0), exp: num(p.exp, 0), energy: num(p.energy, 0),
      removes: num(p.removes, 0), adds: num(p.adds, 0), n: num(p.tier, 1),
    };
    return {
      state: st,
      line: fill(pick(LINES.boot, rng), vars),
      mood: num(p.tier, 1) >= 3 ? 'angry' : (num(p.tier, 1) === 2 ? 'eyeroll' : 'sideeye'),
      entry: p,
    };
  }
  function bootLine(entry, rng) {
    if (!entry) return '';
    return takeBoot({ pendingBoot: entry }, rng).line;
  }

  function line(kind, vars, rng) {
    var pool = Array.isArray(LINES[kind]) ? LINES[kind] : (LINES[kind] ? [LINES[kind]] : []);
    return fill(pick(pool, rng), vars || {});
  }

  var API = {
    RULES: RULES, LINES: LINES, INSPECT_NOOP: INSPECT_NOOP,
    isInspect: isInspect, inspectResult: inspectResult,
    defaultState: defaultState, normalizeState: normalizeState, publicState: publicState,
    isFrozen: isFrozen, frozenLeft: frozenLeft,
    inScope: inScope, diffPlans: diffPlans,
    newPlanCost: newPlanCost, baseCost: baseCost,
    tierOf: tierOf, assess: assess, verdict: verdict, interrogation: interrogation,
    commit: commit, vaultPayload: vaultPayload, vaultIndex: vaultIndex, pushVault: pushVault,
    penalize: penalize, takeBoot: takeBoot, bootLine: bootLine,
    line: line, fill: fill,
  };
  return API;
});
