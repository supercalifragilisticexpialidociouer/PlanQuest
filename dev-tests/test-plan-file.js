/* 冒烟测试：计划文件（.pqplan）导出/校验/合并/覆盖/防篡改
 * 用法：node dev-tests/test-plan-file.js
 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PORT = 9232;
const UDATA = 'pqF-' + Date.now().toString(36);
const ROOT = path.join(__dirname, '..');
let child = null, ws = null, msgId = 0;
const pending = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let s = ''; res.on('data', (c) => (s += c));
      res.on('end', () => { try { resolve(JSON.parse(s)); } catch (e) { resolve([]); } });
    }).on('error', reject);
  });
}
async function findPage() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await getJson(`http://127.0.0.1:${PORT}/json`);
      const p = list.find((t) => t.type === 'page' && /index\.html/i.test(t.url)) || list.find((t) => t.type === 'page');
      if (p) return p;
    } catch (_) {}
    await sleep(500);
  }
  throw new Error('CDP 页面未找到');
}
function rpc(method, params) {
  return new Promise((resolve) => {
    const id = ++msgId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expr, timeoutMs = 30000) {
  const r = await Promise.race([
    rpc('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, timeout: timeoutMs }),
    sleep(timeoutMs + 3000).then(() => ({ timeout: true })),
  ]);
  if (r.timeout) throw new Error('evaluate 超时');
  if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception || {}).description || 'JS 异常');
  return r.result && r.result.value;
}

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`PASS  ${name}  → ${detail === undefined ? '' : JSON.stringify(detail)}`); }
  else { fail++; console.log(`FAIL  ${name}  → ${JSON.stringify(detail)}`); }
}

async function main() {
  const electronBin = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
  const childEnv = { ...process.env, PQ_USERDATA: UDATA };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  child = spawn(electronBin, ['.', `--remote-debugging-port=${PORT}`], { cwd: ROOT, env: childEnv, stdio: 'ignore' });
  const page = await findPage();
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  ws.addEventListener('message', (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch (_) { return; }
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result || {}); pending.delete(m.id); }
  });
  await rpc('Runtime.enable', {});
  await sleep(2500);

  // 1. 导出信封
  const built = await evaluate('window.api.planfileBuild()');
  check('planfileBuild 可用', built && built.ok);
  const env = JSON.parse(built.json);
  check('magic 正确', env.magic === 'PLANQUEST-PLAN', env.magic);
  check('format = 1', env.format === 1);
  const sum = crypto.createHash('sha256').update(JSON.stringify(env.data), 'utf8').digest('hex');
  check('校验和匹配', env.checksum === sum, env.checksum.slice(0, 12) + '...');
  check('含 plans 数组', Array.isArray(env.data.plans), env.data.plans.length + ' 个计划');

  // 2. 合并导入（同一份数据 → 新增 0）
  const m1 = await evaluate(`window.api.planfileApply({ data: window.__d, mode: 'merge' })`
    .replace('window.__d', JSON.stringify(JSON.stringify(env.data))).replace('{ data: "{\\"plan', '{ data: JSON.parse("{\\"plan'));
  // 简化：直接用 evaluate 传对象
  const m1b = await evaluate(`(() => {
    const data = ${JSON.stringify(env.data)};
    return window.api.planfileApply({ data, mode: 'merge' });
  })()`);
  check('合并导入成功', m1b && m1b.ok, m1b && m1b.message);
  const m2 = await evaluate(`(() => {
    const data = ${JSON.stringify(env.data)};
    return window.api.planfileApply({ data, mode: 'merge' });
  })()`);
  check('重复合并新增 0', /新增计划 0/.test(m2 && m2.message), m2 && m2.message);

  // 3. 覆盖导入（删掉一个计划再导入 → 数量-1）
  const replaced = await evaluate(`(() => {
    const data = ${JSON.stringify(env.data)};
    if (data.plans.length) data.plans = data.plans.slice(1);
    return window.api.planfileApply({ data, mode: 'replace' }).then(async (r) => {
      const st = await window.api.getState();
      return { r, count: st.plans.length };
    });
  })()`);
  check('覆盖导入成功', replaced && replaced.r && replaced.r.ok, replaced && replaced.r && replaced.r.message);
  check('覆盖后计划数 = len-1', replaced.count === env.data.plans.length - 1, replaced.count);

  // 4. 防篡改：改内容不改校验和 → 拒绝
  const tamper = await evaluate(`(() => {
    const data = ${JSON.stringify(env.data)};
    data.plans.push({ id: 'hacked', title: '篡改' });
    return window.api.planfileApply({ data, checksum: ${JSON.stringify(env.checksum)}, mode: 'merge' });
  })()`);
  check('篡改被拒绝', tamper && !tamper.ok && /校验和/.test(tamper.message), tamper && tamper.message);

  // 5. 非法 magic 拒绝
  const bad = await evaluate(`(() => {
    const data = ${JSON.stringify(env.data)};
    return window.api.planfileApply({ data: { magic: 'OTHER', format: 1, data }, mode: 'merge' });
  })()`);
  check('非 .pqplan 被拒绝', bad && !bad.ok, bad && bad.message);

  child.kill();
  console.log(`\n${fail ? '❌' : '✅'} 通过 ${pass} / 失败 ${fail}`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error('ERROR', e.message); try { child && child.kill(); } catch (_) {} process.exit(1); });
