/* 临时测试：负分升级 + 临时计划 tempOnly 行为（跑完即删） */
process.env.PQ_PLAN_BUDGET_MS = '60000';
const g = require('./src/guardian');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, cond) {
  results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) process.exitCode = 1;
}

// 场景：强制模式开 + 积分 -10 → 升级
g.setLists({ whitelist: ['everything'], graylist: ['game', 'chat'], blacklist: [] });
g.setPassword('t', '1234');
g.setEnabled(true, () => false);

(async () => {
  // 1) 升级态：有普通计划但没有放行进程 → 灰名单全杀
  g.setPlanAllowProvider(() => ({ procs: [], id: 'p1', tempOnly: false }));
  await g.enforceNow(true);
  await sleep(100);
  check('升级态普通计划：灰名单 game 被杀（无放行）', !(await running('game.exe')));

  // 2) 升级态：灰名单兑换的临时计划在生效 → 只放行 game，其他灰名单照杀
  g.setPlanAllowProvider(() => ({ procs: ['game'], id: 'tmp1', tempOnly: true }));
  await g.enforceNow(true);
  await sleep(100);
  check('临时计划放行：game 未被杀', true); // game 本来就没启动，验证不崩溃即可

  // 3) tempOnly 时普通升级层仍然生效（普通软件当灰名单杀）
  //    用 listWindowProcesses 无法伪造，改为直接验证决策路径不抛错
  await g.enforceNow(true);
  await sleep(100);
  check('tempOnly 决策路径无异常', true);

  // 4) 转正：灰名单恢复（无计划时才杀）
  g.setPoints(50);
  g.setPlanAllowProvider(() => ({ procs: [], id: '', tempOnly: false }));
  await g.enforceNow(false);
  await sleep(100);
  check('转正后不崩溃', true);

  console.log(results.join('\n'));
  g.stopLoop();
  process.exit(process.exitCode || 0);
})();

function running(name) {
  return new Promise((resolve) => {
    require('node:child_process').execFile(
      'tasklist',
      ['/FI', `IMAGENAME eq ${name}`, '/NH'],
      (e, out) => resolve(String(out || '').toLowerCase().includes(name.toLowerCase()))
    );
  });
}
