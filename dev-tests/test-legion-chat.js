/* 军团频道规则测试：档位阈值、脏词、刷屏复读、禁言账本、信誉门槛、规则归一化 */
'use strict';

const assert = require('assert');
const C = require('../src/legion-chat');

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

console.log('\n[1] 规则归一化');
ok('默认是开启 + 标准 + 5 分钟', () => {
  const r = C.normalizeRules();
  assert.equal(r.on, true);
  assert.equal(r.level, 'normal');
  assert.equal(r.muteMin, 5);
  assert.deepEqual(r.words, []);
});
ok('未知档位退回标准', () => assert.equal(C.normalizeRules({ level: 'xx' }).level, 'normal'));
ok('时长夹在 1~60', () => {
  assert.equal(C.normalizeRules({ muteMin: 0 }).muteMin, 1);
  assert.equal(C.normalizeRules({ muteMin: 999 }).muteMin, 60);
});
ok('单字自定义词被丢掉', () => assert.deepEqual(C.normalizeRules({ words: ['a', '广告狗'] }).words, ['广告狗']));
ok('自定义词去重 + 最多 20 个', () => {
  const many = Array.from({ length: 40 }, (_, i) => '词话' + i);
  const r = C.normalizeRules({ words: many.concat(['词话0']) });
  assert.equal(r.words.length, 20);
});
ok('自定义词可以传字符串', () => {
  const r = C.normalizeRules({ words: '广告狗，代练  刷单' });
  assert.deepEqual(r.words, ['广告狗', '代练', '刷单']);
});
ok('withLevel 没手改时长时跟着档位走', () => {
  const r = C.withLevel({ on: true, level: 'normal', muteMin: 5, words: [] }, 'strict');
  assert.equal(r.level, 'strict');
  assert.equal(r.muteMin, 10);
});
ok('withLevel 手改过时长就不覆盖', () => {
  const r = C.withLevel({ on: true, level: 'normal', muteMin: 20, words: [] }, 'loose');
  assert.equal(r.muteMin, 20);
});

console.log('\n[2] 文本裁剪');
ok('去掉控制字符与零宽字符', () => assert.equal(C.clip('你\u200b好\u0007'), '你好'));
ok('超长截断到 200', () => assert.equal(C.clip('字'.repeat(300)).length, 200));
ok('连续空行压成一段', () => assert.equal(C.clip('a\n\n\n\nb'), 'a\n\nb'));

console.log('\n[3] 脏词');
ok('内置词命中', () => assert.equal(C.hitWord('你个傻逼', C.normalizeRules()), '傻逼'));
ok('用分隔符拼的也能抓', () => assert.equal(C.hitWord('傻 逼', C.normalizeRules()), '傻逼'));
ok('自定义词命中', () => assert.equal(C.hitWord('这里代练接单', C.normalizeRules({ words: ['代练'] })), '代练'));
ok('正常句子不误伤', () => assert.equal(C.hitWord('今天把第三章看完了', C.normalizeRules()), ''));
ok('短词只认整句', () => {
  assert.equal(C.hitWord('sb', C.normalizeRules()), 'sb');
  assert.equal(C.hitWord('sb这个单词在句子里', C.normalizeRules()), '');
});

console.log('\n[4] 刷屏与复读');
const N = C.normalizeRules({ level: 'normal' });
ok('第一条正常放行', () => assert.equal(C.scan('大家好', [], N, T0).level, 'ok'));
ok('标准档第 5 条还没事', () => {
  const recent = Array.from({ length: 4 }, (_, i) => ({ text: '消息' + i, at: T0 - i * 1000 }));
  assert.equal(C.scan('第 5 条', recent, N, T0).level, 'ok');
});
ok('标准档第 6 条拦下', () => {
  const recent = Array.from({ length: 5 }, (_, i) => ({ text: '消息' + i, at: T0 - i * 1000 }));
  const r = C.scan('第 6 条', recent, N, T0);
  assert.equal(r.level, 'deny');
  assert.equal(r.rule, 'burst');
  assert.equal(r.minutes, 5);
});
ok('严格档第 4 条就拦', () => {
  const S = C.normalizeRules({ level: 'strict' });
  const recent = Array.from({ length: 3 }, (_, i) => ({ text: '消息' + i, at: T0 - i * 1000 }));
  assert.equal(C.scan('第 4 条', recent, S, T0).rule, 'burst');
});
ok('宽松档第 9 条才拦', () => {
  const L = C.normalizeRules({ level: 'loose' });
  const recent = Array.from({ length: 7 }, (_, i) => ({ text: '消息' + i, at: T0 - i * 1000 }));
  assert.equal(C.scan('第 8 条', recent, L, T0).level, 'ok');
  assert.equal(C.scan('第 9 条', recent.concat([{ text: '第 8 条', at: T0 }]), L, T0).rule, 'burst');
});
ok('窗口外的旧消息不算数', () => {
  const recent = Array.from({ length: 9 }, (_, i) => ({ text: '旧' + i, at: T0 - 60000 - i * 1000 }));
  assert.equal(C.scan('现在说一句', recent, N, T0).level, 'ok');
});
ok('复读第三次拦下', () => {
  const recent = [
    { text: '同上', at: T0 - 3000 },
    { text: '同上', at: T0 - 2000 },
  ];
  const r = C.scan('同上', recent, N, T0);
  assert.equal(r.rule, 'dup');
});
ok('复读中间隔开别的句子也算', () => {
  const recent = [
    { text: '同上', at: T0 - 5000 },
    { text: '别的', at: T0 - 4000 },
    { text: '同上', at: T0 - 3000 },
  ];
  assert.equal(C.scan('同上', recent, N, T0).rule, 'dup');
});

console.log('\n[5] 提醒但不罚');
ok('@ 太多只提醒', () => {
  const r = C.scan('@甲 @乙 @丙 @丁 @戊 你们看', [], N, T0);
  assert.equal(r.level, 'warn');
  assert.equal(r.minutes, 0);
});
ok('大喊大叫只提醒', () => {
  const r = C.scan('冷静一点!!!!!!!!!!!!!!!!!!!!', [], N, T0);
  assert.equal(r.level, 'warn');
});
ok('正常长句不提醒', () => {
  assert.equal(C.scan('今天把这三章看完了，明天继续推进第四和第五章的内容。', [], N, T0).level, 'ok');
});

console.log('\n[6] 开关');
ok('关掉之后一律只读', () => {
  const r = C.scan('随便说点什么', [], C.normalizeRules({ on: false }), T0);
  assert.equal(r.level, 'deny');
  assert.equal(r.rule, 'off');
});
ok('空消息不收', () => assert.equal(C.scan('   ', [], N, T0).rule, 'empty'));

console.log('\n[7] 信誉门槛');
ok('标准档 60 以下不能发', () => {
  const r = C.canSpeak(59, C.normalizeRules({ level: 'normal' }));
  assert.equal(r.ok, false);
  assert.equal(r.floor, 60);
});
ok('标准档 60 可以发', () => assert.equal(C.canSpeak(60, C.normalizeRules({ level: 'normal' })).ok, true));
ok('严格档要 80', () => assert.equal(C.canSpeak(70, C.normalizeRules({ level: 'strict' })).ok, false));
ok('宽松档 40 就够', () => assert.equal(C.canSpeak(45, C.normalizeRules({ level: 'loose' })).ok, true));
ok('新人第一天不看分', () => assert.equal(C.canSpeak(0, C.normalizeRules({ level: 'strict' }), true).ok, true));
ok('频道关掉谁都不能发', () => assert.equal(C.canSpeak(160, C.normalizeRules({ on: false })).ok, false));

console.log('\n[8] 禁言账本');
ok('禁言后剩余时间正确', () => {
  const m = { u1: { until: T0 + 3 * 60e3, count: 1 } };
  assert.equal(C.muteLeft(m, 'u1', T0), 3 * 60e3);
});
ok('没被禁言是 0', () => assert.equal(C.muteLeft({}, 'u1', T0), 0));
ok('过期后自动归零', () => {
  const m = { u1: { until: T0 - 1, count: 1 } };
  assert.equal(C.muteLeft(m, 'u1', T0), 0);
});
ok('重复违规累加次数', () => {
  let m = C.applyMute({}, 'u1', 5, '刷屏', T0);
  assert.equal(m.u1.count, 1);
  m = C.applyMute(m, 'u1', 5, '刷屏', T0 + 1000);
  assert.equal(m.u1.count, 2);
  assert.equal(C.muteLeft(m, 'u1', T0 + 1000), 5 * 60e3);
});
ok('解禁清掉记录', () => {
  let m = C.applyMute({}, 'u1', 5, '刷屏', T0);
  m = C.clearMute(m, 'u1');
  assert.equal(C.muteLeft(m, 'u1', T0), 0);
});
ok('清理只留 24 小时内的历史', () => {
  const m = {
    a: { until: T0 + 1000, count: 1, at: T0 },
    b: { until: T0 - 1000, count: 1, at: T0 - 5 * 3600e3 },
    c: { until: T0 - 1000, count: 1, at: T0 - 30 * 3600e3 },
  };
  const out = C.pruneMutes(m, T0);
  assert.ok(out.a);
  assert.ok(out.b);
  assert.equal(out.c, undefined);
});
ok('剩余时间文案', () => {
  assert.equal(C.leftText(90e3), '2 分钟');
  assert.equal(C.leftText(0), '已解除');
  assert.equal(C.leftText(90 * 60e3), '1 小时 30 分钟');
});

console.log('\n[9] 消息入库');
ok('同一 id 不会重复入列', () => {
  const e = C.makeEntry('u1', '小明', '你好', T0);
  const log = C.pushLog(C.pushLog([], e), e);
  assert.equal(log.length, 1);
});
ok('超过上限只留最近 120 条', () => {
  let log = [];
  for (let i = 0; i < 200; i++) log = C.pushLog(log, C.makeEntry('u1', '小明', '第' + i + '条', T0 + i));
  assert.equal(log.length, C.MAX_LOG);
  assert.equal(log[log.length - 1].text, '第199条');
});
ok('文本在入库时被裁过', () => {
  const e = C.makeEntry('u1', '小明', '  你好  ', T0);
  assert.equal(e.text, '你好');
});
ok('昵称最多 12 字', () => {
  const e = C.makeEntry('u1', '一二三四五六七八九十十一十二十三', 'x', T0);
  assert.equal(e.alias.length, 12);
});

console.log('\n[10] 规则文案');
ok('关闭时文案写清楚', () => assert.ok(C.rulesText({ on: false }).includes('已关闭')));
ok('开启时带档位与门槛', () => {
  const t = C.rulesText({ on: true, level: 'strict', muteMin: 10, words: ['代练'] });
  assert.ok(t.includes('严格'));
  assert.ok(t.includes('10 分钟'));
  assert.ok(t.includes('80'));
  assert.ok(t.includes('自定义词 1 个'));
});
ok('三档都有文案', () => {
  for (const l of C.levelList()) {
    assert.ok(l.label && l.desc && l.floor >= 0);
  }
});

console.log('\n[11] @ 人');
const ROSTER = [
  { uid: 'u1', alias: '小明' },
  { uid: 'u2', alias: '小红' },
  { uid: 'u3', alias: '团长' },
];
ok('认出被 @ 的人', () => {
  const hits = C.mentionsOf('@小明 今天几点开始', ROSTER);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].uid, 'u1');
});
ok('一次 @ 多个人都认', () => {
  assert.equal(C.mentionsOf('@小明 @小红 一起来', ROSTER).length, 2);
});
ok('长昵称不会被短昵称抢走', () => {
  const r = [{ uid: 'a', alias: '小明' }, { uid: 'b', alias: '小明明' }];
  const hits = C.mentionsOf('@小明明 你看', r);
  assert.equal(hits.length, 2); // 两个都命中，但渲染时按长度优先
  const parts = C.splitMentions('@小明明 你看', r);
  assert.equal(parts[0].text, '@小明明');
});
ok('@ 到我自己', () => assert.equal(C.mentionsMe('@小明 在吗', '小明'), true));
ok('没 @ 我就不提醒', () => assert.equal(C.mentionsMe('小明在吗', '小明'), false));
ok('昵称是别人前缀时不算 @ 我', () => assert.equal(C.mentionsMe('@小明明 在吗', '小明'), true));
ok('切段不会丢字', () => {
  const parts = C.splitMentions('@小明 和 @小红 一起看第三章', ROSTER);
  assert.equal(parts.map((p) => p.text).join(''), '@小明 和 @小红 一起看第三章');
  assert.equal(parts.filter((p) => p.at).length, 2);
});
ok('没有 @ 时原样一段', () => {
  const parts = C.splitMentions('普通一句话', ROSTER);
  assert.equal(parts.length, 1);
  assert.equal(parts[0].at, false);
});

console.log('\n[12] 房间邀请');
ok('合法邀请能带上', () => {
  const inv = C.cleanInvite({ ip: '192.168.1.5', port: 48790, code: '1234' });
  assert.ok(inv && inv.ip === '192.168.1.5' && inv.port === 48790 && inv.code === '1234');
});
ok('缺端口拒绝', () => assert.equal(C.cleanInvite({ ip: '192.168.1.5', port: 0, code: '1234' }), null));
ok('缺房间码拒绝', () => assert.equal(C.cleanInvite({ ip: '192.168.1.5', port: 48790, code: '' }), null));
ok('端口越界拒绝', () => assert.equal(C.cleanInvite({ ip: '192.168.1.5', port: 70000, code: '1234' }), null));
ok('乱码地址拒绝', () => assert.equal(C.cleanInvite({ ip: '<script>', port: 1, code: '1' }), null));
ok('邀请跟着消息一起走', () => {
  const e = C.makeEntry('u1', '小明', '来房间', T0, { ip: '10.0.0.2', port: 48770, code: '8888' });
  assert.ok(e.invite && e.invite.code === '8888');
});
ok('没有邀请就不带字段', () => {
  const e = C.makeEntry('u1', '小明', '普通消息', T0, null);
  assert.equal(e.invite, undefined);
});

console.log('\n[13] 软件内链接');
ok('房间链接能生成', () => {
  const u = C.buildLink('room', { ip: '192.168.1.5', port: 48790, code: '1234' });
  assert.ok(/^pq:\/\/room\?/.test(u));
  assert.ok(u.includes('code=1234'));
});
ok('房间链接能解析回来', () => {
  const u = C.buildLink('room', { ip: '192.168.1.5', port: 48790, code: '1234' });
  const p = C.parseLink(u);
  assert.equal(p.kind, 'room');
  assert.equal(p.ip, '192.168.1.5');
  assert.equal(p.port, 48790);
  assert.equal(p.code, '1234');
});
ok('局域网军团链接', () => {
  const u = C.buildLink('legion', { net: 'lan', ip: '10.0.0.3', port: 48770, code: 'AB12' });
  const p = C.parseLink(u);
  assert.equal(p.kind, 'legion');
  assert.equal(p.net, 'lan');
  assert.equal(p.code, 'AB12');
});
ok('异地军团链接带邀请码', () => {
  const invite = 'x'.repeat(1200);
  const u = C.buildLink('legion', { net: 'p2p', code: 'ZZ99', invite });
  const p = C.parseLink(u);
  assert.equal(p.net, 'p2p');
  assert.equal(p.invite.length, 1200);
});
ok('缺参数不生成链接', () => {
  assert.equal(C.buildLink('room', { ip: '', port: 1, code: '12' }), '');
  assert.equal(C.buildLink('legion', { net: 'p2p', code: '1', invite: '' }), '');
});
ok('乱写的链接解析为 null', () => {
  assert.equal(C.parseLink('pq://room?ip=&port=0&code='), null);
  assert.equal(C.parseLink('http://example.com'), null);
});
ok('正文里的链接能被切出来', () => {
  const u = C.buildLink('room', { ip: '192.168.1.5', port: 48790, code: '1234' });
  const segs = C.splitLinks('来房间：' + u + ' 一起学');
  assert.equal(segs.length, 3);
  assert.equal(segs[0].text, '来房间：');
  assert.ok(segs[1].link && segs[1].link.kind === 'room');
  assert.equal(segs[2].text, ' 一起学');
});
ok('没有链接时原样一段', () => {
  const segs = C.splitLinks('普通消息');
  assert.equal(segs.length, 1);
  assert.equal(segs[0].text, '普通消息');
});
ok('计划包作为附件', () => {
  const text = JSON.stringify({ magic: 'PQPLAN', data: { plans: [] } });
  const lk = C.cleanLink({ kind: 'plan', name: '全部计划', count: 3, text });
  assert.ok(lk && lk.kind === 'plan' && lk.count === 3);
});
ok('超大计划包被拒', () => {
  assert.equal(C.cleanLink({ kind: 'plan', text: 'x'.repeat(60001) }), null);
});
ok('计划包跟着消息走', () => {
  const text = JSON.stringify({ magic: 'PQPLAN', data: { plans: [] } });
  const e = C.makeEntry('u1', '小明', '分享计划', T0, null, { kind: 'plan', name: '全部', count: 2, text });
  assert.ok(e.link && e.link.kind === 'plan' && e.link.count === 2);
});

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
if (fail) process.exit(1);
process.exit(0);
