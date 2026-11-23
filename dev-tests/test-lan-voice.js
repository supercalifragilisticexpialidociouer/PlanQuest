/* 局域网语音（WebRTC 点对点）联调测试
 * 起两个独立实例：A 开自习房，B 用 127.0.0.1 + 房间码加入，
 * 双方开语音后检查：信令中继是否通、RTCPeerConnection 是否 connected。
 * 用 WebAudio 生成静音音轨，避免依赖真实麦克风。
 * 用法：node dev-tests/test-lan-voice.js
 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const PORTS = [9331, 9332];
const TAGS = ['lanvA-' + Date.now().toString(36), 'lanvB-' + Date.now().toString(36)];
const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function check(name, cond, extra) {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra !== undefined ? '  → ' + JSON.stringify(extra) : ''}`);
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let s = '';
      res.on('data', (c) => (s += c));
      res.on('end', () => { try { resolve(JSON.parse(s)); } catch (_) { resolve([]); } });
    }).on('error', reject);
  });
}

async function findPage(port) {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await getJson(`http://127.0.0.1:${port}/json`);
      const page = list.find((t) => t.type === 'page' && /index\.html/i.test(t.url)) || list.find((t) => t.type === 'page');
      if (page) return page;
    } catch (_) {}
    await sleep(500);
  }
  throw new Error('CDP 页面未找到 ' + port);
}

function makeClient(wsUrl) {
  return new Promise((resolve, reject) => {
    const state = { ws: null, id: 0, pending: new Map() };
    const ws = new WebSocket(wsUrl);
    state.ws = ws;
    ws.onopen = () => resolve(state);
    ws.onerror = () => reject(new Error('WS 连接失败'));
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && state.pending.has(m.id)) {
        const { resolve: r, reject: j } = state.pending.get(m.id);
        state.pending.delete(m.id);
        if (m.error) j(new Error(m.error.message));
        else r(m.result);
      }
    };
  });
}

async function evalJs(c, expr) {
  const id = ++c.id;
  const p = new Promise((resolve, reject) => c.pending.set(id, { resolve, reject }));
  c.ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }));
  const r = await p;
  if (r.exceptionDetails) throw new Error('页面异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result?.value;
}

function launch(tag, port) {
  const udir = path.join(os.homedir(), 'AppData', 'Roaming', 'PlanQuest-' + tag);
  fs.rmSync(udir, { recursive: true, force: true });
  const bin = process.platform === 'win32'
    ? path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
    : path.join(ROOT, 'node_modules', '.bin', 'electron');
  const env = { ...process.env, PQ_USERDATA: tag, PQ_EYE_INT_MS: '3600000' };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  return spawn(bin, ['.', '--force-new', `--remote-debugging-port=${port}`], { cwd: ROOT, env, stdio: 'ignore' });
}

const MIC_JS = `
(() => {
  const ctx = new AudioContext();
  const dst = ctx.createMediaStreamDestination();
  const osc = ctx.createOscillator();
  osc.frequency.value = 440;
  const gain = ctx.createGain();
  gain.gain.value = 0.02;
  osc.connect(gain).connect(dst);
  osc.start();
  window.__pqTestCtx = ctx;
  lanVoice.stream = dst.stream;
  lanVoice.on = true;
  roomJoined = true;
  syncLanVoicePeers(true);
  return true;
})()
`;

async function peerState(c) {
  return evalJs(c, `(() => {
    const arr = [...lanVoice.peers.values()];
    return { count: arr.length, states: arr.map(p => p.pc.connectionState), hasTrack: arr.map(p => !!p.audio) };
  })()`);
}

async function main() {
  const procs = [launch(TAGS[0], PORTS[0]), launch(TAGS[1], PORTS[1])];
  const pageA = await findPage(PORTS[0]);
  const pageB = await findPage(PORTS[1]);
  const A = await makeClient(pageA.webSocketDebuggerUrl);
  const B = await makeClient(pageB.webSocketDebuggerUrl);
  await sleep(3000);

  // A 建房
  const created = await evalJs(A, `api.roomCreate({ name: 'A', avatar: '🙂', type: 'study' })`);
  check('A 创建自习房', created && created.ok, created && { code: created.code, port: created.port });
  if (!created || !created.ok) throw new Error('建房失败：' + JSON.stringify(created));

  // B 加入
  const joined = await evalJs(B, `api.roomJoin({ ip: '127.0.0.1', port: ${created.port}, code: '${created.code}', name: 'B', avatar: '🐱' })`);
  check('B 加入房间', joined && joined.ok, joined && { yourId: joined.yourId });
  if (!joined || !joined.ok) throw new Error('加入失败：' + JSON.stringify(joined));

  await sleep(2500);
  const sa = await evalJs(A, `api.getState()`);
  const sb = await evalJs(B, `api.getState()`);
  check('A 看到自己在房间', sa.room && sa.room.inRoom === true, sa.room && { myId: sa.room.myId, code: sa.room.code });
  check('B 看到自己在房间', sb.room && sb.room.inRoom === true, sb.room && { myId: sb.room.myId });

  // 双方开语音
  await evalJs(A, MIC_JS);
  await evalJs(B, MIC_JS);
  await sleep(1200);
  // 再同步一次（成员列表就绪后补建）
  await evalJs(A, `syncLanVoicePeers()`);
  await evalJs(B, `syncLanVoicePeers()`);

  // 等待 P2P 连接建立
  let pa = { count: 0, states: [] };
  let pb = { count: 0, states: [] };
  for (let i = 0; i < 24; i++) {
    pa = await peerState(A);
    pb = await peerState(B);
    if (pa.states.includes('connected') && pb.states.includes('connected')) break;
    await sleep(500);
  }
  check('A 与 B 互相建立了 1 条连接', pa.count === 1 && pb.count === 1, { a: pa.count, b: pb.count });
  check('A 侧语音连接 connected', pa.states.includes('connected'), pa.states);
  check('B 侧语音连接 connected', pb.states.includes('connected'), pb.states);

  // 收到远端音轨（说明音频真的在传）
  await sleep(1500);
  const remote = await evalJs(A, `(() => [...lanVoice.peers.values()].map(p => ({ hasAudioEl: !!p.audio, track: !!(p.audio && p.audio.srcObject) })))()`);
  check('A 收到 B 的音轨', Array.isArray(remote) && remote[0] && remote[0].track === true, remote);

  // 关麦应清理连接
  await evalJs(B, `lanVoiceStop(true)`);
  await sleep(600);
  const pb2 = await peerState(B);
  check('B 关麦后连接清空', pb2.count === 0, pb2);

  await evalJs(A, `api.roomLeave()`);
  await evalJs(B, `api.roomLeave()`);

  const pass = results.filter((r) => r.ok).length;
  console.log(`\n${pass}/${results.length} PASS`);
  procs.forEach((p) => { try { p.kill(); } catch (_) {} });
  process.exit(pass === results.length ? 0 : 1);
}

main().catch((e) => {
  console.error('测试异常:', e.message);
  process.exit(1);
});
