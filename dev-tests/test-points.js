/* 冒烟测试：负分扣分 + 商城奖励规则（守护密码 / 最低价）
 * 用法：node dev-tests/test-points.js
 * 原理：启动独立 userData 的 Electron 实例（CDP 9223），通过 window.api 直测 IPC。
 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = 9223;
const UDATA = 'ptsA-' + Date.now().toString(36);
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
    ws.onerror = (e) => reject(new Error('WS 连接失败'));
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

async function main() {
  const root = path.resolve(__dirname, '..');
  // 清理旧测试数据
  const udir = path.join(os.homedir(), 'AppData', 'Roaming', 'PlanQuest-' + UDATA);
  fs.rmSync(udir, { recursive: true, force: true });

  const electronBin = process.platform === 'win32'
    ? path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
    : path.join(root, 'node_modules', '.bin', 'electron');
  const childEnv = { ...process.env, PQ_USERDATA: UDATA, PQ_EYE_INT_MS: '3600000' };
  delete childEnv.ELECTRON_RUN_AS_NODE; // 宿主可能注入，删掉才能以 Electron 模式启动
  child = spawn(electronBin,
    ['.', `--remote-debugging-port=${PORT}`],
    { cwd: root, env: childEnv, stdio: 'ignore', detached: false });

  const page = await findPage();
  await connect(page.webSocketDebuggerUrl);
  await sleep(2500);

  // 1. 设置守护密码
  const setup = await evalJs(`api.guardSetup({ user: 'tester', password: '1234' })`);
  check('守护密码设置', setup && setup.ok, setup);

  await evalJs(`api.shopInit()`);

  // 2. 商城：无密码添加 → needPassword
  const r1 = await evalJs(`api.shopAddItem({ name: '测试A', cost: 5, type: 'plain' })`);
  check('添加奖励需守护密码', r1 && r1.needPassword === true, r1);

  // 3. 有密码 + 普通奖励 5 分 → 抬到 10
  const r2 = await evalJs(`api.shopAddItem({ name: '测试A', cost: 5, type: 'plain', password: '1234' })`);
  check('普通奖励最低 10 积分', r2 && r2.ok && r2.item && r2.item.cost === 10, r2 && r2.item);

  // 4. 有密码 + 娱乐券 30 分 → 抬到 50
  const r3 = await evalJs(`api.shopAddItem({ name: '测试B', cost: 30, type: 'ticket', minutes: 30, password: '1234' })`);
  check('娱乐券最低 50 积分', r3 && r3.ok && r3.item && r3.item.cost === 50, r3 && r3.item);

  // 5. 删除：无密码 / 错密码 / 对密码
  const r4 = await evalJs(`api.shopDeleteItem(${JSON.stringify(r2.item.id)})`);
  check('删除奖励需守护密码', r4 && r4.needPassword === true, r4);
  const r5 = await evalJs(`api.shopDeleteItem({ id: ${JSON.stringify(r2.item.id)}, password: '9999' })`);
  check('删除密码错误拦截', r5 && r5.needPassword === true, r5);
  const r6 = await evalJs(`api.shopDeleteItem({ id: ${JSON.stringify(r2.item.id)}, password: '1234' })`);
  check('删除密码正确通过', r6 && r6.ok === true, r6);

  // 6. 普通奖励 10 分刚好放行
  const r7 = await evalJs(`api.shopAddItem({ name: '测试C', cost: 10, type: 'plain', password: '1234' })`);
  check('普通奖励 10 分放行', r7 && r7.ok && r7.item.cost === 10, r7 && r7.item);

  // 7. 惩罚扣分可扣成负分：每次往计划里新增「非白名单普通软件」各扣 10
  const p = await evalJs(`api.savePlan({ title: '测试计划', time: '23:59', days: [0,1,2,3,4,5,6], points: 20, allowProcs: ['code'], password: '1234' })`);
  check('新建测试计划（放行非白名单 -10）', p && p.ok && p.deducted === 10, p);
  const t1 = await evalJs(`api.savePlan({ id: ${JSON.stringify(p.id)}, title: '测试计划', time: '23:59', days: [0,1,2,3,4,5,6], points: 20, allowProcs: ['code','steam'], password: '1234' })`);
  const t2 = await evalJs(`api.savePlan({ id: ${JSON.stringify(p.id)}, title: '测试计划', time: '23:59', days: [0,1,2,3,4,5,6], points: 20, allowProcs: ['code','steam','wechat'], password: '1234' })`);
  const t3 = await evalJs(`api.togglePlan(${JSON.stringify(p.id)}, false)`);
  check('两次新增各扣 10 / 暂停不扣', t1.deducted === 10 && t2.deducted === 10 && t3.deducted === 0, { t1, t2, t3 });
  const st = await evalJs(`api.getState()`);
  check('积分扣成负分 -30', st.profile && st.profile.points === -30, st.profile && st.profile.points);

  // 8. 守护模块实时同步负分（不重启也生效）
  const gi = await evalJs(`api.guardInfo()`);
  check('守护模块同步负分', gi && Number(gi.points) === -30, gi && gi.points);

  // 9. 撤销打卡同样可扣成负分
  const c = await evalJs(`api.checkin(${JSON.stringify(p.id)})`);
  check('打卡成功', c && c.ok, c);
  const u = await evalJs(`api.undoCheckin(${JSON.stringify(p.id)})`);
  check('撤销打卡成功', u && u.ok, u);
  const st2 = await evalJs(`api.getState()`);
  // -30 → 打卡+20 → -10 → 撤销-20 → -30（撤销把已花的积分也扣回来，可到负分）
  check('撤销后积分下探(-10→-30)', st2.profile.points === -30, st2.profile.points);

  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} PASS`);
  process.exitCode = results.every((r) => r.ok) ? 0 : 1;
}

function cleanup() {
  try { if (ws) ws.close(); } catch (_) {}
  try { if (child) child.kill(); } catch (_) {}
  try { fs.rmSync(path.join(os.homedir(), 'AppData', 'Roaming', 'PlanQuest-' + UDATA), { recursive: true, force: true }); } catch (_) {}
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(1); });

main().catch((e) => { console.error('TEST ERROR:', e.message); process.exitCode = 1; });
