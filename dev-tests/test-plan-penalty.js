/* 冒烟测试：计划扣分新规则
 * 规则：只有「计划里新放行非白名单普通软件」才扣 10 分；
 *       改标题/时间/星期、只放行白名单软件、暂停、重新启用、删除 —— 全部 0 分。
 * 附加：when='boot'（开机时）能持久化。
 * 用法：node dev-tests/test-plan-penalty.js
 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = 9229;
const UDATA = 'plpen-' + Date.now().toString(36);
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

async function pts() {
  const s = await evalJs(`api.getState()`);
  return s.profile.points;
}

async function main() {
  const root = path.resolve(__dirname, '..');
  const udir = path.join(os.homedir(), 'AppData', 'Roaming', 'PlanQuest-' + UDATA);
  fs.rmSync(udir, { recursive: true, force: true });

  const electronBin = process.platform === 'win32'
    ? path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
    : path.join(root, 'node_modules', '.bin', 'electron');
  const childEnv = { ...process.env, PQ_USERDATA: UDATA, PQ_EYE_INT_MS: '3600000' };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  child = spawn(electronBin, ['.', `--remote-debugging-port=${PORT}`], { cwd: root, env: childEnv, stdio: 'ignore' });

  const page = await findPage();
  await connect(page.webSocketDebuggerUrl);
  await sleep(2500);

  await evalJs(`api.guardSetup({ user: 'tester', password: '1234' })`);
  // 设一个白名单软件：notepad（测试里当作白名单）
  await evalJs(`api.guardSetLists({ lists: { whitelist: ['notepad'], graylist: [], blacklist: [] }, password: '1234' })`);

  const P0 = await pts();

  // 1. 新建计划（无放行软件）→ 不扣分
  const a = await evalJs(`api.savePlan({ title: '普通计划', time: '09:00', days: [0,1,2,3,4,5,6], points: 20, password: '1234' })`);
  check('新建普通计划不扣分', a.ok && a.deducted === 0, a);
  check('积分未变', (await pts()) === P0, { before: P0, after: await pts() });

  // 2. 编辑标题 → 不扣分
  const b = await evalJs(`api.savePlan({ id: ${JSON.stringify(a.id)}, title: '普通计划（改名）', time: '10:30', days: [0,1,2,3,4,5,6], points: 20, password: '1234' })`);
  check('编辑标题/时间不扣分', b.ok && b.deducted === 0, b);

  // 3. 编辑：只放行白名单软件 → 不扣分
  const c = await evalJs(`api.savePlan({ id: ${JSON.stringify(a.id)}, title: '普通计划（改名）', time: '10:30', days: [0,1,2,3,4,5,6], points: 20, allowProcs: ['notepad'], password: '1234' })`);
  check('只放行白名单软件不扣分', c.ok && c.deducted === 0, c);

  // 4. 新建计划：放行非白名单普通软件 → 扣 10
  const P1 = await pts();
  const d = await evalJs(`api.savePlan({ title: '需要 VSCode 的计划', time: '14:00', days: [0,1,2,3,4,5,6], points: 20, allowProcs: ['code'], password: '1234' })`);
  check('新建含非白名单软件扣 10', d.ok && d.deducted === 10, d);
  check('积分 -10', (await pts()) === P1 - 10, { before: P1, after: await pts() });

  // 5. 再次编辑同一计划（allowProcs 不变）→ 不扣分
  const e = await evalJs(`api.savePlan({ id: ${JSON.stringify(d.id)}, title: '需要 VSCode 的计划 2', time: '15:00', days: [0,1,2,3,4,5,6], points: 30, allowProcs: ['code'], password: '1234' })`);
  check('编辑已有放行项不重复扣分', e.ok && e.deducted === 0, e);

  // 6. 追加一个新的非白名单软件 → 再扣 10
  const f = await evalJs(`api.savePlan({ id: ${JSON.stringify(d.id)}, title: '需要 VSCode 的计划 2', time: '15:00', days: [0,1,2,3,4,5,6], points: 30, allowProcs: ['code','steam'], password: '1234' })`);
  check('新增非白名单软件再扣 10', f.ok && f.deducted === 10, f);

  // 7. 暂停 / 重新启用 → 不扣分
  const P2 = await pts();
  const g = await evalJs(`api.togglePlan(${JSON.stringify(a.id)}, false)`);
  const h = await evalJs(`api.togglePlan(${JSON.stringify(a.id)}, true)`);
  check('暂停不扣分', g.ok && g.deducted === 0, g);
  check('重新启用不扣分', h.ok && h.deducted === 0, h);
  check('开关后积分不变', (await pts()) === P2, { before: P2, after: await pts() });

  // 8. 删除 → 不扣分
  const P3 = await pts();
  const i = await evalJs(`api.deletePlan({ id: ${JSON.stringify(a.id)}, password: '1234' })`);
  check('删除计划不扣分', i.ok && i.deducted === 0, i);
  check('删除后积分不变', (await pts()) === P3, { before: P3, after: await pts() });

  // 9. when='boot' 持久化
  const j = await evalJs(`api.savePlan({ title: '开机计划', when: 'boot', time: '09:00', days: [0,1,2,3,4,5,6], points: 20, password: '1234' })`);
  const st = await evalJs(`api.getState()`);
  const saved = (st.plans || []).find((p) => p.id === j.id);
  check('when=boot 已持久化', j.ok && saved && saved.when === 'boot', saved && saved.when);

  const pass = results.filter((r) => r.ok).length;
  console.log(`\n${pass}/${results.length} PASS`);
  try { child.kill(); } catch (_) {}
  process.exit(pass === results.length ? 0 : 1);
}

main().catch((e) => {
  console.error('测试异常:', e.message);
  try { child && child.kill(); } catch (_) {}
  process.exit(1);
});
