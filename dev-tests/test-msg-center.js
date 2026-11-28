/* 消息中心引擎单测：四条硬规矩逐条钉死
 *  1 去重（双通道同一消息只弹一次）
 *  2 不限频（刷屏不丢，同会话合并成 N 条）
 *  3 离线聚合（按会话合成一个泡泡）
 *  4 免打扰分粒度（全局 + 单会话，静音不影响未读）
 */
const path = require('path');
const assert = require('assert');
const { createEngine, MAX_BUBBLES } = require(path.join(__dirname, '../src/renderer/msg-center.js'));

let pass = 0;
function ok(name, fn) {
  try {
    fn();
    pass += 1;
    console.log('  ✓ ' + name);
  } catch (e) {
    console.error('  ✗ ' + name + '\n    ' + e.message);
    process.exitCode = 1;
  }
}

let T = 1700000000000;
const clock = () => T;
const mk = (o) => createEngine({ now: clock, ...(o || {}) });

console.log('\n[1] 去重：P2P 与 WebSocket 双通道同一条消息');
ok('同 id 双通道只弹一次，第二次判为 dup', () => {
  const e = mk();
  const msg = { kind: 'friend', convId: 'u1', id: 'm-9', from: '小林', text: '在吗' };
  const a = e.push(msg);
  const b = e.push({ ...msg });
  assert.strictEqual(a.action, 'bubble');
  assert.strictEqual(b.action, 'dup');
  assert.strictEqual(e.visible().length, 1);
  assert.strictEqual(e.visible()[0].count, 1, '重复消息不能把条数加一');
});

ok('不同通道 id 但内容相同（同一句话）也只弹一次', () => {
  const e = mk();
  e.push({ kind: 'room', convId: 'r1', from: '阿May', text: '打卡了' });
  const r = e.push({ kind: 'room', convId: 'r1', from: '阿May', text: '打卡了' });
  assert.strictEqual(r.action, 'dup');
});

ok('不同人 / 不同会话说的同样内容不算重复', () => {
  const e = mk();
  e.push({ kind: 'room', convId: 'r1', from: 'A', text: '1' });
  const r = e.push({ kind: 'room', convId: 'r1', from: 'B', text: '1' });
  assert.strictEqual(r.action, 'bubble');
});

ok('指纹过期后同内容可以再弹（两分钟后）', () => {
  const e = mk();
  e.push({ kind: 'room', convId: 'r1', from: 'A', text: '1' });
  T += 121000;
  const r = e.push({ kind: 'room', convId: 'r1', from: 'A', text: '1' });
  assert.strictEqual(r.action, 'bubble');
  T = 1700000000000;
});

console.log('\n[2] 不限频：刷屏不丢，同会话原地合并');
ok('同一会话连推 30 条：不丢，合并成 30 条新消息，只有一个泡泡', () => {
  const e = mk();
  let last = null;
  for (let i = 0; i < 30; i++) {
    last = e.push({ kind: 'room', convId: 'r1', from: '刷屏怪', id: 'x' + i, text: '第' + i + '条' });
  }
  assert.strictEqual(last.action, 'bubble');
  assert.strictEqual(e.visible().length, 1);
  assert.strictEqual(e.visible()[0].count, 30);
  assert.strictEqual(e.visible()[0].text, '第29条', '正文要是最后一条');
});

ok('不同会话超过上限时排队，不丢，关一个补一个', () => {
  const e = mk();
  for (let i = 0; i < MAX_BUBBLES + 3; i++) {
    const r = e.push({ kind: 'friend', convId: 'u' + i, id: 'm' + i, from: 'F' + i, text: 'hi' });
    if (i < MAX_BUBBLES) assert.strictEqual(r.action, 'bubble');
    else assert.ok(r.queued, '超出上限应排队');
  }
  assert.strictEqual(e.visible().length, MAX_BUBBLES);
  assert.strictEqual(e.queued().length, 3);
  const closed = e.close(e.visible()[0].key);
  assert.ok(closed.promoted, '关掉一个应立刻补上一个');
  assert.strictEqual(e.visible().length, MAX_BUBBLES);
  assert.strictEqual(e.queued().length, 2);
});

console.log('\n[3] 离线堆积：按会话聚合，不逐条炸');
ok('离线 3 个会话共 12 条 → 3 个泡泡，条数分别是 5/4/3', () => {
  const e = mk();
  const list = [];
  for (let i = 0; i < 5; i++) list.push({ kind: 'friend', convId: 'u1', id: 'o1-' + i, from: '小林', text: 'a' + i });
  for (let i = 0; i < 4; i++) list.push({ kind: 'room', convId: 'r1', id: 'o2-' + i, from: '阿May', text: 'b' + i });
  for (let i = 0; i < 3; i++) list.push({ kind: 'channel', convId: 'c1', id: 'o3-' + i, from: '团长', text: 'c' + i });
  const rs = e.pushBatch(list);
  assert.strictEqual(rs.length, 3);
  assert.strictEqual(e.visible().length, 3);
  const byKey = {};
  for (const c of e.visible()) byKey[c.key] = c;
  assert.strictEqual(byKey['friend:u1'].count, 5);
  assert.strictEqual(byKey['room:r1'].count, 4);
  assert.strictEqual(byKey['channel:c1'].count, 3);
  assert.strictEqual(byKey['friend:u1'].offline, true, '离线泡泡要打标记');
});

ok('离线批次里混进的重复消息被去重', () => {
  const e = mk();
  e.push({ kind: 'friend', convId: 'u1', id: 'dup1', from: '小林', text: 'x' });
  const rs = e.pushBatch([{ kind: 'friend', convId: 'u1', id: 'dup1', from: '小林', text: 'x' }]);
  assert.strictEqual(rs.length, 0);
});

console.log('\n[4] 免打扰：全局 + 单会话粒度');
ok('单会话静音：不弹窗，但未读照常累计', () => {
  const e = mk();
  e.mute('room', 'r1');
  const r = e.push({ kind: 'room', convId: 'r1', id: 'n1', from: '阿May', text: '吵死了' });
  assert.strictEqual(r.action, 'muted');
  assert.strictEqual(e.visible().length, 0);
  assert.strictEqual(e.unreadByKind().room, 1);
});

ok('静音按会话隔离：同 kind 的另一个会话不受影响', () => {
  const e = mk();
  e.mute('friend', 'u1');
  e.push({ kind: 'friend', convId: 'u1', id: 'a1', from: 'A', text: 'x' });
  const r = e.push({ kind: 'friend', convId: 'u2', id: 'a2', from: 'B', text: 'y' });
  assert.strictEqual(r.action, 'bubble');
});

ok('取消静音后新消息恢复弹窗', () => {
  const e = mk();
  e.mute('friend', 'u1');
  e.unmute('friend', 'u1');
  const r = e.push({ kind: 'friend', convId: 'u1', id: 'z1', from: 'A', text: 'x' });
  assert.strictEqual(r.action, 'bubble');
});

ok('全局关闭：全部不弹，但未读完整保留（不漏消息）', () => {
  const e = mk();
  e.setGlobal(false);
  assert.strictEqual(e.push({ kind: 'room', convId: 'r1', id: 'g1', from: 'A', text: '1' }).action, 'off');
  assert.strictEqual(e.push({ kind: 'aci', convId: 'aci', id: 'g2', from: '阿刺', text: '2' }).action, 'off');
  assert.strictEqual(e.visible().length, 0);
  assert.strictEqual(e.unreadTotal(), 2);
});

ok('@ 我 的消息带 mention 标记（弹窗要更醒目）', () => {
  const e = mk();
  const r = e.push({ kind: 'channel', convId: 'c1', id: 'at1', from: '团长', text: '@我 上线', mention: true });
  assert.strictEqual(r.mention, true);
  assert.strictEqual(e.visible()[0].mention, true);
});

console.log('\n[5] 持久化与已读');
ok('序列化/恢复静音名单与全局开关', () => {
  const a = mk();
  a.mute('friend', 'u9');
  a.setGlobal(false);
  const dump = JSON.parse(JSON.stringify(a.serialize()));
  const b = mk();
  b.restore(dump);
  assert.strictEqual(b.getGlobal(), false);
  assert.ok(b.isMuted('friend', 'u9'));
  assert.strictEqual(b.list().length, 1);
});

ok('markRead 清掉该会话的未读与条数', () => {
  const e = mk();
  e.push({ kind: 'room', convId: 'r1', id: 'k1', from: 'A', text: 'x' });
  e.push({ kind: 'room', convId: 'r1', id: 'k2', from: 'A', text: 'y' });
  assert.strictEqual(e.unreadTotal(), 2);
  e.markRead('room:r1');
  assert.strictEqual(e.unreadTotal(), 0);
  assert.strictEqual(e.visible().length, 0);
});

ok('清空后同 id 仍判重（不会因为关了泡泡又弹一次）', () => {
  const e = mk();
  e.push({ kind: 'friend', convId: 'u1', id: 'same', from: 'A', text: 'x' });
  e.closeAll();
  const r = e.push({ kind: 'friend', convId: 'u1', id: 'same', from: 'A', text: 'x' });
  assert.strictEqual(r.action, 'dup');
});

console.log(`\n通过 ${pass} 项\n`);
