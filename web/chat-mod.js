/* PlanQuest · 军团频道秩序（刷屏 / 骂人 / 引战）
 *
 * 原则：先提醒、再降速、最后禁言；禁言是「房间级」的，不写进信誉分账本，
 * 但连续被禁言会通过 creditEvent('report_ok') 那条链路反向扣分（由房主确认）。
 *
 * 判定的都是「可观测行为」，不猜动机：
 *   刷屏   —— 10 秒内 >5 条，或同一句 30 秒内出现 3 次
 *   骂人   —— 命中脏词表（按字面匹配，含常见变体分隔）
 *   引战   —— 连续 @ 多人 + 反问句 + 情绪词
 *   喊话   —— 大写/感叹号占比过高
 *
 * 冷处理（单人小黑屋）留给「职业杠精」：不禁言、不回复，
 * 他的消息只有他自己看得见 —— 没有反馈，抬杠就没有收益。
 */
'use strict';

(function (root) {
  const WIN_MS = 10e3;
  const DUP_WIN = 30e3;

  /* 脏词只做「字面 + 常见分隔」匹配，避免误伤正常词（例如「沙」单独不算） */
  const BAD = ['傻逼', '煞笔', '沙比', 'sb', '智障', '脑残', '废物', '垃圾人', '滚蛋', '去死', '你妈', 'cnm', 'nmsl', '操你'];

  const norm = (s) =>
    String(s || '')
      .toLowerCase()
      .replace(/[\s\-_.*~·、,，。.!！?？]+/g, '');

  function hitBad(text) {
    const t = norm(text);
    return BAD.some((w) => t.includes(w));
  }

  function shouty(text) {
    const t = String(text || '');
    if (t.length < 12) return false;
    const letters = t.replace(/[^A-Za-z\u4e00-\u9fa5]/g, '');
    if (!letters.length) return false;
    const caps = (t.match(/[A-Z]/g) || []).length;
    const bang = (t.match(/[!！]/g) || []).length;
    return caps / letters.length > 0.7 || bang >= 5;
  }

  function atCount(text) {
    return (String(text || '').match(/@[^\s@]{1,16}/g) || []).length;
  }

  /* 返回 { level: 'ok' | 'warn' | 'mute', minutes, reason } */
  function scan(text, recent, opts) {
    const list = Array.isArray(recent) ? recent : [];
    const now = (opts && opts.now) || Date.now();
    const mine = list.filter((m) => m && now - (Number(m.at) || 0) < WIN_MS);
    const body = String(text || '').trim();
    if (!body) return { level: 'ok', minutes: 0, reason: '' };

    if (hitBad(body)) return { level: 'mute', minutes: 5, reason: '辱骂他人' };

    if (mine.length >= 5) return { level: 'mute', minutes: 3, reason: '刷屏（10 秒内超过 5 条）' };

    const same = list.filter((m) => m && now - (Number(m.at) || 0) < DUP_WIN && norm(m.text) === norm(body));
    if (same.length >= 2) return { level: 'mute', minutes: 3, reason: '重复刷同一句' };

    if (atCount(body) >= 4) return { level: 'warn', minutes: 0, reason: '一次 @ 太多人，容易被当成引战' };
    if (shouty(body)) return { level: 'warn', minutes: 0, reason: '感叹号/大写太多，像在喊话' };

    return { level: 'ok', minutes: 0, reason: '' };
  }

  /* ---- 本机记账：禁言与小黑屋 ---- */
  const KEY = 'pq-chat-mod-v1';

  function load() {
    try {
      return JSON.parse(localStorage.getItem(KEY) || '{}') || {};
    } catch (_) {
      return {};
    }
  }
  function save(o) {
    try {
      localStorage.setItem(KEY, JSON.stringify(o));
    } catch (_) {}
  }

  function muteLeft(mid, now) {
    const o = load();
    const m = (o.mutes || {})[mid];
    if (!m) return 0;
    return Math.max(0, (Number(m.until) || 0) - (now || Date.now()));
  }

  function mute(mid, minutes, reason) {
    const o = load();
    o.mutes = o.mutes || {};
    const prev = o.mutes[mid] || { count: 0 };
    o.mutes[mid] = {
      until: Date.now() + minutes * 60e3,
      count: (Number(prev.count) || 0) + 1,
      reason: String(reason || '').slice(0, 40),
    };
    /* 同一个人被禁言 3 次以上 → 进「小黑屋」：消息只有他自己看得见 */
    if (o.mutes[mid].count >= 3) o.blackbox = { ...(o.blackbox || {}), [mid]: Date.now() };
    save(o);
    return o.mutes[mid];
  }

  function isBlackboxed(mid) {
    const o = load();
    return !!(o.blackbox && o.blackbox[mid]);
  }

  function clearMute(mid) {
    const o = load();
    if (o.mutes) delete o.mutes[mid];
    if (o.blackbox) delete o.blackbox[mid];
    save(o);
  }

  /* 信誉分低于阈值 → 失去军团发言权（不是禁言，是「资格」） */
  const SPEAK_FLOOR = 60;
  function canSpeak(credit, isNewbieDay1) {
    if (isNewbieDay1) return { ok: true, reason: '' };
    const c = Number(credit);
    if (!Number.isFinite(c)) return { ok: true, reason: '' };
    if (c < SPEAK_FLOOR) return { ok: false, reason: `信誉分 ${c} 低于 ${SPEAK_FLOOR}，暂时不能发言。打卡与助人可以把分挣回来。` };
    return { ok: true, reason: '' };
  }

  root.ChatMod = { scan, mute, muteLeft, isBlackboxed, clearMute, canSpeak, SPEAK_FLOOR, hitBad, shouty, atCount };
  if (typeof module === 'object' && module.exports) module.exports = root.ChatMod;
})(typeof window !== 'undefined' ? window : globalThis);
