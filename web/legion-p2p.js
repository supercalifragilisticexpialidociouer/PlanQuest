/* PlanQuest · 军团异地通道（WebRTC 点对点）
 *
 * 和自习房的「异地对联机」用的是同一套技术，只是把会议室换成一条只跑摘要的
 * DataChannel：
 *   - 信令不走服务器：offer/answer 用 gzip 压成「邀请码 / 回执码」，自己微信发给对方；
 *   - 数据走 DataChannel（DTLS 强制加密，点对点直传），不经任何中继；
 *   - 星型拓扑：成员都连房主，成员之间互不可见。
 *
 * 和房间的差别只有一点：房间是「进房间就一直在」，军团是「开着软件就挂着，
 * 到点在这条通道上发一次摘要」。所以关掉软件 = 连接断开，重开要重新配对一次。
 *
 * 隐私：这里只转发档位摘要；真正落账的还是主进程（legion:absorb），
 * 走的是和局域网一模一样的白名单裁剪，前端被改也带不出原始数据。
 */
'use strict';

window.PQLegionNet = (function () {
  /* 异地必须靠 STUN 打洞，否则两个不同网络之间几乎连不上。
     全部是公共 STUN，只用来交换地址，不转发任何数据。
     Google + Cloudflare 双冗余（2026 年现行可用地址）。 */
  const STUNS = [
    'stun:stun.l.google.com:19302',
    'stun:stun1.l.google.com:19302',
    'stun:stun.cloudflare.com:3478',
  ];

  /* 内置公共 TURN（openrelay.metered.ca，免费无凭据申请）：
     纯中继模式的兜底。自建 coturn 的用户可在设置里填自己的，会优先用自填的。 */
  const OPENRELAY = {
    urls: [
      'turn:openrelay.metered.ca:80',
      'turn:openrelay.metered.ca:443',
      'turns:openrelay.metered.ca:443?transport=tcp',
    ],
    username: 'openrelayproject',
    credential: 'openrelayproject',
  };

  /* 网络偏好：direct = 点对点直传（默认，快且不经第三方）；
     relay = 纯中继，强制 iceTransportPolicy:'relay'，所有流量经 TURN 转发。 */
  let netPrefs = { mode: 'direct', turn: null };
  function setNetPrefs(p) {
    p = p || {};
    netPrefs.mode = p.mode === 'relay' ? 'relay' : 'direct';
    netPrefs.turn = p.turn && p.turn.urls
      ? {
          urls: Array.isArray(p.turn.urls) ? p.turn.urls : String(p.turn.urls).split(/[\s,]+/).filter(Boolean),
          username: String(p.turn.username || ''),
          credential: String(p.turn.credential || ''),
        }
      : null;
  }
  function buildRtcConfig() {
    const cfg = {
      iceServers: [{ urls: STUNS }],
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require',
    };
    if (netPrefs.mode !== 'relay') return cfg;
    cfg.iceServers.push(netPrefs.turn || OPENRELAY);
    cfg.iceTransportPolicy = 'relay';
    return cfg;
  }

  /* ---------------- 端到端加密 ----------------
   * DTLS 只保证「传输加密」，不验证「对面是谁」；这层补上端到端：
   * 邀请码里带一把 256 位随机密钥，双方对 DataChannel 上所有消息做
   * AES-GCM 加密 —— 即使 TURN 中继或中间人看到流量，也读不到内容。
   * 密钥跟邀请码走用户自己的私信（微信等），不经任何网络。 */
  const encKeys = new Map();
  function randHex(n) {
    const b = crypto.getRandomValues(new Uint8Array(n));
    return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  }
  async function deriveKey(keyHex) {
    if (encKeys.has(keyHex)) return encKeys.get(keyHex);
    const raw = new Uint8Array(32);
    for (let i = 0; i < 32; i++) raw[i] = parseInt(keyHex.slice(i * 2, i * 2 + 2), 16);
    const k = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
    if (encKeys.size > 16) encKeys.clear();
    encKeys.set(keyHex, k);
    return k;
  }
  const b64buf = (buf) => btoa(Array.from(new Uint8Array(buf), (c) => String.fromCharCode(c)).join(''));
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  async function sealMsg(keyHex, obj) {
    const k = await deriveKey(keyHex);
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const data = new TextEncoder().encode(JSON.stringify(obj));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, k, data));
    const out = new Uint8Array(12 + ct.length);
    out.set(nonce, 0);
    out.set(ct, 12);
    return 'E1:' + b64buf(out);
  }
  async function openMsg(keyHex, raw) {
    if (typeof raw !== 'string' || !raw.startsWith('E1:')) return null;
    try {
      const k = await deriveKey(keyHex);
      const buf = unb64(raw.slice(3));
      const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf.slice(0, 12) }, k, buf.slice(12));
      return JSON.parse(new TextDecoder().decode(pt));
    } catch (_) {
      return null;
    }
  }

  const PING_MS = 30e3; // 成员心跳
  const IDLE_MS = 100e3; // 房主侧超时判定

  let role = null; // 'host' | 'member'
  let code = '';
  let myUid = '';
  let myAlias = '';
  let hubStarted = false;

  const peers = new Map(); // 房主：pid -> { pc, dc, uid, alias, at, ready }
  const pending = new Map(); // 房主：已发邀请、还没收到回执的 pid
  let memberPc = null;
  let memberDc = null;
  let memberAt = 0;
  let replyResolver = null;

  let onAgg = () => {};
  let onEvent = () => {};
  /* 业务帧订阅者：军团频道（lgc/lgcr/lgcm）等模块挂在这里。
     网格把不认识的帧原样抛上来，不认识的再由各订阅者自己判断。 */
  const dataHandlers = new Set();
  function onData(cb) {
    if (typeof cb !== 'function') return () => {};
    dataHandlers.add(cb);
    return () => dataHandlers.delete(cb);
  }
  let hbTimer = null;

  function api() {
    return window.api || {};
  }

  /* 网格（数据面）由 legion-mesh.js 负责；这里只当信令通道 */
  function mesh() {
    return window.PQLegionMesh || null;
  }

  function creditOf() {
    try {
      return Number((window.state && window.state.credit && window.state.credit.score) || 0) || 0;
    } catch (_) {
      return 0;
    }
  }

  /* 房主手里的名册：自己 + 每个已握手的成员（含公钥，供成员之间直接协商密钥） */
  function rosterNow() {
    const M = mesh();
    const list = M ? [M.selfEntry()] : [];
    for (const e of peers.values()) {
      if (!e.uid) continue;
      list.push({ uid: e.uid, alias: e.alias, credit: e.credit || 0, pub: e.pub || '', joinedAt: e.joinedAt || 0 });
    }
    return list;
  }

  function broadcastRoster() {
    const M = mesh();
    if (!M) return;
    const list = rosterNow();
    const info = M.info();
    for (const e of peers.values()) {
      if (e.dc) packDc(e.dc, { t: 'roster', list, term: info.term, host: myUid, code });
    }
    M.adoptRoster(list, { term: info.term, host: myUid, code });
  }

  function ready() {
    return !!(api().legionHubStart && api().netPack && api().netUnpack && window.RTCPeerConnection);
  }

  function emit(type, payload) {
    try {
      onEvent({ type, ...(payload || {}) });
    } catch (_) {}
  }

  function waitIce(pc, timeout = 8000) {
    if (pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        pc.removeEventListener('icegatheringstatechange', onChange);
        resolve();
      };
      const onChange = () => {
        if (pc.iceGatheringState === 'complete') finish();
      };
      pc.addEventListener('icegatheringstatechange', onChange);
      setTimeout(finish, timeout);
    });
  }

  async function packDc(dc, obj) {
    if (!dc || dc.readyState !== 'open') return false;
    try {
      /* 有密钥就加密；没有密钥的通道拒绝发 —— 宁可不发也不走明文 */
      dc.send(dc.__keyHex ? await sealMsg(dc.__keyHex, obj) : null);
      return true;
    } catch (_) {
      return false;
    }
  }

  /* ---------------- 房主 ---------------- */

  async function hostStart(opts) {
    const o = opts || {};
    if (!ready()) return { ok: false, message: '这台设备不支持异地通道' };
    if (role === 'member') return { ok: false, message: '你正在当成员，先退出' };
    code = String(o.code || '').trim();
    myAlias = String(o.alias || '我').slice(0, 12);
    myUid = String(o.uid || '').trim();
    const r = await api().legionHubStart({ code, alias: myAlias, uid: myUid });
    if (!r || !r.ok) return r || { ok: false, message: '启动失败' };
    code = r.code || code;
    myUid = r.uid || myUid;
    role = 'host';
    hubStarted = true;
    startHeartbeat();
    await initMesh('host');
    return { ok: true, code, uid: myUid };
  }

  /* 网格初始化：房主只做信令；成员之间直连由网格自己协商 */
  async function initMesh(r) {
    const M = mesh();
    if (!M) return;
    M.mount({
      api,
      role: r,
      netMode: netPrefs.mode,
      turn: netPrefs.turn,
      self: { uid: myUid, alias: myAlias, credit: creditOf() },
      onEvent: (evt) => {
        /* 网格事件原样抛给上层（军团界面用），但「聚合」要落到同一套状态上 */
        if (evt && evt.type === 'agg' && evt.agg) onAgg(evt.agg);
        /* 业务帧（频道消息等）单独分发给订阅者，别让上层组件互相抢 handler */
        if (evt && evt.type === 'data') {
          for (const cb of dataHandlers) {
            try {
              cb(evt);
            } catch (_) {}
          }
        }
        emit(evt.type, evt);
      },
      sendSignal: (msg) => {
        if (!msg) return false;
        if (role === 'host') {
          const to = String(msg.to || '');
          const tgt = [...peers.values()].find((e) => e.uid === to);
          if (tgt && tgt.dc) return packDc(tgt.dc, { t: 'sig', from: myUid, kind: msg.kind, sdp: msg.sdp, data: msg.data });
          return false;
        }
        if (!memberDc || memberDc.readyState !== 'open') return false;
        return packDc(memberDc, { t: 'sig', to: msg.to, kind: msg.kind, sdp: msg.sdp, data: msg.data });
      },
    });
    M.setRole(r);
    M.setCode(code);
    await M.ensureKeys();
    if (r === 'host') broadcastRoster();
  }

  /* 生成邀请码：一条 offer + 军团号，压成一段文本 */
  async function invite() {
    if (role !== 'host') return { ok: false, message: '只有房主能发邀请' };
    const pid = 'p-' + Math.random().toString(16).slice(2, 10);
    const keyHex = randHex(32); // 这把密钥随邀请码发给成员，不落盘
    const pc = new RTCPeerConnection(buildRtcConfig());
    const dc = pc.createDataChannel('pq-legion', { ordered: true });
    dc.__keyHex = keyHex;
    const entry = { pc, dc, uid: '', alias: '', at: Date.now(), ready: false, keyHex };
    peers.set(pid, entry);
    pending.set(pid, entry);

    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === 'failed' || s === 'closed') drop(pid, '连接断开');
    };
    dc.onopen = () => {
      entry.ready = true;
      entry.at = Date.now();
      emit('peer-online', { pid });
    };
    dc.onclose = () => drop(pid, '对方下线');
    dc.onmessage = (e) => hostMsg(pid, e.data);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitIce(pc);

    const p = await api().netPack({
      t: 'lg-offer',
      code,
      pid,
      k: keyHex,
      sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp },
    });
    if (!p || !p.ok) return { ok: false, message: (p && p.msg) || '生成邀请码失败' };
    return { ok: true, pid, text: p.text };
  }

  async function applyReply(text) {
    if (role !== 'host') return { ok: false, message: '只有房主能粘贴回执码' };
    const un = await api().netUnpack(text);
    if (!un || !un.ok) return { ok: false, message: (un && un.msg) || '回执码无效' };
    const o = un.obj || {};
    if (o.t !== 'lg-answer') return { ok: false, message: '这不是军团回执码' };
    const pid = String(o.pid || '');
    const entry = pending.get(pid) || peers.get(pid);
    if (!entry) return { ok: false, message: '这条回执找不到对应的邀请，请重新生成邀请码' };
    try {
      await entry.pc.setRemoteDescription(o.sdp);
    } catch (e) {
      return { ok: false, message: '建立连接失败（' + String((e && e.message) || e) + '）' };
    }
    pending.delete(pid);
    return { ok: true, pid };
  }

  async function hostMsg(pid, raw) {
    const entry = peers.get(pid);
    if (!entry) return;
    const m = await openMsg(entry.keyHex, raw);
    if (!m || typeof m !== 'object') {
      if (typeof raw === 'string' && raw.startsWith('E1:')) drop(pid, '密钥不匹配');
      else drop(pid, '对方版本过旧（未加密），请两边都更新软件后重新配对');
      return;
    }
    entry.at = Date.now();

    if (m.t === 'hello') {
      entry.uid = String(m.uid || '').slice(0, 40);
      entry.alias = String(m.alias || '').slice(0, 12);
      entry.credit = Math.max(0, Math.min(160, Number(m.credit) || 0));
      entry.pub = String(m.pub || '').slice(0, 200);
      entry.joinedAt = Number(m.joinedAt) || Date.now();
      emit('peer-hello', { pid, alias: entry.alias });
      /* 名册发下去，成员据此两两直连；房主自己也在名册里 */
      broadcastRoster();
      return;
    }
    /* 成员之间的信令：房主只转交，不看内容（SDP / 公钥） */
    if (m.t === 'sig') {
      const to = String(m.to || '');
      const tgt = [...peers.values()].find((e) => e.uid === to);
      if (tgt && tgt.dc) {
        packDc(tgt.dc, { t: 'sig', from: entry.uid, kind: m.kind, sdp: m.sdp, data: m.data });
      }
      return;
    }
    if (m.t === 'push') {
      const uid = String(m.uid || entry.uid || '').trim();
      if (!uid) return;
      api()
        .legionAbsorb({ uid, alias: String(m.alias || entry.alias || ''), bundle: m.bundle })
        .then(async (r) => {
          if (!r || !r.ok) return;
          if (r.agg) broadcastAgg(r.agg);
          /* 个人位置只回给本人，不进广播 */
          try {
            const pos = await api().legionPos(uid);
            if (pos) packDc(entry.dc, { t: 'you', pos });
          } catch (_) {}
        })
        .catch(() => {});
      return;
    }
    if (m.t === 'rescue') {
      api()
        .legionHostLamp()
        .then(() => api().legionAgg())
        .then((agg) => {
          if (agg) broadcastAgg(agg);
        })
        .catch(() => {});
      return;
    }
    if (m.t === 'ping') {
      packDc(entry.dc, { t: 'pong', at: Date.now() });
    }
  }
  function broadcastAgg(agg) {
    if (!agg) return;
    for (const [, e] of peers) packDc(e.dc, { t: 'agg', agg });
    emit('agg', { agg });
    /* 房主自己那份「我的位置」也要跟着刷新（只在本机显示） */
    if (role === 'host') {
      try {
        api()
          .legionPos(myUid)
          .then((pos) => {
            if (pos) emit('you', { pos });
          })
          .catch(() => {});
      } catch (_) {}
    }
  }

  function drop(pid, reason) {
    const e = peers.get(pid);
    if (!e) return;
    try {
      e.dc && e.dc.close();
    } catch (_) {}
    try {
      e.pc && e.pc.close();
    } catch (_) {}
    peers.delete(pid);
    pending.delete(pid);
    emit('peer-offline', { pid, reason });
  }

  /* 房主侧：先把自己那份算进去，再广播
     网格模式下房主和成员完全对等 —— 摘要只发给同伴，不再由房主代转 */
  async function pushAsHost(bundle) {
    const M = mesh();
    if (M) {
      const r = await M.push(bundle);
      if (r && r.ok) {
        const agg = await api().legionAgg();
        if (agg) broadcastAgg(agg); // 兼容老版本成员：控制通道上的 agg 仍照发
        return r;
      }
    }
    const r = await api().legionPush(bundle);
    if (r && r.ok) {
      const agg = await api().legionAgg();
      if (agg) broadcastAgg(agg);
      try {
        const pos = await api().legionPos(myUid);
        if (pos) emit('you', { pos });
      } catch (_) {}
    }
    return r || { ok: false, message: '上报失败' };
  }

  /* ---------------- 成员 ---------------- */

  async function accept(text) {
    if (!ready()) return { ok: false, message: '这台设备不支持异地通道' };
    if (role === 'host') return { ok: false, message: '你是房主，先解散再当成员' };
    const un = await api().netUnpack(text);
    if (!un || !un.ok) return { ok: false, message: (un && un.msg) || '邀请码无效' };
    const o = un.obj || {};
    if (o.t !== 'lg-offer') return { ok: false, message: '这不是军团邀请码' };
    const keyHex = String(o.k || '');
    if (!/^[0-9a-f]{64}$/.test(keyHex)) {
      return { ok: false, message: '邀请码缺少加密密钥，请对方更新软件后重新生成' };
    }

    leaveQuiet();

    const pc = new RTCPeerConnection(buildRtcConfig());
    memberPc = pc;
    const pid = String(o.pid || '');
    pc.ondatachannel = (e) => {
      memberDc = e.channel;
      memberDc.__keyHex = keyHex;
      bindMemberDc();
      if (replyResolver) replyResolver();
      replyResolver = null;
    };
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === 'failed' || s === 'closed') {
        memberDc = null;
        emit('offline', { reason: '异地连接已断开，需要重新配对' });
      }
    };

    try {
      await pc.setRemoteDescription(o.sdp);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await waitIce(pc);
    } catch (e) {
      return { ok: false, message: '生成回执码失败（' + String((e && e.message) || e) + '）' };
    }

    const p = await api().netPack({
      t: 'lg-answer',
      pid,
      sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp },
    });
    if (!p || !p.ok) return { ok: false, message: '回执码生成失败' };

    role = 'member';
    code = String(o.code || '');
    await initMesh('member');
    emit('waiting', { code });
    return { ok: true, code, pid, text: p.text };
  }

  function bindMemberDc() {
    const dc = memberDc;
    if (!dc) return;
    dc.onmessage = async (e) => {
      memberAt = Date.now();
      const m = await openMsg(dc.__keyHex, e.data);
      if (!m) {
        if (typeof e.data === 'string' && e.data.startsWith('E1:')) {
          emit('offline', { reason: '连接被重置（密钥不匹配），需要重新配对' });
        }
        return;
      }
      if (m.t === 'agg' && m.agg) {
        emit('agg', { agg: m.agg });
        try {
          onAgg(m.agg);
        } catch (_) {}
      } else if (m.t === 'you' && m.pos) {
        emit('you', { pos: m.pos });
      } else if (m.t === 'roster') {
        const M = mesh();
        if (M) M.adoptRoster(m.list || [], { term: m.term, host: m.host, code: m.code || code });
      } else if (m.t === 'sig') {
        const M = mesh();
        if (M) M.onSignal(m.from || '', m.kind, { sdp: m.sdp, data: m.data });
      } else if (m.t === 'hb' || m.t === 'newhost') {
        const M = mesh();
        if (M) M.adoptHost(m);
      } else if (m.t === 'ping') {
        packDc(dc, { t: 'pong', at: Date.now() });
      }
    };
    dc.onopen = async () => {
      memberAt = Date.now();
      const M = mesh();
      let pub = '';
      if (M) {
        M.setSelf({ uid: myUid, alias: myAlias, credit: creditOf() });
        try {
          pub = await M.ensureKeys();
        } catch (_) {}
      }
      packDc(dc, { t: 'hello', uid: myUid, alias: myAlias, credit: creditOf(), pub, joinedAt: Date.now() });
      emit('online', { code });
      startHeartbeat();
    };
    dc.onclose = () => {
      memberDc = null;
      emit('offline', { reason: '异地连接已断开，需要重新配对' });
    };
  }

  /* 等成员侧 DataChannel 真正 open（回执码发出后才会连上） */
  function waitOnline(timeout = 12000) {
    if (memberDc && memberDc.readyState === 'open') return Promise.resolve(true);
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => {
        if (done) return;
        done = true;
        replyResolver = null;
        clearTimeout(t);
        resolve(v);
      };
      replyResolver = () => finish(true);
      const t = setTimeout(() => finish(false), timeout);
    });
  }

  /* 成员点灯：只发一个「有人点了一盏灯」，不带任何身份 */
  function lampToHost() {
    if (!memberDc || memberDc.readyState !== 'open') return false;
    return packDc(memberDc, { t: 'rescue' });
  }

  /* 成员上报：优先走网格（直连每个同伴），网格不通才退回只报房主 */
  async function pushAsMember(bundle) {
    const M = mesh();
    if (M) {
      const i = M.info();
      if (i.topo.direct + i.topo.overlay + i.topo.relay > 0) {
        const r = await M.push(bundle);
        return r && r.ok ? r : { ok: false, message: '发送失败' };
      }
    }
    if (!memberDc || memberDc.readyState !== 'open') {
      return { ok: false, message: '异地连接未建立，需要重新配对' };
    }
    const ok = packDc(memberDc, { t: 'push', uid: myUid, alias: myAlias, bundle });
    if (!ok) return { ok: false, message: '发送失败' };
    return { ok: true };
  }

  /* ---------------- 心跳 ---------------- */

  function startHeartbeat() {
    stopHeartbeat();
    hbTimer = setInterval(() => {
      if (role === 'host') {
        const now = Date.now();
        for (const [pid] of peers) {
          const e = peers.get(pid);
          if (!e) continue;
          if (e.ready && now - e.at > IDLE_MS) drop(pid, '长时间没有消息');
          else packDc(e.dc, { t: 'ping', at: now });
        }
      } else if (role === 'member' && memberDc && memberDc.readyState === 'open') {
        packDc(memberDc, { t: 'ping', at: Date.now() });
      }
    }, PING_MS);
    if (hbTimer && hbTimer.unref) hbTimer.unref();
  }

  function stopHeartbeat() {
    if (hbTimer) clearInterval(hbTimer);
    hbTimer = null;
  }

  /* ---------------- 收尾 ---------------- */

  function leaveQuiet() {
    const M = mesh();
    if (M) M.leave();
    for (const pid of [...peers.keys()]) drop(pid, '退出');
    pending.clear();
    if (memberDc) {
      try {
        packDc(memberDc, { t: 'bye' });
        memberDc.close();
      } catch (_) {}
    }
    memberDc = null;
    if (memberPc) {
      try {
        memberPc.close();
      } catch (_) {}
    }
    memberPc = null;
    stopHeartbeat();
    role = null;
    hubStarted = false;
  }

  function leave() {
    leaveQuiet();
    code = '';
    emit('left', {});
    return { ok: true };
  }

  function info() {
    let online = 0;
    for (const [, e] of peers) if (e.ready) online++;
    return {
      ready: ready(),
      role,
      code,
      peers: peers.size,
      online: role === 'member' ? (memberDc && memberDc.readyState === 'open' ? 1 : 0) : online,
      memberOnline: !!(memberDc && memberDc.readyState === 'open'),
      state: memberDc ? memberDc.readyState : '',
      netMode: netPrefs.mode,
      encrypted: !!(role === 'member' ? memberDc && memberDc.__keyHex : [...peers.values()].some((e) => e.dc && e.dc.__keyHex)),
    };
  }

  function onAggregate(cb) {
    onAgg = typeof cb === 'function' ? cb : () => {};
  }

  function on(handler) {
    onEvent = typeof handler === 'function' ? handler : () => {};
  }

  return {
    ready,
    setNetPrefs,
    hostStart,
    invite,
    applyReply,
    accept,
    waitOnline,
    pushAsHost,
    pushAsMember,
    lampToHost,
    broadcastAgg,
    leave,
    info,
    onAggregate,
    on,
    onData,
    setIdentity: (uid, alias) => {
      myUid = String(uid || myUid);
      myAlias = String(alias || myAlias || '').slice(0, 12);
    },
    /* 仅供 dev-tests 使用：加密往返与中继配置。生产代码不要依赖。 */
    _test: { sealMsg, openMsg, buildRtcConfig, setNetPrefs, randHex },
  };
})();
