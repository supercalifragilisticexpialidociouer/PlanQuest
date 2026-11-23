/* PlanQuest · 军团闲聊档位（L0 静默 / L1 轻聊 / L2 狂欢 / L3 荣光）
 *
 * 与 legion-chat.js 的分工：
 *   legion-chat 管「单条消息违不违规」（辱骂/刷屏/复读）；
 *   这里管「今天整个频道开到哪一档」—— 档位由任务完成情况决定，不由团长心情决定：
 *     L0 静默（默认）：个人 <50% 或军团集体任务没达基线 → 频道只读，
 *        只能发打卡截图 / 系统通知 / 求助@团长 / 非闲聊文本 / 软件内链接；AI 闲聊雷达全开。
 *     L1 轻聊：个人 ≥50% 解锁 → 纯文本 ≤50 字/条 + 软件内链接；雷达抽检，
 *        闲聊超 3 条/小时 → 回落 L0 直到次日重置。
 *     L2 狂欢：军团集体任务达成 → 全频道解锁到当日 24:00；
 *        个人贡献 <30% 的成员不跟随解锁（防搭便车），只回 L1。
 *     L3 荣光：个人连续 7 天全勤 且 军团本周集体任务全勤 → 纯荣誉层（头衔/置顶/徽章）。
 *
 * 内容权限矩阵全在这里（含 F1 搭子 / F2 战友两列，好友区共用一套判定）。
 */
'use strict';

(function (root) {
  const CHAT_PER_HOUR = 3; // L1 抽检：闲聊超 3 条/小时回落 L0
  const HOUR_MS = 3600e3;
  const L1_TEXT_MAX = 50; // L1 每条 ≤50 字
  const L2_IMAGES = 3; // L2 每条 ≤3 张图
  const L3_IMAGES = 5;
  const L2_EMOJI = 3;
  const L3_EMOJI = 5;
  const L2_FILE_MB = 10;
  const L3_FILE_MB = 20;

  /* ---------------- 档位计算 ----------------
   * ctx: {
   *   personalRate  0~100（今日个人完成率）
   *   collectiveMet 军团集体任务今天是否达基线
   *   contribution  0~1 我对集体任务的贡献占比（L2 防搭便车用）
   *   streak7       个人连续 7 天全勤
   *   weekFull      军团本周集体任务全勤
   * }
   */
  function computeTier(ctx) {
    const c = ctx || {};
    const rate = Number(c.personalRate);
    const met = c.collectiveMet === true;
    const ok = Number.isFinite(rate) && rate >= 50;
    if (ok && met && c.streak7 === true && c.weekFull === true) {
      return { key: 'L3', label: '荣光档', reason: '连续 7 天全勤 + 军团本周集体任务全勤' };
    }
    if (ok && met) {
      const contrib = Number(c.contribution);
      if (Number.isFinite(contrib) && contrib < 0.3) {
        return { key: 'L1', label: '轻聊档', reason: '集体任务达成，但你的贡献不足 30%，不跟随解锁狂欢' };
      }
      return { key: 'L2', label: '狂欢档', reason: '军团集体任务达成，今天随便造' };
    }
    if (ok) return { key: 'L1', label: '轻聊档', reason: '个人完成率 ≥50%，解锁轻聊' };
    return { key: 'L0', label: '静默档', reason: '先干活：个人完成率 <50% 或集体任务没达基线' };
  }

  /* ---------------- 内容权限矩阵 ----------------
   * 每档一行的策略，界面据此渲染「能发什么」，sendGate 据此拦截。
   * plan 一律带「需二次确认」；外部 URL 全档禁止；跨军团邀请全档需审批。
   */
  const POLICY = {
    L0: {
      key: 'L0', label: '静默档',
      chat: false, textMax: 200, images: 0, files: 0, plan: 'confirm', shot: true,
      extUrl: false, roomLink: true, tempRoom: true, crossLegion: 'approve', home: true,
      voice: true, emoji: 0, radar: 'full',
      note: '频道只读：打卡截图 / 系统通知 / 求助@团长 / 非闲聊文本 / 软件内链接',
    },
    L1: {
      key: 'L1', label: '轻聊档',
      chat: true, textMax: L1_TEXT_MAX, images: 0, files: 0, plan: 'confirm', shot: true,
      extUrl: false, roomLink: true, tempRoom: true, crossLegion: 'approve', home: true,
      voice: true, emoji: 0, radar: 'sample', chatPerHour: CHAT_PER_HOUR,
      note: '纯文本短句（≤50 字/条）+ 软件内链接，禁图禁表情包',
    },
    L2: {
      key: 'L2', label: '狂欢档',
      chat: true, textMax: 2000, images: L2_IMAGES, files: L2_FILE_MB, plan: 'confirm', shot: true,
      extUrl: false, roomLink: true, tempRoom: true, crossLegion: 'approve', home: true,
      voice: true, emoji: L2_EMOJI, radar: 'off',
      note: '全频道解锁：长文、图片、文件、语音房、表情包随便造',
    },
    L3: {
      key: 'L3', label: '荣光档',
      chat: true, textMax: 2000, images: L3_IMAGES, files: L3_FILE_MB, plan: 'confirm', shot: true,
      extUrl: false, roomLink: true, tempRoom: true, crossLegion: 'approve', home: true,
      voice: true, emoji: L3_EMOJI, radar: 'off', honor: true,
      note: '荣光档：在狂欢档之上加头衔、置顶庆功公告、专属徽章',
    },
    /* 好友区两列共用同一套矩阵 */
    F1: {
      key: 'F1', label: '搭子档',
      chat: true, textMax: 500, images: 0, files: 0, plan: false, shot: false,
      extUrl: false, roomLink: true, tempRoom: true, crossLegion: 'approve', home: true,
      voice: false, emoji: 0, radar: 'off',
      note: '纯文本 + 软件内链接，24h 焚毁，每日 20 条',
    },
    F2: {
      key: 'F2', label: '战友档',
      chat: true, textMax: 500, images: 0, files: 0, plan: 'confirm', shot: true,
      extUrl: false, roomLink: true, tempRoom: true, crossLegion: 'approve', home: true,
      voice: true, emoji: 0, radar: 'off',
      note: '50 条/天 · 打卡截图互证 · 计划包（二次确认）· 1v1 语音监督房',
    },
  };

  function policyOf(tier) {
    return POLICY[String(tier || '')] || POLICY.L0;
  }

  /* ---------------- 单条消息判定 ----------------
   * msg: { text, images:n, files:n, emojis:n, kind:'text'|'shot'|'plan'|'room'|'temp'|'cross'|'home' }
   * 返回 { ok, reason, folded } —— folded=true 时消息照发但被折叠（L0 雷达命中闲聊不扣分只折叠）。
   */
  function checkContent(tier, msg) {
    const p = policyOf(tier);
    const m = msg && typeof msg === 'object' ? msg : {};
    const kind = String(m.kind || 'text');

    if (kind === 'exturl') return { ok: false, reason: '外部链接全档禁止' };
    if (kind === 'cross' && p.crossLegion === 'approve') return { ok: false, reason: '跨军团邀请需要审批' };
    if (kind === 'plan') {
      if (!p.plan) return { ok: false, reason: `${p.label}不能发计划包` };
      return { ok: true, reason: 'confirm' }; /* 调用方必须走二次确认 */
    }
    if (kind === 'shot' && !p.shot) return { ok: false, reason: `${p.label}不能发打卡截图` };

    const imgs = Math.max(0, Number(m.images) || 0);
    if (imgs > p.images) {
      return { ok: false, reason: p.images ? `${p.label}每条最多 ${p.images} 张图` : `${p.label}禁图片` };
    }
    const files = Math.max(0, Number(m.files) || 0);
    if (files > 0 && !p.files) return { ok: false, reason: `${p.label}禁普通文件` };
    const emojis = Math.max(0, Number(m.emojis) || 0);
    if (emojis > p.emoji) {
      return { ok: false, reason: p.emoji ? `${p.label}每条最多 ${p.emoji} 个表情` : `${p.label}禁表情包` };
    }
    const text = String(m.text || '');
    if (text.length > p.textMax) {
      return { ok: false, reason: `${p.label}每条最多 ${p.textMax} 字` };
    }
    /* L0：雷达全开，命中闲聊 → 不扣分但折叠 */
    if (p.radar === 'full' && isChitChat(text)) {
      return { ok: true, reason: '雷达命中闲聊，先干活', folded: true };
    }
    return { ok: true, reason: '' };
  }

  /* ---------------- AI 闲聊雷达（轻量规则版） ----------------
   * 只认「可观测」特征：语气词刷屏、纯表情、明显灌水短语；
   * 命中任务/打卡/房间/求助等正事词 → 一律不算闲聊（宁可漏，不可误伤）。
   */
  const CHAT_HINTS = [
    '哈哈', '呵呵', '嘿嘿', '嘿嘿嘿', '笑死', '666', '6666', '233', '牛逼', 'nb',
    '哈哈哈哈', '草', '绷不住了', '乐', '蚌埠', '摸了', '开摆', '摆了', '整活',
  ];
  const WORK_HINTS = [
    '打卡', '打完卡', '任务', '计划', '房间', '自习', '契约', '求助', '帮', '完成率', '积分',
    '押金', '监督', '提醒', '翻车', '全勤', '集体', '军团', '额', '押', '拼',
  ];

  function isChitChat(text) {
    const t = String(text || '').trim();
    if (!t) return false;
    const low = t.toLowerCase();
    /* 正事词优先：沾上一个就不算闲聊 */
    for (const w of WORK_HINTS) if (low.includes(w)) return false;
    /* 纯表情/符号 */
    const body = t.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\p{P}\p{S}\s]/gu, '');
    if (!body) return true;
    for (const w of CHAT_HINTS) if (low.includes(w)) return true;
    /* 超短且无实质内容（≤4 字的语气词） */
    if (body.length <= 4 && /^(嗯|哦|噢|噢|嗯嗯|好|行|？|\?|。|…+)$/.test(body)) return true;
    return false;
  }

  /* ---------------- L1 抽检：闲聊超 3 条/小时 → 回落 L0 直到次日 ---------------- */

  function strikesOf(strikes, uid) {
    const s = strikes && typeof strikes === 'object' ? strikes : {};
    return Array.isArray(s[uid]) ? s[uid] : [];
  }

  function hourCount(strikes, uid, at) {
    const t = Number(at) || Date.now();
    return strikesOf(strikes, uid).filter((x) => t - (Number(x) || 0) < HOUR_MS).length;
  }

  function endOfDay(now) {
    const d = new Date(Number(now) || Date.now());
    d.setHours(24, 0, 0, 0);
    return d.getTime();
  }

  /* 记一次闲聊：返回 { count, backUntil } —— count > 3 时回落 L0 到当日 24 点 */
  function onChatStrike(strikes, uid, at) {
    const t = Number(at) || Date.now();
    const s = strikes && typeof strikes === 'object' ? strikes : {};
    const list = (Array.isArray(s[uid]) ? s[uid] : []).filter((x) => t - (Number(x) || 0) < 24 * HOUR_MS);
    list.push(t);
    s[uid] = list;
    const count = hourCount(s, uid, t);
    const over = count > CHAT_PER_HOUR;
    if (over) s[String(uid) + ':until'] = endOfDay(t); // 击落：当日 24 点前按 L0 算
    return { count, over, backUntil: over ? endOfDay(t) : 0, strikes: s };
  }

  /* 生效档位：L1 被抽检击落 → 当日按 L0 算（until 单独存，避免被滑动窗口裁掉） */
  function effectiveTier(baseTier, strikes, uid, now) {
    const t = Number(now) || Date.now();
    const s = strikes && typeof strikes === 'object' ? strikes : {};
    const u = Number(s[String(uid) + ':until']) || 0;
    if (baseTier === 'L1' && u > t) return 'L0';
    return baseTier;
  }

  function strikeBack(strikes, uid, backUntil) {
    const s = strikes && typeof strikes === 'object' ? strikes : {};
    if (Number(backUntil) > 0) s[String(uid) + ':until'] = Number(backUntil);
    else delete s[String(uid) + ':until'];
    return s;
  }

  /* 次日重置（0 点定时器调用） */
  function resetStrikes(strikes) {
    const out = {};
    const s = strikes && typeof strikes === 'object' ? strikes : {};
    for (const k of Object.keys(s)) if (!k.endsWith(':until')) out[k] = [];
    return out;
  }

  const API = {
    CHAT_PER_HOUR,
    L1_TEXT_MAX,
    POLICY,
    computeTier,
    policyOf,
    checkContent,
    isChitChat,
    strikesOf,
    hourCount,
    endOfDay,
    onChatStrike,
    effectiveTier,
    strikeBack,
    resetStrikes,
  };

  root.PQLegionTier = API;
  if (typeof module === 'object' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
