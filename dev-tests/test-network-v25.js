/* 测试：军团网格策略 / PK 校验 / 签名 / 新手保护罩 / 频道秩序
 * 用法：node dev-tests/test-network-v25.js
 */
'use strict';

const assert = require('node:assert');
const P = require('../web/legion-mesh-policy.js');
const V = require('../src/pk-validate.js');
const S = require('../src/pk-sign.js');
const Sh = require('../src/credit-shield.js');
const C = require('../web/chat-mod.js');

let pass = 0;
let fail = 0;
function ok(name, fn) {
  try {
    fn();
    pass++;
    console.log('PASS  ' + name);
  } catch (e) {
    fail++;
    console.log('FAIL  ' + name + '  → ' + e.message);
  }
}

/* ---------------- 网格策略 ---------------- */
ok('信誉分档位', () => {
  assert.equal(P.tierOf(0).name, '受限');
  assert.equal(P.tierOf(85).name, '普通');
  assert.equal(P.tierOf(105).name, '良好');
  assert.equal(P.tierOf(150).name, '可信');
});

ok('副主选举：信誉优先，其次入团时间，最后 uid', () => {
  const list = [
    { uid: 'b', credit: 120, joinedAt: 200 },
    { uid: 'a', credit: 120, joinedAt: 100 },
    { uid: 'c', credit: 150, joinedAt: 900 },
  ];
  assert.equal(P.electDeputy(list), 'c');
  const tie = [
    { uid: 'z', credit: 130, joinedAt: 500 },
    { uid: 'y', credit: 130, joinedAt: 500 },
  ];
  assert.equal(P.electDeputy(tie), 'y');
  assert.equal(P.electDeputy(tie), P.electDeputy([...tie].reverse()), '顺序不应影响结果');
});

ok('连接阶梯：直连优先，纯中继模式直接从第二级开始', () => {
  assert.equal(P.ladder('direct').length, 2);
  assert.equal(P.ladder('direct')[0].step, 'direct');
  assert.equal(P.ladder('relay').length, 1);
  assert.equal(P.ladder('relay')[0].step, 'relay');
  assert.equal(P.stepAt(0).addTurn, false);
  assert.equal(P.stepAt(1).addTurn, true);
});

ok('链路分类：relay / Tailscale 组网 / 直连', () => {
  assert.equal(P.classifyPair([{ state: 'succeeded', localCandidateType: 'relay' }]), 'relay');
  assert.equal(P.classifyPair([{ state: 'succeeded', localCandidateType: 'host', remoteAddress: '100.101.2.3' }]), 'overlay');
  assert.equal(P.classifyPair([{ state: 'succeeded', localCandidateType: 'srflx', remoteAddress: '1.2.3.4' }]), 'direct');
  assert.equal(P.classifyPair([]), 'none');
});

ok('密钥轮换：到点即换，名册变动也换', () => {
  const now = 1e12;
  assert.equal(P.needRotate(now, 0), true);
  assert.equal(P.needRotate(now, now - 60e3), false);
  assert.equal(P.needRotate(now, now - 60e3, { rosterChanged: true }), true);
  assert.equal(P.needRotate(now, now - 31 * 60e3), true);
});

ok('名册合并：新增 / 变更 / 离开各算一次', () => {
  const cur = [
    { uid: 'a', alias: 'A', credit: 100, pub: 'x'.repeat(43) },
    { uid: 'b', alias: 'B', credit: 90, pub: 'y'.repeat(43) },
  ];
  const next = [
    { uid: 'a', alias: 'A2', credit: 100, pub: 'x'.repeat(43) },
    { uid: 'c', alias: 'C', credit: 110, pub: 'z'.repeat(43) },
  ];
  const d = P.mergeRoster(cur, next);
  assert.equal(d.list.length, 2);
  assert.deepEqual(d.added.map((m) => m.uid), ['c']);
  assert.deepEqual(d.updated.map((m) => m.uid), ['a']);
  assert.deepEqual(d.removed, ['b']);
});

ok('拓扑统计文案', () => {
  const t = P.topo([{ state: 'direct' }, { state: 'relay' }, { state: 'overlay' }, { state: 'down' }]);
  assert.equal(t.direct, 1);
  assert.equal(t.relay, 1);
  assert.equal(t.overlay, 1);
  assert.equal(t.down, 1);
  assert.ok(P.topoText(t).includes('直连 1'));
});

/* ---------------- PK 校验 ---------------- */
const NOW = Date.parse('2026-11-20T10:00:00Z');
const today = '2026-11-20';

ok('出操率越界 → 回退到上次合法值', () => {
  const r = V.validateLegionFile(
    { code: 'L001', season: '2026Q4', week: '2026-11-16', size: 10, rate7: 60, days: { [today]: 120 } },
    { code: 'L001', days: { [today]: 55 } },
    NOW
  );
  assert.equal(r.value.days[today], 55);
  assert.equal(r.ok, false);
  assert.ok(V.summarize(r.warnings).includes('回退'));
});

ok('专注分钟超过 1440 → 回退', () => {
  const r = V.validateBundle({ day: today, focusMin: 1441, credit: 100 }, { day: today, focusMin: 300, credit: 100 }, NOW);
  assert.equal(r.value.focusMin, 300);
  assert.equal(r.warnings[0].field, 'focusMin');
});

ok('信誉分超过 160 → 回退', () => {
  const r = V.validateBundle({ day: today, credit: 200 }, { day: today, credit: 120 }, NOW);
  assert.equal(r.value.credit, 120);
});

ok('未知军团码直接判无效', () => {
  const r = V.validateLegionFile({ code: '../etc/passwd' }, null, NOW);
  assert.equal(r.ok, false);
  assert.ok(r.fatal);
});

/* ---------------- 签名 ---------------- */
ok('签名往返 + 篡改检测', () => {
  const k = S.newKeyPair();
  const sealed = S.seal({ code: 'L001', size: 10, days: { [today]: 50 } }, k);
  const open = S.openSealed(sealed);
  assert.equal(open.ok, true);
  assert.equal(open.payload.code, 'L001');

  const bad = JSON.parse(JSON.stringify(sealed));
  bad.payload.size = 999;
  assert.equal(S.openSealed(bad).ok, false);
});

ok('换一把钥匙但签得对 → 仍然能验，公钥变化由上层固定值发现', () => {
  const k1 = S.newKeyPair();
  const k2 = S.newKeyPair();
  const f1 = S.seal({ code: 'L002' }, k1);
  const f2 = S.seal({ code: 'L002' }, k2);
  assert.equal(S.openSealed(f1).pub, k1.pub);
  assert.equal(S.openSealed(f2).pub, k2.pub);
  assert.notEqual(S.openSealed(f1).pub, S.openSealed(f2).pub);
});

/* ---------------- 新手保护罩 ---------------- */
const DAY = 86400e3;
const T0 = 1700000000000;

ok('保护罩：第 1 天只提醒', () => {
  const sh = Sh.shieldOf(T0, T0 + 3600e3);
  assert.equal(sh.day, 1);
  assert.equal(sh.factor, 0);
  assert.equal(Sh.applyPenalty(-5, sh).delta, 0);
});

ok('保护罩：第 2-3 天减半', () => {
  const sh = Sh.shieldOf(T0, T0 + 1 * DAY);
  assert.equal(sh.key, 'half');
  assert.equal(Sh.applyPenalty(-8, sh).delta, -4);
});

ok('保护罩：第 4-7 天下限 0', () => {
  const sh = Sh.shieldOf(T0, T0 + 3 * DAY);
  assert.equal(sh.key, 'soft');
  const p = Sh.applyPenalty(-30, sh);
  assert.equal(p.delta, -30);
  assert.equal(p.floor, 0);
});

ok('保护罩：第 8 天起正常', () => {
  const sh = Sh.shieldOf(T0, T0 + 7 * DAY);
  assert.equal(sh.key, 'normal');
  assert.equal(Sh.applyPenalty(-30, sh).delta, -30);
  assert.equal(Sh.applyPenalty(-30, sh).floor, undefined);
});

ok('保护罩不影响加分', () => {
  const sh = Sh.shieldOf(T0, T0);
  assert.equal(Sh.applyPenalty(5, sh).delta, 5);
});

/* ---------------- 频道秩序 ---------------- */
ok('刷屏：10 秒内第 6 条被拦', () => {
  const recent = Array.from({ length: 5 }, (_, i) => ({ at: NOW - i * 500, text: 'm' + i }));
  assert.equal(C.scan('再来一条', recent, { now: NOW }).level, 'mute');
});

ok('重复同一句：第三次被拦', () => {
  const recent = [
    { at: NOW - 1000, text: '在吗' },
    { at: NOW - 2000, text: '在吗' },
  ];
  const r = C.scan('在 吗', recent, { now: NOW });
  assert.equal(r.level, 'mute');
  assert.ok(r.reason.includes('重复'));
});

ok('骂人：直接禁言', () => {
  assert.equal(C.scan('你这个傻逼', [], { now: NOW }).level, 'mute');
});

ok('正常聊天不误伤', () => {
  assert.equal(C.scan('今天的保养记录我整理好了', [], { now: NOW }).level, 'ok');
});

ok('信誉分低于 60 不能发言', () => {
  assert.equal(C.canSpeak(59).ok, false);
  assert.equal(C.canSpeak(60).ok, true);
  assert.equal(C.canSpeak(10, true).ok, true, '第 1 天保护罩内不受限制');
});

ok('禁言三次进单人小黑屋', () => {
  /* 用内存桩替代 localStorage */
  const mem = new Map();
  global.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
  };
  C.mute('m1', 1, '刷屏');
  C.mute('m1', 1, '刷屏');
  assert.equal(C.isBlackboxed('m1'), false);
  C.mute('m1', 1, '刷屏');
  assert.equal(C.isBlackboxed('m1'), true);
  C.clearMute('m1');
  assert.equal(C.isBlackboxed('m1'), false);
});

console.log(`\n结果：${pass}/${pass + fail} 通过`);
process.exit(fail ? 1 : 0);
