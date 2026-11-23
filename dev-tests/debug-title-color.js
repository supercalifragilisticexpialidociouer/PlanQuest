/* 探针：验证 .view-title computed color 与裁切原因 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const APPDIR = path.join(ROOT, 'dist', 'PlanQuest-win64');
const UD = path.join(process.env.APPDATA || '', 'PlanQuest-probe-title-' + Date.now());

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.PQ_USERDATA = path.basename(UD);
env.PQ_DEBUG_PORT = '19222';
env.PQ_LNK_DISABLE = '1';

const exe = path.join(APPDIR, 'PlanQuest.exe');
const child = spawn(exe, ['--force-new'], { env, cwd: APPDIR, stdio: 'ignore' });

function getTargets() {
  return new Promise((resolve, reject) => {
    http.get('http://127.0.0.1:19222/json/list', (res) => {
      let s = '';
      res.on('data', (c) => (s += c));
      res.on('end', () => resolve(JSON.parse(s)));
    }).on('error', reject);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // 等 CDP 端口就绪
  let targets = null;
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    try { targets = await getTargets(); break; } catch (_) {}
  }
  if (!targets) { console.log('CDP 未就绪'); child.kill(); process.exit(1); }
  const page = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const d = JSON.parse(ev.data);
    if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
  });
  const send = (method, params) => new Promise((res) => {
    const i = ++id;
    pending.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  await sleep(2500);

  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    return r.result && r.result.result ? r.result.result.value : null;
  };

  const out = await evalJs(`(() => {
    const t = document.querySelector('.view-title');
    const body = document.body;
    const app = document.getElementById('app');
    const cs = t ? getComputedStyle(t) : null;
    const bodyCs = getComputedStyle(body);
    return {
      theme: app && app.dataset.theme,
      titleColor: cs ? cs.color : null,
      bodyColor: bodyCs.color,
      bodyVarText: bodyCs.getPropertyValue('--text') || '(body 上取不到)',
      appVarText: app ? getComputedStyle(app).getPropertyValue('--text') : null,
      titleText: t ? t.textContent : null,
      scrollTop: document.getElementById('view') ? document.getElementById('view').scrollTop : null,
      viewClientTop: (() => { const el = document.querySelector('.view-title'); if (!el) return null; const r = el.getBoundingClientRect(); return { top: r.top, height: r.height }; })(),
    };
  })()`);
  console.log(JSON.stringify(out, null, 2));

  // 场景 2：把当前视图滚下去再切走，验证新视图从顶部开始（标题不被裁切）
  const sc = await evalJs(`(async () => {
    const v0 = document.getElementById('view');
    v0.scrollTop = 300;                    // 模拟用户滚下去
    await new Promise(r => setTimeout(r, 150));
    switchView('stats');                   // 切走
    await new Promise(r => setTimeout(r, 300));
    const v1 = document.getElementById('view');
    const t1 = document.querySelector('.view-title');
    const r1 = t1 ? t1.getBoundingClientRect() : null;
    const st = { scrollTopAfter: v1.scrollTop, titleTop: r1 ? Math.round(r1.top) : null, titleText: t1 ? t1.textContent : null };
    switchView('today');
    await new Promise(r => setTimeout(r, 300));
    const v2 = document.getElementById('view');
    st.scrollTopBack = v2.scrollTop;
    return st;
  })()`);
  console.log('切视图滚动:', JSON.stringify(sc));

  ws.close();
  child.kill();
  process.exit(0);
})().catch((e) => { console.error('ERR', e.message); child.kill(); process.exit(1); });
