/* .pqplan 安全四件套测试：预览二次确认 / 来源标记 / 24h 沙箱 / 黑名单拦截 */
'use strict';

const assert = require('assert');
const PG = require('../src/plan-guard');

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
const DAY = 24 * 3600e3;

function env(n, stake) {
  return {
    v: 1,
    data: {
      plans: Array.from({ length: n }, (_, i) => ({ id: 'p' + i, title: '计划' + i, remindTime: '07:3' + (i % 10) })),
      contractProjects: stake ? [{ id: 'c1', title: '对赌', stake }] : [],
      settings: { reward: 10, penalty: 8 },
    },
  };
}

console.log('\n[1] 预览摘要（二次确认）');
ok('列出项目/契约/押金/积分规则', () => {
  const p = PG.preview(env(3, 200));
  assert.equal(p.plans, 3);
  assert.equal(p.contracts, 1);
  assert.equal(p.deposit, 200);
  assert.equal(p.pointsRules.reward, 10);
  assert.equal(p.items.length, 3);
});
ok('超过 12 个项目折叠计数', () => {
  const p = PG.preview(env(15, 0));
  assert.equal(p.items.length, 12);
  assert.equal(p.hidden, 3);
});
ok('押金离谱 → 高危标记', () => {
  assert.equal(PG.preview(env(1, 2000)).risk, 'high');
  assert.equal(PG.preview(env(1, 400)).risk, 'mid');
  assert.equal(PG.preview(env(1, 50)).risk, '');
});
ok('空计划包不给预览', () => assert.equal(PG.preview({ data: { plans: [] } }).ok, false));

console.log('\n[2] 来源标记');
ok('记发送者 + 时间戳，能读成人话', () => {
  const src = PG.markSource(null, 'uid-abc', '老王', T0);
  assert.equal(src.from, 'uid-abc');
  assert.ok(/老王/.test(PG.sourceText(src)));
});

console.log('\n[3] 24h 沙箱');
ok('沙箱 24 小时，到期判过期', () => {
  const sb = PG.sandboxPut('text', { from: 'u' }, T0);
  assert.equal(sb.expiresAt, T0 + DAY);
  assert.equal(PG.sandboxExpired(sb, T0 + DAY - 1), false);
  assert.equal(PG.sandboxExpired(sb, T0 + DAY), true);
});
ok('过期不能转正', () => {
  const sb = PG.sandboxPut('t', null, T0);
  const r = PG.sandboxPromote(sb, T0 + DAY + 1);
  assert.equal(r.ok, false);
});
ok('没过期可以转正，且只转一次', () => {
  const sb = PG.sandboxPut('t', null, T0);
  assert.equal(PG.sandboxPromote(sb, T0 + 3600e3).ok, true);
  assert.equal(PG.sandboxPromote(sb, T0 + 3600e3).ok, false);
});
ok('剩余时间能读成人话', () => {
  assert.equal(PG.leftText(PG.sandboxLeft(PG.sandboxPut('t', null, T0), T0 + 2 * 3600e3)), '22 小时 0 分');
  assert.equal(PG.leftText(0), '已过期');
});

console.log('\n[4] 军团计划文件黑名单');
ok('黑名单成员的计划包直接拦截，连预览都没有', () => {
  const r = PG.receive(JSON.stringify(env(2, 0)), null, ['bad-uid'], 'bad-uid', T0);
  assert.equal(r.ok, false);
  assert.ok(/黑名单/.test(r.reason));
});
ok('不在黑名单 → 正常进沙箱', () => {
  const r = PG.receive(JSON.stringify(env(2, 0)), null, ['bad-uid'], 'good-uid', T0);
  assert.equal(r.ok, true);
  assert.ok(r.sandbox);
  assert.equal(r.sandbox.expiresAt, T0 + DAY);
});
ok('黑名单增删', () => {
  let list = [];
  list = PG.banToggle(list, 'u1', true).list;
  assert.equal(PG.blocked(list, 'u1'), true);
  list = PG.banToggle(list, 'u1', false).list;
  assert.equal(PG.blocked(list, 'u1'), false);
});
ok('格式坏掉/内容不完整的直接拒', () => {
  assert.equal(PG.receive('not json', null, [], 'u', T0).ok, false);
  assert.equal(PG.receive('short', null, [], 'u', T0).ok, false);
});

console.log('\n' + (fail === 0 ? '全部通过' : '有失败项') + `：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
