/* 军团闲聊档位测试：L0~L3 计算 / 内容权限矩阵 / 闲聊雷达 / L1 抽检回落 */
'use strict';

const assert = require('assert');
const T = require('../src/legion-tier');

let pass = 0;
let fail = 0;
function ok(name, fn) {
  try {
    fn();
    pass += 1;
    console.log('  ✓ ' + name);
  } catch (e) {
    fail += 1;
    console.log('  ✗ ' + name + ' → ' + e.message);
  }
}

const T0 = 1700000000000;

console.log('\n[1] 档位计算');
ok('默认 L0 静默档（没完成率也没集体任务）', () => {
  const r = T.computeTier({ personalRate: 30, collectiveMet: false });
  assert.equal(r.key, 'L0');
});
ok('个人 ≥50% → L1 轻聊档', () => {
  const r = T.computeTier({ personalRate: 50, collectiveMet: false });
  assert.equal(r.key, 'L1');
});
ok('个人达标 + 集体任务达成 → L2 狂欢档', () => {
  const r = T.computeTier({ personalRate: 80, collectiveMet: true, contribution: 0.6 });
  assert.equal(r.key, 'L2');
});
ok('L2 防搭便车：贡献 <30% 只回 L1', () => {
  const r = T.computeTier({ personalRate: 80, collectiveMet: true, contribution: 0.2 });
  assert.equal(r.key, 'L1');
  assert.ok(/贡献/.test(r.reason));
});
ok('连续 7 天全勤 + 本周集体全勤 → L3 荣光档', () => {
  const r = T.computeTier({ personalRate: 100, collectiveMet: true, contribution: 0.9, streak7: true, weekFull: true });
  assert.equal(r.key, 'L3');
});
ok('L3 缺一个条件都不行（weekFull 缺 → L2）', () => {
  const r = T.computeTier({ personalRate: 100, collectiveMet: true, contribution: 0.9, streak7: true, weekFull: false });
  assert.equal(r.key, 'L2');
});

console.log('\n[2] 内容权限矩阵');
ok('L0 禁表情/图片/文件，外部链接全档禁止', () => {
  assert.equal(T.checkContent('L0', { kind: 'text', text: '哈', emojis: 1 }).ok, false);
  assert.equal(T.checkContent('L0', { kind: 'text', text: '看', images: 1 }).ok, false);
  assert.equal(T.checkContent('L0', { kind: 'exturl' }).ok, false);
});
ok('L0 非闲聊文本可以发', () => {
  const r = T.checkContent('L0', { kind: 'text', text: '今天打卡完成了吗，求监督' });
  assert.equal(r.ok, true);
});
ok('L0 雷达命中闲聊 → 折叠但不拒收', () => {
  const r = T.checkContent('L0', { kind: 'text', text: '哈哈哈哈笑死我了' });
  assert.equal(r.ok, true);
  assert.equal(r.folded, true);
});
ok('L1 每条 ≤50 字', () => {
  assert.equal(T.checkContent('L1', { kind: 'text', text: '好'.repeat(50) }).ok, true);
  assert.equal(T.checkContent('L1', { kind: 'text', text: '好'.repeat(51) }).ok, false);
});
ok('L1 依旧禁图禁表情', () => {
  assert.equal(T.checkContent('L1', { kind: 'text', text: '干', emojis: 1 }).ok, false);
  assert.equal(T.checkContent('L1', { kind: 'text', text: '干', images: 1 }).ok, false);
});
ok('L2 全解锁：长文/3图/10MB文件/3表情', () => {
  const p = T.policyOf('L2');
  assert.equal(p.textMax, 2000);
  assert.equal(p.images, 3);
  assert.equal(p.files, 10);
  assert.equal(p.emoji, 3);
  assert.equal(T.checkContent('L2', { kind: 'text', text: '冲', images: 3, files: 1, emojis: 3 }).ok, true);
  assert.equal(T.checkContent('L2', { kind: 'text', text: '冲', images: 4 }).ok, false);
  assert.equal(T.checkContent('L2', { kind: 'text', text: '冲', emojis: 4 }).ok, false);
});
ok('L3 加到 5 图 5 表情 20MB + 荣光标记', () => {
  const p = T.policyOf('L3');
  assert.equal(p.images, 5);
  assert.equal(p.emoji, 5);
  assert.equal(p.files, 20);
  assert.equal(p.honor, true);
});
ok('计划包全档都走二次确认（F1 搭子除外）', () => {
  assert.equal(T.checkContent('L0', { kind: 'plan' }).reason, 'confirm');
  assert.equal(T.checkContent('L2', { kind: 'plan' }).reason, 'confirm');
  assert.equal(T.checkContent('F1', { kind: 'plan' }).ok, false);
  assert.equal(T.checkContent('F2', { kind: 'plan' }).reason, 'confirm');
});
ok('打卡截图：L0/L1/F2 可发，F1 不可', () => {
  assert.equal(T.checkContent('L0', { kind: 'shot' }).ok, true);
  assert.equal(T.checkContent('F2', { kind: 'shot' }).ok, true);
  assert.equal(T.checkContent('F1', { kind: 'shot' }).ok, false);
});
ok('跨军团邀请全档需审批', () => {
  assert.equal(T.checkContent('L2', { kind: 'cross' }).ok, false);
});

console.log('\n[3] 闲聊雷达（轻量规则）');
ok('正事词优先：沾上打卡/房间/求助就不算闲聊', () => {
  for (const t of ['今天打卡了吗', '房间码发我一下', '求助，计划卡住了', '哈哈哈刚打完卡']) {
    assert.equal(T.isChitChat(t), false, t);
  }
});
ok('灌水短语命中雷达', () => {
  for (const t of ['哈哈哈哈', '666', '笑死', '开摆']) assert.equal(T.isChitChat(t), true, t);
});
ok('纯表情/符号算闲聊', () => assert.equal(T.isChitChat('😀😀 😀'), true));

console.log('\n[4] L1 抽检：闲聊超 3 条/小时回落 L0 到次日');
{
  let strikes = {};
  const h = 3600e3;
  let r;
  r = T.onChatStrike(strikes, 'u1', T0);
  assert.equal(r.over, false);
  r = T.onChatStrike(strikes, 'u1', T0 + 1);
  r = T.onChatStrike(strikes, 'u1', T0 + 2);
  ok('前 3 条只是计数', () => assert.equal(r.over, false));
  r = T.onChatStrike(strikes, 'u1', T0 + 3);
  ok('第 4 条击落：backUntil = 当日 24 点', () => {
    assert.equal(r.over, true);
    assert.equal(r.backUntil, T.endOfDay(T0 + 3));
    strikes = r.strikes;
  });
  ok('生效档位：L1 → L0', () => {
    assert.equal(T.effectiveTier('L1', strikes, 'u1', T0 + 4), 'L0');
    assert.equal(T.effectiveTier('L1', strikes, 'u1', T.endOfDay(T0 + 3) + 1), 'L1');
    assert.equal(T.effectiveTier('L2', strikes, 'u1', T0 + 4), 'L2');
  });
  ok('次日重置清空', () => {
    const fresh = T.resetStrikes(strikes);
    assert.equal(T.hourCount(fresh, 'u1', T0 + h * 25), 0);
  });
}

console.log('\n' + (fail === 0 ? '全部通过' : '有失败项') + `：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
