/* 军团治理规则测试：信誉分等级、投票门槛、法定人数、举报作废、职务权限 */
'use strict';

const assert = require('assert');
const G = require('../src/legion-gov');

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

console.log('\n[1] 信誉分等级');
ok('0 分是受限', () => assert.equal(G.tierOf(0).name, '受限'));
ok('79 还是受限', () => assert.equal(G.tierOf(79).name, '受限'));
ok('80 升普通', () => assert.equal(G.tierOf(80).name, '普通'));
ok('100 升良好', () => assert.equal(G.tierOf(100).name, '良好'));
ok('120 升可信', () => assert.equal(G.tierOf(120).name, '可信'));
ok('160 封顶仍是可信', () => assert.equal(G.tierOf(160).name, '可信'));
ok('徽章只给等级不给分数', () => {
  const b = G.tierBadge(103);
  assert.equal(b.name, '良好');
  assert.equal(Object.prototype.hasOwnProperty.call(b, 'score'), false);
});

console.log('\n[2] 发起投票的门槛');
const st = () => ({ votes: [], roles: {}, reports: [], daily: {}, bans: {}, log: [] });

ok('受限不能发起', () => {
  const r = G.canStart(st(), { uid: 'u1', tier: 0, type: 'other', now: T0 });
  assert.equal(r.ok, false);
  assert.ok(r.message.includes('普通'));
});
ok('普通可以发起', () => {
  const r = G.canStart(st(), { uid: 'u1', tier: 1, type: 'other', now: T0 });
  assert.equal(r.ok, true);
});
ok('职务投票：团长能发起，普通成员不能', () => {
  const a = G.canStart(st(), { uid: 'u1', tier: 3, type: 'role', isHost: false, now: T0 });
  const b = G.canStart(st(), { uid: 'u1', tier: 3, type: 'role', isHost: true, now: T0 });
  assert.equal(a.ok, false);
  assert.equal(b.ok, true);
});
ok('职务投票：副团长（有 assign.ask）也能发起', () => {
  const s = st();
  s.roles = { u9: 'deputy' };
  const r = G.canStart(s, {
    uid: 'u9',
    tier: 1,
    type: 'role',
    isHost: false,
    perms: G.permsOf(s.roles, 'u9'),
    roles: s.roles,
    target: 'u2',
    now: T0,
  });
  assert.equal(r.ok, true);
});
ok('职务投票：候选人已有职务被拒（一人一职）', () => {
  const s = st();
  s.roles = { u2: 'judge' };
  const r = G.canStart(s, { uid: 'u1', tier: 3, type: 'role', isHost: true, roles: s.roles, target: 'u2', now: T0 });
  assert.equal(r.ok, false);
  assert.ok(r.message.includes('一个职务'));
});
ok('职务投票：被禁发起的人也不能发起职务投票', () => {
  const s = st();
  s.bans['u1'] = T0 + 3600e3;
  const r = G.canStart(s, { uid: 'u1', tier: 3, type: 'role', isHost: true, now: T0 });
  assert.equal(r.ok, false);
  assert.ok(r.message.includes('禁发起'));
});
ok('每日次数：普通 2 次用完就拦', () => {
  const s = st();
  s.daily['u1'] = { day: G.dayKey(T0), n: 2 };
  const r = G.canStart(s, { uid: 'u1', tier: 1, type: 'other', now: T0 });
  assert.equal(r.ok, false);
  assert.ok(r.message.includes('次数'));
});
ok('可信 4 次，用 2 次还剩 2', () => {
  const s = st();
  s.daily['u1'] = { day: G.dayKey(T0), n: 2 };
  assert.equal(G.leftToday(s, 'u1', 3, T0), 2);
});
ok('跨天自动重置', () => {
  const s = st();
  s.daily['u1'] = { day: G.dayKey(T0), n: 4 };
  assert.equal(G.leftToday(s, 'u1', 3, T0 + 86400e3), 4);
});
ok('同时 2 个未结束就拦', () => {
  const s = st();
  s.votes = [
    { id: 'a', by: 'u1', type: 'other', status: 'open' },
    { id: 'b', by: 'u1', type: 'other', status: 'open' },
  ];
  const r = G.canStart(s, { uid: 'u1', tier: 3, type: 'other', now: T0 });
  assert.equal(r.ok, false);
  assert.ok(r.message.includes('还没结束'));
});
ok('被禁发起时给出剩余小时', () => {
  const s = st();
  s.bans['u1'] = T0 + 5 * 3600e3;
  const r = G.canStart(s, { uid: 'u1', tier: 3, type: 'other', now: T0 });
  assert.equal(r.ok, false);
  assert.ok(r.message.includes('5'));
});

console.log('\n[3] 投票与法定人数');
function mk(opts) {
  return G.newVote({ id: 'v1', type: 'other', by: 'u0', byAlias: '团长', question: '要不要', now: T0, ...opts });
}

ok('自己不能给自己投', () => {
  const v = mk();
  assert.equal(G.cast(v, 'u0', 'yes', T0).ok, false);
});
ok('4 人团需 2 人参与（50%）', () => {
  const v = mk();
  G.cast(v, 'u1', 'yes', T0);
  const t1 = G.tally(v, 4, T0);
  assert.equal(t1.need, 2);
  assert.equal(t1.quorum, false);
  G.cast(v, 'u2', 'yes', T0);
  const t2 = G.tally(v, 4, T0);
  assert.equal(t2.quorum, true);
});
ok('同意率 ≥60% 且同意>反对才算通过', () => {
  const v = mk();
  G.cast(v, 'u1', 'yes', T0);
  G.cast(v, 'u2', 'yes', T0);
  G.cast(v, 'u3', 'no', T0);
  const t = G.settle(v, 6, T0 + 11 * 60e3);
  assert.equal(t.status, 'pass'); // 2/3 = 66%
  assert.equal(v.status, 'pass');
});
ok('1 同意 1 反对 → 不通过', () => {
  const v = mk();
  G.cast(v, 'u1', 'yes', T0);
  G.cast(v, 'u2', 'no', T0);
  const t = G.settle(v, 4, T0 + 11 * 60e3);
  assert.equal(t.status, 'fail');
});
ok('人数不足即使全同意也不通过', () => {
  const v = mk();
  G.cast(v, 'u1', 'yes', T0);
  const t = G.settle(v, 8, T0 + 11 * 60e3); // 需要 4 人参与
  assert.equal(t.quorum, false);
  assert.equal(t.status, 'fail');
});
ok('没到时间不能结算', () => {
  const v = mk();
  G.cast(v, 'u1', 'yes', T0);
  G.cast(v, 'u2', 'yes', T0);
  const t = G.settle(v, 4, T0 + 1000);
  assert.equal(t.status, 'open');
});
ok('结束后不能再投', () => {
  const v = mk();
  G.cast(v, 'u1', 'yes', T0);
  G.cast(v, 'u2', 'yes', T0);
  G.settle(v, 4, T0 + 11 * 60e3);
  assert.equal(G.cast(v, 'u3', 'yes', T0 + 12 * 60e3).ok, false);
});
ok('改票只留最后一次', () => {
  const v = mk();
  G.cast(v, 'u1', 'yes', T0);
  G.cast(v, 'u1', 'no', T0 + 1000);
  const t = G.tally(v, 4, T0 + 2000);
  assert.equal(t.yes, 0);
  assert.equal(t.no, 1);
});

console.log('\n[4] 举报乱发投票');
ok('2 人举报还不作废', () => {
  const v = mk();
  G.cast(v, 'u1', 'yes', T0);
  G.report(v, 'u1', T0);
  const r = G.report(v, 'u2', T0);
  assert.equal(r.voided, false);
  assert.equal(v.status, 'open');
});
ok('第 3 个不同的人举报 → 作废', () => {
  const v = mk();
  G.cast(v, 'u1', 'yes', T0);
  G.report(v, 'u1', T0);
  G.report(v, 'u2', T0);
  const r = G.report(v, 'u3', T0);
  assert.equal(r.voided, true);
  assert.equal(v.status, 'void');
  assert.equal(v.result.voidBy, 'report');
});
ok('同一人重复举报只算一次', () => {
  const v = mk();
  for (let i = 0; i < 5; i += 1) G.report(v, 'u1', T0);
  assert.equal(v.reports.length, 1);
  assert.equal(v.status, 'open');
});
ok('不能举报自己的投票', () => {
  const v = mk();
  assert.equal(G.report(v, 'u0', T0).ok, false);
});
ok('作废的投票不参与结算', () => {
  const v = mk();
  G.cast(v, 'u1', 'yes', T0);
  G.cast(v, 'u2', 'yes', T0);
  G.report(v, 'u1', T0);
  G.report(v, 'u2', T0);
  G.report(v, 'u3', T0);
  const t = G.settle(v, 4, T0 + 11 * 60e3);
  assert.equal(t.status, 'void');
});

console.log('\n[5] 职务与权限');
ok('任命记录职务', () => {
  const r = G.assign({}, 'u1', 'judge');
  assert.equal(r.ok, true);
  assert.equal(G.roleOf(r.roles, 'u1').name, '纪律官');
});
ok('一人一职：已有职务的人不能再任命', () => {
  const roles = G.assign({}, 'u1', 'judge').roles;
  const r = G.assign(roles, 'u1', 'scribe');
  assert.equal(r.ok, false);
  assert.ok(r.message.includes('一个职务'));
  assert.equal(G.roleOf(r.roles, 'u1').name, '纪律官');
});
ok('职务带权限', () => {
  const r = G.assign({}, 'u1', 'judge');
  assert.equal(G.hasPerm(r.roles, 'u1', 'mute'), true);
  assert.equal(G.hasPerm(r.roles, 'u1', 'audit.view'), false);
});
ok('普通成员没有任何权限', () => {
  const roles = G.assign({}, 'u1', 'scribe').roles;
  assert.equal(G.hasPerm(roles, 'u2', 'vote.start'), false);
  assert.deepEqual(JSON.stringify(G.permsOf(roles, 'u2')), '[]');
});
ok('撤职', () => {
  const roles = G.assign({}, 'u1', 'judge').roles;
  const r = G.assign(roles, 'u1', '');
  assert.equal(r.ok, true);
  assert.equal(G.roleOf(r.roles, 'u1'), null);
});
ok('不存在的职务被拒', () => {
  assert.equal(G.assign({}, 'u1', 'king').ok, false);
});

console.log('\n[6] 候选人排序');
ok('按等级降序、同级按入团早', () => {
  const list = [
    { uid: 'b', alias: 'B', credit: 100, joinedAt: 2 },
    { uid: 'a', alias: 'A', credit: 100, joinedAt: 1 },
    { uid: 'c', alias: 'C', credit: 130, joinedAt: 9 },
  ];
  const out = G.candidates(list);
  assert.equal(out.map((m) => m.uid).join(''), 'cab');
});
ok('别名截断到 12 字', () => {
  const out = G.candidates([{ uid: 'x', alias: '一二三四五六七八九十十一十二十三', credit: 90 }]);
  assert.equal(out[0].alias.length, 12);
});

console.log('\n[7] 发言审核投票');
ok('带上原判定，通过时给出结论', () => {
  const v = G.newVote({
    id: 's1', type: 'speech', by: 'u1', byAlias: '纪律官', question: '这句算摸鱼吗',
    speech: { msgId: 'm1', current: 'work', text: '哈哈哈' }, now: T0,
  });
  G.cast(v, 'u2', 'yes', T0);
  G.cast(v, 'u3', 'yes', T0);
  const t = G.settle(v, 4, T0 + 11 * 60e3);
  assert.equal(t.status, 'pass');
  assert.equal(v.speech.current, 'work');
  assert.equal(v.speech.msgId, 'm1');
});

console.log('\n[8] 团长选举（团长退团 → 公告 → 投票接任）');
ok('新建选举：开放状态、10 分钟期限', () => {
  const e = G.newElection({ prevUid: 'uOld', prevAlias: '老团长', now: T0 });
  assert.equal(e.status, 'open');
  assert.equal(e.endsAt - e.startedAt, G.ELECTION_MS);
  assert.deepEqual(e.candidates, []);
});
ok('参选：登记候选人，重复参选被拒', () => {
  let e = G.newElection({ prevUid: 'uOld', now: T0 });
  e = G.campaign(e, 'u1', '小明', 96, T0).election;
  assert.equal(e.candidates.length, 1);
  const r = G.campaign(e, 'u1', '小明', 96, T0);
  assert.equal(r.ok, false);
});
ok('候选人上限 8 人', () => {
  let e = G.newElection({ now: T0 });
  for (let i = 0; i < 8; i++) e = G.campaign(e, 'c' + i, '成员' + i, 80, T0).election;
  const r = G.campaign(e, 'c9', '第九个', 80, T0);
  assert.equal(r.ok, false);
  assert.ok(r.message.includes('8'));
});
ok('投票：只能投给已参选的人，改票只留最后一次', () => {
  let e = G.newElection({ now: T0 });
  e = G.campaign(e, 'u1', '小明', 96, T0).election;
  e = G.campaign(e, 'u2', '小红', 90, T0).election;
  assert.equal(G.castBallot(e, 'v1', 'uNobody', T0).ok, false);
  e = G.castBallot(e, 'v1', 'u1', T0).election;
  e = G.castBallot(e, 'v1', 'u2', T0 + 1).election;
  assert.equal(e.ballots.v1, 'u2');
});
ok('结算：人数不足 → fail，没有新团长', () => {
  let e = G.newElection({ now: T0 });
  e = G.campaign(e, 'u1', '小明', 96, T0).election;
  e = G.castBallot(e, 'v1', 'u1', T0).election;
  const done = G.settleElection(e, 5, T0 + G.ELECTION_MS + 1);
  assert.equal(done.status, 'fail');
  assert.equal(done.result, null);
});
ok('结算：过半参与 → 票多者胜，写入 result', () => {
  let e = G.newElection({ now: T0 });
  e = G.campaign(e, 'u1', '小明', 96, T0).election;
  e = G.campaign(e, 'u2', '小红', 90, T0).election;
  e = G.castBallot(e, 'v1', 'u1', T0).election;
  e = G.castBallot(e, 'v2', 'u1', T0).election;
  e = G.castBallot(e, 'v3', 'u2', T0).election;
  const done = G.settleElection(e, 4, T0 + G.ELECTION_MS + 1);
  assert.equal(done.status, 'pass');
  assert.equal(done.result, 'u1');
});
ok('平票：信誉等级高者胜；同分按 uid 字典序（全员算出同一人）', () => {
  let e = G.newElection({ now: T0 });
  e = G.campaign(e, 'uA', '甲', 90, T0).election;
  e = G.campaign(e, 'uB', '乙', 110, T0).election;
  e = G.castBallot(e, 'v1', 'uA', T0).election;
  e = G.castBallot(e, 'v2', 'uB', T0).election;
  const done = G.settleElection(e, 4, T0 + G.ELECTION_MS + 1);
  assert.equal(done.result, 'uB');
  let e2 = G.newElection({ now: T0 });
  e2 = G.campaign(e2, 'uB', '乙', 110, T0).election;
  e2 = G.campaign(e2, 'uA', '甲', 110, T0).election;
  e2 = G.castBallot(e2, 'v1', 'uB', T0).election;
  e2 = G.castBallot(e2, 'v2', 'uA', T0).election;
  assert.equal(G.settleElection(e2, 4, T0 + G.ELECTION_MS + 1).result, 'uA');
});
ok('跨机器合并：帧里带来的选举快照归一化后与本机记账一致', () => {
  let e = G.newElection({ prevUid: 'uOld', prevAlias: '老团长', now: T0 });
  e = G.campaign(e, 'u1', '小明', 96, T0).election;
  e = G.castBallot(e, 'v1', 'u1', T0).election;
  const copy = G.normalizeElection(JSON.parse(JSON.stringify(e)));
  assert.deepEqual(copy.candidates, e.candidates);
  assert.deepEqual(copy.ballots, e.ballots);
  /* 伪造票不认：候选人之外的 choice 被丢掉 */
  const evil = { ...JSON.parse(JSON.stringify(e)), ballots: { v1: 'u1', hacker: 'uX' } };
  const clean = G.normalizeElection(evil);
  assert.equal(clean.ballots.hacker, undefined);
});

console.log('\n[12] Lv1 劝导权：折叠提醒 + 观察名单');
ok('第一次提醒只计数不进观察名单', () => {
  const st = { warnings: {}, watch: {} };
  const r = G.fold(st, 'u1', 'host', 'm1', T0);
  assert.equal(r.count, 1);
  assert.equal(r.watch, false);
  assert.ok(/偏离主题/.test(r.notice));
});
ok('提醒 3 次进观察名单', () => {
  const st = { warnings: {}, watch: {} };
  G.fold(st, 'u1', 'host', 'm1', T0);
  G.fold(st, 'u1', 'host', 'm2', T0);
  const r = G.fold(st, 'u1', 'host', 'm3', T0);
  assert.equal(r.watch, true);
  assert.ok(st.watch.u1 && st.watch.u1.since === T0);
});
ok('观察名单能看发言频率（按小时分桶）', () => {
  const rate = G.speechRate([{ at: T0 }, { at: T0 + 1 }, { at: T0 + 3600e3 }], T0 + 7200e3);
  assert.equal(rate.perHour, 2);
});

console.log('\n[13] Lv2 管制权：副团长投票过半 + 理由必填 + 滥用记账');
ok('不填理由不能发起管制', () => {
  const r = G.canStartModerate({}, { isHost: true, reason: '  ', hasDeputies: true });
  assert.equal(r.ok, false);
});
ok('没有副团长不能发起', () => {
  assert.equal(G.canStartModerate({}, { isHost: true, reason: '频繁发广告链接', hasDeputies: false }).ok, false);
});
ok('副团长过半判定：2 个副团长要 2 票同意', () => {
  const v = { votes: { d1: 'yes' }, endsAt: T0 - 1 };
  assert.equal(G.tallyModerate(v, 2, T0).pass, false);
  const v2 = { votes: { d1: 'yes', d2: 'no' }, endsAt: T0 - 1 };
  assert.equal(G.tallyModerate(v2, 2, T0).pass, false); // yes=1 < 过半2
  const v3 = { votes: { d1: 'yes', d2: 'yes' }, endsAt: T0 - 1 };
  assert.equal(G.tallyModerate(v3, 2, T0).pass, true);
});
ok('滥用 3 次自动解除团长职务', () => {
  const st = { log: [] };
  assert.equal(G.abuseTick(st, '违规管制', T0).removed, false);
  assert.equal(G.abuseTick(st, '违规管制', T0).removed, false);
  const r = G.abuseTick(st, '违规管制', T0);
  assert.equal(r.removed, true);
  assert.equal(st.abuse, 3);
});

console.log('\n[14] Lv3 驱逐权：全员投票 >2/3 + 7 天申诉');
ok('驱逐只有团长能发起，且团里至少 3 人', () => {
  assert.equal(G.canStartEvict({}, { isHost: false, rosterSize: 10 }).ok, false);
  assert.equal(G.canStartEvict({}, { isHost: true, rosterSize: 2 }).ok, false);
  assert.equal(G.canStartEvict({}, { isHost: true, rosterSize: 3 }).ok, true);
});
ok('赞成 >2/3 才执行', () => {
  const v = { votes: { a: 'yes', b: 'yes', c: 'no' }, endsAt: T0 - 1 }; // 3/5 = 60% 不够
  assert.equal(G.tallyEvict(v, 5, T0).pass, false);
  const v2 = { votes: { a: 'yes', b: 'yes', c: 'yes', d: 'yes', e: 'no' }, endsAt: T0 - 1 }; // 4/5 > 2/3
  assert.equal(G.tallyEvict(v2, 5, T0).pass, true);
});
ok('申诉期 7 天，一人一份', () => {
  const st = { appeals: {}, log: [] };
  const r = G.openAppeal(st, 'u9', T0);
  assert.equal(r.ok, true);
  assert.equal(r.appeal.until, T0 + G.LIMITS.APPEAL_MS);
  assert.equal(G.openAppeal(st, 'u9', T0).ok, false);
});
ok('申诉成功 → 团长扣 50 信誉', () => {
  const st = { appeals: { u9: { at: T0, until: T0 + 1, status: 'open' } }, log: [] };
  const r = G.judgeAppeal(st, 'u9', true, T0 + 2);
  assert.equal(r.won, true);
  assert.equal(r.creditPenalty, 50);
  assert.equal(st.appeals.u9.status, 'won');
});
ok('申诉失败不扣分', () => {
  const st = { appeals: { u8: { at: T0, until: T0 + 1, status: 'open' } }, log: [] };
  const r = G.judgeAppeal(st, 'u8', false, T0 + 2);
  assert.equal(r.creditPenalty, 0);
});

console.log('\n[15] 军团集体任务');
ok('发起集体任务：名字必填，基线 50~100', () => {
  const st = { log: [] };
  assert.equal(G.setCollective(st, { title: '', by: 'h' }).ok, false);
  const r = G.setCollective(st, { title: '全员出操', target: 300, by: 'h', now: T0 });
  assert.equal(r.ok, true);
  assert.equal(r.collective.target, 100);
  assert.equal(st.collective.title, '全员出操');
});
ok('贡献只涨不跌，进度取平均出操率', () => {
  const st = { log: [] };
  G.setCollective(st, { title: '全员出操', target: 90, by: 'h', now: T0 });
  G.progressCollective(st, 'u1', 1.0);
  const r = G.progressCollective(st, 'u1', 0.5); // 倒刷不认
  assert.equal(r.unchanged, true);
  assert.equal(st.collective.progress, 100);
  G.progressCollective(st, 'u2', 0.8);
  assert.equal(st.collective.progress, 90); // (1.0+0.8)/2
});
ok('进度达基线 → 集体任务达成，全团解锁 L2', () => {
  const st = { log: [] };
  G.setCollective(st, { title: '出操', target: 90, day: '2026-11-21', by: 'h', now: T0 });
  G.progressCollective(st, 'u1', 1.0);
  G.progressCollective(st, 'u2', 0.8);
  const r = G.settleCollective(st, T0);
  assert.equal(r.met, true);
  assert.equal(G.collectiveMetFor(st, '2026-11-21'), true);
  assert.equal(G.collectiveMetFor(st, '2026-11-22'), false);
});
ok('没达基线 → 只报进度', () => {
  const st = { log: [] };
  G.setCollective(st, { title: '出操', target: 90, by: 'h', now: T0 });
  G.progressCollective(st, 'u1', 0.5);
  const r = G.settleCollective(st, T0);
  assert.equal(r.met, false);
  assert.equal(r.progress, 50);
});
ok('个人贡献可查（L2 防搭便车用）', () => {
  const st = { log: [] };
  G.setCollective(st, { title: '出操', by: 'h', now: T0 });
  G.progressCollective(st, 'u1', 0.6);
  assert.equal(G.contributionOf(st, 'u1'), 0.6);
  assert.equal(G.contributionOf(st, 'u2'), null);
});

console.log('\n' + (fail === 0 ? '全部通过' : '有失败项') + `：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
