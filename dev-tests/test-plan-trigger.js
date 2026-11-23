/* 「开机时」计划触发测试：
 * 1. 启动应用后，boot 计划应在启动时刻立即弹窗提醒（fired 标记写入 data.json）
 * 2. boot 计划算「有任务进行中」→ 图标指示器变色日志出现
 * 3. boot 计划在首页 todayPlans 中 status=pending（45 分钟内不判 missed）
 * 用法：node dev-tests/test-plan-trigger.js
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const APPDATA = process.env.APPDATA;
const EXE = path.resolve(__dirname, '..', 'dist', 'PlanQuest-win64', 'PlanQuest.exe');
let pass = 0;
let fail = 0;
const results = [];

function check(name, cond, extra) {
  const ok = !!cond;
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra !== undefined ? '  → ' + JSON.stringify(extra) : ''}`);
  ok ? pass++ : fail++;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function dateKey() {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

(async () => {
  const tag = 'plantrig-' + Date.now().toString(36);
  const dir = path.join(APPDATA, 'PlanQuest-' + tag);
  fs.mkdirSync(dir, { recursive: true });
  const now = new Date();
  const data = {
    plans: [{
      id: 'p-boot-1',
      name: '开机测试计划',
      title: '开机测试计划',
      enabled: true,
      when: 'boot',
      time: '09:00', // boot 计划忽略该时间
      days: [now.getDay()],
      points: 20,
      allowProcs: [],
    }],
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

  const env = {
    ...process.env,
    PQ_USERDATA: tag,
    PQ_DEBUG_PORT: String(9300 + (process.pid % 200)),
    PQ_LNK_DISABLE: '1',
    PQ_EYE_INT_MS: '3600000',
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  const child = spawn(EXE, ['--force-new'], { cwd: path.dirname(EXE), env, stdio: 'ignore' });
  await sleep(12000);
  try { child.kill(); } catch (_) {}
  await sleep(1500);

  const d = JSON.parse(fs.readFileSync(path.join(dir, 'data.json'), 'utf8'));
  const fired = d.fired && d.fired[dateKey()] && d.fired[dateKey()]['p-boot-1'];
  check('开机时 → 应用启动后立即触发提醒（fired 已写入）', !!fired, fired ? '已触发' : '未触发');

  const log = fs.existsSync(path.join(dir, 'boot.log'))
    ? fs.readFileSync(path.join(dir, 'boot.log'), 'utf8')
    : '';
  check('boot 计划 → 图标指示器判定为「任务进行中」', /icon-ind.*变色/.test(log));

  const today = (d.log && d.log[dateKey()] && d.log[dateKey()]['p-boot-1']) || null;
  check('boot 计划 → 未打卡时状态不是 missed', !today || today.status !== 'missed', today || '无日志(=pending)');

  console.log('\n' + results.join('\n'));
  console.log(`\n${pass} PASS / ${fail} FAIL`);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('TEST ERROR:', e.message);
  process.exit(1);
});
