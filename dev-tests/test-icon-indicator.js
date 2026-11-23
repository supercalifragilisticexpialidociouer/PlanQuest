/* 动态图标指示器测试：有任务进行中 → 图标顺滑变色；无任务 → 保持/恢复初始色。
 * 两种场景各启动一次隔离 userData 的 exe，通过 boot.log 的 [icon-ind] 行断言。
 * 用法：node dev-tests/test-icon-indicator.js
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EXE = path.resolve(__dirname, '..', 'dist', 'PlanQuest-win64', 'PlanQuest.exe');
const APPDATA = process.env.APPDATA;
let pass = 0;
let fail = 0;
const results = [];

function check(name, cond, extra) {
  const ok = !!cond;
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra !== undefined ? '  → ' + JSON.stringify(extra) : ''}`);
  ok ? pass++ : fail++;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function udataTag(tag) {
  // main.js: userData = %APPDATA%\PlanQuest-<PQ_USERDATA>
  return 'iconind-' + tag + '-' + Date.now().toString(36);
}

function udataDir(tag) {
  return path.join(APPDATA, 'PlanQuest-' + tag);
}

function todayDow() {
  return new Date().getDay();
}

function dateKey() {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

function nowHHMM() {
  const d = new Date();
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

// 写一个最小可用的 data.json，含（或不含）一个此刻进行中的计划；
// markDone=true 时把这条计划记为当天已完成（回归：打完卡图标不该再变色）
function seedData(dir, withActivePlan, markDone) {
  fs.mkdirSync(dir, { recursive: true });
  const plans = withActivePlan
    ? [{
        id: 'p-ind-1',
        name: '图标指示器测试计划',
        enabled: true,
        time: nowHHMM(),
        days: [todayDow()],
        allowProcs: [],
      }]
    : [];
  const data = {
    plans,
    log: markDone ? { [dateKey()]: { 'p-ind-1': { status: 'done', at: Date.now(), points: 20 } } } : {},
    points: 0,
    totalDone: 0,
    streak: 0,
    bestStreak: 0,
    perfectDays: 0,
    doneDates: {},
    checkins: {},
    settings: {},
    achievements: [],
  };
  fs.writeFileSync(path.join(dir, 'data.json'), JSON.stringify(data), 'utf8');
}

function launch(tag) {
  // PQ_USERDATA 是后缀：userData = %APPDATA%\PlanQuest-<tag>
  const env = {
    ...process.env,
    PQ_USERDATA: tag,
    PQ_DEBUG_PORT: String(9300 + (process.pid % 200)),
    PQ_LNK_DISABLE: '1',
    PQ_EYE_INT_MS: '3600000',
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  const child = spawn(EXE, ['--force-new'], {
    cwd: path.dirname(EXE),
    env,
    stdio: 'ignore',
  });
  return child;
}



async function runScenario(tag, withActivePlan, waitMs, markDone) {
  const realTag = udataTag(tag);
  const dir = udataDir(realTag);
  seedData(dir, withActivePlan, !!markDone);
  const child = launch(realTag);
  await sleep(waitMs);
  try { child.kill(); } catch (_) {}
  await sleep(1200);
  const real = dir;
  const log = fs.readFileSync(path.join(real, 'boot.log'), 'utf8');
  return { dir: real, log };
}

(async () => {
  console.log('EXE:', EXE);

  // 场景1：有进行中的计划 → 应看到「图标开始顺滑变色」
  const a = await runScenario('act', true, 9000);
  const started = /icon-ind.*变色/.test(a.log);
  check('有任务 → 图标开始变色', started, started ? '日志已记录' : '未找到 [icon-ind] 变色日志');
  check('有任务 → 指示器已启动（帧资源加载成功）', !/指示器未启动/.test(a.log));

  // 场景2：没有计划 → 不应有变色日志
  const b = await runScenario('idle', false, 8000);
  const notStarted = !/icon-ind.*变色/.test(b.log);
  check('无任务 → 不变色（保持初始颜色）', notStarted);
  check('无任务 → 指示器仍然正常启动', !/指示器未启动/.test(b.log));

  // 场景3（回归）：计划处于时间窗口内，但当天已完成 → 不应再变色
  const c = await runScenario('done', true, 8000, true);
  const doneNotStarted = !/icon-ind.*变色/.test(c.log);
  check('已完成任务 → 不再变色（打完卡图标恢复初始颜色）', doneNotStarted);
  check('已完成任务 → 指示器仍然正常启动', !/指示器未启动/.test(c.log));

  console.log('\n' + results.join('\n'));
  console.log(`\n${pass} PASS / ${fail} FAIL`);
  // 清理测试目录
  for (const d of [a.dir, b.dir, c.dir]) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {}
  }
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('TEST ERROR:', e.message);
  process.exit(1);
});
