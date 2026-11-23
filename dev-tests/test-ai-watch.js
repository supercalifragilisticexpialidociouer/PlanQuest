/* 冒烟测试：AI 盯学（摸鱼/认真 ONNX 模型）+ ai:penalty 扣分接口
 * 用法：node dev-tests/test-ai-watch.js
 * 原理：启动独立 userData 的 Electron 实例（CDP 9223），
 *      在渲染层用样例图跑 onnxruntime-web 推理，验证分类正确；再直测 IPC 扣分。
 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = 9224;
const UDATA = 'aiA-' + Date.now().toString(36);
let child = null;
let ws = null;
let msgId = 0;
const pending = new Map();

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let s = '';
      res.on('data', (c) => (s += c));
      res.on('end', () => { try { resolve(JSON.parse(s)); } catch (e) { resolve([]); } });
    }).on('error', reject);
  });
}

async function findPage() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await getJson(`http://127.0.0.1:${PORT}/json`);
      const page = list.find((t) => t.type === 'page' && /index\.html|app\.html/i.test(t.url)) || list.find((t) => t.type === 'page');
      if (page) return page;
    } catch (_) {}
    await sleep(500);
  }
  throw new Error('CDP 页面未找到');
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    ws = new WebSocket(wsUrl);
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('WS 连接失败'));
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        const { resolve, reject } = pending.get(m.id);
        pending.delete(m.id);
        if (m.error) reject(new Error(m.error.message));
        else resolve(m.result);
      }
    };
  });
}

async function evalJs(expr) {
  const id = ++msgId;
  const p = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }));
  const r = await p;
  if (r.exceptionDetails) throw new Error('页面异常: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result?.value;
}

const results = [];
function check(name, cond, extra) {
  results.push({ name, ok: !!cond, extra });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra !== undefined ? '  → ' + JSON.stringify(extra) : ''}`);
}

const CLASSIFY_FN = `
window.__aiClassify = async (dataUrl) => {
  const ort = window.ort;
  if (!ort) throw new Error('window.ort 未加载');
  ort.env.wasm.proxy = false;
  ort.env.wasm.numThreads = 1;
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('图片加载失败')); img.src = dataUrl; });
  const S = 224;
  const c = document.createElement('canvas'); c.width = S; c.height = S;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  const side = Math.min(img.width, img.height);
  ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, S, S);
  const d = ctx.getImageData(0, 0, S, S).data;
  const n = S * S;
  const planes = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    planes[i] = d[i * 4] / 255;
    planes[n + i] = d[i * 4 + 1] / 255;
    planes[2 * n + i] = d[i * 4 + 2] / 255;
  }
  if (!window.__sess) {
    if (!window.__PQ_MODEL_B64) throw new Error('内嵌模型缺失');
    const b64 = window.__PQ_MODEL_B64;
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    if (!ort.env.wasm.wasmBinary && window.__ORT_WASM_B64) {
      const wb = atob(window.__ORT_WASM_B64);
      const wbBytes = new Uint8Array(wb.length);
      for (let i = 0; i < wb.length; i++) wbBytes[i] = wb.charCodeAt(i);
      ort.env.wasm.wasmBinary = wbBytes;
    }
    window.__sess = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'] });
  }
  const out = await window.__sess.run({ images: new ort.Tensor('float32', planes, [1, 3, S, S]) });
  const p = Array.from(out.output0.data);
  return { fish: p[0], good: p[1] };
};
true;
`;

function toDataUrl(file) {
  return 'data:image/jpeg;base64,' + fs.readFileSync(file).toString('base64');
}

async function main() {
  const root = path.resolve(__dirname, '..');
  const udir = path.join(os.homedir(), 'AppData', 'Roaming', 'PlanQuest-' + UDATA);
  fs.rmSync(udir, { recursive: true, force: true });

  const electronBin = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
  const childEnv = { ...process.env, PQ_USERDATA: UDATA, PQ_EYE_INT_MS: '3600000' };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  child = spawn(electronBin, ['.', `--remote-debugging-port=${PORT}`], {
    cwd: root, env: childEnv, stdio: 'ignore', detached: false,
  });

  const page = await findPage();
  await connect(page.webSocketDebuggerUrl);
  await sleep(2500);

  // 1. 运行时加载
  const envCheck = await evalJs(`({ ort: typeof window.ort !== 'undefined', ai: typeof window.AIWatch !== 'undefined', api: typeof window.api.aiPenalty === 'function' })`);
  check('window.ort 已加载', envCheck.ort === true, envCheck);
  check('AIWatch 模块已加载', envCheck.ai === true, envCheck);
  check('api.aiPenalty 接口存在', envCheck.api === true, envCheck);

  // 2. 样例图推理（模型包 README 基准：摸鱼 1.0000 / 认真 0.9994）
  await evalJs(CLASSIFY_FN);
  const slack = await evalJs(`window.__aiClassify(${JSON.stringify(toDataUrl(path.join(root, 'model-pack', 'samples', 'sample_slacking.jpg')))})`);
  check('样例「摸鱼」图判定为摸鱼', slack && slack.fish > slack.good, slack);
  check('摸鱼置信度 > 0.9', slack && slack.fish > 0.9, slack && slack.fish);

  const diligent = await evalJs(`window.__aiClassify(${JSON.stringify(toDataUrl(path.join(root, 'model-pack', 'samples', 'sample_diligent.jpg')))})`);
  check('样例「认真」图判定为认真', diligent && diligent.good > diligent.fish, diligent);
  check('认真置信度 > 0.9', diligent && diligent.good > 0.9, diligent && diligent.good);

  // 3. ai:penalty 扣分（允许负分）
  const before = (await evalJs(`api.getState()`)).profile.points || 0;
  const p1 = await evalJs(`api.aiPenalty(-2)`);
  check('aiPenalty 扣 2 分', p1 && p1.ok && p1.points === before - 2, { before, after: p1 && p1.points });
  const p2 = await evalJs(`api.aiPenalty(-2)`);
  const st = await evalJs(`api.getState()`);
  check('连续扣分并同步 state', p2.ok && st.profile.points === before - 4, st.profile.points);
  const gi = await evalJs(`api.guardInfo()`);
  check('守护模块同步扣分', gi && Number(gi.points) === before - 4, gi && gi.points);
  // 越界钳制：单次最多 -100，正数忽略
  const p3 = await evalJs(`api.aiPenalty(-99999)`);
  check('单次扣分上限 -100', p3.ok && p3.points === before - 104, p3.points);
  const p4 = await evalJs(`api.aiPenalty(50)`);
  check('正数增量被忽略（只罚不奖）', p4.ok && p4.points === before - 104, p4.points);

  // 4. AIWatch 状态机：未开摄像头时 start 应被拦截（无 roomJoined 场景）
  const guard = await evalJs(`(function(){ let toasts = 0; const orig = window.toast; window.toast = () => { toasts++; }; AIWatch.start(() => null); window.toast = orig; return { running: AIWatch.isRunning(), toasts }; })()`);
  check('未开摄像头时拒绝启动并提示', guard && !guard.running && guard.toasts >= 1, guard);

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${failed === 0 ? '✅ 全部通过' : '❌ 有 ' + failed + ' 项失败'}（共 ${results.length} 项）`);
}

main()
  .catch((e) => {
    console.error('测试异常:', e.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await evalJs(`true`);
    } catch (_) {}
    try {
      if (child) child.kill();
    } catch (_) {}
    setTimeout(() => process.exit(process.exitCode || 0), 500);
  });
