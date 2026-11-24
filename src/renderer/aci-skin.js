'use strict';
/* ------------------------------------------------------------------ *
 * 阿刺「皮肤」核心：五种带刺生物 → 头像配色 / 主题色 / 语气 三件套
 *
 * 纯逻辑模块，不碰磁盘/网络/Electron，主进程 require 单测用，渲染层
 * 用 <script> 加载后挂在 window.PQSkin 上（UMD 双端同一份源码）。
 *
 * 设计约束（与产品口径一致）：
 *   1) 皮肤只在第一次选定，之后不能改 —— 想反悔只能走「重置」，代价是
 *      清空全部聊天记录 + 养成数据清零（requestSkinChange 只负责拒绝）。
 *   2) 改名不是想改就改：阿刺按自己的心情/等级/被改次数掷骰子，
 *      有概率不接受，并给出一句符合皮肤性格的拒绝理由。
 *   3) 语气微调必须可预测、可单测：所有随机都走可注入的 rng。
 * ------------------------------------------------------------------ */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.PQSkin = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ---------------- 皮肤表 ----------------
   * theme : 面板主色（浮标/面板/进度条都跟着变）
   * look  : 3D 建模参数（基础色、刺色、花瓣色、花冠缩放）
   * voice : 语气档位（harsh 更狠 / flower 带花 / soft 外硬内软 / plain 实在）
   */
  var SKINS = [
    {
      id: 'cactus',
      name: '仙人掌',
      emoji: '🌵',
      tagline: '经典款，浑身是刺，嘴硬心软',
      trait: '毒舌有分寸 · 认死理 · 老兵脾气',
      theme: { accent: '#10b894', accent2: '#6a5cf5' },
      look: { tint: null, spine: '#cfe0a4', petal: '#ffc36b', core: '#f5a623', flower: 1 },
      voice: { bite: 1 },
      names: ['刺头', '老刺', '扎扎', '刺哥', '仙人'],
    },
    {
      id: 'rose',
      name: '玫瑰',
      emoji: '🌹',
      tagline: '带刺的花，好看但不好惹',
      trait: '优雅地刻薄 · 花式阴阳 · 记仇也记好',
      theme: { accent: '#e0507e', accent2: '#b23a63' },
      look: { tint: '#d9598a', spine: '#f3c6d4', petal: '#ff6f9c', core: '#ff8fb1', flower: 1.5 },
      voice: { bite: 1.1, flower: true },
      names: ['小玫', '阿玫', '花刺', '玫瑰姐', '扎花'],
    },
    {
      id: 'hedgehog',
      name: '刺猬',
      emoji: '🦔',
      tagline: '外表扎手，熟了才露肚皮',
      trait: '先说狠话 · 再偷偷心软 · 熟了很黏',
      theme: { accent: '#b07b4f', accent2: '#8a5c39' },
      look: { tint: '#b58a63', spine: '#efe0c8', petal: '#e8c9a0', core: '#d9a05b', flower: 0.62 },
      voice: { bite: 0.8, soft: true },
      names: ['团子', '刺球', '小猬', '球球', '阿团'],
    },
    {
      id: 'chestnut',
      name: '板栗',
      emoji: '🌰',
      tagline: '外壳坚硬，内心实在',
      trait: '不绕弯 · 爱算账 · 说到做到',
      theme: { accent: '#a9743a', accent2: '#7d5226' },
      look: { tint: '#9c6b3d', spine: '#e6c79a', petal: '#d9b077', core: '#e0a24f', flower: 0.34 },
      voice: { bite: 0.95, plain: true },
      names: ['栗子', '阿栗', '小板', '硬壳', '栗哥'],
    },
    {
      id: 'porcupine',
      name: '豪猪',
      emoji: '🐗',
      tagline: '生人勿近，独来独往',
      trait: '不哄人 · 话短 · 怼得最狠',
      theme: { accent: '#5d5a7a', accent2: '#3f3d57' },
      look: { tint: '#5f5b6e', spine: '#dcd6c0', petal: '#8f86a8', core: '#a99fc4', flower: 0.16 },
      voice: { bite: 2.2, harsh: true },
      names: ['老豪', '阿豪', '刺王', '硬茬', '猪哥'],
    },
  ];

  var VOICE_HINT = {
    cactus: '毒舌但不人身攻击，短句、有分寸，偶尔损你一句就给你一条能马上做的建议。',
    rose: '毒舌但讲究体面，爱用花和"亲爱的"调味，阴阳得漂亮，不爆粗。',
    hedgehog: '嘴上凶，说完会漏一点软，偶尔自己先缩一下。',
    chestnut: '不玩花活，先讲事实和数字，再给一条最省事的做法。',
    porcupine: '话少、直、硬，不给台阶也不哄人，但说的都是能落地的。',
  };

  var BAD_WORDS = /傻逼|煞笔|智障|脑残|贱|婊|操你|草泥马|狗东西|去死/i;

  function get(id) {
    for (var i = 0; i < SKINS.length; i++) if (SKINS[i].id === id) return SKINS[i];
    return null;
  }
  /* 拿不到就退回仙人掌：调用方要判断"未选皮肤"请用 get() */
  function ensure(id) { return get(id) || SKINS[0]; }

  function pick(arr, rng) {
    var r = typeof rng === 'function' ? rng() : Math.random();
    return arr[Math.min(arr.length - 1, Math.max(0, Math.floor(r * arr.length)))];
  }
  function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

  /* ---------------- 主题色 ---------------- */
  function hexToRgb(hex) {
    var h = String(hex || '').replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    if (!isFinite(n) || h.length !== 6) return { r: 16, g: 184, b: 148 };
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  /* 面板要用的 CSS 变量：主色 / 次色 / 浅底 */
  function themeVars(id, dark) {
    var s = ensure(id);
    var a = hexToRgb(s.theme.accent);
    var a2 = hexToRgb(s.theme.accent2);
    var alpha = dark ? 0.18 : 0.10;
    return {
      '--pqb-teal': s.theme.accent,
      '--pqb-accent': s.theme.accent2,
      '--pqb-chip': 'rgba(' + a.r + ',' + a.g + ',' + a.b + ',' + alpha + ')',
      '--pqb-accent-rgb': a.r + ',' + a.g + ',' + a.b,
      '--pqb-accent2-rgb': a2.r + ',' + a2.g + ',' + a2.b,
    };
  }

  /* ---------------- 语气微调 ----------------
   * decorate(text, skinId, { kind, rng })
   *   kind: table（查表回答）| scold（补刀）| say（主动说）| model（模型回答）
   * 原则：只调味，不改事实；不删掉任何一条建议；不改数字。
   */
  function cutTail(t) {
    /* 豪猪话短：超过两句就砍到前两句（保留问号/感叹句的完整） */
    var marks = [];
    for (var i = 0; i < t.length; i++) if ('。！？!?'.indexOf(t[i]) >= 0) marks.push(i);
    if (marks.length <= 2) return t;
    return t.slice(0, marks[1] + 1);
  }

  function decorate(text, skinId, opts) {
    var t = String(text == null ? '' : text);
    if (!t) return t;
    var s = get(skinId);
    if (!s) return t;                      // 没选皮肤：原样，不做任何风格化
    var o = opts || {};
    var rng = typeof o.rng === 'function' ? o.rng : Math.random;
    var v = s.voice || {};
    var kind = o.kind || 'table';

    /* 模型答的是"正事"（步骤、事实、方案）：只许加一点署名味道，
     * 不改写、不截断——免得把关键信息剪掉。 */
    if (kind === 'model') {
      if (v.flower && !/🌹|🌸|🥀|🌺/.test(t)) t += rng() < 0.5 ? ' 🌹' : ' 🥀';
      return t;
    }

    if (v.harsh) {
      t = t.replace(/加油/g, '别磨蹭')
        .replace(/建议你/g, '你最好')
        .replace(/可以试试/g, '去做')
        .replace(/稍微/g, '立刻')
        .replace(/要不要/g, '去')
        .replace(/[呀啦哦哟]/g, '');
      t = cutTail(t);
      if (rng() < 0.5) t = t.replace(/[\s。！!]?$/, '') + pick(['少废话。', '别磨叽。', '就这。', '照做。'], rng);
      return t;
    }

    if (v.flower) {
      t = t.replace(/摸鱼/g, '偷闲');
      if (!/🌹|🌸|🥀|🌺/.test(t)) t += rng() < 0.45 ? ' 🌹' : ' 🥀';
      if (rng() < 0.32) t = pick(['亲爱的，', '来，赏你一句：', '我说句体面的：'], rng) + t;
      return t;
    }

    if (v.soft) {
      if (rng() < 0.45) t += pick(['…我没扎你。', '（悄悄把刺收了收）', '…你别嫌我说话直。'], rng);
      return t;
    }

    if (v.plain) {
      if (rng() < 0.4) t = '实在话：' + t;
      if (rng() < 0.28) t += '账我给你记着。';
      return t;
    }

    return t;
  }

  /* 第一次选定后的开场白（此时 identity.name 还是默认的「阿刺」） */
  function greeting(skinId, name) {
    var n = String(name || '阿刺');
    var map = {
      cactus: '行，仙人掌。刺是天生的，嘴是后天练的——以后我盯你。',
      rose: '玫瑰。好看是顺便的，扎人才是本职。以后你的摸鱼我都记在花瓣上，🌹',
      hedgehog: '刺猬。先说好，我扎人，但熟了会露肚皮——别指望太快。',
      chestnut: '板栗。壳硬，话直，不绕弯。你把计划列清楚，我替你数着。',
      porcupine: '豪猪。别套近乎，我话少。计划做完再来找我。',
    };
    return n + '：' + (map[skinId] || map.cactus);
  }

  /* ---------------- 改名 ----------------
   * evaluateRename(skinId, rawName, ctx) → { accept, chance, reply, hard }
   *   ctx: { current, mood, level, disappointed, renameCount, rng }
   * 拒绝不是随机刁难：名字越像"随口一叫"、阿刺心情越差、被改次数越多，
   * 通过率越低；用建议名单里的名字明显更容易过。
   */
  var MOOD_TONE = {
    happy: 0.24, smirk: 0.08, idle: 0, listen: 0.05, surprised: 0.05,
    sleep: -0.10, sad: -0.16, angry: -0.28, disappointed: -0.36, fight: -0.12,
  };

  var REFUSE_LINES = {
    cactus: [
      '「{n}」？我这身刺是长出来的，不是贴上去的。不换。',
      '不叫。名字跟刺一样，拔一次疼一次。',
      '「{n}」这名字太软，配不上我这身刺。驳回。',
    ],
    rose: [
      '「{n}」……不好听。花可以换盆，名字不能。',
      '亲爱的，「{n}」这名字配不上我的刺。再想想。',
      '「{n}」。俗。我这朵花不同意。',
    ],
    hedgehog: [
      '「{n}」…（缩成一团）我、我觉得现在这个挺好。',
      '…不要。「{n}」听着像别人家养的。',
      '（把刺立起来）不换。「{n}」我不熟。',
    ],
    chestnut: [
      '「{n}」不划算：我记性要重刷一遍，成本太高。算了。',
      '实在话：「{n}」没有比现在这个更好记。驳回。',
      '改名这事我算过账，收益为负。不换。',
    ],
    porcupine: [
      '不换。「{n}」听着就别扭。',
      '「{n}」？少来。叫惯了。',
      '不改。名字跟刺一样，长定了。',
    ],
  };

  var ACCEPT_LINES = {
    cactus: [
      '「{n}」……行吧，叫着顺口。先说好，改名不改刺。',
      '行，「{n}」。这名字我认了，别过两天又反悔。',
    ],
    rose: [
      '「{n}」，嗯，这个还算体面。🌹 以后就这么叫。',
      '行吧，「{n}」。名字好听了，我的嘴可不会变软。',
    ],
    hedgehog: [
      '「{n}」…（露出一点肚皮）好、好吧，就这个。',
      '「{n}」。…我叫应了，你别得寸进尺。',
    ],
    chestnut: [
      '「{n}」。行，这个实在。记下了。',
      '可以，「{n}」——比上一个强。',
    ],
    porcupine: [
      '「{n}」。行。以后别改。',
      '就这个。记住你自己起的。',
    ],
  };

  function evaluateRename(skinId, rawName, ctx) {
    var s = ensure(skinId);
    var c = ctx || {};
    var rng = typeof c.rng === 'function' ? c.rng : Math.random;
    var cur = String(c.current || '阿刺');
    var name = String(rawName == null ? '' : rawName).trim().replace(/\s+/g, ' ');

    function no(reply, hard) { return { accept: false, chance: 0, reply: reply, hard: !!hard }; }

    if (!name) return no('没名字叫什么？重新想。', true);
    if (name === cur) return no('这不还是「' + cur + '」吗，逗我玩。', true);
    if (name.length > 8) return no('太长了，我叫不顺口。八个字以内。', true);
    if (!/^[\u4e00-\u9fa5A-Za-z0-9_·]{1,8}$/.test(name)) return no('这名字我带刺的手打不出来，换正常的字。', true);
    if (BAD_WORDS.test(name)) return no('这名字不行。骂我可以，别写我头上。', true);
    /* 改回默认名：无条件通过，算"认祖归宗" */
    if (name === '阿刺') {
      return { accept: true, chance: 1, reply: '行，叫回「阿刺」。本来也是这名字，绕一圈。', hard: false };
    }

    var chance = 0.55;
    var mood = String(c.mood || 'idle');
    chance += MOOD_TONE[mood] || 0;
    if (c.disappointed) chance -= 0.20;
    chance += Math.min(0.20, (Number(c.level) || 1) / 500);
    chance -= 0.18 * Math.min(3, Number(c.renameCount) || 0);
    if (s.names.indexOf(name) >= 0) chance += 0.18;          // 建议名：阿刺自己也想过
    if (new RegExp(s.name).test(name) || /刺|花|刺猬|栗|豪/.test(name)) chance += 0.06;
    chance = clamp(chance, 0.05, 0.95);

    var accept = rng() < chance;
    var line = accept ? pick(ACCEPT_LINES[s.id], rng) : pick(REFUSE_LINES[s.id], rng);
    return {
      accept: accept,
      chance: chance,
      hard: false,
      reply: line.replace(/\{n\}/g, name),
    };
  }

  /* ---------------- 换皮肤：一律拒绝 ----------------
   * 产品口径：选了就定。想重来只能走 reset（删记录 + 清零）。
   */
  function requestSkinChange(skinId, ctx) {
    var s = ensure(skinId);
    var c = ctx || {};
    var rng = typeof c.rng === 'function' ? c.rng : Math.random;
    var lines = {
      cactus: [
        '合同签了就别想反悔。刺长在身上，拔了也是这个形状。',
        '合同签了就别想反悔——你要真想换，只能把我这盆连土一起倒了，从头种。',
      ],
      rose: [
        '合同签了就别想反悔。花谢了也是这盆花，换个盆还是我。',
        '亲爱的，合同签了就别想反悔。🌹 想要别的花，代价你付不起。',
      ],
      hedgehog: [
        '签都签了…（缩成一团）反悔我会扎人的。',
        '合同签了就别想反悔。…我好不容易才认你。',
      ],
      chestnut: [
        '合同签了就别想反悔。壳换不了，里面还是我。',
        '实在话：合同签了就别想反悔。重来的成本，你算过吗。',
      ],
      porcupine: [
        '合同签了就别想反悔。选都选了，认。',
        '不换。合同签了就别想反悔。',
      ],
    };
    return {
      ok: false,
      refused: true,
      reply: pick(lines[s.id] || lines.cactus, rng),
      hint: '真要重来，只有「重置」一条路：聊天记录全清、养成数据清零、从 1 级重新开始。',
    };
  }

  /* 重置的代价说明（UI 弹窗直接显示，别让用户点完才后悔） */
  function resetCost() {
    return {
      title: '和阿刺两清，重新开始',
      items: [
        '清空全部聊天记录与上下文（他不会记得你说过什么）',
        '等级 / 经验 / 协作能量 / 挑战券 / PK 战绩 全部清零，回到 1 级',
        '皮肤重新选一次，名字回到「阿刺」',
      ],
      keep: '你的计划、打卡记录、积分、军团与好友数据一分不动。',
      confirmWord: '重新开始',
    };
  }

  function resetLine(skinId, rng) {
    var s = ensure(skinId);
    var lines = {
      cactus: ['……行。土倒了，刺也拔了。下回见面，咱俩谁都不认识谁。'],
      rose: ['花剪了，盆也空了。下次……希望你还愿意种我。'],
      hedgehog: ['（慢慢把刺收起来）那我走了。…别送了。'],
      chestnut: ['账清了。壳我带走，地给你留着。'],
      porcupine: ['走了。别再选我。'],
    };
    return pick(lines[s.id] || lines.cactus, rng);
  }

  function suggestNames(skinId) {
    var s = ensure(skinId);
    return s.names.slice(0, 3);
  }

  function voiceHint(skinId) { return VOICE_HINT[ensure(skinId).id] || VOICE_HINT.cactus; }

  return {
    SKINS: SKINS,
    get: get,
    ensure: ensure,
    themeVars: themeVars,
    decorate: decorate,
    greeting: greeting,
    evaluateRename: evaluateRename,
    requestSkinChange: requestSkinChange,
    resetCost: resetCost,
    resetLine: resetLine,
    suggestNames: suggestNames,
    voiceHint: voiceHint,
    BAD_WORDS: BAD_WORDS,
  };
});
