/* 测试：AI 闲聊雷达（文本分类）——分词一致性 + 判定一致率
 * 用法：node dev-tests/test-ai-chat.js
 * 参考结果由 tools/make_text_ref.py 生成（HF 原模型 fp32 + Python tokenizer）
 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = 9227;
const UDATA = 'aiT-' + Date.now().toString(36);
let child = null;
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
      const list = await getJson(`http://127.0.0.1:${PORT}/json`);
      const page = list.find((t) => t.type === 'page' && /index\.html/i.test(t.url)) || list.find((t) => t.type === 'page');
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
  const ref = JSON.parse(fs.readFileSync(path.join(__dirname, 'text-ref.json'), 'utf8'));
  const root = path.resolve(__dirname, '..');
  const udir = path.join(os.homedir(), 'AppData', 'Roaming', 'PlanQuest-' + UDATA);
  fs.rmSync(udir, { recursive: true, force: true });

  const electronBin = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
  const env = { ...process.env, PQ_USERDATA: UDATA, PQ_EYE_INT_MS: '3600000' };
  delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(electronBin, ['.', `--remote-debugging-port=${PORT}`], { cwd: root, env, stdio: 'ignore' });

  const page = await findPage();
  await connect(page.webSocketDebuggerUrl);
  await sleep(2500);

  const envCheck = await evalJs(`({ ai: typeof window.AIChat !== 'undefined', read: typeof window.api.readVendorFile === 'function' })`);
  check('AIChat 模块已加载', envCheck.ai === true, envCheck);
  check('preload 提供 readVendorFile', envCheck.read === true, envCheck);

  // 分词一致性（先预热模型，加载词表）
  const tokCompare = await evalJs(`(async () => {
    await AIChat.preload();
    const ref = ${JSON.stringify(ref.map((r) => ({ t: r.text, ids: r.ids })))};
    const bad = [];
    for (const r of ref) {
      const got = AIChat._encode(r.t).ids;
      const same = got.length === r.ids.length && got.every((v, i) => v === r.ids[i]);
      if (!same) bad.push({ text: r.t, exp: r.ids.slice(0, 20), got: got.slice(0, 20) });
    }
    return { total: ref.length, bad: bad.slice(0, 5), badCount: bad.length };
  })()`);
  check(`分词与 Python 完全一致 (${tokCompare.total - tokCompare.badCount}/${tokCompare.total})`, tokCompare.badCount === 0, tokCompare.bad);

  // 逐句判定
  const verdict = await evalJs(`(async () => {
    const ref = ${JSON.stringify(ref.map((r) => ({ t: r.text, p: r.pFish, l: r.label })))};
    const rows = [];
    const t0 = performance.now();
    for (const r of ref) {
      const out = await AIChat.classify(r.t);
      rows.push({ t: r.t, p: out.p, l: out.label, rp: r.p, rl: r.l });
    }
    const ms = (performance.now() - t0) / ref.length;
    return { rows, ms: Math.round(ms * 10) / 10 };
  })()`);

  const rows = verdict.rows;
  const labelSame = rows.filter((r) => r.l === r.rl).length;
  const pDiff = rows.map((r) => Math.abs(r.p - r.rp));
  const maxDiff = Math.max(...pDiff);
  const avgDiff = pDiff.reduce((a, b) => a + b, 0) / pDiff.length;
  // int8 量化 vs fp32 参考：只要求 97% 以上一致（阈值边界句会翻转，属正常）
  check(`判定标签与参考一致 ≥97% (${labelSame}/${rows.length})`, labelSame / rows.length >= 0.97, rows.filter((r) => r.l !== r.rl).slice(0, 3));
  check(`概率平均偏差 < 0.05 (avg=${avgDiff.toFixed(3)}, max=${maxDiff.toFixed(3)})`, avgDiff < 0.05, { max: +maxDiff.toFixed(3) });
  check(`单句耗时 < 400ms (实测 ${verdict.ms}ms)`, verdict.ms < 400, verdict.ms);

  // 典型句抽查
  const spot = await evalJs(`(async () => {
    const cases = [
      ['今晚加班到十点，方案还得再改一版', 'work'],
      ['哈哈哈哈这个视频笑死我了，太好笑了', 'fish'],
      ['车间设备的保养记录我整理好了，明天发你', 'work'],
      ['兄弟们上号，今晚通宵', 'fish'],
    ];
    const out = [];
    for (const [t, exp] of cases) {
      const r = await AIChat.classify(t);
      out.push({ t, exp, got: r.label, p: Math.round(r.p * 100) / 100 });
    }
    return out;
  })()`);
  const spotOk = spot.filter((s) => s.got === s.exp).length;
  check(`典型句 4 例判定 (${spotOk}/4)`, spotOk >= 3, spot);
  console.log('   抽查明细:', JSON.stringify(spot, null, 0));

  const failed = results.filter((r) => !r.ok);
  console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`);
  child.kill();
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error('ERR', e.message);
  if (child) child.kill();
  process.exit(1);
});
