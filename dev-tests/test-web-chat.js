/* 网页/安卓 共用加载路径测试：https 下 fetch 加载编码器 + 文本判定
 * 用法：node dev-tests/test-web-chat.js
 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const WEB_PORT = 8793;
const CDP_PORT = 9229;
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

async function main() {
  const root = path.resolve(__dirname, '..');
  const webDir = path.join(root, 'web');
  server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(req.url.split('?')[0]);
    const fp = path.join(webDir, urlPath === '/' ? 'index.html' : urlPath);
    if (!fp.startsWith(webDir)) { res.writeHead(403); return res.end(); }
    fs.readFile(fp, (err, buf) => {
      if (err) { res.writeHead(404); return res.end('nf'); }
      const ext = path.extname(fp).toLowerCase();
      const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.onnx': 'application/octet-stream', '.wasm': 'application/wasm', '.mjs': 'text/javascript', '.txt': 'text/plain' }[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': mime });
      res.end(buf);
    });
  }).listen(WEB_PORT);

  const chromeBin = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const prof = path.join(os.tmpdir(), 'pq-web-chat-' + Date.now());
  chrome = spawn(chromeBin, [
    '--headless=new', '--disable-gpu', '--no-first-run',
    `--user-data-dir=${prof}`,
    `--remote-debugging-port=${CDP_PORT}`,
    `http://127.0.0.1:${WEB_PORT}/`,
  ], { stdio: 'ignore' });

  const page = await findPage();
  await connect(page.webSocketDebuggerUrl);
  await sleep(3000);

  const env = await evalJs(`({ ai: typeof window.AIChat !== 'undefined', readVendor: typeof (window.api && window.api.readVendorFile) })`);
  check('AIChat 已加载', env.ai === true, env);
  check('网页版无 readVendorFile（走 fetch 路径）', env.readVendor === 'undefined', env);

  const out = await evalJs(`(async () => {
    const t0 = performance.now();
    await AIChat.preload();
    const boot = Math.round(performance.now() - t0);
    const cases = [
      ['今晚加班到十点，方案还得再改一版', 'work'],
      ['哈哈哈哈这个视频笑死我了，太好笑了', 'fish'],
      ['兄弟们上号，今晚通宵', 'fish'],
      ['客户那边催得急，今天必须把图出完', 'work'],
    ];
    const rows = [];
    for (const [t, exp] of cases) {
      const r = await AIChat.classify(t);
      rows.push({ t, exp, got: r.label, p: Math.round(r.p * 100) / 100 });
    }
    return { boot, rows, status: AIChat.status() };
  })()`);
  check('模型预热完成（fetch 加载 30MB 编码器）', out.status && out.status.ready === true, { boot_ms: out.boot, status: out.status });
  const ok = out.rows.filter((r) => r.got === r.exp).length;
  check(`网页端判定正确 (${ok}/4)`, ok >= 3, out.rows);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`);
  if (chrome) chrome.kill();
  server.close();
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error('ERR', e.message);
  if (chrome) chrome.kill();
  if (server) server.close();
  process.exit(1);
});
