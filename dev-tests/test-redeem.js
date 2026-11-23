/* 端到端测试：负分状态兑换灰名单时长（通过 CDP 驱动真实渲染进程） */
const BASE = 'http://127.0.0.1:9223';

async function getTarget() {
  const list = await (await fetch(BASE + '/json')).json();
  const page = list.find((t) => t.type === 'page' && /index\.html/i.test(t.url));
  if (!page) throw new Error('找不到主窗口页面: ' + JSON.stringify(list.map((t) => t.url)));
  return page.webSocketDebuggerUrl;
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.onopen = () => resolve(ws);
    ws.onerror = (e) => reject(new Error('ws 连接失败'));
  });
}

let seq = 0;
function evaluate(ws, expr) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    const onMsg = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id === id) {
        ws.removeEventListener('message', onMsg);
        if (msg.error) return reject(new Error(JSON.stringify(msg.error)));
        const r = msg.result?.result;
        let v = r?.value;
        if (r && r.type === 'object' && r.subtype === 'error') return reject(new Error(r.description));
        resolve(v);
      }
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }));
  });
}

const results = [];
const check = (name, cond, extra = '') => {
  results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  [' + extra + ']' : ''}`);
  if (!cond) process.exitCode = 1;
};

(async () => {
  const ws = await connect(await getTarget());
  const st0 = await evaluate(ws, `window.api.getState().then(s => ({ points: s.profile.points, escalated: s.guard.escalated, gray: s.guard.graylist }))`);
  check('初始积分为负且已升级', st0.escalated === true && st0.points < 0, `points=${st0.points} gray=${JSON.stringify(st0.gray)}`);

  // A. 正常兑换 30 分钟（价格 ceil(30/10)*15=45，负分继续下沉）
  const a = await evaluate(ws, `window.api.guardRedeemGray({ name: 'game', minutes: 30 })`);
  check('兑换 30 分钟成功', a.ok === true, `cost=${a.cost} points=${a.points} left=${a.left}`);
  check('扣 45 分且可为更深的负数', a.cost === 45 && a.points === st0.points - 45, `points=${a.points}`);
  check('今日剩余额度为 0', a.left === 0);

  // B. 超出每日上限 → 拒绝
  const b = await evaluate(ws, `window.api.guardRedeemGray({ name: 'game', minutes: 5 })`);
  check('超每日 30 分钟上限被拒', b.ok === false && /满 30 分钟/.test(b.message || ''), b.message);

  // C. 非灰名单 → 拒绝
  const c = await evaluate(ws, `window.api.guardRedeemGray({ name: 'notepad', minutes: 10 })`);
  check('非灰名单被拒', c.ok === false, c.message);

  // D. 临时计划已插入计划表
  const d = await evaluate(ws, `window.api.getState().then(s => {
    const t = s.plans.filter(p => p.temp);
    return { n: t.length, sample: t[0] ? { title: t[0].title, dur: t[0].durationMin, allow: t[0].allowProcs, expire: t[0].expireKey, points: t[0].points } : null,
             used: s.grayRedeem.used };
  })`);
  check('临时计划已插入计划表', d.n === 1, JSON.stringify(d.sample));
  check('临时计划放行 game / 时长 30 分钟 / 零积分', d.sample && d.sample.allow[0] === 'game' && d.sample.dur === 30 && d.sample.points === 0);
  check('兑换记录 30 分钟', d.used && d.used.game === 30, JSON.stringify(d.used));

  // E. 新建含放行进程的计划扣 10 分（需守护密码）
  const p0 = await evaluate(ws, `window.api.getState().then(s => s.profile.points)`);
  const e = await evaluate(ws, `window.api.savePlan({ plan: { title: '测试放行', time: '23:59', days: [0,1,2,3,4,5,6], points: 20, allowProcs: ['code'] }, password: '1234' })`);
  check('新建含放行进程的计划成功', e.ok === true, JSON.stringify(e));
  const p1 = await evaluate(ws, `window.api.getState().then(s => s.profile.points)`);
  check('新建扣 10 分', p1 === p0 - 10, `${p0} -> ${p1}`);

  // F. 新建不带放行进程的计划不扣分
  const f = await evaluate(ws, `window.api.savePlan({ plan: { title: '普通计划', time: '23:50', days: [0,1,2,3,4,5,6], points: 20 }, password: '1234' })`);
  const p2 = await evaluate(ws, `window.api.getState().then(s => s.profile.points)`);
  check('新建普通计划不扣分', f.ok === true && p2 === p1, `${p1} -> ${p2}`);

  console.log(results.join('\n'));
  ws.close();
  process.exit(process.exitCode || 0);
})().catch((err) => {
  console.error('TEST ERROR:', err.message);
  process.exit(1);
});
