/* 局域网语音信令链路探针：抓两边 room:event 与 roomMembers */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const PORTS = [9341, 9342];
const TAGS = ['dbgA-' + Date.now().toString(36), 'dbgB-' + Date.now().toString(36)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  const bin = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
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
  window.__ev = [];
  api.onRoom((e) => window.__ev.push({ t: e.type, from: e.from, k: e.data && e.data.t, raw: (function(){ try { return JSON.stringify(e.data); } catch(x) { return 'ERR:'+x.message; } })() }));
  lanVoice.stream = dst.stream;
  lanVoice.on = true;
  roomJoined = true;
  syncLanVoicePeers(true);
  return true;
})()
`;

const DUMP = `(() => ({
  myId: state && state.room && state.room.myId,
  members: (roomMembers || []).map(m => ({ id: m.id, name: m.name, self: !!m.self })),
  peers: [...lanVoice.peers.entries()].map(([id, p]) => ({ id, s: p.pc.connectionState, sig: p.pc.signalingState, remoteSet: !!p.remoteSet, ice: p.pc.iceConnectionState })),
  ev: (window.__ev || []).filter(e => e.t === 'rtc').slice(0,3),
}))()`;

async function main() {
  const procs = [launch(TAGS[0], PORTS[0]), launch(TAGS[1], PORTS[1])];
  const A = await makeClient((await findPage(PORTS[0])).webSocketDebuggerUrl);
  const B = await makeClient((await findPage(PORTS[1])).webSocketDebuggerUrl);
  await sleep(3000);

  const created = await evalJs(A, `api.roomCreate({ name: 'A', avatar: '🙂', type: 'study' })`);
  console.log('create', created);
  const joined = await evalJs(B, `api.roomJoin({ ip: '127.0.0.1', port: ${created.port}, code: '${created.code}', name: 'B', avatar: '🐱' })`);
  console.log('join', joined);
  await sleep(2500);

  await evalJs(A, MIC_JS);
  await evalJs(B, MIC_JS);
  await sleep(1500);
  await evalJs(A, `syncLanVoicePeers()`);
  await evalJs(B, `syncLanVoicePeers()`);
  await sleep(4000);

  console.log('\n--- A (host) ---');
  console.log(JSON.stringify(await evalJs(A, DUMP), null, 1));
  console.log('\n--- B (client) ---');
  console.log(JSON.stringify(await evalJs(B, DUMP), null, 1));

  await evalJs(A, `api.roomLeave()`).catch(() => {});
  await evalJs(B, `api.roomLeave()`).catch(() => {});
  procs.forEach((p) => { try { p.kill(); } catch (_) {} });
  process.exit(0);
}

main().catch((e) => { console.error('异常:', e.message); process.exit(1); });
