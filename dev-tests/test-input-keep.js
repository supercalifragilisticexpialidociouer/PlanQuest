/* 重绘保护测试：正在输入的内容不能被整页重绘清空
 * 用法：node dev-tests/test-input-keep.js
 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const PORT = 9351;
const TAG = 'inp-' + Date.now().toString(36);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
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
  throw new Error('CDP 页面未找到');
}
function makeClient(wsUrl) {
  return new Promise((resolve, reject) => {
    const st = { ws: null, id: 0, pending: new Map() };
    const ws = new WebSocket(wsUrl);
    st.ws = ws;
    ws.onopen = () => resolve(st);
    ws.onerror = () => reject(new Error('WS 连接失败'));
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && st.pending.has(m.id)) {
        const { resolve: r, reject: j } = st.pending.get(m.id);
        st.pending.delete(m.id);
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
function launch() {
  const udir = path.join(os.homedir(), 'AppData', 'Roaming', 'PlanQuest-' + TAG);
  fs.rmSync(udir, { recursive: true, force: true });
  const bin = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
  const env = { ...process.env, PQ_USERDATA: TAG, PQ_EYE_INT_MS: '3600000' };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  return spawn(bin, ['.', '--force-new', `--remote-debugging-port=${PORT}`], { cwd: ROOT, env, stdio: 'ignore' });
}

async function main() {
  const proc = launch();
  const A = await makeClient((await findPage(PORT)).webSocketDebuggerUrl);
  await sleep(2500);

  // 切到「设置」视图，未登录时云同步面板有手机号输入框（常驻、会被整页重绘）
  await evalJs(A, `switchView('settings')`);
  await sleep(600);
  const has = await evalJs(A, `!!document.getElementById('cloud-phone')`);
  check('设置页有云同步手机号输入框', has);
  if (!has) throw new Error('找不到测试输入框');

  // 模拟用户正在打字：写入内容 + 聚焦 + 光标在第 3 位
  await evalJs(A, `(() => {
    const el = document.getElementById('cloud-phone');
    el.value = '13800001111';
    el.focus();
    el.setSelectionRange(5, 5);
    return el.value;
  })()`);

  // 触发整页重绘（房间心跳、云同步、每分钟刷新都会走这里）
  await evalJs(A, `render()`);
  await sleep(200);

  const after = await evalJs(A, `(() => {
    const el = document.getElementById('cloud-phone');
    return { value: el.value, focused: document.activeElement === el, caret: el.selectionStart };
  })()`);
  check('重绘后输入内容保留', after.value === '13800001111', after.value);
  check('重绘后焦点仍在输入框', after.focused === true);
  check('重绘后光标位置保留', after.caret === 5, after.caret);

  // 连续重绘 5 次（模拟每秒心跳）
  await evalJs(A, `(() => { for (let i = 0; i < 5; i++) render(); return true; })()`);
  await sleep(200);
  const after2 = await evalJs(A, `document.getElementById('cloud-phone').value`);
  check('连续 5 次重绘后内容仍在', after2 === '13800001111', after2);

  // 切换视图时不恢复：旧视图的内容不能串到新视图
  const cross = await evalJs(A, `(() => {
    switchView('today');
    switchView('settings');
    const el = document.getElementById('cloud-phone');
    return el ? el.value : 'missing';
  })()`);
  check('切换视图后不会串值', cross === '' || cross === 'missing', cross);

  // defer 行为：打字中 render 不替换 DOM 节点，失焦后才真正重绘
  const deferRes = await evalJs(A, `(async () => {
    switchView('settings');
    await new Promise(r => setTimeout(r, 300));
    const el = document.getElementById('cloud-phone');
    el.value = '13911112222';
    el.focus();
    el.setSelectionRange(11, 11);
    const firstOf = () => document.getElementById('view').firstElementChild;
    const before = firstOf();
    render();               // 打字中 → 应跳过，DOM 子节点不变
    const during = firstOf();
    el.blur();
    await new Promise(r => setTimeout(r, 250)); // blur 触发补渲染
    const after = firstOf();
    return {
      sameDuring: before === during,      // true：没重绘
      changedAfter: before !== after,     // true：失焦后重绘了
      valAfter: (document.getElementById('cloud-phone')||{}).value,
    };
  })()`);
  check('打字中重绘被跳过（DOM 未替换）', deferRes.sameDuring === true, JSON.stringify(deferRes));
  check('失焦后补渲染生效', deferRes.changedAfter === true, JSON.stringify(deferRes));
  check('补渲染后输入值不丢（capture/restore 兜底）', deferRes.valAfter === '13911112222', deferRes.valAfter);

  const pass = results.filter((r) => r.ok).length;
  console.log(`\n${pass}/${results.length} PASS`);
  try { proc.kill(); } catch (_) {}
  process.exit(pass === results.length ? 0 : 1);
}

main().catch((e) => { console.error('测试异常:', e.message); process.exit(1); });
