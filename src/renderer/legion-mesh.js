/* PlanQuest · 军团网格（数据面）
 *
 * 目标拓扑：
 *
 *      [房主]  只跑信令：谁在房里 / 谁跟谁连 / 谁该接管
 *        │     （信令走 legion-p2p.js 的控制通道，只看见 SDP 与公钥）
 *   ┌────┼────┐
 *   A ───┼─── B      A/B/C 之间直连，数据不过房主
 *   └────┼────┘
 *        C
 *
 * 几条硬规矩：
 *  1. 房主只转发信令（offer/answer/公钥/名册），不碰聊天与摘要本体；
 *  2. 每一对成员各自 ECDH 现场协商一把 AES-GCM 密钥，房主看不到密钥；
 *  3. 先只靠 STUN 打洞（8 秒），打不通才挂 TURN 重来（用户选纯中继则直接中继）；
 *  4. 30 分钟轮换一次密钥，有人进/出也立刻换；
 *  5. 房主 45 秒没心跳 → 按信誉分选出副主接管信令，已建立的直连不受影响。
 *
 * 这个文件不碰 DOM，也不依赖 Electron IPC 之外的东西，方便离线测试。
 */
(function (root) {
  'use strict';

  const P = root.PQMeshPolicy;
  if (!P) throw new Error('legion-mesh 需要先加载 legion-mesh-policy.js');

  const ROTATE_MS = 30 * 60 * 1000; // 密钥轮换周期
  const HOST_SILENCE_MS = 45 * 1000; // 多久没心跳算房主掉线
  const BEAT_MS = 10 * 1000;
  const TICK_MS = 5 * 1000;
  const RETRY_MAX_MS = 120 * 1000;

  const STUNS = ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun.cloudflare.com:3478'];
  const OPENRELAY = {
    urls: ['turn:openrelay.metered.ca:80', 'turn:openrelay.metered.ca:443', 'turns:openrelay.metered.ca:443?transport=tcp'],
    username: 'openrelayproject',
    credential: 'openrelayproject',
  };

  let role = null; // 'host' | 'member' | 'deputy'
  let self = { uid: '', alias: '我', credit: 0, joinedAt: 0 };
  let term = 1;
  let hostUid = '';
  let lastHostBeat = 0;
  let code = '';
  let netMode = 'direct';
  let userTurn = null;

  let roster = [];
  let peers = new Map(); // uid -> peer
  let myKeys = null; // { priv, pub(b64url) }
  let mounted = false;

  let sendSignal = () => false;
  let onEvent = () => {};
  let api = () => root.api || {};

  let tickTimer = null;
  let beatTimer = null;

  /* ---------------- 小工具 ---------------- */

  const now = () => Date.now();

  function emit(type, payload) {
    try {
      onEvent({ type, ...(payload || {}) });
    } catch (_) {}
  }

  const b64 = (buf) => {
    const b = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  const unb64 = (s) => {
    const t = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
    const pad = t + '==='.slice((t.length + 3) % 4);
    const bin = atob(pad);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  };

  /* ---------------- 身份与密钥 ---------------- */

  async function ensureKeys() {
    if (myKeys) return myKeys.pub;
    const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const raw = await crypto.subtle.exportKey('raw', kp.publicKey);
    myKeys = { priv: kp.privateKey, pub: b64(raw) };
    return myKeys.pub;
  }

  function selfEntry() {
    return {
      uid: self.uid,
      alias: self.alias,
      credit: self.credit,
      pub: myKeys ? myKeys.pub : '',
      joinedAt: self.joinedAt || now(),
    };
  }

  /* 每对成员一把独立密钥：ECDH 协商 + HKDF，房主全程看不到 */
  async function deriveKey(peerUid, peerPub) {
    if (!myKeys || !peerPub) return null;
    const remote = await crypto.subtle.importKey('raw', unb64(peerPub), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: remote }, myKeys.priv, 256);
    const ikm = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
    const salt = new TextEncoder().encode([self.uid, peerUid].sort().join('|') + '|' + term);
    return crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt, info: new TextEncoder().encode('pq-legion-mesh-v1') },
      ikm,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  async function seal(key, obj) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = new TextEncoder().encode(JSON.stringify(obj));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data));
    const out = new Uint8Array(12 + ct.length);
    out.set(iv, 0);
    out.set(ct, 12);
    return 'M1:' + b64(out);
  }

  async function unseal(key, raw) {
    if (typeof raw !== 'string' || !raw.startsWith('M1:')) return null;
    try {
      const buf = unb64(raw.slice(3));
      const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf.slice(0, 12) }, key, buf.slice(12));
      return JSON.parse(new TextDecoder().decode(pt));
    } catch (_) {
      return null;
    }
  }

  /* ---------------- RTC 配置 ---------------- */

  function rtcConfig(step) {
    const cfg = { iceServers: [{ urls: STUNS }], bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' };
    if (step && (step.addTurn || netMode === 'relay')) {
      cfg.iceServers.push(userTurn || OPENRELAY);
      if (netMode === 'relay') cfg.iceTransportPolicy = 'relay';
    }
    return cfg;
  }

  function waitIce(pc, timeout) {
    if (pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        pc.removeEventListener('icegatheringstatechange', check);
        resolve();
      };
      const check = () => {
        if (pc.iceGatheringState === 'complete') finish();
      };
      pc.addEventListener('icegatheringstatechange', check);
      setTimeout(finish, timeout || 4000);
    });
  }

  /* ---------------- 对端 ---------------- */

  function peerOf(m) {
    const uid = String((m && m.uid) || '');
    if (!uid) return null;
    let p = peers.get(uid);
    if (!p) {
      p = {
        uid,
        alias: '',
        credit: 0,
        pub: '',
        joinedAt: 0,
        pc: null,
        dc: null,
        key: null,
        oldKey: null,
        keyAt: 0,
        state: 'idle',
        step: 0,
        retryAt: 0,
        backoff: 0,
        timer: null,
        at: 0,
      };
      peers.set(uid, p);
    }
    if (m) {
      p.alias = String(m.alias || p.alias || '').slice(0, 12);
      p.credit = P.clampScore(m.credit != null ? m.credit : p.credit);
      p.joinedAt = Number(m.joinedAt) || p.joinedAt || 0;
      const pub = P.cleanPub(m.pub);
      if (pub && pub !== p.pub) {
        p.oldKey = p.key;
        p.pub = pub;
        p.key = null; // 公钥变了 → 下面重新协商
      }
    }
    return p;
  }

  function isInitiator(uid) {
    return String(self.uid) < String(uid);
  }

  function clearPeerRtc(p) {
    if (p.timer) {
      clearTimeout(p.timer);
      p.timer = null;
    }
    try {
      p.dc && p.dc.close();
    } catch (_) {}
    try {
      p.pc && p.pc.close();
    } catch (_) {}
    p.dc = null;
    p.pc = null;
  }

  /* 建（或重建）一条连接。step 决定这一轮用不用 TURN。 */
  async function buildPeer(p, stepIndex) {
    if (!p || !p.pub) return;
    clearPeerRtc(p);
    const step = P.stepAt(stepIndex);
    p.step = stepIndex;

    const pc = new RTCPeerConnection(rtcConfig(step));
    p.pc = pc;

    /* 这一轮没连上就升级到下一级；两级都失败就退避重试，不无限空转 */
    if (p.timer) clearTimeout(p.timer);
    p.timer = setTimeout(() => {
      if (p.pc !== pc) return;
      if (pc.connectionState === 'connected') return;
      if (p.step + 1 < P.LADDER.length) {
        emit('peer-step', { uid: p.uid, step: P.stepAt(p.step + 1).step });
        buildPeer(p, p.step + 1);
      } else {
        p.state = 'down';
        p.backoff = Math.min(RETRY_MAX_MS, Math.max(15e3, (p.backoff || 0) * 2 || 30e3));
        p.retryAt = now() + p.backoff;
        emit('peer-down', { uid: p.uid });
      }
    }, step.timeoutMs);

    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === 'connected') {
        if (p.timer) clearTimeout(p.timer);
        p.timer = null;
        p.backoff = 0;
        p.retryAt = 0;
        probePair(p);
      } else if (s === 'failed') {
        if (p.timer) clearTimeout(p.timer);
        p.timer = null;
        if (p.step + 1 < P.LADDER.length) buildPeer(p, p.step + 1);
        else {
          p.state = 'down';
          p.backoff = Math.min(RETRY_MAX_MS, Math.max(15e3, (p.backoff || 0) * 2 || 30e3));
          p.retryAt = now() + p.backoff;
          emit('peer-down', { uid: p.uid });
        }
      } else if (s === 'disconnected') {
        /* 先别急着拆：手机切网、休眠回来常常几秒就恢复 */
        p.state = 'unstable';
        setTimeout(() => {
          if (p.pc === pc && pc.connectionState === 'disconnected') {
            p.state = 'down';
            p.retryAt = now() + 20e3;
          }
        }, 12e3);
      }
    };

    if (isInitiator(p.uid)) {
      const dc = pc.createDataChannel('pq-mesh', { ordered: true });
      bindDc(p, dc);
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await waitIce(pc, 4000);
        sendSignal({ to: p.uid, kind: 'offer', sdp: pc.localDescription });
      } catch (e) {
        emit('peer-error', { uid: p.uid, message: String((e && e.message) || e) });
      }
    } else {
      pc.ondatachannel = (e) => bindDc(p, e.channel);
      /* 被动侧：等对方的 offer，收到后由 onSignal 回 answer */
    }
  }

  /* 连上之后回看一眼实际选中的候选对：直连、组网（Tailscale 等）还是 TURN 中继 */
  async function probePair(p) {
    let link = 'direct';
    try {
      const stats = await p.pc.getStats();
      const cands = new Map();
      let pair = null;
      stats.forEach((s) => {
        if (s.type === 'local-candidate' || s.type === 'remote-candidate') cands.set(s.id, s);
        if (s.type === 'candidate-pair' && (s.selected || s.state === 'succeeded')) pair = pair || s;
      });
      if (pair) {
        const lc = cands.get(pair.localCandidateId) || {};
        const rc = cands.get(pair.remoteCandidateId) || {};
        link = P.classifyPair([
          {
            state: 'succeeded',
            localCandidateType: lc.candidateType,
            remoteCandidateType: rc.candidateType,
            remoteAddress: rc.address || rc.ip,
          },
        ]);
      }
    } catch (_) {}
    p.state = link === 'none' ? 'direct' : link;
    emit('peer-up', { uid: p.uid, link: p.state });
  }

  function bindDc(p, dc) {
    p.dc = dc;
    dc.onopen = async () => {
      p.at = now();
      await ensurePeerKey(p);
      emit('peer-online', { uid: p.uid, link: p.state });
      /* 连上就把自己的公钥再报一次，确保双方用同一份材料派生 */
      const pub = await ensureKeys();
      send(p, { t: 'pub', pub }).catch(() => {});
      flushOutbox(p);
    };
    dc.onclose = () => {
      p.state = 'down';
      p.retryAt = now() + 20e3;
      emit('peer-offline', { uid: p.uid });
    };
    dc.onmessage = async (e) => {
      p.at = now();
      let m = p.key ? await unseal(p.key, e.data) : null;
      if (!m && p.oldKey) m = await unseal(p.oldKey, e.data);
      if (!m) return;
      handleMeshMsg(p, m);
    };
  }

  async function ensurePeerKey(p) {
    if (!p.pub) return null;
    if (!p.key) {
      const k = await deriveKey(p.uid, p.pub);
      if (k) {
        p.key = k;
        p.keyAt = now();
      }
    }
    return p.key;
  }

  async function send(p, obj) {
    if (!p || !p.dc || p.dc.readyState !== 'open') return false;
    if (!p.key) await ensurePeerKey(p);
    if (!p.key) return false; // 没密钥宁可不发，也不走明文
    try {
      p.dc.send(await seal(p.key, obj));
      return true;
    } catch (_) {
      return false;
    }
  }

  /* 通道刚开、密钥还没派生出来时的少量积压消息 */
  function flushOutbox(p) {
    const q = p.outbox || [];
    p.outbox = [];
    for (const obj of q) send(p, obj).catch(() => {});
  }

  function queue(p, obj) {
    if (!p) return;
    p.outbox = p.outbox || [];
    if (p.outbox.length < 32) p.outbox.push(obj);
  }

  function handleMeshMsg(p, m) {
    const t = String(m.t || '');
    if (t === 'pub') {
      const pub = P.cleanPub(m.pub);
      if (pub && pub !== p.pub) {
        p.oldKey = p.key;
        p.pub = pub;
        p.key = null;
        ensurePeerKey(p).catch(() => {});
      }
      return;
    }
    if (t === 'hb') {
      adoptBeat(m);
      return;
    }
    if (t === 'newhost') {
      adoptHost(m);
      return;
    }
    if (t === 'rek') {
      /* 轮换：对方换了新公钥，用旧密钥派生出的通道把新公钥送到，然后双方重算 */
      const pub = P.cleanPub(m.pub);
      if (pub) {
        p.oldKey = p.key;
        p.pub = pub;
        p.key = null;
        ensurePeerKey(p)
          .then(() => emit('peer-rotated', { uid: p.uid }))
          .catch(() => {});
      }
      return;
    }
    if (t === 'bundle') {
      const uid = String(m.uid || p.uid).slice(0, 40);
      if (!uid) return;
      api()
        .legionMeshAbsorb({ uid, alias: String(m.alias || p.alias || ''), bundle: m.bundle })
        .then((r) => {
          if (r && r.ok && r.agg) {
            emit('agg', { agg: r.agg });
            onEvent({ type: 'agg', agg: r.agg });
          }
        })
        .catch(() => {});
      return;
    }
    if (t === 'agg' && m.agg) {
      onEvent({ type: 'agg', agg: m.agg });
      return;
    }
    if (t === 'ping') {
      send(p, { t: 'pong', at: now() }).catch(() => {});
      return;
    }
    /* 其它业务帧（聊天 / 投票 / 画面信令）原样抛给上层 */
    emit('data', { uid: p.uid, msg: m });
  }

  /* ---------------- 名册 ---------------- */

  function adoptRoster(incoming, meta) {
    const diff = P.mergeRoster(roster, incoming);
    roster = diff.list.filter((m) => m.uid !== self.uid);
    if (meta && meta.term) adoptHost({ term: meta.term, host: meta.host });
    if (meta && meta.code) code = String(meta.code);

    for (const m of diff.added) peerOf(m);
    for (const m of diff.updated) peerOf(m);
    for (const uid of diff.removed) {
      const p = peers.get(uid);
      if (p) {
        clearPeerRtc(p);
        peers.delete(uid);
        emit('peer-left', { uid });
      }
    }

    /* 名册一变就换密钥：走了的人不该还能解新消息 */
    if (diff.added.length || diff.removed.length) rotateAll('roster');

    /* 只对「新增 + 变更」的成员发起连接；已有连接不重连 */
    for (const m of [...diff.added, ...diff.updated]) {
      const p = peers.get(m.uid);
      if (!p) continue;
      if (p.pc && (p.state === 'direct' || p.state === 'overlay' || p.state === 'relay')) continue;
      if (!isInitiator(m.uid)) continue;
      if (!m.pub) continue;
      buildPeer(p, 0);
    }
    /* 被动侧：公钥可能后到，补一次（不主动发 offer） */
    for (const m of [...diff.added, ...diff.updated]) {
      const p = peers.get(m.uid);
      if (p && !p.pc && !isInitiator(m.uid) && m.pub && p.retryAt === 0) {
        /* 等对方 offer；这里只确保对象存在 */
      }
    }
    emit('roster', { n: roster.length });
  }

  /* ---------------- 信令（房主转发过来） ---------------- */

  async function onSignal(from, kind, msg) {
    const uid = String(from || '');
    if (!uid || uid === self.uid) return;
    let p = peers.get(uid);
    if (!p) p = peerOf({ uid });

    if (kind === 'offer' && msg && msg.sdp) {
      /* 只有「uid 更大」的一侧被动接收，避免双向同时 offer 打架 */
      if (isInitiator(uid)) return;
      clearPeerRtc(p);
      const step = P.stepAt(0);
      const pc = new RTCPeerConnection(rtcConfig(step));
      p.pc = pc;
      p.step = 0;
      pc.ondatachannel = (e) => bindDc(p, e.channel);
      pc.onconnectionstatechange = () => {
        const s = pc.connectionState;
        if (s === 'connected') probePair(p);
        else if (s === 'failed') {
          p.state = 'down';
          p.retryAt = now() + 30e3;
          emit('peer-down', { uid: p.uid });
        }
      };
      try {
        await pc.setRemoteDescription(msg.sdp);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await waitIce(pc, 4000);
        sendSignal({ to: uid, kind: 'answer', sdp: pc.localDescription });
      } catch (e) {
        emit('peer-error', { uid, message: String((e && e.message) || e) });
      }
      return;
    }

    if (kind === 'answer' && msg && msg.sdp && p.pc) {
      try {
        await p.pc.setRemoteDescription(msg.sdp);
      } catch (e) {
        emit('peer-error', { uid, message: String((e && e.message) || e) });
      }
    }
  }

  /* ---------------- 房主心跳与副主选举 ---------------- */

  function adoptBeat(m) {
    if (!m) return;
    const t = Number(m.term) || 0;
    if (t > term) {
      term = t;
      hostUid = String(m.host || hostUid);
    }
    lastHostBeat = now();
  }

  function adoptHost(m) {
    if (!m) return;
    const t = Number(m.term) || 0;
    if (t < term) return;
    term = t;
    hostUid = String(m.host || '');
    lastHostBeat = now();
    if (m.code) code = String(m.code);
    emit('host', { term, host: hostUid, code });
  }

  async function becomeDeputy() {
    if (role === 'host') return;
    term += 1;
    hostUid = self.uid;
    lastHostBeat = now();
    role = 'deputy';
    /* 接管信令根：本机开始收新成员的邀请码；已建立的直连不受影响 */
    try {
      const r = await api().legionHubStart({ code, alias: self.alias, uid: self.uid });
      if (r && r.ok) {
        code = r.code || code;
        self.uid = r.uid || self.uid;
      }
    } catch (_) {}
    broadcast({ t: 'newhost', term, host: self.uid, code }, true);
    emit('takeover', { term });
  }

  function maybeElect() {
    if (role === 'host' || !mounted) return;
    if (!lastHostBeat) return;
    if (now() - lastHostBeat < HOST_SILENCE_MS) return;
    const alive = roster.filter((m) => {
      const p = peers.get(m.uid);
      return m.uid === self.uid || (p && ['direct', 'overlay', 'relay'].includes(p.state));
    });
    if (!alive.length) return;
    if (P.shouldTakeOver(alive, self.uid)) becomeDeputy();
    else {
      /* 不是我接管：把心跳往后推一点，等副主广播，避免每 5 秒重复判断 */
      lastHostBeat = now() - HOST_SILENCE_MS + 20e3;
    }
  }

  /* ---------------- 广播与上报 ---------------- */

  function broadcast(obj, includeControl) {
    let n = 0;
    for (const p of peers.values()) {
      if (p.dc && p.dc.readyState === 'open') send(p, obj).catch(() => {});
      else queue(p, obj);
      n++;
    }
    if (includeControl && sendSignal) {
      try {
        sendSignal({ kind: 'bcast', data: obj });
      } catch (_) {}
    }
    return n;
  }

  async function push(bundle) {
    if (!bundle) return { ok: false, message: '摘要格式不对' };
    try {
      await api().legionMeshAbsorb({ uid: self.uid, alias: self.alias, bundle });
    } catch (_) {}
    const n = broadcast({ t: 'bundle', uid: self.uid, alias: self.alias, bundle });
    const agg = await api().legionAgg().catch(() => null);
    if (agg) emit('agg', { agg });
    return { ok: true, peers: n, agg: agg || null };
  }

  /* ---------------- 轮换 ---------------- */

  async function rotateAll(reason) {
    await ensureKeys();
    const fresh = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const raw = await crypto.subtle.exportKey('raw', fresh.publicKey);
    /* 先把新公钥用旧密钥发出去，再切自己的私钥 */
    for (const p of peers.values()) {
      if (p.dc && p.dc.readyState === 'open') {
        send(p, { t: 'rek', pub: b64(raw) }).catch(() => {});
      }
    }
    myKeys = { priv: fresh.privateKey, pub: b64(raw) };
    for (const p of peers.values()) {
      p.oldKey = p.key;
      p.key = null;
      if (p.dc && p.dc.readyState === 'open') {
        ensurePeerKey(p)
          .then(() => send(p, { t: 'pub', pub: myKeys.pub }))
          .catch(() => {});
      }
    }
    emit('rotated', { reason: reason || 'timer' });
  }

  /* ---------------- 生命周期 ---------------- */

  function startTimers() {
    stopTimers();
    tickTimer = setInterval(() => {
      const t = now();
      /* 轮换 */
      if (P.needRotate(t, lastRotateAt, { everyMs: ROTATE_MS })) {
        lastRotateAt = t;
        rotateAll('timer');
      }
      /* 退避重试 */
      for (const p of peers.values()) {
        if (p.retryAt && t >= p.retryAt && !p.pc && p.pub) {
          p.retryAt = 0;
          if (isInitiator(p.uid)) buildPeer(p, 0);
        }
      }
      maybeElect();
      if (role === 'host' || role === 'deputy') {
        broadcast({ t: 'hb', term, host: hostUid || self.uid }, true);
      }
    }, TICK_MS);
    if (tickTimer.unref) tickTimer.unref();
  }

  let lastRotateAt = 0;

  function stopTimers() {
    if (tickTimer) clearInterval(tickTimer);
    if (beatTimer) clearInterval(beatTimer);
    tickTimer = null;
    beatTimer = null;
  }

  function mount(opts) {
    const o = opts || {};
    if (o.api) api = o.api;
    if (o.onEvent) onEvent = o.onEvent;
    if (o.sendSignal) sendSignal = o.sendSignal;
    if (o.self) setSelf(o.self);
    if (o.role) role = o.role;
    if (o.netMode) netMode = o.netMode === 'relay' ? 'relay' : 'direct';
    if (o.turn) userTurn = o.turn;
    mounted = true;
    startTimers();
    return info();
  }

  function setSelf(patch) {
    const p = patch || {};
    if (p.uid) self.uid = String(p.uid).slice(0, 40);
    if (p.alias) self.alias = String(p.alias).slice(0, 12);
    if (p.credit != null) self.credit = P.clampScore(p.credit);
    if (!self.joinedAt) self.joinedAt = now();
  }

  function setRole(r, meta) {
    role = r || null;
    if (meta && meta.term) term = Number(meta.term) || term;
    if (r === 'host') {
      hostUid = self.uid;
      lastHostBeat = now();
    }
  }

  function setCode(c) {
    if (c) code = String(c);
  }

  function setNetMode(mode, turn) {
    netMode = mode === 'relay' ? 'relay' : 'direct';
    if (turn) userTurn = turn;
  }

  function leave() {
    stopTimers();
    for (const p of peers.values()) clearPeerRtc(p);
    peers.clear();
    roster = [];
    mounted = false;
    role = null;
    hostUid = '';
    lastHostBeat = 0;
    myKeys = null;
    lastRotateAt = 0;
  }

  function info() {
    const list = [];
    for (const p of peers.values()) {
      list.push({
        uid: p.uid,
        alias: p.alias,
        credit: p.credit,
        tier: P.tierOf(p.credit).name,
        state: p.state,
        step: P.stepAt(p.step).step,
        encrypted: !!p.key,
        lastAt: p.at,
      });
    }
    const t = P.topo(list);
    return {
      mounted,
      role,
      term,
      host: hostUid,
      hostAlive: !!lastHostBeat && now() - lastHostBeat < HOST_SILENCE_MS,
      selfUid: self.uid,
      roster: roster.map((m) => ({ uid: m.uid, alias: m.alias, credit: m.credit })),
      peers: list,
      topo: t,
      topoText: P.topoText(t),
      rotateInMs: P.rotateLeft(now(), lastRotateAt, ROTATE_MS),
      netMode,
    };
  }

  root.PQLegionMesh = {
    mount,
    setSelf,
    setRole,
    setCode,
    setNetMode,
    selfEntry,
    ensureKeys,
    adoptRoster,
    adoptHost,
    onSignal,
    broadcast,
    push,
    leave,
    info,
  };
  if (typeof module === 'object' && module.exports) module.exports = root.PQLegionMesh;
})(typeof window !== 'undefined' ? window : globalThis);
