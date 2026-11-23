'use strict';

/* 异地联机 · 点对点会议房间（WebRTC，星型拓扑）
 *
 * 设计原则：
 *  - 信令完全不走服务器：offer/answer 压成"连接码"，用户自己微信发给对方。
 *  - 数据与语音走 DataChannel / RTP：强制加密、点对点直传。
 *  - STUN 由用户自行开启（默认关闭；关闭时完全不经公网，适合同网段/有公网 IP）。
 *  - 星型拓扑：成员都连房主，成员间消息由房主转发。
 *  - 语音：配对时先占一条 sendrecv 音频通道，开麦用 replaceTrack 塞入麦克风轨道，
 *    不需要重新协商、也不需要重新交换连接码。
 *
 * 流程：配对（互发连接码）→ 已连接 → 点「进入房间」→ 会议界面（成员格子 / 语音 / 画面 / 聊天）
 */

const PQ_NET = (() => {
  const NET_STUN = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];

  /* 内置公共 TURN（openrelay.metered.ca）：纯中继模式的兜底。
     与军团异地通道（legion-p2p.js）保持同一份配置；设置里填了自建 coturn 则优先用自填的。 */
  const OPENRELAY = {
    urls: [
      'turn:openrelay.metered.ca:80',
      'turn:openrelay.metered.ca:443',
      'turns:openrelay.metered.ca:443?transport=tcp',
    ],
    username: 'openrelayproject',
    credential: 'openrelayproject',
  };

  const st = {
    mode: null, // 'host' | 'client'
    roomType: 'study', // 'study' | 'fun'
    code: '',
    myId: '',
    open: false,
    entered: false, // 是否已点「进入房间」
    joinedAt: 0,
    funEndsAt: 0,
    useStun: false,
    netMode: 'direct', // 'direct' | 'relay'：与军团共用设置里的「异地通道」连接方式
    netTurn: null, // 自建 TURN（来自设置），null = 用内置公共中继
    peers: new Map(),
    pending: [],
    chat: [],
    micOn: false,
    micStream: null,
    micLevel: 0,
    camStream: null,
    camTimer: null,
    scrStream: null,
    scrTimer: null,
    selfCam: false,
    selfScr: false,
    audioCtx: null,
  };

  const frames = new Map(); // 'cam:pid' | 'scr:pid' -> { url, at }
  let funTimer = null;

  function el(id) {
    return document.getElementById(id);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /* app.js 的 state/pomo 是 const 声明（全局词法环境），用 typeof 安全读取 */
  function appState() {
    try {
      return typeof state !== 'undefined' && state ? state : {};
    } catch (_) {
      return {};
    }
  }

  function appPomo() {
    try {
      return typeof pomo !== 'undefined' && pomo ? pomo : {};
    } catch (_) {
      return {};
    }
  }

  function myProfile() {
    return appState().profile || {};
  }

  function toast(msg, sub, warn) {
    try {
      if (typeof window.toast === 'function') return window.toast(msg, sub, warn);
    } catch (_) {}
  }

  function pcConfig() {
    /* 纯中继模式：强制所有流量经 TURN 转发（设置里的连接方式，与军团共用）。
       直连模式：维持原行为 —— STUN 由用户开关控制，关闭时完全不经公网。 */
    if (st.netMode === 'relay') {
      return {
        iceServers: [...NET_STUN, st.netTurn || OPENRELAY],
        iceTransportPolicy: 'relay',
        bundlePolicy: 'max-bundle',
        rtcpMuxPolicy: 'require',
      };
    }
    return { iceServers: st.useStun ? NET_STUN : [] };
  }

  /* 配对前读一次设置：连接方式/自建中继改过之后，新配对立即生效 */
  async function loadNetPrefs() {
    try {
      const s = await window.api.getState();
      const set = (s && s.settings) || {};
      st.netMode = set.netMode === 'relay' ? 'relay' : 'direct';
      st.netTurn = set.netTurn && set.netTurn.urls
        ? {
            urls: Array.isArray(set.netTurn.urls)
              ? set.netTurn.urls
              : String(set.netTurn.urls).split(/[\s,]+/).filter(Boolean),
            username: String(set.netTurn.username || ''),
            credential: String(set.netTurn.credential || ''),
          }
        : null;
    } catch (_) {
      /* 读不到设置就用默认直连 */
    }
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

  /* ---------------- 语音 ---------------- */

  function audioCtx() {
    if (!st.audioCtx) {
      try {
        st.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      } catch (_) {
        st.audioCtx = null;
      }
    }
    if (st.audioCtx && st.audioCtx.state === 'suspended') st.audioCtx.resume().catch(() => {});
    return st.audioCtx;
  }

  /* 音量探针：谁在说话就给他的格子加光圈 */
  function watchLevel(stream, onLevel) {
    const ctx = audioCtx();
    if (!ctx || !stream || !stream.getAudioTracks().length) return;
    try {
      const src = ctx.createMediaStreamSource(stream);
      const an = ctx.createAnalyser();
      an.fftSize = 512;
      src.connect(an);
      const buf = new Uint8Array(an.frequencyBinCount);
      setInterval(() => {
        try {
          an.getByteTimeDomainData(buf);
          let sum = 0;
          for (let i = 0; i < buf.length; i++) {
            const v = (buf[i] - 128) / 128;
            sum += v * v;
          }
          onLevel(Math.sqrt(sum / buf.length));
          paintSpeaking();
        } catch (_) {}
      }, 240);
    } catch (_) {}
  }

  async function toggleMic() {
    if (st.micOn) return stopMic();
    let stream = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (_) {
      return toast('无法打开麦克风', '请检查系统权限与是否被其他程序占用', true);
    }
    st.micStream = stream;
    st.micOn = true;
    const track = stream.getAudioTracks()[0];
    for (const p of st.peers.values()) {
      if (!p.pc) continue;
      const cands = p.pc.getSenders().filter((s) => s.track === null || (s.track && s.track.kind === 'audio'));
      const sender = cands.find((s) => s.transport) || cands[0];
      if (sender) sender.replaceTrack(track).catch(() => {});
    }
    startMicMeter(stream);
    /* 本地语音转文字 → 闲聊雷达（同一模型同一规则，音频不出设备） */
    if (window.VoiceASR) {
      VoiceASR.attach(stream, judgeNetVoice).catch(() => {});
    }
    broadcast({ t: 'state', st: myState() });
    render();
    toast('🎤 麦克风已开启', '语音点对点直传，不经过服务器');
  }

  /* 本地麦克风音量：自己格子高亮 + 语音状态同步给房间 */
  function startMicMeter(stream) {
    const ctx = audioCtx();
    if (!ctx) return;
    try {
      const src = ctx.createMediaStreamSource(stream);
      const an = ctx.createAnalyser();
      an.fftSize = 512;
      src.connect(an);
      const buf = new Uint8Array(an.frequencyBinCount);
      st.micTimer = setInterval(() => {
        if (!st.micOn) return;
        try {
          an.getByteTimeDomainData(buf);
          let sum = 0;
          for (let i = 0; i < buf.length; i++) {
            const v = (buf[i] - 128) / 128;
            sum += v * v;
          }
          const lv = Math.sqrt(sum / buf.length);
          const was = st.micLevel > 0.02;
          st.micLevel = lv;
          const now = lv > 0.02;
          if (was !== now) broadcast({ t: 'state', st: myState() });
          paintSpeaking();
        } catch (_) {}
      }, 240);
    } catch (_) {}
  }

  function stopMic() {
    st.micOn = false;
    st.micLevel = 0;
    if (window.VoiceASR) VoiceASR.detach();
    if (st.micTimer) clearInterval(st.micTimer);
    st.micTimer = null;
    if (st.micStream) st.micStream.getTracks().forEach((t) => t.stop());
    st.micStream = null;
    for (const p of st.peers.values()) {
      if (!p.pc) continue;
      const anyAudio = p.pc.getSenders().find((s) => s.track && s.track.kind === 'audio');
      if (anyAudio) anyAudio.replaceTrack(null).catch(() => {});
    }
    broadcast({ t: 'state', st: myState() });
    render();
  }

  /* ---------------- 消息收发 ---------------- */

  function broadcast(obj) {
    let n = 0;
    for (const p of st.peers.values()) {
      if (p.dc && p.dc.readyState === 'open') {
        try {
          p.dc.send(JSON.stringify(obj));
          n++;
        } catch (_) {}
      }
    }
    return n;
  }

  function relay(fromPid, obj) {
    for (const [pid, p] of st.peers) {
      if (pid === fromPid) continue;
      if (p.dc && p.dc.readyState === 'open') {
        try {
          p.dc.send(JSON.stringify({ ...obj, via: fromPid }));
        } catch (_) {}
      }
    }
  }

  function handleMessage(pid, raw) {
    let m = null;
    try {
      m = JSON.parse(raw);
    } catch (_) {
      return;
    }
    if (!m || !m.t) return;
    const p = st.peers.get(pid);

    if (m.t === 'hello') {
      if (p) {
        p.name = String(m.name || '同学').slice(0, 20);
        p.avatar = String(m.avatar || '🙂').slice(0, 4);
        p.roomType = m.roomType || st.roomType;
      }
      if (st.mode === 'host') {
        try {
          p.dc.send(JSON.stringify({ t: 'hello', name: myProfile().name || '房主', avatar: myProfile().avatar || '👑', roomType: st.roomType }));
        } catch (_) {}
        try {
          p.dc.send(JSON.stringify({ t: 'state', st: myState() }));
        } catch (_) {}
      }
      render();
      return;
    }
    if (m.t === 'state') {
      if (p) {
        p.st = m.st || {};
        p.speaking = !!m.st && !!m.st.speaking;
      }
      paintSpeaking();
      return;
    }
    if (m.t === 'chat') {
      const item = {
        id: 'n' + ++chatSeq,
        name: m.name || (p && p.name) || '同学',
        text: String(m.text || '').slice(0, 200),
        at: Date.now(),
        mine: false,
      };
      st.chat.push(item);
      if (st.chat.length > 200) st.chat.shift();
      renderChat();
      classifyNetChat(item);
      return;
    }
    if (m.t === 'frame') {
      frames.set((m.kind === 'scr' ? 'scr:' : 'cam:') + pid, { url: m.d, at: Date.now() });
      renderStage();
      return;
    }
    if (m.t === 'bye') {
      dropPeer(pid, '对方离开了');
      return;
    }
    if (st.mode === 'host') relay(pid, m);
  }

  /* ---------------- 连接管理 ---------------- */

  function preparePc(pc, pid, isHost) {
    // 房主是 offer 方：先占一条双向音频通道（以后开麦 replaceTrack 即可，不用重新协商）。
    // 成员是 answer 方：不能在这里 addTransceiver —— 手动加的通道不会和 offer 的 m-line 配对，
    // answer 会变成 recvonly（对方听不到），正确做法是在 setRemoteDescription 之后把
    // offer 自动创建的音频 transceiver 方向改成 sendrecv（见 clientAcceptInvite）。
    if (isHost) {
      try {
        pc.addTransceiver('audio', { direction: 'sendrecv' });
      } catch (_) {}
    }

    pc.ontrack = (e) => {
      const p = st.peers.get(pid);
      if (!p || !e.track) return;
      /* addTransceiver 占位的音轨不属于任何 MediaStream（e.streams 为空），
         必须用 e.track 现场包一个 stream，否则远端声音永远挂不上 → 听不到对方 */
      const stream = (e.streams && e.streams[0]) || new MediaStream([e.track]);
      p.audio = stream;
      attachRemoteAudio(pid, stream);
      watchLevel(stream, (lv) => {
        p.level = lv;
        paintSpeaking();
      });
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        st.pending = st.pending.filter((x) => x.pc !== pc);
        if (st.peers.has(pid)) dropPeer(pid, '连接中断');
      }
    };
  }

  /* 远端音频：每个成员一个 <audio>，静音元素常驻（不显示） */
  function attachRemoteAudio(pid, stream) {
    let a = document.getElementById('audio-' + pid);
    if (!a) {
      a = document.createElement('audio');
      a.id = 'audio-' + pid;
      a.autoplay = true;
      a.playsInline = true;
      a.style.display = 'none';
      document.body.appendChild(a);
    }
    a.srcObject = stream;
    a.play().catch(() => {});
  }

  function bindDc(pid, dc, isHost) {
    const p = st.peers.get(pid);
    if (p) p.dc = dc;
    dc.onopen = () => {
      const prof = myProfile();
      try {
        dc.send(JSON.stringify({ t: 'hello', name: prof.name || '我', avatar: prof.avatar || '🙂', roomType: st.roomType }));
      } catch (_) {}
      if (isHost) {
        try {
          dc.send(JSON.stringify({ t: 'state', st: myState() }));
        } catch (_) {}
      }
      render();
      toast('🌐 已连上', st.entered ? '新成员已加入房间' : '点「进入房间」开始一起学');
    };
    dc.onmessage = (e) => handleMessage(pid, e.data);
    dc.onclose = () => dropPeer(pid, '连接已断开');
    dc.onerror = () => {};
  }

  function dropPeer(pid, reason) {
    const p = st.peers.get(pid);
    if (!p) return;
    try {
      p.dc && p.dc.close();
    } catch (_) {}
    try {
      p.pc && p.pc.close();
    } catch (_) {}
    st.peers.delete(pid);
    frames.delete('cam:' + pid);
    frames.delete('scr:' + pid);
    const a = document.getElementById('audio-' + pid);
    if (a) a.remove();
    // 没人了 → 退回配对界面
    if (st.peers.size === 0 && st.entered) {
      st.entered = false;
      if (st.mode === 'client') {
        st.mode = null;
        st.code = '';
      }
    }
    render();
    if (reason && st.open) toast('成员已离开', reason);
  }

  function myState() {
    const pom = appPomo();
    const s = appState();
    const phase = pom.phase;
    return {
      status: phase === 'focus' ? 'studying' : phase === 'break' ? 'rest' : 'idle',
      focus: (s.todayFocus || 0) + (phase === 'focus' ? Math.round(((pom.total || 0) - (pom.left || 0)) / 60) : 0),
      mic: !!st.micOn,
      cam: !!st.selfCam,
      scr: !!st.selfScr,
      speaking: !!st.micOn && st.micLevel > 0.02,
    };
  }

  /* ---------------- 配对 ---------------- */

  async function hostInvite() {
    if (st.mode !== 'host') return;
    await loadNetPrefs();
    const pid = 'p-' + Math.random().toString(16).slice(2, 10);
    const pc = new RTCPeerConnection(pcConfig());
    const entry = { pid, pc, dc: null, name: '', avatar: '', st: {}, level: 0 };
    st.peers.set(pid, entry);
    st.pending.push(entry);
    preparePc(pc, pid, true);

    const dc = pc.createDataChannel('pq', { ordered: true });
    entry.dc = dc;
    bindDc(pid, dc, true);

    if (st.micOn && st.micStream) {
      const sender = pc.getSenders().find((s) => s.track === null);
      if (sender) sender.replaceTrack(st.micStream.getAudioTracks()[0]).catch(() => {});
    }

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitIce(pc);

    const r = await window.api.netPack({
      t: 'offer',
      code: st.code,
      pid,
      roomType: st.roomType,
      sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp },
    });
    if (!r || !r.ok) return toast('生成邀请码失败', (r && r.msg) || '', true);
    render();
    showCode('邀请码', r.text, '① 发给朋友，让他点「我要加入」粘贴这一段');
  }

  async function hostApplyReply(text) {
    const un = await window.api.netUnpack(text);
    if (!un || !un.ok) return toast('回执码无效', (un && un.msg) || '', true);
    if (un.obj.t !== 'answer') return toast('这不是回执码', '应该是朋友发回来的那一段', true);
    const entry = st.pending.find((x) => !x.used);
    if (!entry) return toast('没有等待中的邀请', '请先点「＋邀请」生成邀请码', true);
    try {
      await entry.pc.setRemoteDescription(un.obj.sdp);
      entry.used = true;
      st.pending = st.pending.filter((x) => x !== entry);
      toast('回执码已应用', '正在建立点对点连接…');
      render();
    } catch (e) {
      toast('应用回执码失败', String((e && e.message) || e), true);
    }
  }

  async function clientAcceptInvite(text) {
    const un = await window.api.netUnpack(text);
    if (!un || !un.ok) return toast('邀请码无效', (un && un.msg) || '', true);
    if (un.obj.t !== 'offer') return toast('这不是邀请码', '请让房主生成邀请码后把那段发给你', true);
    st.mode = 'client';
    st.code = String(un.obj.code || '');
    st.roomType = un.obj.roomType === 'fun' ? 'fun' : 'study';

    await loadNetPrefs();
    const pid = 'host';
    const pc = new RTCPeerConnection(pcConfig());
    const entry = { pid, pc, dc: null, name: '房主', avatar: '👑', st: {}, level: 0 };
    st.peers.set(pid, entry);
    preparePc(pc, pid, false);
    pc.ondatachannel = (e) => bindDc(pid, e.channel, false);

    try {
      await pc.setRemoteDescription(un.obj.sdp);
      // 关键：offer 自动创建的音频通道默认 recvonly，必须显式改成双向，
      // 否则 answer 里是 a=recvonly，对方永远听不到你的声音
      const at = pc.getTransceivers().find((t) => t.receiver.track && t.receiver.track.kind === 'audio');
      if (at) {
        try {
          at.direction = 'sendrecv';
        } catch (_) {}
      }
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await waitIce(pc);
    } catch (e) {
      return toast('生成回执码失败', String((e && e.message) || e), true);
    }

    if (st.micOn && st.micStream) {
      const sender = pc.getSenders().find((s) => s.track === null || (s.track && s.track.kind === 'audio'));
      if (sender) sender.replaceTrack(st.micStream.getAudioTracks()[0]).catch(() => {});
    }

    const r = await window.api.netPack({ t: 'answer', sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } });
    if (!r || !r.ok) return toast('生成回执码失败', (r && r.msg) || '', true);
    render();
    showCode('回执码', r.text, '② 把这段发回给房主，他粘贴后你们就连上了');
  }

  /* ---------------- 会话控制 ---------------- */

  async function create(type, minutes) {
    const roomType = type === 'fun' ? 'fun' : 'study';
    const mins = Math.max(10, Math.min(120, Number(minutes) || 30));
    const r = await window.api.netCreateRoom({ type: roomType, minutes: mins });
    if (!r || !r.ok) return toast('创建失败', (r && (r.message || r.msg)) || '积分不足？', true);
    st.mode = 'host';
    st.code = r.code;
    st.myId = r.myId;
    st.roomType = roomType;
    st.funEndsAt = r.funEndsAt || 0;
    st.peers.clear();
    st.pending = [];
    st.chat = [];
    st.entered = false;
    frames.clear();
    render();
    if (roomType === 'fun') {
      toast('🎉 娱乐房已创建', `已扣 ${r.cost || 0} 积分 · ${mins} 分钟 · 灰名单已放行`);
    } else {
      toast('会议已创建', '房间号 ' + r.code + ' · 点「＋邀请」生成连接码');
    }
    // 房主创建后直接问一句：现在就进房间，还是先发邀请码
    askEnter();
  }

  /* 房主创建后弹出的「是否进入房间」确认框 */
  function askEnter() {
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    const isFun = st.roomType === 'fun';
    mask.innerHTML = `
      <div class="modal" style="width:430px;text-align:center">
        <h2 style="justify-content:center;text-align:center">房间已创建</h2>
        <p style="font-size:13.5px;line-height:1.8;margin:0">
          房间号 <b style="letter-spacing:3px;font-size:16px">${esc(st.code || '—')}</b><br />
          ${isFun ? '娱乐房计时已开始，邀请码要尽快发给朋友。<br />' : ''}
          是否现在进入房间？
        </p>
        <div class="form-foot" style="justify-content:center;gap:12px;margin-top:22px">
          <button class="btn ghost" data-r="0">稍后，先发邀请码</button>
          <button class="btn" data-r="1">进入房间</button>
        </div>
      </div>`;
    mask.addEventListener('click', (e) => {
      const r = e.target.closest('[data-r]');
      if (!r) return;
      mask.remove();
      if (r.dataset.r === '1') enterRoom();
    });
    el('modal-root').appendChild(mask);
  }

  async function enterRoom() {
    const isHost = st.mode === 'host';
    // 房主可以先自己进房间等人，成员必须连上房主才能进
    if (!isHost && !st.peers.size) return toast('还没有连上房主', '先把回执码发回给房主', true);
    st.entered = true;
    st.joinedAt = Date.now();
    render();
    if (st.roomType === 'fun') startFunTimer();
    // 语音要自己开麦才发得出去：进房自动尝试，失败就提示手动开
    if (!st.micOn) {
      try {
        await toggleMic();
      } catch (_) {
        toast('🎤 麦克风没开', '想说话请点上方 🎤 按钮', true);
      }
    } else {
      toast('已进入房间', '麦克风开启中 · 点右上角 □ 可以全屏');
    }
    if (isHost && !st.peers.size) {
      setTimeout(() => {
        if (!st.open || !st.entered) return;
        toast('房间已开启', '点「＋邀请」生成邀请码发给朋友，他连上后会自己出现在格子里');
      }, 900);
    }
  }

  function startFunTimer() {
    if (funTimer) clearInterval(funTimer);
    funTimer = setInterval(() => {
      const left = st.funEndsAt - Date.now();
      const box = el('meet-fun-left');
      if (box) box.textContent = left > 0 ? '⏳ ' + fmtLeft(left) : '⏳ 已结束';
      if (st.funEndsAt && left <= 0) {
        clearInterval(funTimer);
        funTimer = null;
        toast('⏰ 娱乐房时间到', '已自动退出房间', true);
        leave();
      }
    }, 1000);
  }

  function fmtLeft(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = s % 60;
    return (h ? h + ':' : '') + String(m).padStart(2, '0') + ':' + String(ss).padStart(2, '0');
  }

  function leave() {
    for (const p of st.peers.values()) {
      try {
        p.dc && p.dc.readyState === 'open' && p.dc.send(JSON.stringify({ t: 'bye' }));
      } catch (_) {}
      try {
        p.dc && p.dc.close();
      } catch (_) {}
      try {
        p.pc && p.pc.close();
      } catch (_) {}
      const a = document.getElementById('audio-' + p.pid);
      if (a) a.remove();
    }
    if (funTimer) clearInterval(funTimer);
    funTimer = null;
    stopMic();
    stopCam();
    stopScr();
    st.peers.clear();
    st.pending = [];
    frames.clear();
    st.mode = null;
    st.code = '';
    st.chat = [];
    st.entered = false;
    st.funEndsAt = 0;
    render();
  }

  /* ---------------- 画面 ---------------- */

  async function toggleCam() {
    if (st.selfCam) return stopCam();
    try {
      st.camStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 12 } },
        audio: false,
      });
    } catch (_) {
      return toast('无法打开摄像头', '请检查权限', true);
    }
    st.selfCam = true;
    const v = document.createElement('video');
    v.autoplay = true;
    v.muted = true;
    v.playsInline = true;
    v.srcObject = st.camStream;
    try {
      await v.play();
    } catch (_) {}
    const c = document.createElement('canvas');
    c.width = 480;
    c.height = 360;
    const ctx = c.getContext('2d');
    st.camTimer = setInterval(() => {
      if (!st.selfCam) return stopCam();
      if (v.readyState < 2) return;
      try {
        ctx.drawImage(v, 0, 0, 480, 360);
        const d = c.toDataURL('image/jpeg', 0.55);
        if (d.length > 200000) return;
        frames.set('cam:self', { url: d, at: Date.now() });
        broadcast({ t: 'frame', kind: 'cam', d });
        renderStage();
      } catch (_) {}
    }, 420);
    broadcast({ t: 'state', st: myState() });
    render();
    // 强制开启：异地房开摄像头同样自动盯学
    if (window.AIWatch && !window.AIWatch.isRunning()) window.AIWatch.start(() => st.camStream);
  }

  function stopCam() {
    st.selfCam = false;
    if (st.camTimer) clearInterval(st.camTimer);
    st.camTimer = null;
    if (st.camStream) st.camStream.getTracks().forEach((t) => t.stop());
    st.camStream = null;
    frames.delete('cam:self');
    try {
      if (window.AIWatch && window.AIWatch.isRunning()) window.AIWatch.stop('摄像头已关闭', true);
    } catch (_) {}
    broadcast({ t: 'state', st: myState() });
    render();
  }

  async function toggleScr() {
    if (st.selfScr) return stopScr();
    let stream = null;
    try {
      const list = await window.api.screenSources();
      if (!Array.isArray(list) || !list.length) return toast('没有可共享的画面', '', true);
      const pick = await window.api.screenPick(list[0].id);
      if (!pick || !pick.ok) return toast('无法共享画面', (pick && pick.msg) || '', true);
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 8, max: 12 }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      });
    } catch (_) {
      return toast('未能开始共享屏幕', '授权被拒绝', true);
    }
    st.scrStream = stream;
    st.selfScr = true;
    const v = document.createElement('video');
    v.autoplay = true;
    v.muted = true;
    v.playsInline = true;
    v.srcObject = stream;
    try {
      await v.play();
    } catch (_) {}
    stream.getVideoTracks().forEach((t) => {
      t.onended = () => stopScr();
    });
    const c = document.createElement('canvas');
    const ctx = c.getContext('2d');
    /* DataChannel 单条消息上限约 256KB：先按高清出图，超限逐档降级，保证画面不断 */
    const LADDER = [
      { w: 1600, q: 0.78 },
      { w: 1440, q: 0.7 },
      { w: 1280, q: 0.6 },
      { w: 1024, q: 0.5 },
    ];
    st.scrTimer = setInterval(() => {
      if (!st.selfScr) return stopScr();
      if (v.readyState < 2) return;
      try {
        const vw = v.videoWidth || 1280;
        const vh = v.videoHeight || 720;
        let out = '';
        for (const step of LADDER) {
          const w = Math.min(step.w, vw);
          const h = Math.round((vh / vw) * w);
          if (c.width !== w || c.height !== h) {
            c.width = w;
            c.height = h;
          }
          ctx.drawImage(v, 0, 0, w, h);
          out = c.toDataURL('image/jpeg', step.q);
          if (out.length <= 190000) break;
        }
        if (!out || out.length > 190000) return; // 四档都超限（极少数满屏碎图），丢弃这一帧
        frames.set('scr:self', { url: out, at: Date.now() });
        broadcast({ t: 'frame', kind: 'scr', d: out });
        renderStage();
      } catch (_) {}
    }, 500);
    broadcast({ t: 'state', st: myState() });
    render();
  }

  function stopScr() {
    st.selfScr = false;
    if (st.scrTimer) clearInterval(st.scrTimer);
    st.scrTimer = null;
    if (st.scrStream) {
      st.scrStream.getTracks().forEach((t) => {
        t.onended = null;
        t.stop();
      });
    }
    st.scrStream = null;
    frames.delete('scr:self');
    broadcast({ t: 'state', st: myState() });
    render();
  }

  /* ---------------- AI（闲聊雷达 + 盯学，强制开启） ---------------- */

  let chatSeq = 0;
  const AI_LIMIT = 3;
  const AI_PENALTY = 2;
  const AI_WINDOW = 5 * 60 * 1000;
  /* 只有比较确定是闲聊才扣分（语音转写含糊，0.5 附近的判定容易误伤正经说话） */
  const AI_FISH_CONF = 0.7;
  const aiStat = { total: 0, fish: 0 };
  let aiMine = [];
  let aiFbTimer = null;

  function netBadge(m) {
    if (!m || !m.ai) return '';
    if (m.ai.label === 'fish')
      return `<span class="chat-badge fish" data-fix="${esc(m.id || '')}" title="判错了？点一下改判并存成训练样本">🐟 闲聊 ${Math.round(m.ai.p * 100)}%</span>`;
    if (m.ai.label === 'work')
      return `<span class="chat-badge work" data-fix="${esc(m.id || '')}" title="判错了？点一下改判并存成训练样本">📖 正经事 ${Math.round((1 - m.ai.p) * 100)}%</span>`;
    return '';
  }

  function refreshAiStat() {
    const el2 = el('net-ai-stat');
    if (!el2) return;
    if (!aiStat.total) return (el2.textContent = '等第一条消息');
    const pct = Math.round((aiStat.fish / aiStat.total) * 100);
    el2.textContent = `已判 ${aiStat.total} 条 · 闲聊 ${aiStat.fish} 条（${pct}%）`;
  }

  /* 每条聊天都本地判定（强制开启），判定结果挂在消息上 */
  function classifyNetChat(msg) {
    if (!msg || !msg.text || !window.AIChat) return;
    if (/^🤖/.test(String(msg.text))) return; // AI 自己的广播不判
    AIChat.classify(msg.text)
      .then((r) => {
        if (!r || !r.label || r.label === 'error') return;
        msg.ai = { label: r.label, p: r.p };
        aiStat.total += 1;
        if (r.label === 'fish') aiStat.fish += 1;
        refreshAiStat();
        renderChat();
        if (msg.mine && r.label === 'fish' && r.p >= AI_FISH_CONF) noteNetFish();
      })
      .catch(() => {});
  }

  /* 自己闲聊攒够 3 条 → 强制扣分（无开关，允许扣成负分） */
  function noteNetFish() {
    const now = Date.now();
    aiMine = aiMine.filter((t) => now - t < AI_WINDOW);
    aiMine.push(now);
    if (aiMine.length < AI_LIMIT) {
      const left = AI_LIMIT - aiMine.length;
      if (left <= 2) toast('🤖 闲聊雷达', `再聊 ${left} 条无关内容就要扣 ${AI_PENALTY} 积分`, false);
      return;
    }
    aiMine = [];
    toast(`🤖 闲聊被抓包：${AI_LIMIT} 条`, `扣除 ${AI_PENALTY} 积分 · 回来自习吧！`, true);
    try {
      if (window.api && typeof window.api.aiPenalty === 'function') window.api.aiPenalty(-AI_PENALTY).catch(() => {});
    } catch (_) {}
  }

  /* 语音转写结果 → 同一闲聊判定（与文字聊天同模型、同窗口、同扣分） */
  let voiceLastTexts = [];
  function judgeNetVoice(text) {
    if (!window.AIChat || typeof AIChat.classify !== 'function') return;
    const now = Date.now();
    voiceLastTexts = voiceLastTexts.filter((x) => now - x.at < 60 * 1000);
    if (voiceLastTexts.some((x) => x.text === text)) return; // 1 分钟内重复的话只算一次
    voiceLastTexts.push({ text, at: now });
    AIChat.classify(text)
      .then((r) => {
        if (!r || !r.label || r.label === 'error') return;
        aiStat.total += 1;
        if (r.label === 'fish' && r.p >= AI_FISH_CONF) {
          aiStat.fish += 1;
          refreshAiStat();
          noteNetFish();
          toast('🎙 语音闲聊', `「${text.slice(0, 24)}」闲聊 ${Math.round(r.p * 100)}%`, false);
        } else {
          refreshAiStat();
        }
      })
      .catch(() => {});
  }

  /* 点徽章 = 判错了，改判并存成训练样本 */
  function fixNetBadge(ev) {
    const b = ev.target && ev.target.closest ? ev.target.closest('.chat-badge[data-fix]') : null;
    if (!b) return;
    const id = b.getAttribute('data-fix');
    const msg = st.chat.find((m) => m.id === id);
    if (!msg || !msg.ai) return;
    const truth = msg.ai.label === 'fish' ? 0 : 1;
    msg.ai = { label: truth === 1 ? 'fish' : 'work', p: truth === 1 ? 0.99 : 0.01 };
    if (window.AITrain) {
      window.AITrain.addTextSample(msg.text, truth, '异地房纠错');
      const c = window.AITrain.counts();
      toast('已改判并存成训练样本', `文字样本 ${c.text} 条 · 攒够 10 条可训练自己的模型`);
    }
    renderChat();
  }

  /* 抓包后问一句 → 画面校准样本 */
  function showAiFeedback() {
    const bar = el('ai-fb');
    if (!bar) return;
    bar.hidden = false;
    if (aiFbTimer) clearTimeout(aiFbTimer);
    aiFbTimer = setTimeout(() => {
      bar.hidden = true;
    }, 30000);
  }
  function saveAiFeedback(y) {
    const shot = window.AIWatch && window.AIWatch.getShot ? window.AIWatch.getShot() : null;
    const bar = el('ai-fb');
    if (bar) bar.hidden = true;
    if (aiFbTimer) clearTimeout(aiFbTimer);
    if (!shot || !window.AITrain) return;
    window.AITrain.addImageSample(shot, y);
    const c = window.AITrain.counts();
    toast(y ? '记下了：这算摸鱼' : '记下了：那时在认真学习', `画面样本 ${c.image} 条`);
  }

  /* ---------------- 聊天 ---------------- */

  function sendChat(text) {
    const clean = String(text || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 200);
    if (!clean) return;
    const prof = myProfile();
    broadcast({ t: 'chat', text: clean, name: prof.name || '我', at: Date.now() });
    const item = { id: 'n' + ++chatSeq, name: prof.name || '我', text: clean, at: Date.now(), mine: true };
    st.chat.push(item);
    if (st.chat.length > 200) st.chat.shift();
    renderChat();
    classifyNetChat(item);
  }

  /* ---------------- 会议画面 ---------------- */

  function tileHtml(key, o) {
    const fresh = (x) => x && Date.now() - x.at < 8000;
    const scrF = fresh(frames.get('scr:' + key)) ? frames.get('scr:' + key) : null;
    const camF = fresh(frames.get('cam:' + key)) ? frames.get('cam:' + key) : null;
    const img = scrF || camF;
    const wide = !!scrF;
    return `
      <div class="mtile ${wide ? 'wide' : ''} ${o.speaking ? 'speaking' : ''}" data-tile="${esc(key)}">
        <div class="mtile-body">
          ${
            img
              ? `<img class="mtile-img" src="${img.url}" alt=""/>`
              : `<div class="mtile-ph"><span class="mtile-av">${esc(o.avatar || '🙂')}</span></div>`
          }
        </div>
        <div class="mtile-bar">
          <span class="mtile-mic">${o.mic ? '🎤' : '🔇'}</span>
          <span class="mtile-name">${esc(o.name || '成员')}</span>
          <span class="mtile-st">${esc(o.st || '')}</span>
        </div>
        ${wide ? '<span class="mtile-tag">🖥 共享中</span>' : ''}
      </div>`;
  }

  function stageHtml() {
    const prof = myProfile();
    const parts = [
      tileHtml('self', {
        name: (prof.name || '我') + '（我）',
        avatar: prof.avatar || '🙂',
        mic: st.micOn,
        speaking: st.micOn && st.micLevel > 0.02,
        st: st.selfScr ? '共享屏幕' : st.selfCam ? '摄像头' : '',
      }),
    ];
    for (const [pid, p] of st.peers) {
      const s = p.st || {};
      const label = s.status === 'studying' ? '专注中' : s.status === 'rest' ? '休息中' : '在场';
      parts.push(
        tileHtml(pid, {
          name: p.name || '连接中…',
          avatar: p.avatar || '🙂',
          mic: !!s.mic,
          speaking: !!p.speaking || (p.level || 0) > 0.02,
          st: label + (s.focus ? ' · ' + s.focus + 'min' : ''),
        })
      );
    }
    // 房主先自己进房间时，给一个"等人"的空格子，避免画面只有自己
    if (!st.peers.size && st.mode === 'host') {
      parts.push(`
        <div class="mtile" style="opacity:.6">
          <div class="mtile-body"><div class="mtile-ph"><span class="mtile-av">＋</span></div></div>
          <div class="mtile-bar"><span class="mtile-name">等待成员加入</span><span class="mtile-st">点「＋邀请」发连接码</span></div>
        </div>`);
    }
    return parts.join('');
  }

  function renderStage() {
    const stage = el('meet-stage');
    if (!stage) return;
    stage.innerHTML = stageHtml();
    // 有画面的格子可以点开全屏看
    stage.querySelectorAll('.mtile').forEach((t) => {
      const key = t.dataset.tile;
      const f = frames.get('scr:' + key) || frames.get('cam:' + key);
      if (!f) return;
      t.style.cursor = 'zoom-in';
      t.onclick = () => openTileViewer(key);
    });
  }

  /* ---- 共享画面全屏浮层：点格子放大，点任意处 / Esc 退出 ---- */
  let tileViewer = null;

  function openTileViewer(key) {
    closeTileViewer();
    const isScr = !!frames.get('scr:' + key);
    const mask = document.createElement('div');
    mask.id = 'tile-viewer';
    /* 打开即整窗全屏 + 画面铺满整屏（cover，无黑边） */
    window.api.setFullscreen(true).then((before) => {
      if (tileViewer && tileViewer.timer === timer) tileViewer.wasFull = !!before;
    });
    mask.style.cssText =
      'position:fixed;inset:0;width:100vw;height:100vh;background:#000;z-index:90;overflow:auto;cursor:zoom-out;display:flex;align-items:center;justify-content:center';
    mask.innerHTML = `
      <img id="tv-img" style="width:100%;height:100%;object-fit:cover;display:block" alt=""/>
      <div id="tv-tip" style="position:fixed;top:14px;left:18px;color:#cfe0f2;font-size:13px;
        background:rgba(10,14,22,.72);padding:7px 15px;border-radius:99px;transition:opacity .4s;
        border:1px solid rgba(120,150,190,.35)">🖥 ${isScr ? '共享屏幕' : '摄像头画面'} · 已铺满整屏 · 双击切换 完整显示/原始像素 · 点击或 Esc 退出</div>`;
    const img = mask.querySelector('#tv-img');
    const tip = mask.querySelector('#tv-tip');
    /* 三态：cover 铺满（默认）→ contain 完整显示 → none 原始像素 */
    const MODES = ['cover', 'contain', 'none'];
    let mode = 0;
    const applyMode = () => {
      const m = MODES[mode];
      img.style.objectFit = m;
      img.style.width = m === 'none' ? 'auto' : '100%';
      img.style.height = m === 'none' ? 'auto' : '100%';
      mask.style.cursor = m === 'none' ? 'zoom-in' : 'zoom-out';
      tip.textContent =
        m === 'cover'
          ? '🖥 已铺满整屏（双击切完整显示）'
          : m === 'contain'
            ? '🖥 完整显示（双击切原始像素）'
            : '🔍 原始像素，可拖动查看细节（双击还原铺满）';
      tip.style.opacity = '1';
      clearTimeout(tip._t);
      tip._t = setTimeout(() => (tip.style.opacity = '0'), 2600);
    };
    const update = () => {
      const f = frames.get('scr:' + key) || frames.get('cam:' + key);
      if (!img || !mask.isConnected) return;
      if (f && Date.now() - f.at < 8000) {
        if (img.dataset.cur !== String(f.at)) {
          img.src = f.url;
          img.dataset.cur = String(f.at);
        }
        img.style.opacity = '1';
      } else {
        img.style.opacity = '0.35';
      }
    };
    update();
    const timer = setInterval(update, 250);
    const close = () => {
      clearInterval(timer);
      mask.remove();
      document.removeEventListener('keydown', onKey);
      if (tileViewer && tileViewer.timer === timer) {
        if (tileViewer.wasFull === false) window.api.setFullscreen(false); // 之前不是全屏，退出时还原
        tileViewer = null;
      }
    };
    const onKey = (e) => e.key === 'Escape' && close();
    document.addEventListener('keydown', onKey);
    let clickTimer = null;
    mask.onclick = () => {
      if (clickTimer) return;
      clickTimer = setTimeout(() => {
        clickTimer = null;
        close();
      }, 220);
    };
    mask.ondblclick = (e) => {
      e.stopPropagation();
      if (clickTimer) {
        clearTimeout(clickTimer);
        clickTimer = null;
      }
      mode = (mode + 1) % MODES.length;
      applyMode();
    };
    tileViewer = { timer };
    document.body.appendChild(mask);
    setTimeout(() => (tip.style.opacity = '0'), 3200);
  }

  function closeTileViewer() {
    if (tileViewer) {
      clearInterval(tileViewer.timer);
      tileViewer = null;
      const m = document.getElementById('tile-viewer');
      if (m) m.remove();
    }
  }

  function paintSpeaking() {
    const stage = el('meet-stage');
    if (!stage) return;
    const self = stage.querySelector('[data-tile="self"]');
    if (self) self.classList.toggle('speaking', st.micOn && st.micLevel > 0.02);
    for (const [pid, p] of st.peers) {
      const t = stage.querySelector('[data-tile="' + pid + '"]');
      if (t) t.classList.toggle('speaking', !!p.speaking || (p.level || 0) > 0.02);
    }
  }

  function renderChat() {
    const box = el('meet-chat');
    if (!box) return;
    box.innerHTML =
      st.chat
        .map((m) => {
          const t = new Date(m.at);
          const hh = String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0');
          return `<div class="meet-msg ${m.mine ? 'mine' : ''}"><span class="mm-from">${esc(m.name)} ${hh}</span><span class="mm-text">${esc(m.text)}${netBadge(m)}</span></div>`;
        })
        .join('') || '<div class="meet-tip">还没有消息，打个招呼吧</div>';
    box.scrollTop = box.scrollHeight;
  }

  /* ---------------- 视图 ---------------- */

  function lobbyHtml() {
    return `
      <div class="nbox">
        <div class="nbox-t">开始一场异地自习</div>
        <div class="lobby-cards">
          <div class="lobby-card">
            <div class="lobby-t">👑 我来主持</div>
            <p class="lobby-d">创建房间，生成连接码发给朋友。</p>
            <div class="lobby-types">
              <button class="seg ${st.roomType === 'study' ? 'on' : ''}" data-net="type" data-type="study">📚 自习房</button>
              <button class="seg ${st.roomType === 'fun' ? 'on' : ''}" data-net="type" data-type="fun">🎉 娱乐房</button>
            </div>
            <div class="lobby-fun" id="lobby-fun" style="display:${st.roomType === 'fun' ? '' : 'none'}">
              <input type="range" id="lobby-min" min="10" max="120" step="10" value="30" class="range"/>
              <div class="lobby-fun-row"><b id="lobby-min-val">30</b> 分钟 · 消耗 <b id="lobby-cost">15</b> 积分</div>
            </div>
            <button class="btn" data-net="create">创建会议</button>
          </div>
          <div class="lobby-card">
            <div class="lobby-t">🙋 我要加入</div>
            <p class="lobby-d">粘贴房主的邀请码，生成回执码发回去。</p>
            <button class="btn ghost" data-net="join">粘贴邀请码</button>
          </div>
        </div>
      </div>
      <div class="nbox">
        <div class="nbox-t">连接方式说明</div>
        <p class="nbox-hint" style="margin-top:0">
          <b>不经过任何服务器</b>：连接码由你自己用微信/QQ 转发；连上之后聊天、语音、画面都是点对点直传，
          由 WebRTC 强制加密，不落在任何第三方机器上。STUN 默认关闭，完全不出公网。
        </p>
      </div>`;
  }

  /* 配对中转界面：已连上但还没进入房间 */
  function pairingHtml() {
    const isHost = st.mode === 'host';
    const ready = [...st.peers.values()].filter((p) => p.dc && p.dc.readyState === 'open').length;
    const canEnter = isHost || ready > 0;
    return `
      <div class="nbox">
        <div class="pair-head" style="border-bottom:none;padding-bottom:0">
          <span class="pair-room">房间 <b>${esc(st.code || '—')}</b></span>
          <span class="pair-badge ${st.roomType === 'fun' ? 'fun' : ''}">${st.roomType === 'fun' ? '🎉 娱乐房' : '📚 自习房'}</span>
          <span class="pair-n">已连接 <b>${ready}</b> 人</span>
          <button class="mbtn danger" data-net="leave" style="margin-left:auto">退出</button>
        </div>
      </div>

      <div class="nbox">
        <div class="nbox-t">第一步 · 互发连接码</div>
        <div class="pair-actions" style="margin:0 0 4px">
          ${
            isHost
              ? `<button class="btn small" data-net="invite">＋ 生成邀请码</button>
                 <button class="btn small ghost" data-net="apply">粘贴回执码</button>`
              : `<button class="btn small ghost" data-net="reply">重新粘贴邀请码</button>`
          }
        </div>
        <p class="nbox-hint" style="margin-top:8px">
          ${isHost ? '把邀请码发给朋友 → 朋友回传回执码 → 你点「粘贴回执码」即可连上。' : '把生成的回执码发回给房主，他粘贴后就连上了。'}
        </p>
        <div class="meet-code-box" id="net-code-box" style="display:none">
          <div class="meet-code-title" id="net-code-title"></div>
          <textarea class="net-code-text" id="net-code-text" readonly></textarea>
          <div class="meet-row">
            <button class="btn small" data-net="copy">复制</button>
            <span class="meet-tip" id="net-code-tip"></span>
          </div>
        </div>
      </div>

      <div class="nbox" style="text-align:center">
        <div class="nbox-t" style="justify-content:center">第二步 · 进入房间</div>
        ${
          ready > 0
            ? `<div class="pair-ok">✓ 已连上 ${ready} 人</div>`
            : isHost
              ? '<div class="pair-tip">可以先自己进房间等待，成员连上后会自动出现在格子里</div>'
              : '<div class="pair-tip">等待房主确认…</div>'
        }
        <button class="btn ${canEnter ? '' : 'ghost'}" data-net="enter" style="margin-top:10px;min-width:180px" ${canEnter ? '' : 'disabled'}>进入房间</button>
      </div>`;
  }

  function meetingHtml() {
    const isHost = st.mode === 'host';
    return `
      <div class="nbox" style="padding:10px 12px">
        <div class="meet-head" style="border-bottom:none;padding-bottom:0">
          <span class="meet-room">房间 <b>${esc(st.code || '—')}</b></span>
          <span class="pair-badge ${st.roomType === 'fun' ? 'fun' : ''}">${st.roomType === 'fun' ? '🎉 娱乐房' : '📚 自习房'}</span>
          <span class="meet-count">${st.peers.size + 1} 人</span>
          ${st.roomType === 'fun' ? '<span class="meet-fun" id="meet-fun-left">⏳ --:--</span>' : ''}
          <div class="meet-actions">
            ${isHost ? '<button class="mbtn" data-net="invite" title="邀请成员">＋邀请</button>' : ''}
            <button class="mbtn ${st.micOn ? 'on mic' : ''}" data-net="mic" title="${st.micOn ? '关闭麦克风' : '开启麦克风'}">${st.micOn ? '🎤' : '🔇'}</button>
            <button class="mbtn ${st.selfCam ? 'on' : ''}" data-net="cam" title="摄像头">📷</button>
            <button class="mbtn ${st.selfScr ? 'on' : ''}" data-net="scr" title="共享屏幕">🖥</button>
            <button class="mbtn" data-net="full" title="全屏">□</button>
            <button class="mbtn danger" data-net="leave" title="离开">✕</button>
          </div>
        </div>
        <div class="meet-code-box" id="net-code-box" style="display:none">
          <div class="meet-code-title" id="net-code-title"></div>
          <textarea class="net-code-text" id="net-code-text" readonly></textarea>
          <div class="meet-row">
            <button class="btn small" data-net="copy">复制</button>
            <span class="meet-tip" id="net-code-tip"></span>
          </div>
        </div>
      </div>

      <div class="meet-stage" id="meet-stage">${stageHtml()}</div>

      <div class="nbox">
        <div class="nbox-t">房间聊天</div>
        <div class="meet-ai" id="net-ai-bar">
          <span class="ai-force">🟢 闲聊雷达 · 强制开启</span>
          <span class="ai-chat-stat" id="net-ai-stat">等第一条消息</span>
          <span class="ai-chat-pen">闲聊攒到 3 条强制扣 2 分</span>
          <span class="ai-status" id="ai-status"></span>
        </div>
        <div class="ai-fb" id="ai-fb" hidden>
          <span class="ai-fb-t">🤖 刚才那帧真的是摸鱼吗？</span>
          <button class="btn small ghost" id="ai-fb-yes">确实是摸鱼</button>
          <button class="btn small ghost" id="ai-fb-no">我在学习（误判）</button>
        </div>
        <div class="meet-chat" id="meet-chat"></div>
        <div class="meet-row">
          <input class="input" id="net-chat-input" placeholder="说点什么…（回车发送）" maxlength="200" />
          <button class="btn small" data-net="send">发送</button>
        </div>
      </div>`;
  }

  function render() {
    const box = el('net-body');
    if (!box) return;
    if (!st.mode) box.innerHTML = lobbyHtml();
    else if (!st.entered) box.innerHTML = pairingHtml();
    else box.innerHTML = meetingHtml();
    bind();
    if (st.entered) {
      renderStage();
      renderChat();
      const lf = el('meet-fun-left');
      if (lf && st.funEndsAt) lf.textContent = '⏳ ' + fmtLeft(st.funEndsAt - Date.now());
    }
  }

  function showCode(title, text, tip) {
    const box = el('net-code-box');
    if (!box) return;
    box.style.display = '';
    el('net-code-title').textContent = title + '（' + text.length + ' 字符，复制发给对方）';
    el('net-code-text').value = text;
    el('net-code-tip').textContent = tip || '';
    el('net-code-text').focus();
    el('net-code-text').select();
  }

  function askCode(title, placeholder) {
    return new Promise((resolve) => {
      const mask = document.createElement('div');
      mask.className = 'modal-mask';
      mask.innerHTML = `
        <div class="modal" style="width:560px">
          <h2>${esc(title)}</h2>
          <p style="font-size:12px;color:var(--text-2);line-height:1.6">粘贴对方发来的那一段（以 z 开头），然后点确定。</p>
          <textarea class="net-code-text" id="ask-code" style="height:130px" placeholder="${esc(placeholder || '')}"></textarea>
          <div class="form-foot">
            <button class="btn ghost" data-r="0">取消</button>
            <button class="btn" data-r="1">确定</button>
          </div>
        </div>`;
      mask.addEventListener('click', (e) => {
        const r = e.target.closest('[data-r]')?.dataset.r;
        if (r === undefined && e.target !== mask) return;
        const v = (mask.querySelector('#ask-code') || {}).value || '';
        mask.remove();
        resolve(r === '1' ? v : '');
      });
      el('modal-root').appendChild(mask);
      setTimeout(() => mask.querySelector('#ask-code')?.focus(), 60);
    });
  }

  function bind() {
    const body = el('net-body');
    if (!body) return;
    body.querySelectorAll('[data-net]').forEach((b) => {
      const act = b.dataset.net;
      b.onclick = async () => {
        if (act === 'type') {
          st.roomType = b.dataset.type === 'fun' ? 'fun' : 'study';
          render();
          return;
        }
        if (act === 'create') {
          const mins = Number(el('lobby-min')?.value || 30);
          return create(st.roomType, mins);
        }
        if (act === 'join' || act === 'reply') {
          const code = await askCode('粘贴房主发来的邀请码', 'zH4sIA…');
          if (!code) return;
          return clientAcceptInvite(code);
        }
        if (act === 'invite') return hostInvite();
        if (act === 'apply') {
          const code = await askCode('粘贴对方发回来的回执码', 'zH4sIA…');
          if (!code) return;
          return hostApplyReply(code);
        }
        if (act === 'enter') return enterRoom();
        if (act === 'copy') {
          const t = el('net-code-text');
          if (!t) return;
          t.select();
          try {
            await navigator.clipboard.writeText(t.value);
            toast('已复制', '发到微信/QQ 给对方');
          } catch (_) {
            toast('复制失败', '请手动全选复制', true);
          }
          return;
        }
        if (act === 'mic') return toggleMic();
        if (act === 'cam') return toggleCam();
        if (act === 'scr') return toggleScr();
        if (act === 'send') {
          const inp = el('net-chat-input');
          if (inp) {
            sendChat(inp.value);
            inp.value = '';
          }
          return;
        }
        if (act === 'full') {
          const m = el('net-mask');
          if (!m) return;
          try {
            if (document.fullscreenElement) await document.exitFullscreen();
            else await m.requestFullscreen();
          } catch (e) {
            toast('无法进入全屏', String((e && e.message) || e), true);
          }
          return;
        }
        if (act === 'leave') return leave();
      };
    });

    // 娱乐房时长滑块
    const range = el('lobby-min');
    if (range) {
      const upd = () => {
        const mins = Number(range.value);
        const lv = el('lobby-min-val');
        const cost = el('lobby-cost');
        if (lv) lv.textContent = mins;
        if (cost) cost.textContent = 15 * Math.ceil(mins / 30);
      };
      range.oninput = upd;
      upd();
    }

    const inp = el('net-chat-input');
    if (inp) {
      inp.onkeydown = (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          sendChat(inp.value);
          inp.value = '';
        }
      };
    }
  }

  function openPanel(type) {
    if (type === 'fun') st.roomType = 'fun';
    else if (type === 'study') st.roomType = 'study';
    let mask = el('net-mask');
    if (mask) return;
    mask = document.createElement('div');
    mask.id = 'net-mask';
    mask.className = 'modal-mask';
    mask.innerHTML = `
      <div class="modal meet-modal">
        <div class="meet-top">
          <h2>🌐 异地联机 · 点对点</h2>
          <button class="mbtn" id="meet-close" title="关闭">✕</button>
        </div>
        <p class="meet-sub">不经服务器 · 用微信传连接码 · 数据与语音直连加密</p>
        <div id="net-body"></div>
      </div>`;
    mask.addEventListener('click', (e) => {
      if (e.target === mask) closePanel();
    });
    el('modal-root').appendChild(mask);
    el('meet-close').onclick = closePanel;
    st.open = true;
    render();
  }

  /* 独立窗口挂载（net.html）：直接渲染到页面里的 #net-body，不套 modal */
  function mount(type) {
    if (type === 'fun') st.roomType = 'fun';
    else if (type === 'study') st.roomType = 'study';
    st.open = true;
    render();
  }

  function closePanel() {
    const m = el('net-mask');
    if (m) m.remove();
    st.open = false;
    leave();
  }

  /* 定时刷新画面（超过 8 秒没有新帧自动收回成头像） */
  setInterval(() => {
    if (st.open && st.entered) renderStage();
  }, 2000);

  /* AI 钩子：异地房聊天广播 / 抓包回调 / 徽章改判 / 纠错按钮 */
  function installAiHooks() {
    window.pqSay = (text) => {
      try {
        if (st.entered) sendChat(text);
      } catch (_) {}
    };
    window.onAIWatched = () => {
      if (st.entered) showAiFeedback();
    };
    // 装载「我的模型」（默认官方模型），异地房与主窗口共用同一套样本/模型
    try {
      if (window.AITrain) window.AITrain.applyActive();
      if (window.AIChat && window.AIChat.preload) window.AIChat.preload();
    } catch (_) {}
    document.addEventListener('click', (e) => {
      const id = e.target && e.target.id;
      if (id === 'ai-fb-yes') return saveAiFeedback(1);
      if (id === 'ai-fb-no') return saveAiFeedback(0);
      fixNetBadge(e);
    });
  }

  return {
    installAiHooks,
    openPanel,
    mount,
    closePanel,
    create,
    leave,
    sendChat,
    myState,
    _internal: {
      state: st,
      hostInvite,
      hostApplyReply,
      clientAcceptInvite,
      enterRoom,
      toggleMic,
      peers: () => [...st.peers.keys()],
      chatOf: () => st.chat.slice(),
      framesOf: () => [...frames.keys()],
    },
  };
})();

window.pqNet = PQ_NET;

try {
  PQ_NET.installAiHooks();
} catch (_) {}
