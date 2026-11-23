/* PlanQuest · 军团频道（渲染层）
 *
 * 军团自己的频道，跟自习房闲聊分开：不进房间也能说话，说话的人只有军团里的人。
 *
 * 两种走法，同一套规则：
 *   局域网  —— 消息交给主进程，房主判定后广播（成员之间不一定直连，必须房主中继）
 *   异地    —— 消息走网格 DataChannel 直连广播，判定用同一份纯函数在本地算
 *
 * 规则（开关 / 严格度 / 禁言时长 / 自定义词）只有团长能改；
 * 改完局域网由房主下发，异地由团长在网格里广播，成员立即跟上。
 */
'use strict';

(function (root) {
  const lib = () => root.PQLegionChat || null;
  const KEY = 'pq-legion-chat-v1';

  const st = {
    code: '',
    self: { uid: '', alias: '', credit: 0 },
    role: '', // host | member
    net: '', // lan | p2p
    rules: null,
    log: [],
    mutes: {},
    leftUntil: 0, // 自己被禁言的截止时间（本地倒计时用）
    lastErr: '',
    ready: false,
  };

  const listeners = new Set();
  let wired = false;
  let pollTimer = null;
  let roster = []; // 团内名册：@ 人、高亮、邀请都用这一份
  let mentions = 0; // 未读 @ 数
  let onMention = null;
  let govHandler = null; // 军团长选举帧的接收方（app.js 注册）

  function L() {
    const l = lib();
    return l || { normalizeRules: (x) => x || {}, muteLeft: () => 0, scan: () => ({ level: 'ok' }), canSpeak: () => ({ ok: true }), pushLog: (a, b) => (b ? a.concat([b]) : a), clip: (s) => s, leftText: () => '', rulesText: () => '', makeEntry: () => ({}), levelList: () => [], levelOf: () => ({ floor: 0, label: '标准' }) };
  }

  function emit() {
    for (const fn of listeners) {
      try {
        fn(state());
      } catch (_) {}
    }
  }

  function isHost() {
    return st.role === 'host';
  }

  function isP2P() {
    return st.net === 'p2p';
  }

  function storageKey() {
    return KEY + ':' + (st.code || 'x');
  }

  function persist() {
    try {
      localStorage.setItem(
        storageKey(),
        JSON.stringify({ rules: st.rules, log: st.log.slice(-60), mutes: st.mutes })
      );
    } catch (_) {}
  }

  function restore() {
    try {
      const raw = JSON.parse(localStorage.getItem(storageKey()) || 'null');
      if (!raw) return;
      if (raw.rules) st.rules = L().normalizeRules(raw.rules);
      if (Array.isArray(raw.log)) st.log = raw.log.slice(-80);
      if (raw.mutes && typeof raw.mutes === 'object') st.mutes = raw.mutes;
    } catch (_) {}
  }

  /* ---------------- 状态 ---------------- */

  function state() {
    const l = L();
    const rules = st.rules || l.normalizeRules();
    const now = Date.now();
    const left = Math.max(l.muteLeft(st.mutes, st.self.uid, now), Math.max(0, st.leftUntil - now));
    const gate = l.canSpeak(st.self.credit, rules, false);
    return {
      ready: st.ready,
      code: st.code,
      role: st.role,
      net: st.net,
      isHost: isHost(),
      rules,
      rulesText: l.rulesText(rules),
      log: st.log,
      mutes: st.mutes,
      self: st.self,
      roster,
      mentions,
      left,
      leftText: l.leftText(left),
      canSend: !!rules.on && left <= 0 && gate.ok,
      why: !rules.on ? '频道已关闭，暂时只读' : left > 0 ? `你被禁言，${l.leftText(left)}后可发言` : gate.ok ? '' : gate.reason,
      err: st.lastErr,
    };
  }

  function onChange(fn) {
    if (typeof fn === 'function') listeners.add(fn);
    return () => listeners.delete(fn);
  }

  /* ---------------- 本地入库 ---------------- */

  function append(entry) {
    if (!entry || !entry.id) return false;
    if (st.log.some((m) => m && m.id === entry.id)) return false;
    st.log = L().pushLog(st.log, entry);
    /* 有人 @ 我：只在本机记一笔未读，不回任何「已读」回执（不让别人知道我看没看） */
    if (!entry.sys && entry.uid !== st.self.uid && st.self.alias && L().mentionsMe && L().mentionsMe(entry.text, st.self.alias)) {
      mentions += 1;
      if (typeof onMention === 'function') {
        try {
          onMention(entry);
        } catch (_) {}
      }
    }
    persist();
    return true;
  }

  function setRoster(list) {
    roster = (Array.isArray(list) ? list : [])
      .filter((m) => m && m.alias)
      .map((m) => ({ uid: String(m.uid || ''), alias: String(m.alias).slice(0, 12), credit: Number(m.credit) || 0 }))
      .slice(0, 200);
    emit();
  }

  function markSeen() {
    if (!mentions) return;
    mentions = 0;
    emit();
  }

  function setMentionHandler(fn) {
    onMention = typeof fn === 'function' ? fn : null;
  }

  function appendSys(text) {
    const now = Date.now();
    append({ id: 'sys-' + now.toString(36) + '-' + Math.random().toString(36).slice(2, 5), sys: true, text: String(text || '').slice(0, 120), at: now });
  }

  function onGov(cb) {
    govHandler = typeof cb === 'function' ? cb : null;
  }

  function fireGov(frame) {
    if (govHandler) {
      try {
        govHandler(frame);
      } catch (_) {}
    }
  }

  /* 网格里的治理帧：选举公告 / 参选 / 投票 */
  function handleGve(m) {
    const kind = String(m.kind || '');
    if (kind === 'election') {
      if (m.notice) appendSys(m.notice);
      fireGov({ kind: 'seed', election: m.election });
      emit();
      return true;
    }
    if (kind === 'candidacy') {
      if (m.notice) appendSys(m.notice);
      fireGov({ kind: 'candidacy', uid: m.uid, alias: m.alias, credit: m.credit });
      emit();
      return true;
    }
    if (kind === 'ballot') {
      /* 投票不广播谁投了谁以外的信息，避免影响别人判断 */
      fireGov({ kind: 'ballot', voter: String(m.from || m.voter || ''), choice: String(m.choice || '') });
      return true;
    }
    return false;
  }

  function applyRules(rules, quiet) {
    const before = st.rules ? L().rulesText(st.rules) : '';
    st.rules = L().normalizeRules(rules);
    const after = L().rulesText(st.rules);
    if (!quiet && before && before !== after) appendSys(`频道规则已更新：${after}`);
    persist();
    emit();
  }

  /* ---------------- 传输：局域网（主进程中继） ---------------- */

  function api() {
    return root.api || {};
  }

  async function refresh() {
    if (isP2P()) return state();
    if (typeof api().legionChatState !== 'function') return state();
    try {
      const r = await api().legionChatState();
      if (!r) return state();
      st.ready = true;
      if (r.rules) st.rules = L().normalizeRules(r.rules);
      if (Array.isArray(r.log)) st.log = r.log.slice(-80);
      if (r.mutes && typeof r.mutes === 'object') st.mutes = r.mutes;
      if (r.left) st.leftUntil = Date.now() + Number(r.left);
      persist();
      emit();
    } catch (_) {}
    return state();
  }

  /* ---------------- 传输：异地（网格广播） ---------------- */

  function mesh() {
    return root.PQLegionMesh || null;
  }

  function netInfo() {
    const N = root.PQLegionNet;
    return N && typeof N.info === 'function' ? N.info() : null;
  }

  function meshBroadcast(obj) {
    const M = mesh();
    if (!M || typeof M.broadcast !== 'function') return 0;
    try {
      return M.broadcast(obj) || 0;
    } catch (_) {
      return 0;
    }
  }

  /* 网格帧：只有这几种 t 会被频道接住，其它原样留给别人 */
  function onFrame(evt) {
    if (!evt || evt.type !== 'data' || !evt.msg) return false;
    const m = evt.msg;
    if (m.t === 'gve') return handleGve(m);
    const l = L();
    if (m.t === 'lgc' && m.msg && m.msg.id) {
      if (append(m.msg)) emit();
      /* 自己发的被别人转回来时，用服务端的 at 校正顺序即可，不重复入列 */
      return true;
    }
    if (m.t === 'lgcr' && m.rules) {
      const hostUid = (netInfo() && netInfo().hostUid) || '';
      if (hostUid && m.from && m.from !== hostUid) return true; // 只有团长的规则算数
      applyRules(m.rules);
      return true;
    }
    if (m.t === 'lgcq') {
      if (isHost()) meshBroadcast({ t: 'lgcr', from: st.self.uid, rules: st.rules || l.normalizeRules() });
      return true;
    }
    if (m.t === 'lgcm') {
      const hostUid = (netInfo() && netInfo().hostUid) || '';
      if (hostUid && m.from && m.from !== hostUid) return true;
      const until = Number(m.until) || 0;
      if (m.uid) st.mutes = { ...st.mutes, [m.uid]: { until, count: 1, reason: String(m.reason || '').slice(0, 40), at: Date.now() } };
      if (m.uid === st.self.uid && until > Date.now()) st.leftUntil = until;
      appendSys(`${m.alias || '成员'} 被禁言至 ${new Date(until).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}${m.reason ? '：' + m.reason : ''}`);
      persist();
      emit();
      return true;
    }
    return false;
  }

  /* ---------------- 对外：发消息 ---------------- */

  async function send(text, opts) {
    const l = L();
    const rules = st.rules || l.normalizeRules();
    const now = Date.now();
    const s = state();
    if (!s.canSend) return { ok: false, message: s.why || '现在不能发言' };

    const body = l.clip(text);
    if (!body) return { ok: false, message: '空消息' };
    const invite = l.cleanInvite ? l.cleanInvite(opts && opts.invite) : null;
    const link = l.cleanLink ? l.cleanLink(opts && opts.link) : null;

    /* 本地先判一次，两种传输都受益：局域网省一趟往返，异地没有服务器可判 */
    const recent = st.log
      .filter((m) => m && !m.sys && m.uid === st.self.uid && now - (Number(m.at) || 0) < 120e3)
      .map((m) => ({ text: m.text, at: m.at }));
    const verdict = l.scan(body, recent, rules, now);
    if (verdict.level === 'deny') {
      const mins = verdict.minutes || rules.muteMin;
      st.mutes = { ...st.mutes, [st.self.uid]: { until: now + mins * 60e3, count: 1, reason: verdict.reason, at: now } };
      st.leftUntil = now + mins * 60e3;
      persist();
      emit();
      return { ok: false, message: `消息被拦下：${verdict.reason}，禁言 ${mins} 分钟` };
    }

    if (isP2P()) {
      const entry = l.makeEntry(st.self.uid, st.self.alias, body, now, invite, link);
      const n = meshBroadcast({ t: 'lgc', msg: entry });
      if (!n) return { ok: false, message: '还没有连上任何人，等连上再发' };
      append(entry);
      emit();
      return { ok: true, msg: entry, warn: verdict.level === 'warn' ? verdict.reason : '' };
    }

    if (typeof api().legionChatSend !== 'function') return { ok: false, message: '这台设备不支持军团频道' };
    try {
      const r = await api().legionChatSend(body, invite || undefined, link || undefined);
      if (r && r.ok) {
        if (r.msg) append(r.msg);
        emit();
        return r;
      }
      const msg = (r && r.message) || '发送失败';
      if (r && r.left) {
        st.leftUntil = now + Number(r.left);
        persist();
      }
      emit();
      return { ok: false, message: msg };
    } catch (_) {
      return { ok: false, message: '发送失败' };
    }
  }

  /* ---------------- 对外：团长规则 ---------------- */

  async function setRules(patch) {
    if (!isHost()) return { ok: false, message: '只有军团主能改频道规则' };
    const l = L();
    const src = { ...(st.rules || l.normalizeRules()), ...(patch || {}) };
    const rules = patch && patch.level && !('muteMin' in patch) && typeof l.withLevel === 'function'
      ? l.withLevel(src, patch.level)
      : l.normalizeRules(src);

    if (isP2P()) {
      st.rules = rules;
      meshBroadcast({ t: 'lgcr', from: st.self.uid, rules });
      appendSys(`频道规则已更新：${l.rulesText(rules)}`);
      persist();
      emit();
      /* 主进程也存一份，换设备/重开还在 */
      try {
        if (typeof api().legionChatRules === 'function') api().legionChatRules(rules).catch(() => {});
      } catch (_) {}
      return { ok: true, rules };
    }

    if (typeof api().legionChatRules !== 'function') return { ok: false, message: '这台设备不支持' };
    try {
      const r = await api().legionChatRules(patch || {});
      if (r && r.ok) {
        applyRules(r.rules, true);
        await refresh();
        return r;
      }
      return r || { ok: false, message: '保存失败' };
    } catch (_) {
      return { ok: false, message: '保存失败' };
    }
  }

  async function mute(uid, minutes, reason) {
    if (!isHost()) return { ok: false, message: '只有军团主能操作' };
    const id = String(uid || '');
    if (!id || id === st.self.uid) return { ok: false, message: '不能禁言自己' };
    const mins = Math.max(1, Math.min(60, Number(minutes) || (st.rules || {}).muteMin || 5));
    const until = Date.now() + mins * 60e3;
    const alias = (state().log.find((m) => m && m.uid === id) || {}).alias || '成员';

    if (isP2P()) {
      meshBroadcast({ t: 'lgcm', from: st.self.uid, uid: id, alias, until, reason: String(reason || '团长处理').slice(0, 40) });
      st.mutes = { ...st.mutes, [id]: { until, count: 1, reason: String(reason || '团长处理'), at: Date.now() } };
      appendSys(`${alias} 被禁言 ${mins} 分钟`);
      persist();
      emit();
      return { ok: true };
    }
    if (typeof api().legionChatMute !== 'function') return { ok: false, message: '这台设备不支持' };
    try {
      const r = await api().legionChatMute({ uid: id, minutes: mins, reason });
      await refresh();
      return r || { ok: true };
    } catch (_) {
      return { ok: false, message: '操作失败' };
    }
  }

  async function unmute(uid) {
    if (!isHost()) return { ok: false, message: '只有军团主能操作' };
    const id = String(uid || '');
    if (isP2P()) {
      meshBroadcast({ t: 'lgcm', from: st.self.uid, uid: id, until: 0, reason: '解除' });
      const m = { ...st.mutes };
      delete m[id];
      st.mutes = m;
      if (id === st.self.uid) st.leftUntil = 0;
      persist();
      emit();
      return { ok: true };
    }
    if (typeof api().legionChatMute !== 'function') return { ok: false, message: '这台设备不支持' };
    try {
      const r = await api().legionChatMute({ uid: id, clear: true });
      await refresh();
      return r || { ok: true };
    } catch (_) {
      return { ok: false, message: '操作失败' };
    }
  }

  function levels() {
    return L().levelList();
  }

  /* ---------------- 装配 ---------------- */

  function configure(opts) {
    const o = opts || {};
    const prevCode = st.code;
    const prevNet = st.net;
    st.code = String(o.code || '');
    st.role = String(o.role || '');
    st.net = String(o.net || 'lan');
    st.self = {
      uid: String((o.self && o.self.uid) || ''),
      alias: String((o.self && o.self.alias) || '我').slice(0, 12),
      credit: Number((o.self && o.self.credit) || 0),
    };
    if (st.code !== prevCode || st.net !== prevNet) {
      st.log = [];
      st.mutes = {};
      st.leftUntil = 0;
      st.rules = null;
      restore();
    }
    if (!st.rules) st.rules = L().normalizeRules();

    if (!wired) wire();
    /* 局域网：主动拉一次完整状态（含历史）；异地：向团长要一次规则 */
    if (!isP2P()) refresh();
    else {
      st.ready = true;
      meshBroadcast({ t: 'lgcq' });
      emit();
    }
    return state();
  }

  function wire() {
    wired = true;
    const a = api();
    if (typeof a.onLegion === 'function') {
      a.onLegion((evt) => {
        if (!evt) return;
        const l = L();
        if (evt.type === 'chat' && evt.msg) {
          if (append(evt.msg)) emit();
        } else if (evt.type === 'chatHistory' && Array.isArray(evt.log)) {
          st.log = evt.log.slice(-80);
          persist();
          emit();
        } else if (evt.type === 'chatRules' && evt.rules) {
          applyRules(evt.rules);
        } else if (evt.type === 'chatDenied') {
          if (evt.left) {
            st.leftUntil = Date.now() + Number(evt.left);
            persist();
          }
          st.lastErr = String(evt.reason || '');
          emit();
        } else if (evt.type === 'govElection' && evt.election) {
          /* 局域网：团长退团的选举帧（公告已在 chat 里） */
          fireGov({ kind: 'seed', election: evt.election });
        }
      });
    }

    const N = root.PQLegionNet;
    if (N && typeof N.onData === 'function') {
      N.onData((evt) => {
        if (onFrame(evt)) return;
      });
    }

    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(() => {
      if (!st.code) return;
      if (isP2P()) {
        /* 异地没人给自己发消息时，也要按时清掉过期禁言 */
        const left = L().muteLeft(st.mutes, st.self.uid, Date.now());
        if (left !== st.leftUntil - Date.now() || left === 0) emit();
      } else refresh();
    }, 20e3);
    if (pollTimer.unref) pollTimer.unref();
  }

  root.PQLegionChannel = {
    configure,
    state,
    onChange,
    send,
    setRules,
    mute,
    unmute,
    refresh,
    levels,
    setRoster,
    markSeen,
    setMentionHandler,
    onGov,
    sys: appendSys,
    meshBroadcast,
    /* 测试用 */
    _test: { append, onFrame, applyRules, st, roster: () => roster },
  };
})(typeof window !== 'undefined' ? window : globalThis);
