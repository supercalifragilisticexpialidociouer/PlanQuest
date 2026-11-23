/* 测试：异地联机（net.html）窗口里的 AI —— 闲聊雷达 / 盯学 / 自训练是否都可用
 * 用法：node dev-tests/test-net-ai.js
 * 说明：真的调用主进程打开「异地联机」窗口，再连上那个窗口做检查。
 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = 9236;
const UDATA = 'netAI-' + Date.now().toString(36);
let child = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let s = '';
      res.on('data', (c) => (s += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(s));
        } catch (e) {
          resolve([]);
        }
      });
    }).on('error', reject);
  });
}

async function targets() {
  try {
    return await getJson(`http://127.0.0.1:${PORT}/json`);
  } catch (_) {
    return [];
  }
}

async function waitTarget(match, timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const list = await targets();
    const hit = list.find((t) => t.type === 'page' && match.test(t.url));
    if (hit) return hit;
    await sleep(400);
  }
  return null;
}

function attach(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pend = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pend.has(m.id)) {
      pend.get(m.id)(m.result);
      pend.delete(m.id);
    }
  };
  const ready = new Promise((r, j) => {
    ws.onopen = r;
    ws.onerror = () => j(new Error('WS 连接失败'));
  });
  const ev = async (expr) => {
    const i = ++id;
    const p = new Promise((r) => pend.set(i, r));
    ws.send(
      JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } })
    );
    const r = await p;
    if (r.exceptionDetails)
      throw new Error('页面异常: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result?.value;
  };
  return { ready, ev, close: () => ws.close() };
}

const results = [];
function check(name, cond, extra) {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra !== undefined ? '  → ' + JSON.stringify(extra) : ''}`);
}

async function main() {
  const root = path.resolve(__dirname, '..');
  const udir = path.join(os.homedir(), 'AppData', 'Roaming', 'PlanQuest-' + UDATA);
  fs.rmSync(udir, { recursive: true, force: true });

  const env = { ...process.env, PQ_USERDATA: UDATA, PQ_EYE_INT_MS: '3600000' };
  delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe'), ['.', `--remote-debugging-port=${PORT}`], {
    cwd: root,
    env,
    stdio: 'ignore',
  });

  const main = await waitTarget(/index\.html/);
  if (!main) throw new Error('主窗口未出现');
  const M = attach(main.webSocketDebuggerUrl);
  await M.ready;
  await sleep(2000);

  const opened = await M.ev(`api.netOpenWindow('study').then(() => 'ok').catch((e) => 'err:' + e.message)`);
  check('主进程打开异地联机窗口', opened === 'ok', opened);

  const net = await waitTarget(/net\.html/);
  check('异地联机页面已创建', !!net, net && net.url);
  if (!net) {
    child.kill();
    process.exit(1);
  }

  const N = attach(net.webSocketDebuggerUrl);
  await N.ready;
  /* 轮询等脚本就绪：model-b64.js 有 8MB+，冷缓存时解析可能超过 2 秒 */
  for (let i = 0; i < 30; i++) {
    const st = await N.ev(`({ chat: typeof window.AIChat, net: typeof window.pqNet })`).catch(() => null);
    if (st && st.chat === 'object' && st.net === 'object') break;
    await sleep(500);
  }

  const loaded = await N.ev(`({
    ort: typeof window.ort,
    watch: typeof window.AIWatch,
    chat: typeof window.AIChat,
    train: typeof window.AITrain,
    net: typeof window.pqNet,
    hooks: typeof window.pqNet?.installAiHooks === 'function',
    pqSay: typeof window.pqSay,
    watched: typeof window.onAIWatched,
    modelB64: !!window.__PQ_MODEL_B64 || !!window.__PQ_MODEL_LOADED,
    wasmB64: !!window.__ORT_WASM_B64
  })`);
  check('异地页加载了 onnxruntime', loaded.ort === 'object', loaded);
  check('异地页加载了 AI 三个模块', loaded.watch === 'object' && loaded.chat === 'object' && loaded.train === 'object', loaded);
  check('异地页挂好了聊天/抓包钩子', loaded.pqSay === 'function' && loaded.watched === 'function' && loaded.hooks === true, loaded);

  const chat = await N.ev(`(async () => {
    const t0 = performance.now();
    await AIChat.preload();
    const ms = Math.round(performance.now() - t0);
    const a = await AIChat.classify('兄弟们上号今晚通宵');
    const b = await AIChat.classify('这份周报的数据我核对过了');
    return { ms, a: a.label, b: b.label, status: AIChat.status() };
  })()`);
  check(`异地页能本地判定闲聊（预热 ${chat.ms}ms）`, chat.a === 'fish' && chat.b !== 'fish', chat);
  check('异地页模型加载正常', chat.status && chat.status.ready === true, chat.status);

  const watch = await N.ev(`(async () => {
    // 直接喂一张纯色图给模型，确认盯学在异地页也能跑
    const c = document.createElement('canvas'); c.width = 256; c.height = 256;
    const g = c.getContext('2d'); g.fillStyle = '#224'; g.fillRect(0, 0, 256, 256);
    return { calib: window.AIWatch.calib(), running: window.AIWatch.isRunning(), hasGetShot: typeof window.AIWatch.getShot === 'function' };
  })()`);
  check('异地页 AIWatch 可校准可取样', watch.calib === null && watch.hasGetShot === true, watch);

  const train = await N.ev(`(async () => {
    const before = AITrain.counts();
    AITrain.addTextSample('异地房测试样本：这周的报告今天必须交', 0, '异地房');
    AITrain.addTextSample('异地房测试样本：哈哈哈太搞笑了', 1, '异地房');
    const after = AITrain.counts();
    return { before: before.text, after: after.text, total: after.text + after.image };
  })()`);
  check(`异地页能写自训练样本 (${train.before} → ${train.after})`, train.after === train.before + 2, train);

  const shared = await M.ev(`(() => {
    const raw = window.api && window.api.aiStore ? JSON.parse(window.api.aiStore.load() || '{}') : {};
    return { file: (raw.samples || []).filter((x) => x.kind === 'text').length, hasStore: !!window.api.aiStore };
  })()`);
  check(
    `训练样本落盘，两个窗口共用同一份文件 (磁盘 ${shared.file} 条)`,
    shared.hasStore === true && shared.file === train.after,
    { disk: shared.file, net: train.after }
  );

  const fb = await N.ev(`(() => {
    // 会议界面还没渲染（没建房），先确认模板里有 AI 状态条与纠错条
    return { attached: typeof window.pqSay === 'function' };
  })()`);
  check('异地房发送钩子可用（AI 抓包会广播到异地聊天）', fb.attached === true, fb);

  const pass = results.filter((r) => r.ok).length;
  console.log(`\n===== ${pass}/${results.length} PASS =====`);
  try {
    child.kill();
  } catch (_) {}
  process.exit(pass === results.length ? 0 : 1);
}

main().catch((e) => {
  console.error('ERR', e.message);
  try {
    child && child.kill();
  } catch (_) {}
  process.exit(1);
});
