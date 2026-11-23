'use strict';
/* 翻案风控（FlipGuard v1）
   —— 一条消息 / 一帧画面被 AI 判错，用户的「翻案」不能一键就进训练集。

   规则（与《全面介绍》3.16 一致）：
   1) 摩擦：徽章要双击 / 长按 600ms 才触发；必须选理由；确认后也不一定立即改判。
   2) 限额：按「信用分」（与积分借贷同一套信用体系，不是积分）分四档，
      每日翻案上限 2 / 5 / 10 / 20 次，超限锁到次日；全局 15 秒冷却；同一条消息 24h 只翻一次。
   3) 权重：0.2 / 0.5 / 0.8 / 1.0。只有「良好」及以上、且行为一致的翻案直接采纳（direct），
      其余进候选池（pending），不进训练集、不上传云端。
   4) 反投毒：行为一致性降权（历史 80% 是闲聊还标「正经事」→ 权重 ×0.3 且强制候选）；
      本地先过滤明显垃圾 / 广告 / 乱码；候选池需「30 分钟冷静期二次确认」或
      「另一条相似内容的同向翻案佐证」才转正。
   5) 隐式反馈：翻案后 10 分钟内同一人又连续被判 3 条高置信闲聊 → 自动回滚该翻案并扣信用分。
   6) 训练集隔离：候选 / 拦截 / 回滚三类样本不进训练、不上传；审计日志可单条回滚、可整体清空（去毒）。
   7) 新手期：首次使用起 7 天内翻的案，只在本机改判，样本记为「观察」（probation），
      不参与训练、不上传云端 —— 前一周连软件都没摸熟，错标一条比漏标十条更伤模型。
*/
window.FlipGuard = (function () {
  const KEY = 'pq-flip-guard-v1';
  const DAY = 86400000;
  const COOLDOWN_MS = 15 * 1000;        // 两次翻案之间的最小间隔
  const SAME_TEXT_MS = 24 * 3600 * 1000; // 同一条消息 24 小时内只允许翻一次
  const COOL_MS = 30 * 60 * 1000;        // 候选池冷静期
  const EVIDENCE_WINDOW = 10 * 60 * 1000; // 隐式反馈观察窗
  const EVIDENCE_HITS = 3;               // 窗口内再被判闲聊几次 → 自动回滚
  const PENALTY = 5;                     // 每次回滚扣多少信用分
  const PENALTY_DAILY_LOCK = 3;          // 一天被回滚几次 → 翻案锁到次日
  const ROOKIE_DAYS = 7;                  // 新手期：首次使用起 7 天内

  /* 信用分四档：与积分借贷共用 data.credit.score（默认 100） */
  const TIERS = [
    { key: 'trust', name: '可信', min: 120, quota: 20, weight: 1.0, direct: true },
    { key: 'good', name: '良好', min: 100, quota: 10, weight: 0.8, direct: true },
    { key: 'normal', name: '普通', min: 80, quota: 5, weight: 0.5, direct: false },
    { key: 'limit', name: '受限', min: 0, quota: 2, weight: 0.2, direct: false },
  ];

  const REASONS = ['AI 误判', '上下文误解', '漏看关键信息', '确实是玩笑/反讽'];

  let st = { v: 1, firstAt: 0, flips: [], day: { date: '', n: 0 }, lockUntil: 0, pen: { date: '', n: 0 } };
  let ctx = { score: 100, blockUntil: 0, fishRatio: 0 }; // 由主界面每次翻案前注入
  let lastAt = 0;

  function today() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  function uid() {
    return 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  }
  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const d = JSON.parse(raw);
        if (d && typeof d === 'object') {
          st.flips = Array.isArray(d.flips) ? d.flips.filter((x) => x && x.id) : [];
          st.day = d.day && d.day.date ? d.day : { date: '', n: 0 };
          st.lockUntil = Number(d.lockUntil) || 0;
          st.pen = d.pen && d.pen.date ? d.pen : { date: '', n: 0 };
          st.firstAt = Number(d.firstAt) || 0;
        }
      }
    } catch (_) {}
    rollDay();
  }
  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(st));
    } catch (_) {}
  }
  function rollDay() {
    const t = today();
    if (st.day.date !== t) st.day = { date: t, n: 0 };
    if (st.pen.date !== t) st.pen = { date: t, n: 0 };
    if (!st.firstAt) {
      st.firstAt = Date.now();
      save();
    }
  }

  /* ---------------- 新手期 ---------------- */
  function daysSinceFirst() {
    return (Date.now() - (st.firstAt || Date.now())) / DAY;
  }
  /* 新手期还剩几天（不足一天按一天算；0 = 已过新手期）
     不清缓存就一直在，换设备会重新算 —— 宁可多观察几天，也不放过小号刷样本。 */
  function rookieLeft() {
    const d = daysSinceFirst();
    if (d >= ROOKIE_DAYS) return 0;
    return Math.max(1, Math.ceil(ROOKIE_DAYS - d));
  }
  function isRookie() {
    return rookieLeft() > 0;
  }

  /* ---------------- 信用分 → 等级 ---------------- */
  function tierOf(score) {
    const s = Number(score);
    for (const t of TIERS) if (s >= t.min) return t;
    return TIERS[TIERS.length - 1];
  }
  function tier() {
    /* 翻案权 = f(信用分, 历史准确率, 使用时长)：
       信用分定基准档；准确率 < 50%（满 5 次翻案后才有意义）降一档；
       新号（首日）最高只能「普通」，三天内最高「良好」—— 别让小号搞崩模型。 */
    let idx = TIERS.indexOf(tierOf(ctx.score));
    const okN = st.flips.filter((f) => f.status === 'confirmed' || f.status === 'direct').length;
    const badN = st.flips.filter((f) => f.status === 'rollback').length;
    const acc = okN + badN >= 5 ? okN / (okN + badN) : null;
    if (acc != null && acc < 0.5) idx = Math.min(TIERS.length - 1, idx + 1);
    const days = daysSinceFirst();
    if (days < 1) idx = Math.max(idx, 2);
    else if (days < 3) idx = Math.max(idx, 1);
    return TIERS[idx];
  }
  function setContext(o) {
    if (!o) return;
    if (typeof o.score === 'number') ctx.score = o.score;
    if (typeof o.blockUntil === 'number') ctx.blockUntil = o.blockUntil;
    if (typeof o.fishRatio === 'number') ctx.fishRatio = Math.max(0, Math.min(1, o.fishRatio));
  }

  /* ---------------- 本地轻量过滤（明显垃圾不进服务器/训练集） ---------------- */
  function looksGarbage(text) {
    const s = String(text || '').trim();
    if (!s) return '空内容';
    if (s.length < 2) return '内容太短';
    if (!/[\u4e00-\u9fa5A-Za-z0-9]/.test(s)) return '纯表情/符号';
    if (/(加微信|加 ?v|vx|wx[:：]|扣扣|qq ?群|代刷|返利|优惠券|点击链接|扫码|兼职|日赚|http|www\.)/i.test(s)) return '疑似广告';
    if (s.length >= 8) {
      const uniq = new Set(s.replace(/\s/g, '')).size;
      if (uniq / s.length < 0.3) return '疑似刷屏乱码';
    }
    return '';
  }

  /* 文字相似度（中文按相邻两字切词，够用且不引依赖） */
  function grams(text) {
    const s = String(text || '').replace(/[\s\p{P}]/gu, '').slice(0, 120);
    const out = new Set();
    for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
    return out;
  }
  function similar(a, b) {
    const A = grams(a);
    const B = grams(b);
    if (!A.size || !B.size) return false;
    let hit = 0;
    for (const g of A) if (B.has(g)) hit++;
    return hit >= 2 && hit / Math.min(A.size, B.size) >= 0.25;
  }

  /* ---------------- 名额与冷却 ---------------- */
  function status() {
    rollDay();
    const t = tier();
    const used = st.day.n;
    const pending = st.flips.filter((f) => f.status === 'pending').length;
    return {
      score: Math.round(Number(ctx.score) || 0),
      tier: t.name,
      tierKey: t.key,
      quota: t.quota,
      used,
      left: Math.max(0, t.quota - used),
      weight: t.weight,
      direct: t.direct,
      lockUntil: st.lockUntil,
      locked: Date.now() < st.lockUntil,
      pending,
      confirmed: st.flips.filter((f) => f.status === 'confirmed' || f.status === 'direct').length,
      rolledback: st.flips.filter((f) => f.status === 'rollback').length,
      probation: st.flips.filter((f) => f.status === 'probation').length,
      days: Math.floor(daysSinceFirst()),
      rookie: isRookie(),
      rookieLeft: rookieLeft(),
      rookieDays: ROOKIE_DAYS,
      penaltiesToday: st.pen.n,
      reasons: REASONS.slice(),
    };
  }

  /* ---------------- 翻案请求 ---------------- */
  /* opts: { kind:'text'|'image', text?, from:0|1, to:0|1, reason:string } */
  function request(opts) {
    rollDay();
    const o = opts || {};
    const now = Date.now();
    if (now < st.lockUntil) {
      return { ok: false, code: 'locked', message: `翻案已锁定，${new Date(st.lockUntil).toLocaleString('zh-CN')} 后恢复` };
    }
    if (now < (ctx.blockUntil || 0)) {
      return { ok: false, code: 'credit', message: '信用失信期内不能翻案，先把打卡续上' };
    }
    if (!o.reason || REASONS.indexOf(o.reason) < 0) {
      return { ok: false, code: 'reason', message: '必须选择一个翻案理由' };
    }
    if (now - lastAt < COOLDOWN_MS) {
      const s = Math.ceil((COOLDOWN_MS - (now - lastAt)) / 1000);
      return { ok: false, code: 'cooldown', message: `手别太快，${s} 秒后再试` };
    }
    /* 明显垃圾：直接拦，不消耗名额、不进候选池 */
    if (o.kind === 'text') {
      const bad = looksGarbage(o.text);
      if (bad) return { ok: false, code: 'blocked', message: `${bad} —— 这类内容不进入训练集` };
    }
    /* 同一条「消息」24h 只翻一次；画面帧没有稳定文本，靠下面的冷却与名额限制 */
    const same = (o.kind || 'text') === 'text'
      ? st.flips.find(
          (f) => f.kind === 'text' && f.text === String(o.text || '') && now - f.at < SAME_TEXT_MS && f.status !== 'rollback'
        )
      : null;
    if (same) return { ok: false, code: 'dupe', message: '这条 24 小时内已经翻过一次了' };
    const t = tier();
    if (st.day.n >= t.quota) {
      st.lockUntil = Math.min(st.lockUntil || Infinity, new Date(new Date(today() + 'T00:00:00').getTime() + DAY).getTime());
      save();
      return { ok: false, code: 'quota', message: `今日翻案名额已用完（${t.quota} / ${t.quota}），明天再来` };
    }

    /* 行为一致性：翻成「正经事」但历史 80% 是闲聊（或反过来）→ 降权 + 只能进候选池 */
    const to = Number(o.to) ? 1 : 0;
    const ratio = Number(ctx.fishRatio) || 0;
    const inconsistent = (to === 0 && ratio >= 0.8) || (to === 1 && ratio <= 0.2);
    const weight = Number((t.weight * (inconsistent ? 0.3 : 1)).toFixed(2));
    const direct = !inconsistent && t.direct;
    /* 新手期（首次使用起 7 天）：改判的规则不变，只是这条样本不进训练池。
       直接采纳 → 观察集 probation（当场改判，不参与训练、不上传）；
       需要复核 → 仍是候选池，复核通过后同样落到 probation。 */
    const rookie = isRookie();
    const status = direct ? (rookie ? 'probation' : 'direct') : 'pending';

    const f = {
      id: uid(),
      at: now,
      kind: o.kind || 'text',
      text: String(o.text || '').slice(0, 300),
      from: Number(o.from) ? 1 : 0,
      to,
      reason: o.reason,
      tier: t.name,
      weight,
      status,
      rookie,
      inconsistent: !!inconsistent,
      sampleId: null,
      votes: [],
    };
    st.flips.unshift(f);
    st.day.n += 1;
    lastAt = now;
    save();
    return {
      ok: true,
      flip: f,
      status,
      weight,
      direct,
      rookie,
      rookieLeft: rookie ? rookieLeft() : 0,
      inconsistent,
      message: direct
        ? rookie
          ? `已改判（仅本机生效）· 新手第 ${ROOKIE_DAYS - rookieLeft() + 1} 天，这条不进训练池`
          : '已采纳（信誉良好 · 直接进训练集）'
        : inconsistent
          ? '先放候选池：和你以往的表现对不上，需要复核'
          : '先放候选池：冷静 30 分钟后二次确认，或由另一条相似翻案佐证',
    };
  }

  function attachSample(flipId, sampleId) {
    const f = st.flips.find((x) => x.id === flipId);
    if (!f) return;
    f.sampleId = sampleId || null;
    save();
  }

  /* ---------------- 候选池：确认 / 驳回 ---------------- */
  function corroboration(f) {
    /* 另一条相似内容、同向、且未被回滚的翻案算 1 票佐证 */
    return st.flips.filter(
      (x) => x.id !== f.id && x.to === f.to && x.kind === f.kind && x.status !== 'rollback' && x.status !== 'blocked' && similar(x.text, f.text)
    ).length;
  }

  /* 房间公投：其他成员对这条翻案的「认可 / 不认可」（取多数） */
  function peerVotes(f) {
    const vs = (f.votes || []).filter((v) => typeof v.agree === 'boolean');
    return { yes: vs.filter((v) => v.agree).length, no: vs.filter((v) => !v.agree).length };
  }

  function addPeerVote(id, voter, agree) {
    const f = st.flips.find((x) => x.id === id);
    if (!f) return { ok: false, message: '本机没有这条翻案' };
    const who = String(voter || 'anon').slice(0, 40);
    f.votes = f.votes || [];
    if (f.votes.some((v) => v.by === 'peer:' + who)) return { ok: false, message: '同一个人只能投一次' };
    f.votes.push({ at: Date.now(), by: 'peer:' + who, agree: !!agree });
    const pv = peerVotes(f);
    /* 两人以上不认可且多于认可 → 直接作废（取多数） */
    if (pv.no >= 2 && pv.no > pv.yes) {
      f.status = 'rollback';
      f.auto = true;
    }
    save();
    return { ok: true, yes: pv.yes, no: pv.no, status: f.status };
  }

  function pendingList() {
    return st.flips
      .filter((f) => f.status === 'pending')
      .sort((a, b) => b.at - a.at)
      .map((f) => {
        const peer = corroboration(f);
        const pv = peerVotes(f);
        const cooled = Date.now() - f.at >= COOL_MS;
        return {
          id: f.id,
          at: f.at,
          kind: f.kind,
          text: f.text,
          from: f.from,
          to: f.to,
          reason: f.reason,
          weight: f.weight,
          rookie: !!f.rookie,
          sampleId: f.sampleId,
          peer,
          votes: pv,
          cooled,
          waitMin: cooled ? 0 : Math.ceil((COOL_MS - (Date.now() - f.at)) / 60000),
          canConfirm: (pv.yes >= 1 && pv.yes > pv.no) || peer >= 1 || cooled,
        };
      });
  }

  function confirm(id) {
    const f = st.flips.find((x) => x.id === id);
    if (!f) return { ok: false, message: '找不到这条翻案' };
    if (f.status === 'confirmed' || f.status === 'direct') return { ok: false, message: '已经确认过了' };
    const peer = corroboration(f);
    const pv = peerVotes(f);
    const cooled = Date.now() - f.at >= COOL_MS;
    let via = '';
    if (pv.yes >= 1 && pv.yes > pv.no) via = 'room';
    else if (peer >= 1) via = 'peer';
    else if (cooled) via = 'cool';
    if (!via) {
      const wait = Math.ceil((COOL_MS - (Date.now() - f.at)) / 60000);
      return { ok: false, message: `还需 ${wait} 分钟冷静期，或房间其他同学认可，或一条相似内容的同向翻案作佐证` };
    }
    /* 新手期的候选翻案复核通过后也只进观察集（probation），不因为「确认过」就混进训练池。
       只看提交时的标记：第 6 天提交、第 8 天确认，仍然算新手期翻的。 */
    f.status = f.rookie ? 'probation' : 'confirmed';
    f.votes.push({ at: Date.now(), by: via === 'room' ? 'room-vote' : via === 'peer' ? 'peer' : 'self-review' });
    save();
    return { ok: true, sampleId: f.sampleId, via, status: f.status, rookie: !!f.rookie };
  }

  function reject(id) {
    const f = st.flips.find((x) => x.id === id);
    if (!f) return { ok: false, message: '找不到这条翻案' };
    f.status = 'rollback';
    f.votes.push({ at: Date.now(), by: 'reject' });
    save();
    return { ok: true, sampleId: f.sampleId };
  }

  /* ---------------- 隐式反馈：翻案后行为打脸 → 自动回滚 ---------------- */
  let fishHits = [];
  function onFishEvidence() {
    const now = Date.now();
    fishHits = fishHits.filter((t) => now - t < EVIDENCE_WINDOW);
    fishHits.push(now);
    if (fishHits.length < EVIDENCE_HITS) return { rolled: 0 };
    fishHits = [];
    /* 观察集（probation）也算：新手期改判错了同样要撤回，只是它本来就没进训练池 */
    const recent = st.flips.filter(
      (f) =>
        now - f.at < EVIDENCE_WINDOW &&
        (f.status === 'direct' || f.status === 'confirmed' || f.status === 'pending' || f.status === 'probation') &&
        f.to === 0
    );
    if (!recent.length) return { rolled: 0 };
    for (const f of recent) {
      f.status = 'rollback';
      f.auto = true;
      f.votes.push({ at: now, by: 'implicit' });
    }
    st.pen.n += 1;
    if (st.pen.n >= PENALTY_DAILY_LOCK) {
      st.lockUntil = new Date(new Date(today() + 'T00:00:00').getTime() + DAY).getTime();
    }
    save();
    return { rolled: recent.length, sampleIds: recent.map((f) => f.sampleId).filter(Boolean), penalty: PENALTY, locked: Date.now() < st.lockUntil };
  }

  /* ---------------- 审计 / 去毒 ---------------- */
  function audit(n) {
    return st.flips.slice(0, n || 20).map((f) => ({
      id: f.id,
      at: f.at,
      kind: f.kind,
      text: String(f.text || '').slice(0, 40),
      from: f.from,
      to: f.to,
      reason: f.reason,
      tier: f.tier,
      weight: f.weight,
      status: f.status,
      rookie: !!f.rookie,
      auto: !!f.auto,
      sampleId: f.sampleId,
    }));
  }

  /* 把「被回滚」的翻案全部撤销（训练集去毒） */
  function purgeRolledBack() {
    const ids = st.flips.filter((f) => f.status === 'rollback').map((f) => f.id);
    st.flips = st.flips.filter((f) => f.status !== 'rollback');
    save();
    return { ok: true, removed: ids.length };
  }

  /* 清空本机全部翻案记录（含审计） */
  function resetAll() {
    /* 保留 firstAt：清记录不等于把自己变回新号（否则重置就能刷出新手保护漏洞/降档） */
    const first = st.firstAt || Date.now();
    st = { v: 1, firstAt: first, flips: [], day: { date: today(), n: 0 }, lockUntil: 0, pen: { date: today(), n: 0 } };
    fishHits = [];
    lastAt = 0;
    save();
    return { ok: true };
  }

  load();

  return {
    REASONS,
    ROOKIE_DAYS,
    setContext,
    status,
    request,
    attachSample,
    pendingList,
    addPeerVote,
    confirm,
    reject,
    onFishEvidence,
    audit,
    purgeRolledBack,
    resetAll,
    looksGarbage,
    daysSinceFirst,
    rookieLeft,
    isRookie,
  };
})();
