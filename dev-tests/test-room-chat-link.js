/* 自习房聊天 · 附件与 @ 的链路测试
 *
 * 房间聊天和军团频道是同一套底层（裸 TCP + JSON 行），这次验证：
 * - 计划包作为附件在房主↔成员之间双向可达
 * - 非法附件（未知 kind / 太短 / 超长）在服务端就被丢掉
 * - 只发附件、不写正文时补一个占位正文，不会变成空消息
 * - @ 文本原样透传（@ 的解析在渲染层，后端不碰）
 */
'use strict';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fresh() {
  for (const k of Object.keys(require.cache)) {
    if (/study-room\.js$/.test(k)) delete require.cache[k];
  }
  return require('../src/study-room.js');
}

(async () => {
  let pass = 0;
  let fail = 0;
  const ck = (name, cond, extra) => {
    if (cond) {
      pass++;
      console.log('  ✓', name);
    } else {
      fail++;
      console.log('  ✗', name, extra === undefined ? '' : JSON.stringify(extra));
    }
  };

  const host = fresh();
  const hev = [];
  host.setEmitter((e) => hev.push(e));
  const created = await host.createRoom({ name: '房主', avatar: '🙂' });
  ck('房主建房', created.ok && created.port > 0, created);

  const member = fresh();
  const mev = [];
  member.setEmitter((e) => mev.push(e));
  const joined = await member.joinRoom({
    ip: '127.0.0.1',
    port: created.port,
    code: created.code,
    name: '小明',
    avatar: '🐱',
  });
  ck('成员加入', joined.ok === true, joined);
  await sleep(120);

  const planText = JSON.stringify({ magic: 'PQPLAN', format: 1, data: { plans: [{ id: 'p1', title: '第三章' }] } });

  /* ---- 房主 → 成员：计划包 ---- */
  const r1 = host.sendChat('分享一份计划：全部计划', undefined, {
    kind: 'plan',
    name: '全部计划',
    count: 1,
    text: planText,
  });
  ck('房主发带附件的消息', r1.ok === true, r1);
  await sleep(120);
  const got1 = mev.filter((e) => e.type === 'chat').map((e) => e.msg).pop();
  ck('成员收到附件', !!(got1 && got1.link && got1.link.kind === 'plan' && got1.link.count === 1), got1);

  /* ---- 成员 → 房主：房间链接（纯文本 pq:// 不占附件位） ---- */
  const r2 = member.sendChat('@房主 来我这边 pq://room?ip=192.168.1.7&port=48765&code=4321');
  ck('成员发言成功', r2.ok === true, r2);
  await sleep(150);
  const got2 = hev.filter((e) => e.type === 'chat').map((e) => e.msg).pop();
  ck('房主收到成员的消息', !!(got2 && got2.text && got2.text.includes('@房主')), got2);
  ck('@ 文本原样透传', !!(got2 && got2.text.includes('@房主')), got2 && got2.text);

  /* ---- 成员 → 房主：计划包 ---- */
  const r3 = member.sendChat('分享一份计划：契约计划', undefined, {
    kind: 'plan',
    name: '契约计划',
    count: 2,
    text: planText,
  });
  ck('成员发附件', r3.ok === true, r3);
  await sleep(150);
  const got3 = hev.filter((e) => e.type === 'chat').map((e) => e.msg).pop();
  ck('房主收到成员附件', !!(got3 && got3.link && got3.link.kind === 'plan'), got3);

  /* ---- 只有附件、没有正文 ---- */
  const r4 = host.sendChat('', undefined, { kind: 'plan', name: '全部计划', count: 1, text: planText });
  ck('只有附件也能发', r4.ok === true, r4);
  const last = hev.filter((e) => e.type === 'chat').map((e) => e.msg).pop();
  ck('正文补了占位', !!(last && last.text && last.text.length > 0), last && last.text);

  /* ---- 非法附件被丢 ---- */
  const bad1 = host.sendChat('附件测试一', undefined, { kind: 'shell', cmd: 'rm -rf /' });
  const lastBad1 = hev.filter((e) => e.type === 'chat').map((e) => e.msg).pop();
  ck('未知附件类型被丢', bad1.ok === true && !lastBad1.link, lastBad1);

  const bad2 = host.sendChat('附件测试二', undefined, { kind: 'plan', name: 'x', text: '太短' });
  const lastBad2 = hev.filter((e) => e.type === 'chat').map((e) => e.msg).pop();
  ck('过短的计划包被丢', bad2.ok === true && !lastBad2.link, lastBad2);

  const huge = 'x'.repeat(70000);
  const bad3 = host.sendChat('附件测试三', undefined, { kind: 'plan', name: 'y', count: 1, text: huge });
  const lastBad3 = hev.filter((e) => e.type === 'chat').map((e) => e.msg).pop();
  ck('超大计划包被丢', bad3.ok === true && !lastBad3.link, lastBad3 && lastBad3.link);

  /* ---- 空消息直接拒 ---- */
  const empty = host.sendChat('   ');
  ck('空消息不产生新记录', empty.ok === false, empty);

  /* ---- @ 多个人：文本完整保留，后端不做重写 ---- */
  member.sendChat('@房主 @小明 晚上八点开');
  await sleep(120);
  const atMsg = hev.filter((e) => e.type === 'chat').map((e) => e.msg).pop();
  ck('多个 @ 完整保留', !!(atMsg && atMsg.text.includes('@房主') && atMsg.text.includes('@小明')), atMsg && atMsg.text);

  host.leaveRoom(true);
  member.leaveRoom(true);
  await sleep(50);

  console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail ? 1 : 0);
})();
