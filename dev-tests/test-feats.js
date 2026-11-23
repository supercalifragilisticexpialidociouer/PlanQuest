'use strict';
/* 新功能联测：星期开关 / 需密码确认打卡 / 局域网自动进房 / 护眼模式（加速时钟） */

const A_PORT = 9225;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function targets(port) {
  const r = await fetch(`http://127.0.0.1:${port}/json`);
  return r.json();
}

async function connectPage(port, re) {
  const list = await targets(port);
  const page = list.find((t) => t.type === 'page' && re.test(t.url));
  if (!page) return null;
  const ws = await new Promise((res, rej) => {
    const w = new WebSocket(page.webSocketDebuggerUrl);
    w.onopen = () => res(w);
    w.onerror = () => rej(new Error('ws 失败 ' + port));
  });
  let seq = 0;
  const ev = (expr, timeout = 20000) =>
    new Promise((resolve) => {
      const id = ++seq;
      const t = setTimeout(() => resolve('__TIMEOUT__'), timeout);
      const on = (e) => {
        const m = JSON.parse(e.data);
        if (m.id === id) {
          clearTimeout(t);
          ws.removeEventListener('message', on);
          const r = m.result;
          if (r && r.exceptionDetails) {
            const d = r.exceptionDetails.exception;
            return resolve('__ERR__ ' + ((d && d.description) || r.exceptionDetails.text));
          }
          resolve(r?.result?.value);
        }
      };
      ws.addEventListener('message', on);
      ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }));
    });
  const shot = async (file) => {
    // 截图走 Page 域
    const id = ++seq;
    const r = await new Promise((res) => {
      const on = (e) => {
        const m = JSON.parse(e.data);
        if (m.id === id) {
          ws.removeEventListener('message', on);
          res(m.result);
        }
      };
      ws.addEventListener('message', on);
      ws.send(JSON.stringify({ id, method: 'Page.captureScreenshot', params: { format: 'png' } }));
    });
    if (r && r.data) {
      require('fs').writeFileSync(file, Buffer.from(r.data, 'base64'));
      return true;
    }
    return false;
  };
  return { ev, shot, close: () => ws.close() };
}

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) {
    pass++;
    console.log('  PASS  ' + name + (extra ? '  (' + extra + ')' : ''));
  } else {
    fail++;
    console.log('  FAIL  ' + name + (extra ? '  (' + extra + ')' : ''));
  }
}

(async () => {
  const fs = require('fs');
  const shots = 'C:/Users/18824/WorkBuddy/2026-10-27-21-28-50/planquest/shots';
  fs.mkdirSync(shots, { recursive: true });

  // 等主窗口就绪
  let A = null;
  for (let i = 0; i < 30; i++) {
    A = await connectPage(A_PORT, /index\.html/);
    if (A) break;
    await sleep(700);
  }
  if (!A) throw new Error('主窗口未就绪');
  await sleep(1500);

  // 0. 设置守护密码 1234（重复运行时提示"密码已设置"也算成功）
  const g = await A.ev(`window.api.guardSetup({ user: 'tester', password: '1234' })`);
  check(
    '守护密码已设置',
    !!g && (g.ok === true || (g.ok === false && String(g.message || '').includes('已设置'))),
    JSON.stringify(g).slice(0, 60)
  );

  // 1. 星期开关：点一次亮、再点一次灭
  await A.ev('openPlanForm(null)');
  await sleep(500);
  await A.ev(`[...document.querySelectorAll('#f-days .day-opt')][0].click()`);
  await A.ev(`[...document.querySelectorAll('#f-days .day-opt')][0].click()`);
  await A.ev(`[...document.querySelectorAll('#f-days .day-opt')][1].click()`);
  const dayState = await A.ev(
    `[...document.querySelectorAll('#f-days .day-opt')].map(b => b.classList.contains('sel') ? 1 : 0).join('')`
  );
  // 默认选中 [1..5]；idx0 点两次不变（灭）；idx1 点一次由亮变灭
  check('星期点一次亮、再点一次灭', dayState === '0011110', dayState);

  // 2. 需密码确认开关（在同一个表单里点开再关）
  await A.ev(`document.querySelector('#f-confirm .day-opt').click()`);
  const confirmOn = await A.ev(`!!document.querySelector('#f-confirm .sel')`);
  check('完成确认可点亮', confirmOn === true);
  await A.ev(`document.querySelector('#f-confirm .day-opt').click()`);
  const confirmOff = await A.ev(`!!document.querySelector('#f-confirm .sel')`);
  check('完成确认可点灭', confirmOff === false);
  await A.ev(`document.querySelector('#f-cancel')?.click()`);
  await sleep(300);

  // 3. 主进程侧：needConfirm 计划 → 打卡先记「待验证」，密码验证后才完成
  const saved = await A.ev(
    `window.api.savePlan({ plan: { title: '密码确认计划', time: '09:00', points: 20, days: [0,1,2,3,4,5,6], needConfirm: true }, password: '1234' })`
  );
  check('需确认计划已保存', !!saved && saved.ok === true);
  const planId = saved && saved.id;
  const r1 = await A.ev(`window.api.checkin(${JSON.stringify(planId)})`);
  check('打卡后先记待验证（不发积分）', !!r1 && r1.ok === true && r1.pending === true, JSON.stringify(r1).slice(0, 80));
  const st1 = await A.ev(`window.api.getState().then(s => s.todayPlans.find(p => p.id === ${JSON.stringify(planId)}).status)`);
  check('今日列表显示待验证状态', st1 === 'awaiting', 'status=' + st1);
  const r2 = await A.ev(`window.api.checkin(${JSON.stringify(planId)}, '0000')`);
  check('错误密码 → 仍是待验证', !!r2 && r2.pending === true);
  const st2 = await A.ev(`window.api.getState().then(s => s.todayPlans.find(p => p.id === ${JSON.stringify(planId)}).status)`);
  check('错误密码不改变状态', st2 === 'awaiting', 'status=' + st2);
  const r3 = await A.ev(`window.api.checkin(${JSON.stringify(planId)}, '1234')`);
  check('正确密码 → 验证完成并发积分', !!r3 && r3.ok === true && r3.gained > 0, JSON.stringify(r3).slice(0, 80));

  // 3b. UI 层：打卡 → 待验证 → 验证按钮 → 密码框 → 完成
  await A.ev(`window.api.undoCheckin(${JSON.stringify(planId)})`);
  await sleep(400);
  await A.ev(`switchView('today')`);
  await sleep(500);
  await A.ev(`document.querySelector('[data-checkin="${planId}"]')?.click()`);
  await sleep(700);
  const awaitingShown = await A.ev(`!!document.querySelector('[data-verify="${planId}"]')`);
  check('打卡后出现「验证」按钮（窗口已关）', awaitingShown === true);
  await A.ev(`document.querySelector('[data-verify="${planId}"]').click()`);
  await sleep(400);
  const pwShown = await A.ev(`!!document.querySelector('#pw-input')`);
  check('点验证弹出密码框', pwShown === true);
  await A.ev(`const i=document.querySelector('#pw-input'); i.value='1234'; document.querySelector('.modal .form-foot .btn:not(.ghost)').click()`);
  await sleep(700);
  const doneShown = await A.ev(`!!document.querySelector('[data-undo="${planId}"]')`);
  check('密码验证后变为已完成', doneShown === true);

  // 4. 局域网房间：创建后房主自动进入房间界面
  await A.ev(`switchView('study')`);
  await sleep(400);
  await A.ev(`document.querySelector('#room-create')?.click()`);
  await sleep(1500);
  const inRoom = await A.ev(`!!document.querySelector('.member-grid') && !!document.querySelector('.room-live')`);
  const hostIn = await A.ev(`!!document.querySelector('#member-grid .member-card')`);
  check('创建后房主自动进入房间界面', inRoom === true);
  check('成员格里能看到房主自己', hostIn === true);
  await A.shot(shots + '/8-lan-host-inroom.png');
  console.log('  截图 8-lan-host-inroom.png');
  await A.ev(`document.querySelector('#room-leave')?.click()`);
  await sleep(800);

  // 5. 护眼模式：开关需要密码
  const e1 = await A.ev(`window.api.eyeCareToggle({ enabled: true, password: '0000' })`);
  check('护眼开关错误密码被拒', !!e1 && (e1.needPassword === true || e1.ok === false));
  const e2 = await A.ev(`window.api.eyeCareToggle({ enabled: true, password: '1234' })`);
  check('护眼开关正确密码通过', !!e2 && e2.ok === true && e2.eyeCare && e2.eyeCare.enabled === true);
  await A.ev(`switchView('settings')`);
  await sleep(500);
  const swOn = await A.ev(`!!document.querySelector('#eyecare-switch.on')`);
  check('设置页护眼开关亮起', swOn === true);

  // 6. 护眼轮次（测试时钟：8 秒后触发，引导 12 秒，息屏 12 秒）
  let eye = null;
  for (let i = 0; i < 20; i++) {
    eye = await connectPage(A_PORT, /eyecare\.html/);
    if (eye) break;
    await sleep(700);
  }
  check('到点弹出全屏护眼窗口', !!eye);
  if (eye) {
    await sleep(1200);
    const ph = await eye.ev(`phase`);
    check('第一阶段是眼保健操', ph === 'exercise', 'phase=' + ph);
    const vInfo = await eye.ev(
      `(() => { const v = document.getElementById('video'); return { ready: v.readyState >= 2, dur: Math.round(v.duration || 0), playing: !v.paused }; })()`
    );
    check('眼保健操视频已加载并播放', !!vInfo && vInfo.ready === true && vInfo.dur >= 200 && vInfo.playing === true, JSON.stringify(vInfo));
    await eye.shot(shots + '/9-eyecare-exercise.png');
    console.log('  截图 9-eyecare-exercise.png');
    // 跳过：错密码被拒
    await eye.ev(`document.querySelector('#skip').click()`);
    await eye.ev(`document.querySelector('#pw').value='0000'`);
    await eye.ev(`trySkip()`);
    await sleep(400);
    const err = await eye.ev(`document.querySelector('#pw-err').textContent`);
    check('跳过需正确密码', String(err).length > 0, 'err=' + err);
    // 正确密码 → 进入息屏
    await eye.ev(`document.querySelector('#pw').value='1234'`);
    await eye.ev(`trySkip()`);
    await sleep(900);
    const ph2 = await eye.ev(`phase`);
    check('密码跳过后进入息屏', ph2 === 'rest', 'phase=' + ph2);
    await eye.shot(shots + '/10-eyecare-rest.png');
    console.log('  截图 10-eyecare-rest.png');
    // 再跳过息屏；随后立刻关掉护眼模式（测试时钟 8 秒一轮，否则会立刻再弹新窗口）
    await eye.ev(`document.querySelector('#skip').click()`);
    await eye.ev(`document.querySelector('#pw').value='1234'`);
    await eye.ev(`trySkip()`);
    const e4 = await A.ev(`window.api.eyeCareToggle({ enabled: false, password: '1234' })`);
    check('护眼模式可关闭（密码通过）', !!e4 && e4.ok === true && e4.eyeCare.enabled === false);
    // 窗口销毁有短暂延迟，轮询确认 eyecare.html 从目标列表消失
    let gone = false;
    for (let i = 0; i < 15; i++) {
      await sleep(500);
      const list = await targets(A_PORT);
      if (!list.some((t) => /eyecare\.html/.test(t.url))) {
        gone = true;
        break;
      }
    }
    check('跳过/关闭后护眼窗口关闭', gone);
  }

  console.log(`\n结果：${pass} PASS / ${fail} FAIL`);
  A.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('联测异常:', e.message);
  process.exit(1);
});
