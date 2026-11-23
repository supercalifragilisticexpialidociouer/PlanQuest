/* PlanQuest · .pqplan 计划包安全四件套
 *
 * 二次确认 —— 收到计划包只弹「计划预览」窗口（项目数/契约/押金/积分规则），
 *             必须手动点「确认导入」才生效，防整蛊防恶意攻击。
 * 来源标记 —— 所有转发的计划包自动带发送者 uid/昵称/时间戳，出问题能追溯、能举报。
 * 沙箱运行 —— 导入他人的计划包先进 24h 沙箱：积分变动和契约执行全是虚拟的，
 *             不动主计划；没问题手动「转正」，有问题直接删，毫发无损。
 * 黑名单   —— 军团长可把频繁发恶意计划包的成员拉进计划文件黑名单，
 *             其计划包在接收端被自动拦截，连预览都看不到。
 */
'use strict';

(function (root) {
  const SANDBOX_MS = 24 * 3600e3; // 沙箱 24 小时
  const MAX_PREVIEW_ITEMS = 12; // 预览窗口最多列 12 个项目，其余折叠成「等 N 个」

  /* ---------------- 二次确认：预览摘要 ----------------
   * env 是 pqplan 信封（JSON.parse 后的对象）。这里只做只读摘要，绝不改数据。
   */
  function preview(env) {
    const d = env && env.data && typeof env.data === 'object' ? env.data : {};
    const plans = Array.isArray(d.plans) ? d.plans : [];
    const contracts = Array.isArray(d.contractProjects) ? d.contractProjects : [];
    const deposit = contracts.reduce((s, c) => s + Math.max(0, Number(c && c.stake) || 0), 0);
    const pointsRules = {
      reward: Math.max(0, Number(d.settings && d.settings.reward) || 0),
      penalty: Math.max(0, Number(d.settings && d.settings.penalty) || 0),
    };
    const items = plans.slice(0, MAX_PREVIEW_ITEMS).map((p) => ({
      title: String((p && (p.title || p.name)) || '未命名').slice(0, 30),
      kind: p && p.contract ? '契约' : '普通',
      remind: String((p && p.remindTime) || (p && p.time) || '').slice(0, 8),
    }));
    return {
      ok: plans.length > 0 || contracts.length > 0,
      plans: plans.length,
      contracts: contracts.length,
      deposit,
      pointsRules,
      items,
      hidden: Math.max(0, plans.length - items.length),
      /* 危险信号：押金高得离谱或者惩罚特别狠，预览里高亮提醒 */
      risk: deposit > 1000 || pointsRules.penalty > 50 ? 'high' : deposit > 300 || pointsRules.penalty > 20 ? 'mid' : '',
    };
  }

  /* ---------------- 来源标记 ---------------- */
  function markSource(env, uid, alias, at) {
    const t = Number(at) || Date.now();
    return {
      from: String(uid || '').slice(0, 40),
      fromAlias: String(alias || '').slice(0, 12),
      at: t,
    };
  }

  function sourceText(src) {
    const s = src || {};
    if (!s.from) return '';
    const d = new Date(Number(s.at) || 0);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `来自 ${s.fromAlias || s.from} · ${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
  }

  /* ---------------- 沙箱运行 ---------------- */
  function sandboxPut(text, src, now) {
    const t = Number(now) || Date.now();
    return {
      text: String(text || '').slice(0, 60000),
      src: src || null,
      at: t,
      expiresAt: t + SANDBOX_MS,
      promoted: false,
    };
  }

  function sandboxLeft(sb, now) {
    return Math.max(0, (Number((sb || {}).expiresAt) || 0) - (Number(now) || Date.now()));
  }

  function sandboxExpired(sb, now) {
    return sandboxLeft(sb, now) <= 0;
  }

  function sandboxPromote(sb, now) {
    const s = sb || {};
    if (s.promoted) return { ok: false, message: '已经转正过了' };
    if (sandboxExpired(s, now)) return { ok: false, message: '沙箱已过期（24 小时），请让对方重新发一次' };
    s.promoted = true;
    s.promotedAt = Number(now) || Date.now();
    return { ok: true };
  }

  function sandboxText(sb) {
    return String((sb || {}).text || '');
  }

  function leftText(ms) {
    const n = Number(ms) || 0;
    if (n <= 0) return '已过期';
    const h = Math.floor(n / 3600e3);
    const m = Math.ceil((n % 3600e3) / 60e3);
    return h > 0 ? `${h} 小时 ${m} 分` : `${m} 分钟`;
  }

  /* ---------------- 军团计划文件黑名单 ----------------
   * list: uid 数组，存在军团治理台账里（data.gov.planBan），跟着军团走。
   * 接收端先查黑名单再谈预览 —— 拦下来的连看都看不到。
   */
  function blocked(list, uid) {
    const arr = Array.isArray(list) ? list : [];
    const id = String(uid || '');
    return !!id && arr.includes(id);
  }

  function banToggle(list, uid, on) {
    const arr = (Array.isArray(list) ? list : []).map(String).filter(Boolean);
    const id = String(uid || '');
    if (!id) return { ok: false, list: arr };
    if (on === false) {
      return { ok: true, list: arr.filter((x) => x !== id) };
    }
    if (arr.includes(id)) return { ok: false, list: arr, message: '已经在黑名单里了' };
    if (arr.length >= 50) return { ok: false, list: arr, message: '黑名单最多 50 人' };
    arr.push(id);
    return { ok: true, list: arr };
  }

  /* 接收计划包的第一道闸：黑名单 → 来源缺失 → 沙箱进厂
   * 返回 { ok, sandbox, reason } —— ok=false 时调用方直接拒绝，弹都不弹。
   */
  function receive(text, src, planBan, fromUid, now) {
    const t = Number(now) || Date.now();
    if (blocked(planBan, fromUid)) {
      return { ok: false, reason: '对方已被军团长拉进计划文件黑名单，计划包已拦截' };
    }
    const body = String(text || '');
    if (body.length < 20 || body.length > 60000) return { ok: false, reason: '计划包内容不完整' };
    let env = null;
    try {
      env = JSON.parse(body);
    } catch (_) {
      return { ok: false, reason: '计划包格式不对' };
    }
    const p = preview(env);
    if (!p.ok) return { ok: false, reason: '计划包里没有任何计划' };
    const marked = src || markSource(env, fromUid || (env && env.from), '', t);
    return { ok: true, preview: p, src: marked, sandbox: sandboxPut(body, marked, t) };
  }

  const API = {
    SANDBOX_MS,
    MAX_PREVIEW_ITEMS,
    preview,
    markSource,
    sourceText,
    sandboxPut,
    sandboxLeft,
    sandboxExpired,
    sandboxPromote,
    sandboxText,
    leftText,
    blocked,
    banToggle,
    receive,
  };

  root.PQPlanGuard = API;
  if (typeof module === 'object' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
