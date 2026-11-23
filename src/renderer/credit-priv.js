/* PlanQuest · 信誉等级与特权（L1 基础 / L2 社交 / L3 荣耀）
 *
 * 一条铁律：这个文件里只写「软件真的会拦、真的会给」的东西。
 *   · live:true  → 已经有代码在用它做判断（借分额度、建团门槛、选举候选、团内星标）
 *   · live:false → 还没做，界面标「规划中」，不冒充已生效
 *
 * 等级只是「分数区间」的别名，不是新造一套分：
 *   <80  受限（没有等级）
 *   ≥80  L1 基础：能借分、能翻案，额度按分给
 *   ≥100 L2 社交：能自己开军团、能被选去裁定争议
 *   ≥120 L3 荣耀：团里挂星标，称号「守约者」
 *
 * 为什么不在海报上露出等级/分数/排名：那三样是「我多牛」，海报要写「我做了什么」。
 * 见 share.js 的 FORBIDDEN —— 那三项在海报绘制代码里根本不存在。
 */
'use strict';

(function (root) {
  /* ---------------- 等级 ---------------- */
  const LEVELS = [
    { key: 'L1', idx: 1, name: '基础', title: '信用可用', min: 80, desc: '借分、翻案都走得通，额度按分数给' },
    { key: 'L2', idx: 2, name: '社交', title: '可托付', min: 100, desc: '可以自己开军团，也能被推去做纪律官/仲裁员' },
    { key: 'L3', idx: 3, name: '荣耀', title: '守约者', min: 120, desc: '军团名册挂星标，新功能先给你开' },
  ];

  /* 借分额度：按等级给，不再是写死的 50。
     额度只是「一次最多能借多少」，不代表鼓励借——借了要还，逾期照样扣分。 */
  const LOAN_LIMIT = { 0: 30, 1: 50, 2: 80, 3: 120 };

  function clampScore(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return 0;
    return Math.max(-30, Math.min(160, Math.round(n)));
  }

  /* 0 = 受限（没有等级）；1/2/3 对应 L1/L2/L3 */
  function tierIndex(score) {
    const s = clampScore(score);
    let i = 0;
    LEVELS.forEach((l, k) => {
      if (s >= l.min) i = k + 1;
    });
    return i;
  }

  function levelOf(score) {
    const i = tierIndex(score);
    if (!i) return { idx: 0, key: '', name: '受限', title: '失信期', min: 0, desc: '先把打卡续上，分数自己会回来', next: LEVELS[0], nextIn: Math.max(0, LEVELS[0].min - clampScore(score)) };
    const cur = LEVELS[i - 1];
    const nx = LEVELS[i] || null;
    return {
      idx: i,
      key: cur.key,
      name: cur.name,
      title: cur.title,
      min: cur.min,
      desc: cur.desc,
      next: nx,
      nextIn: nx ? Math.max(0, nx.min - clampScore(score)) : 0,
    };
  }

  /* 分数是否够某个等级（'L2' 表示「至少 L2」） */
  function atLeast(score, key) {
    const need = LEVELS.find((l) => l.key === key);
    if (!need) return true;
    return clampScore(score) >= need.min;
  }

  function loanLimit(score) {
    return LOAN_LIMIT[tierIndex(score)] || LOAN_LIMIT[0];
  }

  /* ---------------- 特权清单 ----------------
   * lv     ：从哪一档开始有
   * live   ：是否真的生效（false = 规划中，界面不许写成已解锁）
   * where  ：生效在哪段代码/哪个按钮，用户能自己验证
   */
  const PRIVS = [
    { id: 'flip', lv: 'L1', name: '翻案权重', good: '分越高，翻案越容易被直接采信，不用等别人交叉验证', where: '闲聊判定 · 翻案', live: true },
    { id: 'quota', lv: 'L1', name: '每日翻案次数', good: '受限档 2 次 / 普通 5 次 / 良好 10 次 / 可信 20 次', where: '翻案风控', live: true },
    { id: 'loan', lv: 'L1', name: '借分额度', good: '受限 30 / 普通 50 / 良好 80 / 可信 120 分', where: '借分按钮', live: true },
    { id: 'legion', lv: 'L2', name: '自建军团', good: '可以自己当团长开一个军团', where: '创建军团', live: true },
    { id: 'arbiter', lv: 'L2', name: '争议裁定候选', good: '能被推选为纪律官 / 仲裁员，参与裁定争议', where: '团内选举', live: true },
    { id: 'badge', lv: 'L3', name: '守约者星标', good: '军团名册里挂 ✦ 星标 + 「守约者」称号', where: '军团名册', live: true },
    { id: 'match', lv: 'L2', name: '自习房优先匹配', good: '同样条件下优先跟你分到一间房', where: '自习房匹配', live: false },
    { id: 'beta', lv: 'L3', name: '抢先体验', good: '新功能先给你开一周', where: '灰度开关', live: false },
  ];

  function privs(score) {
    const idx = tierIndex(score);
    const need = (lv) => LEVELS.find((l) => l.key === lv).idx;
    return PRIVS.map((p) => ({
      ...p,
      unlocked: idx >= need(p.lv),
      coming: !p.live,
    }));
  }

  /* ---------------- 军团内排名 ----------------
   * 只回答「我第几」，不回答「别人多少分」。
   * 传入 roster：[{ uid, alias, credit }]；credit 未知的成员不参与排序（不猜）。
   */
  function rank(roster, uid) {
    /* credit 为 null / '' 的成员直接不算 —— Number(null) 是 0，
       不显式排除的话「没同步到等级」的人会被当成 0 分排在最后，等于替他编了个分。 */
    const list = (Array.isArray(roster) ? roster : []).filter(
      (m) => m && m.credit != null && m.credit !== '' && Number.isFinite(Number(m.credit)) && String(m.uid || '')
    );
    if (!list.length) return null;
    const sorted = list.slice().sort((a, b) => {
      const d = Number(b.credit) - Number(a.credit);
      if (d) return d;
      return String(a.alias || '').localeCompare(String(b.alias || ''));
    });
    const i = sorted.findIndex((m) => String(m.uid) === String(uid));
    if (i < 0) return null;
    const total = sorted.length;
    const pos = i + 1;
    const known = sorted.filter((m) => Number.isFinite(Number(m.credit))).length;
    return {
      pos,
      total,
      known,
      /* 高于团里百分之多少的人：自己在最后一名时为 0，第一名时为 100 */
      abovePct: total > 1 ? Math.round(((total - pos) / (total - 1)) * 100) : 100,
      level: levelOf(sorted[i].credit),
    };
  }

  /* 称号：团内名册与成就页共用一套文案 */
  function title(score) {
    return levelOf(score).title;
  }

  /* 海报禁放项：不是「不显示」，是绘制代码里根本不取这几项数据。
     留在这里是给测试和后来人看的清单。 */
  const POSTER_FORBIDDEN = ['信誉等级', '信誉分', '排名', '击败', '贷款额度', '可借'];

  const API = { LEVELS, LOAN_LIMIT, PRIVS, POSTER_FORBIDDEN, clampScore, tierIndex, levelOf, atLeast, loanLimit, privs, rank, title };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  root.PQCreditPriv = API;
})(typeof window !== 'undefined' ? window : globalThis);
