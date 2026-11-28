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
  check('重复合并新增 0（按新建口径扣 0 分）', /新增 0/.test(m2 && m2.message) && /扣 0 积分/.test(m2 && m2.message), m2 && m2.message);

  // 2.5 只打开编辑：不扣分、不应用、不记账
  const insp = await evaluate(`(() => {
    const data = ${JSON.stringify(env.data)};
    return window.api.planfileApply({ data, mode: 'inspect' }).then(async (r) => {
      const st = await window.api.getState();
      return { r, points: st.profile.points, count: st.overwrite && st.overwrite.count };
    });
  })()`);
  check('只打开编辑：不应用、不扣分、不记账',
    insp && insp.r && insp.r.ok && insp.r.applied === false && insp.r.deducted === 0 && insp.count === 0,
    insp && insp.r);

  // 2.6 覆盖必须先过阿刺审讯：未确认一律拦下
  const gate = await evaluate(`(() => {
    const data = ${JSON.stringify(env.data)};
    data.plans = data.plans.slice(1);
    return window.api.planfileApply({ data, mode: 'replace', scope: 'all', confirmed: false });
  })()`);
  check('覆盖未过审讯被拦下', gate && !gate.ok && gate.needConfirm === true && !!(gate.interrogation),
    gate && { ok: gate.ok, needConfirm: gate.needConfirm });

  // 3. 确认覆盖：扣刺 + 留痕 + 计划数变化
  const replaced = await evaluate(`(() => {
    const data = ${JSON.stringify(env.data)};
    if (data.plans.length) data.plans = data.plans.slice(1);
    return window.api.planfileApply({ data, mode: 'replace', scope: 'all', confirmed: true }).then(async (r) => {
      const st = await window.api.getState();
      const av = await window.api.aciState();
      return { r, count: st.plans.length, points: st.profile.points, overwrite: st.overwrite,
        sin: av && av.derived && av.derived.sin };
    });
  })()`);
  check('确认后覆盖导入成功', replaced && replaced.r && replaced.r.ok, replaced && replaced.r && replaced.r.message);
  check('覆盖后计划数 = len-1', replaced.count === env.data.plans.length - 1, replaced.count);
  /* 顶罪是阿刺自作主张：命中时实扣 0、表情 smirk；没命中时按原口径扣分 */
  const covered = !!(replaced.r.punish && replaced.r.punish.covered);
  check('第 1 次覆盖：扣刺 + 斜眼笑台词 + 逃兵标签',
    replaced.r.punish && replaced.r.punish.tier === 1 && replaced.r.punish.deserter === true &&
    /斜眼笑/.test(replaced.r.say || '') &&
    (covered ? replaced.r.mood === 'smirk' : replaced.r.mood === 'sideeye'),
    replaced.r.punish);
  check('积分：顶罪则实扣 0，未顶则确实扣分',
    covered ? (replaced.points === 100 && replaced.r.punish.pointsCut === 0 && replaced.r.cover.covered === true)
            : (replaced.points < 100 && replaced.r.punish.pointsCut > 0),
    { covered: covered, points: replaced.points, cut: replaced.r.punish && replaced.r.punish.pointsCut });
  check('覆盖是严重违规：心情 −2，且 sin 对外不摆概率',
    replaced.sin && replaced.sin.mood === 1 && typeof replaced.sin.moodLabel === 'string' &&
    !('prob' in replaced.sin),
    replaced.sin);

  // 3.5 加密留痕 + 启动翻旧账（读一次即销）
  const vault = await evaluate('window.api.overwriteVault()');
  check('旧计划加密留痕（索引可查，data.json 无明文）',
    vault && vault.ok && Array.isArray(vault.entries) && vault.entries.length >= 1,
    vault && vault.entries && vault.entries.length);
  const boot = await evaluate(`(async () => {
    const a = await window.api.overwriteBoot();
    const b = await window.api.overwriteBoot();
    return { a, b };
  })()`);
  check('启动翻旧账：扣经验 + 别想装失忆，且只读一次',
    boot && /别想装失忆/.test(boot.a.line) && /经验/.test(boot.a.line) && boot.b.line === '',
    boot && boot.a.line);

  // 3.6 阶梯：再覆盖 3 次 → 第 3 档锁死换皮/养成 24 小时
  const tiers = await evaluate(`(async () => {
    const data = ${JSON.stringify(env.data)};
    const out = [];
    for (let i = 0; i < 3; i++) {
      const r = await window.api.planfileApply({ data, mode: 'replace', scope: 'all', confirmed: true });
      out.push({ tier: r.punish && r.punish.tier, lock: r.punish && r.punish.lock, frozen: r.state && r.state.frozen });
    }
    const w = await window.api.aciAction('water', {});
    const av = await window.api.aciState();
    return { out, w, frozen: av && av.derived && av.derived.frozen, deserter: av && av.derived && av.derived.deserter };
  })()`);
  check('阶梯升级：第 2 次 30% / 第 3 次锁死',
    tiers && tiers.out[0].tier === 2 && tiers.out[1].tier === 3 && tiers.out[1].lock === true,
    tiers && tiers.out);
  check('冻结期主进程拒绝养成动作', tiers && tiers.w && tiers.w.frozen === true, tiers && tiers.w);
  check('aci:state 暴露冻结与逃兵标记', tiers && tiers.frozen === true && tiers.deserter === true,
    { frozen: tiers && tiers.frozen, deserter: tiers && tiers.deserter });

  // 3.7 心情事件端到端：聊天互动 / 真诚道歉 / 无「规定顶罪」入口
  const mood = await evaluate(`(async () => {
    const b = await window.api.aciState();
    const a1 = await window.api.aciAction('chatPing', { kind: 'chat' });
    const c = await window.api.aciState();
    const a2 = await window.api.aciAction('apology', {});
    const d = await window.api.aciState();
    const s = await window.api.aciAction('moodState', {});
    const f = await window.api.aciAction('forceCover', { force: true, cover: true });
    return { before: b.derived.sin, chat: c.derived.sin, apology: d.derived.sin,
      state: s.sin, chatOk: a1.ok, apologyLine: a2.message, forceOk: f.ok };
  })()`);
  check('聊天互动微升 +0.2、真诚道歉一次性恢复 +2',
    mood && mood.chatOk === true && mood.chat.mood > mood.before.mood &&
    mood.apology.mood > mood.chat.mood && /本刺/.test(mood.apologyLine || ''),
    mood && { before: mood.before.mood, chat: mood.chat.mood, apology: mood.apology.mood });
  check('心情状态只给心情/次数，不摆概率、不给开关',
    mood && mood.state && typeof mood.state.mood === 'number' &&
    typeof mood.state.moodLabel === 'string' && !('prob' in mood.state),
    mood && mood.state);
  check('IPC 没有「规定他是否顶罪」的入口', mood && mood.forceOk === false,
    mood && mood.forceOk);

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
