/* PlanQuest · 军团频道规则（纯函数，主进程与渲染层共用）
 *
 * 军团频道和自习房闲聊是两回事：
 *   自习房是「一群人在同一个房间里」，规则由房主临场决定；
 *   军团是「长期一起熬的人」，规则得写在墙上、看得见、能改，改完全员立即知道。
 *
 * 所以这里只做一件事：把「团长能调的四样东西」变成可复现的判定。
 *   开关 on        —— 关掉之后频道只读，历史还在，谁也不能发
 *   严格度 level   —— 宽松 / 标准 / 严格，决定刷屏与复读的阈值，也决定发言信誉门槛
 *   禁言时长 muteMin —— 违规一次关多久（1~60 分钟）
 *   自定义词 words —— 团长自己加的敏感词（最多 20 个，每个 ≤8 字）
 *
 * 判定只认「可观测行为」，不猜动机：
 *   辱骂 —— 命中词表（内置高置信词 + 团长自定义）
 *   刷屏 —— 时间窗内条数超过阈值
 *   复读 —— 同一句话在窗口内重复次数超过阈值
 *   引战 —— 一次 @ 太多人；喊话 —— 大写/感叹号占比过高（只提醒，不罚）
 *
 * 禁言不写进信誉分账本：它只是「这个房间暂时不让你说话」。
 * 真正扣分走纪律模块（逃兵/刷分/鸽子精/外挂）和举报链路。
 */
'use strict';

(function (root) {
  /* ---------------- 档位 ---------------- */

  const LEVELS = {
    loose: {
      key: 'loose',
      label: '宽松',
      desc: '只拦明显的辱骂和刷屏，适合熟人小团',
      burst: 8,
      winMs: 10e3,
      dup: 4,
      dupWinMs: 30e3,
      atMany: 6,
      bang: 8,
      muteMin: 3,
      floor: 40,
    },
    normal: {
      key: 'normal',
      label: '标准',
      desc: '刷屏、复读、辱骂都会禁言，默认档',
      burst: 5,
      winMs: 10e3,
      dup: 2,
      dupWinMs: 30e3,
      atMany: 4,
      bang: 5,
      muteMin: 5,
      floor: 60,
    },
    strict: {
      key: 'strict',
      label: '严格',
      desc: '连发几条就拦，适合人多、新人多的大团',
      burst: 3,
      winMs: 15e3,
      dup: 2,
      dupWinMs: 60e3,
      atMany: 3,
      bang: 4,
      muteMin: 10,
      floor: 80,
    },
  };

  /* 内置高置信词：宁可漏，不可误伤。短词只在「整句就是它」时才算 */
  const BASE_WORDS = [
    '傻逼', '煞笔', '沙比', '智障', '脑残', '废物', '垃圾人', '滚蛋', '去死',
    '你妈死了', 'cnm', 'nmsl', '操你', '日你',
  ];
  const SHORT_WORDS = ['sb', 'nt'];

  const MAX_WORDS = 20;
  const MAX_WORD_LEN = 8;
  const MAX_TEXT = 200;
  const MAX_LOG = 120;

  const DEFAULT_RULES = { on: true, level: 'normal', muteMin: 5, words: [] };

  function levelOf(level) {
    return LEVELS[String(level || '')] || LEVELS.normal;
  }

  /* ---------------- 规则归一化 ---------------- */

  function cleanWord(w) {
    const s = String(w == null ? '' : w)
      .replace(/[\s\u2000-\u200f\u2028-\u202f]+/g, '')
      .slice(0, MAX_WORD_LEN);
    /* 单字词太容易误伤，直接丢掉 */
    return s.length >= 2 ? s : '';
  }

  function normalizeRules(raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const lv = LEVELS[String(r.level || '')] ? String(r.level) : 'normal';
    const words = [];
    const seen = new Set();
    const src = Array.isArray(r.words) ? r.words : String(r.words || '').split(/[\s,，、;；|]+/);
    for (const w of src) {
      const c = cleanWord(w);
      if (!c || seen.has(c)) continue;
      seen.add(c);
      words.push(c);
      if (words.length >= MAX_WORDS) break;
    }
    let muteMin = Math.round(Number(r.muteMin));
    if (!Number.isFinite(muteMin)) muteMin = LEVELS[lv].muteMin;
    muteMin = Math.max(1, Math.min(60, muteMin));
    return { on: r.on !== false, level: lv, muteMin, words };
  }

  /* 团长改了档位但没单独调时长 → 时长跟着档位走（除非手动改过） */
  function withLevel(rules, level) {
    const base = normalizeRules(rules);
    const lv = LEVELS[String(level || '')] ? String(level) : 'normal';
    if (!LEVELS[base.level]) base.level = lv;
    const auto = base.muteMin === LEVELS[base.level].muteMin;
    return normalizeRules({ ...base, level: lv, muteMin: auto ? LEVELS[lv].muteMin : base.muteMin });
  }

  function levelList() {
    return Object.values(LEVELS).map((l) => ({
      key: l.key,
      label: l.label,
      desc: l.desc,
      muteMin: l.muteMin,
      floor: l.floor,
    }));
  }

  /* ---------------- 文本处理 ---------------- */

  function clip(text) {
    let s = String(text == null ? '' : text);
    /* 去掉控制字符与零宽字符（用它们拼脏词是最常见的手法） */
    s = s.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
    s = s.replace(/[\u200b-\u200f\u2028-\u202f\ufeff]/g, '');
    s = s.replace(/\r\n?/g, '\n');
    s = s.replace(/\n{3,}/g, '\n\n').trim();
    if (s.length > MAX_TEXT) s = s.slice(0, MAX_TEXT);
    return s;
  }

  const norm = (s) =>
    String(s || '')
      .toLowerCase()
      .replace(/[\s\-_.*~·、,，。.!！?？'"“”‘’()（）\[\]【】]+/g, '');

  function wordsOf(rules) {
    const r = normalizeRules(rules);
    return BASE_WORDS.concat(r.words);
  }

  function hitWord(text, rules) {
    const t = norm(text);
    if (!t) return '';
    for (const w of wordsOf(rules)) {
      const n = norm(w);
      if (!n) continue;
      if (t.includes(n)) return w;
    }
    for (const w of SHORT_WORDS) {
      if (t === w) return w;
    }
    return '';
  }

  function shouty(text, rules) {
    const r = normalizeRules(rules);
    const lv = levelOf(r.level);
    const t = String(text || '');
    if (t.length < 12) return false;
    const letters = t.replace(/[^A-Za-z\u4e00-\u9fa5]/g, '');
    if (!letters.length) return false;
    const caps = (t.match(/[A-Z]/g) || []).length;
    const bang = (t.match(/[!！]/g) || []).length;
    return caps / letters.length > 0.7 || bang >= lv.bang;
  }

  function atCount(text) {
    return (String(text || '').match(/@[^\s@]{1,16}/g) || []).length;
  }

  /* ---------------- 判定 ----------------
   * recent: [{ uid, text, at }]，调用方只传同一个人的最近消息即可
   * 返回 { level: 'ok' | 'warn' | 'deny', minutes, reason, rule }
   */
  function scan(text, recent, rules, now) {
    const r = normalizeRules(rules);
    const t = now || Date.now();
    const body = clip(text);
    if (!body) return { level: 'deny', minutes: 0, reason: '空消息', rule: 'empty' };
    if (!r.on) return { level: 'deny', minutes: 0, reason: '军团频道已关闭，暂时只读', rule: 'off' };

    const lv = levelOf(r.level);
    const list = Array.isArray(recent) ? recent.filter((m) => m && Number(m.at) <= t) : [];
    const inWin = list.filter((m) => t - (Number(m.at) || 0) < lv.winMs);
    const same = list.filter((m) => t - (Number(m.at) || 0) < lv.dupWinMs && norm(m.text) === norm(body));

    const word = hitWord(body, r);
    if (word) return { level: 'deny', minutes: r.muteMin, reason: `用了「${word}」这类词`, rule: 'word' };

    if (inWin.length + 1 > lv.burst) {
      return {
        level: 'deny',
        minutes: r.muteMin,
        reason: `${Math.round(lv.winMs / 1000)} 秒内超过 ${lv.burst} 条`,
        rule: 'burst',
      };
    }

    if (same.length + 1 > lv.dup) {
      return { level: 'deny', minutes: r.muteMin, reason: '重复刷同一句话', rule: 'dup' };
    }

    if (atCount(body) > lv.atMany) {
      return { level: 'warn', minutes: 0, reason: `一次 @ 了 ${atCount(body)} 个人，容易被当成引战`, rule: 'at' };
    }
    if (shouty(body, r)) {
      return { level: 'warn', minutes: 0, reason: '感叹号或大写太多，像在喊话', rule: 'shout' };
    }
    return { level: 'ok', minutes: 0, reason: '', rule: '' };
  }

  /* 发言资格：信誉分低于档位门槛就没资格（不是禁言，是「还没挣到」） */
  function canSpeak(credit, rules, isNewbie) {
    const r = normalizeRules(rules);
    if (!r.on) return { ok: false, reason: '军团频道已关闭', floor: 0 };
    const floor = levelOf(r.level).floor;
    if (isNewbie) return { ok: true, reason: '', floor };
    const c = Number(credit);
    if (!Number.isFinite(c)) return { ok: true, reason: '', floor };
    if (c < floor) {
      return {
        ok: false,
        reason: `信誉分 ${c} 低于 ${floor}，暂时不能在军团频道发言。打卡、助人、翻案都能把分挣回来。`,
        floor,
      };
    }
    return { ok: true, reason: '', floor };
  }

  /* ---------------- 禁言账本（纯对象，落盘由调用方负责） ---------------- */

  function muteLeft(mutes, uid, now) {
    const m = (mutes || {})[String(uid || '')];
    if (!m) return 0;
    return Math.max(0, (Number(m.until) || 0) - (now || Date.now()));
  }

  function applyMute(mutes, uid, minutes, reason, now) {
    const out = { ...(mutes || {}) };
    const key = String(uid || '');
    const t = now || Date.now();
    const prev = out[key] || { count: 0 };
    out[key] = {
      until: t + Math.max(1, Math.min(60, Number(minutes) || 1)) * 60e3,
      count: (Number(prev.count) || 0) + 1,
      reason: String(reason || '').slice(0, 40),
      at: t,
    };
    return out;
  }

  function clearMute(mutes, uid) {
    const out = { ...(mutes || {}) };
    delete out[String(uid || '')];
    return out;
  }

  /* 过期 24 小时以上的记录清掉，只留「最近被禁过几次」 */
  function pruneMutes(mutes, now) {
    const t = now || Date.now();
    const out = {};
    for (const [uid, m] of Object.entries(mutes || {})) {
      if (!m) continue;
      if ((Number(m.until) || 0) > t) out[uid] = m;
      else if (t - (Number(m.at) || 0) < 24 * 3600e3) out[uid] = { ...m, until: 0 };
    }
    return out;
  }

  function leftText(ms) {
    const n = Number(ms) || 0;
    if (n <= 0) return '已解除';
    const min = Math.ceil(n / 60e3);
    if (min < 60) return `${min} 分钟`;
    const h = Math.floor(min / 60);
    return `${h} 小时 ${min % 60} 分钟`;
  }

  /* 给成员看的一句话规则说明 */
  function rulesText(rules) {
    const r = normalizeRules(rules);
    if (!r.on) return '频道已关闭（团长可重新打开）';
    const lv = levelOf(r.level);
    const extra = r.words.length ? ` · 自定义词 ${r.words.length} 个` : '';
    return `${lv.label} · 违规禁言 ${r.muteMin} 分钟 · 发言需信誉分 ≥ ${lv.floor}${extra}`;
  }

  /* 消息条目：id 用 uid+时间+随机，保证群内去重 */
  function makeEntry(uid, alias, text, at, invite, link) {
    const t = Number(at) || Date.now();
    const body = clip(text);
    const out = {
      id: `${String(uid || '').slice(0, 12)}-${t.toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      uid: String(uid || '').slice(0, 40),
      alias: String(alias || '').slice(0, 12),
      text: body,
      at: t,
    };
    const inv = cleanInvite(invite);
    if (inv) out.invite = inv;
    const lk = cleanLink(link);
    if (lk) out.link = lk;
    return out;
  }

  /* 结构化附件：目前只收「计划包」（.pqplan 全文）和「房间邀请」 */
  function cleanLink(raw) {
    if (!raw || typeof raw !== 'object') return null;
    if (raw.kind === 'plan') {
      const name = String(raw.name || '计划包').slice(0, 40);
      const text = String(raw.text || '');
      if (text.length < 20 || text.length > 60000) return null;
      const count = Math.max(0, Math.min(9999, Number(raw.count) || 0));
      return { kind: 'plan', name, count, text };
    }
    const inv = cleanInvite(raw);
    return inv ? { ...inv, kind: 'room' } : null;
  }

  /* 房间邀请：只带 地址 / 端口 / 房间码，和自习房联机用的是同一套连接参数 */
  function cleanInvite(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const ip = String(raw.ip || '').trim().slice(0, 40);
    const port = Number(raw.port) || 0;
    const code = String(raw.code || '').trim().slice(0, 8);
    if (!/^[\d.]{7,15}$/.test(ip) && !/^[a-z0-9.-]{1,40}$/i.test(ip)) return null;
    if (!(port > 0 && port < 65536)) return null;
    if (!code) return null;
    return { ip, port, code, kind: 'lan' };
  }

  /* ---------------- @ 人 ----------------
   * 频道和房间聊天用同一种写法：@昵称。这里只负责「谁是这个人」，
   * 高亮与提醒由界面处理 —— 判定留成纯函数，测试才好写。
   */
  function mentionsOf(text, roster) {
    const body = String(text || '');
    const list = Array.isArray(roster) ? roster : [];
    const out = [];
    for (const m of list) {
      if (!m || !m.alias) continue;
      const alias = String(m.alias);
      if (!alias) continue;
      /* @ 后面跟昵称，允许昵称里带空格时用完整匹配 */
      const at = body.indexOf('@' + alias);
      if (at < 0) continue;
      out.push({ uid: String(m.uid || ''), alias, at });
    }
    return out;
  }

  function mentionsMe(text, alias) {
    const a = String(alias || '').trim();
    if (!a) return false;
    return String(text || '').includes('@' + a);
  }

  /* 给界面用：把 @昵称 切成片段，避免把正文里的 HTML 当成标签 */
  function splitMentions(text, roster) {
    const body = String(text || '');
    const hits = mentionsOf(body, roster).sort((x, y) => y.alias.length - x.alias.length);
    if (!hits.length) return [{ text: body, at: false }];
    const used = [];
    const parts = [];
    let i = 0;
    while (i < body.length) {
      const hit = hits.find((h) => body.startsWith('@' + h.alias, i) && !used.some((u) => i >= u && i < u + h.alias.length + 1));
      if (hit) {
        parts.push({ text: '@' + hit.alias, at: true });
        used.push(i);
        i += hit.alias.length + 1;
      } else {
        const last = parts[parts.length - 1];
        if (last && !last.at) last.text += body[i];
        else parts.push({ text: body[i], at: false });
        i += 1;
      }
    }
    return parts;
  }

  /* ---------------- 软件内链接 ----------------
   * 用一段纯文本的 pq:// 链接把「房间 / 军团」带出去，
   * 微信群能贴、房间聊天能贴、军团频道也能贴 —— 谁认得就渲染成按钮，不认得就是一行字。
   *   房间：pq://room?ip=192.168.1.5&port=48790&code=1234
   *   军团：pq://legion?net=lan&ip=...&port=...&code=4321
   *         pq://legion?net=p2p&invite=<urlencoded 邀请码>
   * 计划文件太大，不走文本，走结构化附件 entry.link（见 cleanLink）。
   */
  const LINK_RE = /pq:\/\/(room|legion|pk)\?[^\s"'<>]{3,4000}/gi;

  function buildLink(kind, info) {
    const i = info || {};
    if (kind === 'room') {
      const ip = String(i.ip || '').trim();
      const port = Number(i.port) || 0;
      const code = String(i.code || '').trim().slice(0, 8);
      if (!ip || !port || !code) return '';
      return `pq://room?ip=${encodeURIComponent(ip)}&port=${port}&code=${encodeURIComponent(code)}`;
    }
    if (kind === 'legion') {
      const code = String(i.code || '').trim().slice(0, 8);
      if (i.net === 'p2p') {
        const inv = String(i.invite || '');
        if (!inv) return '';
        return `pq://legion?net=p2p&code=${encodeURIComponent(code)}&invite=${encodeURIComponent(inv)}`;
      }
      const ip = String(i.ip || '').trim();
      const port = Number(i.port) || 0;
      if (!ip || !code) return '';
      return `pq://legion?net=lan&ip=${encodeURIComponent(ip)}&port=${port || 0}&code=${encodeURIComponent(code)}`;
    }
    if (kind === 'pk') {
      /* PK 挑战券链接：m=matchId, t=创建时间, n=发起人, d=天数, r=对手战力 */
      const m = String(i.matchId || i.m || '').trim().slice(0, 60);
      if (!m) return '';
      return `pq://pk?m=${encodeURIComponent(m)}&t=${Number(i.t) || Date.now()}&n=${encodeURIComponent(i.name || i.n || '搭档')}&d=${Number(i.days || i.d) || 3}&r=${Number(i.rate || i.r) || 0}`;
    }
    return '';
  }

  function parseLink(url) {
    const m = /^pq:\/\/(room|legion|pk)\?([^\s"'<>]{3,4000})$/i.exec(String(url || '').trim());
    if (!m) return null;
    const kind = m[1].toLowerCase();
    const q = {};
    for (const kv of m[2].split('&')) {
      const at = kv.indexOf('=');
      if (at <= 0) continue;
      try {
        q[kv.slice(0, at)] = decodeURIComponent(kv.slice(at + 1));
      } catch (_) {}
    }
    if (kind === 'room') {
      const inv = cleanInvite({ ip: q.ip, port: q.port, code: q.code });
      return inv ? { ...inv, kind: 'room' } : null;
    }
    if (kind === 'pk') {
      const matchId = String(q.m || '').slice(0, 60);
      if (!matchId) return null;
      return {
        kind: 'pk', matchId,
        t: Number(q.t) || 0,
        name: String(q.n || '搭档').slice(0, 16),
        days: Math.min(7, Math.max(1, Number(q.d) || 3)),
        rate: Math.min(100, Math.max(0, Number(q.r) || 0)),
      };
    }
    const code = String(q.code || '').slice(0, 8);
    if (q.net === 'p2p') {
      if (!q.invite) return null;
      return { kind: 'legion', net: 'p2p', code, invite: String(q.invite).slice(0, 6000) };
    }
    return { kind: 'legion', net: 'lan', ip: String(q.ip || '').slice(0, 40), port: Number(q.port) || 0, code };
  }

  /* 把正文切成「文字段 / 链接段」，界面据此渲染卡片 */
  function splitLinks(text) {
    const body = String(text || '');
    if (!body) return [];
    const out = [];
    let last = 0;
    LINK_RE.lastIndex = 0;
    let m;
    while ((m = LINK_RE.exec(body))) {
      const link = parseLink(m[0]);
      if (!link) continue;
      if (m.index > last) out.push({ text: body.slice(last, m.index) });
      out.push({ text: m[0], link });
      last = m.index + m[0].length;
    }
    if (last < body.length) out.push({ text: body.slice(last) });
    return out.length ? out : [{ text: body }];
  }

  function pushLog(log, entry) {
    const list = Array.isArray(log) ? log.slice(-MAX_LOG) : [];
    if (!entry) return list;
    if (list.some((m) => m && m.id === entry.id)) return list;
    list.push(entry);
    return list.slice(-MAX_LOG);
  }

  const API = {
    LEVELS,
    DEFAULT_RULES,
    MAX_WORDS,
    MAX_TEXT,
    MAX_LOG,
    levelOf,
    levelList,
    normalizeRules,
    withLevel,
    clip,
    norm,
    hitWord,
    shouty,
    atCount,
    scan,
    canSpeak,
    muteLeft,
    applyMute,
    clearMute,
    pruneMutes,
    leftText,
    rulesText,
    makeEntry,
    cleanInvite,
    cleanLink,
    buildLink,
    parseLink,
    splitLinks,
    mentionsOf,
    mentionsMe,
    splitMentions,
    pushLog,
  };

  root.PQLegionChat = API;
  if (typeof module === 'object' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
