/* 测试：异地联机房间里，开摄像头是否自动开启 AI 盯学（强制）
 * 用法：node dev-tests/test-net-watch.js
 * 手法：把 getUserMedia 换成 canvas 假摄像头，再点界面上的「创建 → 进入 → 摄像头」。
 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = 9237;
const UDATA = 'netW-' + Date.now().toString(36);
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
async function waitTarget(match, timeoutMs = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const list = await getJson(`http://127.0.0.1:${PORT}/json`);
      const hit = list.find((t) => t.type === 'page' && match.test(t.url));
      if (hit) return hit;
    } catch (_) {}
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
  return { ready, ev };
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
  await M.ev(`api.netOpenWindow('study').then(() => 1).catch(() => 0)`);

  const net = await waitTarget(/net\.html/);
  if (!net) throw new Error('异地联机窗口未出现');
  const N = attach(net.webSocketDebuggerUrl);
  await N.ready;
  await sleep(2000);

  // 假摄像头：canvas 流，避免真的开设备
  const fake = await N.ev(`(() => {
    const c = document.createElement('canvas'); c.width = 320; c.height = 240;
    const g = c.getContext('2d'); g.fillStyle = '#1b2340'; g.fillRect(0, 0, 320, 240);
    g.fillStyle = '#fff'; g.font = '20px sans-serif'; g.fillText('fake cam', 90, 120);
    const stream = c.captureStream(8);
    navigator.mediaDevices.getUserMedia = async () => stream;
    return { tracks: stream.getVideoTracks().length };
  })()`);
  check('假摄像头就绪', fake.tracks === 1, fake);

  // 建房 → 进房
  const step1 = await N.ev(`(async () => {
    const createBtn = document.querySelector('[data-net="create"]');
    if (!createBtn) return { err: 'no create btn' };
    createBtn.click();
    await new Promise((r) => setTimeout(r, 1500));
    const enterBtn = document.querySelector('[data-net="enter"]');
    return { enteredUi: !!enterBtn, text: (document.querySelector('#net-body')?.textContent || '').slice(0, 40) };
  })()`);
  check('创建房间后出现「进入房间」', step1.enteredUi === true, step1);

  const step2 = await N.ev(`(async () => {
    const enterBtn = document.querySelector('[data-net="enter"]');
    if (enterBtn) enterBtn.click();
    await new Promise((r) => setTimeout(r, 1200));
    return {
      camBtn: !!document.querySelector('[data-net="cam"]'),
      aiBar: !!document.querySelector('#net-ai-bar'),
      aiStatus: !!document.querySelector('#ai-status'),
    };
  })()`);
  check('进入会议界面（有摄像头按钮与 AI 条）', step2.camBtn && step2.aiBar === true, step2);

  const step3 = await N.ev(`(async () => {
    const before = window.AIWatch.isRunning();
    document.querySelector('[data-net="cam"]').click();
    await new Promise((r) => setTimeout(r, 9000));
    const chip = document.querySelector('#ai-status');
    return {
      before,
      running: window.AIWatch.isRunning(),
      chip: chip ? chip.textContent : '',
      chipClass: chip ? chip.className : '',
      stats: window.AIWatch.s(),
    };
  })()`);
  check('开摄像头后 AI 盯学自动开启（强制）', step3.running === true, { before: step3.before, running: step3.running });
  check(`状态条有反应 (${step3.chip})`, /盯学中|摸鱼|认真/.test(step3.chip || ''), step3);

  const step4 = await N.ev(`(async () => {
    document.querySelector('[data-net="cam"]').click();
    await new Promise((r) => setTimeout(r, 1200));
    return { running: window.AIWatch.isRunning(), camOn: !!window.pqNet };
  })()`);
  check('关摄像头后 AI 盯学随之停止', step4.running === false, step4);

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
