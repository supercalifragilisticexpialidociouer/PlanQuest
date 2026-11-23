/* 网页版 AI 盯学测试：静态服务器 + Chrome headless CDP
 * 验证 https 场景下的 fetch 模型加载路径（与安卓 WebView 相同机制）。
 * 用法：node dev-tests/test-web-ai.js
 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const WEB_PORT = 8791;
const CDP_PORT = 9227;
let chrome = null;
let server = null;
let ws = null;
let msgId = 0;
const pending = new Map();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
      const list = await getJson(`http://127.0.0.1:${CDP_PORT}/json`);
      const page = list.find((t) => t.type === 'page');
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
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra !== undefined ? '  → ' + JSON.stringify(extra) : ''}`);
}

const CLASSIFY_FN = `
window.__aiClassify = async (dataUrl) => {
  const ort = window.ort;
  if (!ort) throw new Error('window.ort 未加载');
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('图片加载失败')); img.src = dataUrl; });
  const S = 256;
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
    const res = await fetch('vendor/pq-ai/best.onnx');
    if (!res.ok) throw new Error('模型 fetch 失败 ' + res.status);
    window.__sess = await ort.InferenceSession.create(new Uint8Array(await res.arrayBuffer()), { executionProviders: ['wasm'] });
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
  const webDir = path.join(root, 'web');

  // 1. 静态服务器
  server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(req.url.split('?')[0]);
    let fp = path.join(webDir, urlPath === '/' ? 'index.html' : urlPath);
    if (!fp.startsWith(webDir)) { res.writeHead(403); return res.end(); }
    fs.readFile(fp, (err, buf) => {
      if (err) { res.writeHead(404); return res.end('nf'); }
      const ext = path.extname(fp).toLowerCase();
      const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.onnx': 'application/octet-stream', '.wasm': 'application/wasm', '.mjs': 'text/javascript' }[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': mime });
      res.end(buf);
    });
  }).listen(WEB_PORT);

  // 2. Chrome headless
  const chromeBin = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const prof = path.join(require('os').tmpdir(), 'pq-web-ai-test-' + Date.now());
  chrome = spawn(chromeBin, [
    '--headless=new', '--disable-gpu', '--no-first-run',
    `--user-data-dir=${prof}`,
    `--remote-debugging-port=${CDP_PORT}`,
    `--use-fake-ui-for-media-stream`, `--use-fake-device-for-media-stream`,
    `http://127.0.0.1:${WEB_PORT}/`,
  ], { stdio: 'ignore' });

  const page = await findPage();
  await connect(page.webSocketDebuggerUrl);
  await sleep(3000);

  const envCheck = await evalJs(`({ ort: typeof window.ort !== 'undefined', ai: typeof window.AIWatch !== 'undefined', api: typeof window.api.aiPenalty === 'function' })`);
  check('window.ort 已加载', envCheck.ort === true, envCheck);
  check('AIWatch 模块已加载', envCheck.ai === true, envCheck);
  check('api.aiPenalty 接口存在', envCheck.api === true, envCheck);

  // 推理（走 fetch 加载模型 —— 与安卓 WebView 同路径）
  await evalJs(CLASSIFY_FN);
  const slack = await evalJs(`window.__aiClassify(${JSON.stringify(toDataUrl(path.join(root, 'model-pack', 'samples', 'sample_slacking.jpg')))})`);
  check('样例「摸鱼」判定为摸鱼', slack && slack.fish > slack.good, slack);
  const diligent = await evalJs(`window.__aiClassify(${JSON.stringify(toDataUrl(path.join(root, 'model-pack', 'samples', 'sample_diligent.jpg')))})`);
  check('样例「认真」判定为认真', diligent && diligent.good > diligent.fish, diligent);

  // aiPenalty 扣分
  const before = (await evalJs(`api.getState()`)).profile.points || 0;
  const p1 = await evalJs(`api.aiPenalty(-2)`);
  check('aiPenalty 扣 2 分', p1 && p1.ok && p1.points === before - 2, { before, after: p1 && p1.points });

  // AIWatch 状态机
  const guard = await evalJs(`(function(){ let n = 0; const o = window.toast; window.toast = () => n++; AIWatch.start(() => null); window.toast = o; return { running: AIWatch.isRunning(), toasts: n }; })()`);
  check('无摄像头时拒绝启动并提示', guard && !guard.running && guard.toasts >= 1, guard);

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${failed === 0 ? '✅ 全部通过' : '❌ 有 ' + failed + ' 项失败'}（共 ${results.length} 项）`);
}

main()
  .catch((e) => {
    console.error('测试异常:', e.message);
    process.exitCode = 1;
  })
  .finally(() => {
    try { if (chrome) chrome.kill(); } catch (_) {}
    try { if (server) server.close(); } catch (_) {}
    setTimeout(() => process.exit(process.exitCode || 0), 500);
  });
