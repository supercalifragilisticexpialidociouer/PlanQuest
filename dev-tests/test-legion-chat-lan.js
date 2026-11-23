/* 军团频道 · 局域网联调：真开 TCP，房主建团、成员加入、互发消息、改规则、禁言 */
'use strict';

function fresh() {
  const p = require.resolve('../src/legion-room.js');
  delete require.cache[p];
  return require(p);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  const events = [];
  host.setEmitter((e) => events.push(e));
  const created = await host.createLegion({ code: '4321', alias: '团长', uid: 'u-host' });
  ck('房主建团', created.ok && created.port > 0, created);

  /* ---- 频道初始状态 ---- */
  const st0 = host.chatState();
  ck('默认规则：开启 + 标准 + 5 分钟', st0.rules.on === true && st0.rules.level === 'normal' && st0.rules.muteMin === 5, st0.rules);

  const r1 = host.chatSend('大家好，今天一起把第三章看完', { credit: 120 });
  ck('房主发言成功', r1.ok && r1.msg && r1.msg.text.includes('第三章'), r1);
  ck('发言进了记录', host.chatState().log.some((m) => m.text.includes('第三章')));

  /* ---- 房间邀请：和自习房联机同一套连接参数 ---- */
  const inv = host.chatSend('来我的自习房', { credit: 120, invite: { ip: '192.168.1.9', port: 48790, code: '1234' } });
  ck('邀请跟着消息带出去', inv.ok && inv.msg && inv.msg.invite && inv.msg.invite.code === '1234', inv);

  const planText = JSON.stringify({ magic: 'PQPLAN', format: 1, data: { plans: [{ id: 'p1', title: '第三章' }] } });
  const pl = host.chatSend('分享一份计划：全部计划', { credit: 120, link: { kind: 'plan', name: '全部计划', count: 1, text: planText } });
  ck('计划包作为附件发出', pl.ok && pl.msg && pl.msg.link && pl.msg.link.kind === 'plan' && pl.msg.link.count === 1, pl);

  /* ---- 成员加入，拿得到规则与历史 ---- */
  const member = fresh();
  const mev = [];
  member.setEmitter((e) => mev.push(e));
  const joined = await member.joinLegion({ ip: '127.0.0.1', port: created.port, code: '4321', alias: '小明', uid: 'u-min' });
  ck('成员加入成功', joined.ok && joined.uid === 'u-min', joined);
  ck('加入时带回规则', joined.chat && joined.chat.rules && joined.chat.rules.level === 'normal', joined.chat && joined.chat.rules);
  ck('加入时带回历史', joined.chat && Array.isArray(joined.chat.log) && joined.chat.log.some((m) => m.text.includes('第三章')));

  await sleep(120);

  /* ---- 成员发言，房主广播 ---- */
  const r2 = member.chatSend('我在，刚打完卡', { credit: 100 });
  ck('成员发言交给房主中继', r2.ok && r2.pending === true, r2);
  await sleep(200);
  const hostLog = host.chatState().log;
  ck('房主收到并记账', hostLog.some((m) => m.uid === 'u-min' && m.text === '我在，刚打完卡'), hostLog.slice(-3));
  ck('房主自己看得到这条', events.some((e) => e.type === 'chat' && e.msg && e.msg.uid === 'u-min'));
  /* 广播会绕回成员自己，用于确认消息确实进了公共记录 */
  ck('广播回到成员端', mev.some((e) => e.type === 'chat' && e.msg && e.msg.text === '我在，刚打完卡'), mev.map((e) => e.type));
  const sawInvite =
    mev.some((e) => e.type === 'chat' && e.msg && e.msg.invite && e.msg.invite.code === '1234') ||
    mev.some((e) => e.type === 'chatHistory' && (e.log || []).some((m) => m && m.invite && m.invite.code === '1234'));
  ck('成员收到了房间邀请', sawInvite, mev.map((e) => e.type));

  /* ---- 团长改规则：立即下发 ---- */
  const rr = host.setChatRules({ level: 'strict' });
  ck('改严格档成功', rr.ok && rr.rules.level === 'strict' && rr.rules.muteMin === 10, rr);
  await sleep(150);
  ck('成员收到新规则', mev.some((e) => e.type === 'chatRules' && e.rules.level === 'strict'), mev.filter((e) => e.type === 'chatRules'));
  ck('改规则留了系统消息', host.chatState().log.some((m) => m.sys && m.text.includes('严格')));

  /* ---- 严格档：信誉门槛拦人 ---- */
  const low = member.chatSend('我分很低也想说句话', { credit: 50 });
  ck('信誉 50 在严格档发不出', low.ok === false && String(low.message).includes('70') === false && String(low.message).length > 0, low);

  /* ---- 刷屏：连发四条被拦下并禁言 ---- */
  const spam = [];
  for (let i = 0; i < 4; i++) {
    spam.push(host.chatSend('刷屏测试第' + i + '条', { credit: 120 }));
    await sleep(30);
  }
  const denied = spam.filter((x) => !x.ok);
  ck('严格档连发被拦', denied.length >= 1, spam.map((x) => x.ok));
  ck('被拦后进了禁言', Object.keys(host.chatState().mutes).length >= 1, host.chatState().mutes);
  /* 团长自己也会被规则关住，但可以自己解开 —— 规则对团长同样生效，处置权也还在他手上 */
  host.chatUnmute('u-host');

  /* ---- 团长手动禁言 / 解禁 ---- */
  const m1 = host.chatMute('u-min', 5, '乱发投票');
  ck('团长可以禁言成员', m1.ok && host.chatState().mutes['u-min'].until > Date.now(), m1);
  await sleep(120);
  const blocked = member.chatSend('我还能说话吗', { credit: 100 });
  ck('被禁言的成员发不出', blocked.ok === false, blocked);
  ck('成员端收到了禁言通知', mev.some((e) => e.type === 'chatMute' && e.uid === 'u-min'), mev.map((e) => e.type));
  const m2 = host.chatUnmute('u-min');
  ck('解除禁言', m2.ok && !host.chatState().mutes['u-min'], m2);

  /* ---- 自定义词 ---- */
  host.setChatRules({ words: ['代练'] });
  const bad = host.chatSend('这里可以代练吗', { credit: 120 });
  ck('自定义词拦下广告', bad.ok === false && String(bad.message).includes('代练'), bad);
  host.chatUnmute('u-host');

  /* ---- 关闭频道 ---- */
  host.setChatRules({ on: false });
  ck('关掉后规则是只读', host.chatState().rules.on === false);
  const off = host.chatSend('关掉还能说吗', { credit: 120 });
  ck('关掉后发不出', off.ok === false && String(off.message).includes('关闭'), off);
  host.setChatRules({ on: true });

  /* ---- 团长退团：公告 + 选举帧到达成员端（放在落盘之前，loadStore 会清 socket 表） ---- */
  mev.length = 0;
  const el = host.govAnnounceLeave({ uid: 'u-host', alias: '团长甲' });
  ck('退团公告返回选举对象', el.ok && el.election && el.election.status === 'open', el);
  await sleep(100);
  ck('公告以系统消息广播出去', mev.some((e) => e.type === 'chat' && e.msg && e.msg.sys && String(e.msg.text).includes('已退团')), mev.map((e) => e.type));
  ck('成员收到选举帧', mev.some((e) => e.type === 'govElection' && e.election && e.election.prevUid === 'u-host'), mev.map((e) => e.type));
  const seeded = host.govElectionSeed(el.election);
  ck('选举快照可再播种（幂等）', seeded.ok && seeded.election.id === el.election.id, seeded);

  /* ---- 落盘再读回 ---- */
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const tmp = path.join(os.tmpdir(), 'pq-legion-chat-' + Date.now() + '.json');
  host.setStorePath(tmp);
  host.chatUnmute('u-host'); // 顺手触发一次落盘
  await sleep(50);
  const saved = JSON.parse(fs.readFileSync(tmp, 'utf8'));
  ck('规则与记录都落了盘', !!(saved.chat && saved.chat.rules && Array.isArray(saved.chat.log)), saved.chat && Object.keys(saved.chat));

  const again = fresh();
  again.setStorePath(tmp);
  const back = again.chatState();
  ck('重启后规则还在', back.rules.words.includes('代练'), back.rules);
  ck('重启后记录还在', back.log.length > 0, back.log.length);

  member.leaveLegion(true);
  host.leaveLegion(true);
  try {
    fs.unlinkSync(tmp);
  } catch (_) {}

  console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail ? 1 : 0);
})();
