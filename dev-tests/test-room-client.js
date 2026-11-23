/* 手机版局域网房间 · 协议层端到端测试
 *
 * 思路：在 Node 里模拟 Capacitor 原生插件 LanRoom（用 net 实现同样的 open/write/close/request + 事件），
 * 把 www/room-lan.js 原样跑起来，对着真实的电脑版房间服务（src/study-room.js）走完整流程。
 * 这样验证的是"手机点加入 → 收到 welcome → 快照/聊天/表情/状态 → 退出"整条链路。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const net = require('net');
const vm = require('vm');

const roomServer = require('../src/study-room.js');

let pass = 0;
let fail = 0;
function ok(cond, name, extra) {
  if (cond) {
    pass++;
    console.log('  ✓ ' + name);
  } else {
    fail++;
    console.log('  ✗ ' + name + (extra ? '  → ' + JSON.stringify(extra) : ''));
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 模拟原生插件 LanRoom（行为对齐 LanRoomPlugin.kt） ---------- */
function mockPlugin() {
  const listeners = { line: [], closed: [] };
  let sock = null;
  let closedBySelf = false;

  const fire = (ev, payload) => (listeners[ev] || []).forEach((cb) => setImmediate(() => cb(payload)));

  function attach(s, onFirst) {
    let buf = '';
    s.setEncoding('utf8');
    s.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        if (onFirst) onFirst(line);
        else fire('line', { line });
      }
    });
    s.on('close', () => fire('closed', { reason: closedBySelf ? 'bye' : 'remote' }));
    s.on('error', () => {});
  }

  return {
    addListener(ev, cb) {
      (listeners[ev] = listeners[ev] || []).push(cb);
      return Promise.resolve({ remove() {} });
    },
    open({ host, port, timeout }) {
      return new Promise((resolve) => {
        closedBySelf = false;
        const s = new net.Socket();
        s.setTimeout(timeout || 4000);
        s.once('error', () => resolve({ ok: false, message: '连不上，请检查 IP 和网络' }));
        s.once('timeout', () => resolve({ ok: false, message: '连接超时' }));
        s.connect(port, host, () => {
          s.setTimeout(0);
          attach(s);
          sock = s;
          resolve({ ok: true });
        });
      });
    },
    write({ line }) {
      if (sock && !sock.destroyed) sock.write(line + '\n');
      return Promise.resolve({ ok: true });
    },
    close() {
      closedBySelf = true;
      try {
        if (sock) sock.destroy();
      } catch (e) {}
      sock = null;
      return Promise.resolve({ ok: true });
    },
    request({ host, port, line, timeout }) {
      return new Promise((resolve) => {
        const s = new net.Socket();
        let buf = '';
        let done = false;
        const finish = (r) => {
          if (done) return;
          done = true;
          try { s.destroy(); } catch (e) {}
          resolve(r);
        };
        s.setTimeout(timeout || 3500);
        s.once('error', () => finish({ ok: false, message: '连不上，请检查 IP 和网络' }));
        s.once('timeout', () => finish({ ok: false, message: '连接超时' }));
        s.setEncoding('utf8');
        s.on('data', (c) => {
          buf += c;
          const i = buf.indexOf('\n');
          if (i >= 0) finish({ ok: true, line: buf.slice(0, i).trim() });
        });
        s.connect(port, host, () => s.write(line + '\n'));
      });
    },
  };
}

/* ---------- 把 room-lan.js 装进沙箱 ---------- */
function loadClient(plugin) {
  const code = fs.readFileSync(path.join(__dirname, '../android-app/www/room-lan.js'), 'utf8');
  const win = { Capacitor: { registerPlugin: () => plugin } };
  const sandbox = {
    window: win,
    console,
    setTimeout,
    clearTimeout,
    data: { profile: { name: '手机同学', avatar: '📱', points: 80 }, guardian: { allowUntil: 0 } },
  };
  sandbox.window = win;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'room-lan.js' });
  return sandbox.window.PQRoom;
}

(async () => {
  // 1. 起一个真实的电脑版房间（房主）
  const created = await roomServer.createRoom({ name: '房主', avatar: '🙂', type: 'study' });
  ok(created.ok, '房主开房成功', created);
  const port = created.port;
  const code = created.code;
  console.log(`  · 房间 ${code} 在 127.0.0.1:${port}`);

  const hostEvents = [];
  roomServer.setEmitter((e) => hostEvents.push(e));

  const client = loadClient(mockPlugin());
  ok(client.available(), '手机端识别到局域网组件');

  // 2. 错误房间码
  const bad = await client.probe({ ip: '127.0.0.1', port, code: '0000' });
  ok(bad.ok === false && /房间码/.test(bad.message || ''), '错误房间码被拒绝', bad);

  // 3. 正确房间码探测
  const info = await client.probe({ ip: '127.0.0.1', port, code });
  ok(info.ok && info.roomType === 'study', '探测拿到房间信息', info);
  ok(info.fee === 0 && info.enough === true, '自习房不要积分', info);

  // 4. 加入
  const events = [];
  client.onRoom((e) => events.push(e));
  const joined = await client.join({ ip: '127.0.0.1', port, code, name: '手机同学', avatar: '📱' });
  ok(joined.ok && !!joined.yourId, '加入成功并拿到成员号', joined);
  ok(/^m-/.test(joined.yourId || ''), '成员号格式与电脑版一致', joined.yourId);

  await sleep(250);
  const snap = events.filter((e) => e.type === 'snapshot').pop();
  ok(!!snap, '收到成员快照', events.map((e) => e.type));
  ok(snap && snap.members.length === 2, '快照里有房主和自己', snap && snap.members.map((m) => m.name));
  ok(
    snap && snap.members.some((m) => m.name === '手机同学' && m.st),
    '自己那一项带 st 字段（界面要用）',
    snap && snap.members
  );

  // 5. 状态与身份
  const st = client.status();
  ok(st.inRoom && st.code === code && st.isHost === false, '房间状态正确', st);
  ok(st.myId === joined.yourId, '状态里带上自己的成员号', { myId: st.myId, expect: joined.yourId });

  // 6. 再拉一台设备进来，验证"另一台设备能看到我的状态"
  const client2 = loadClient(mockPlugin());
  const events2 = [];
  client2.onRoom((e) => events2.push(e));
  const joined2 = await client2.join({ ip: '127.0.0.1', port, code, name: '平板同学', avatar: '📲' });
  ok(joined2.ok, '第二台设备加入成功', joined2);
  await sleep(250);
  const snap2 = events2.filter((e) => e.type === 'snapshot').pop();
  ok(snap2 && snap2.members.length === 3, '两台设备都在成员列表里', snap2 && snap2.members.map((m) => m.name));

  // 7. 番茄钟状态同步（电脑版的成员卡片靠这个显示"专注中"）
  const s1 = client.sendState({ status: 'studying', focus: 12 });
  ok(s1.ok, '发送番茄钟状态');
  await sleep(250);
  const seen = events2.filter((e) => e.type === 'snapshot').pop();
  const mineSeen = seen && seen.members.find((m) => m.name === '手机同学');
  ok(!!mineSeen && mineSeen.st && mineSeen.st.status === 'studying', '另一台设备看到我的专注状态', mineSeen && mineSeen.st);

  // 8. 聊天
  client.sendChat('来自手机的同学报到');
  await sleep(250);
  const chatEvt = events2.filter((e) => e.type === 'chat').pop();
  ok(!!chatEvt && chatEvt.msg.text.includes('手机'), '聊天广播到另一台设备', chatEvt);
  ok(!!chatEvt && chatEvt.msg.from === '手机同学', '聊天带上发送者名字', chatEvt && chatEvt.msg);

  // 9. 表情
  client.sendReaction('👍');
  await sleep(250);
  ok(events2.some((e) => e.type === 'reaction' && e.emoji === '👍'), '表情广播到另一台设备');

  // 10. 空消息不发
  const empty = client.sendChat('   ');
  ok(empty.ok === false, '空聊天不发出去', empty);

  // 11. 退出：另一台设备的成员列表应该少一个人，房主收到"离开"提示
  await client.leave(false);
  await sleep(300);
  ok(events.some((e) => e.type === 'closed'), '退出后收到 closed 事件');
  ok(!client.status().inRoom, '退出后状态回到未进房');
  const after = events2.filter((e) => e.type === 'snapshot').pop();
  ok(after && after.members.length === 2, '另一台设备看到我离开', after && after.members.map((m) => m.name));
  ok(
    hostEvents.some((e) => e.type === 'reaction' && e.emoji === '🚪' && e.from === '手机同学'),
    '房主收到离开提示',
    hostEvents.filter((e) => e.type === 'reaction')
  );

  await client2.leave(true);
  roomServer.leaveRoom(true);
  console.log(`\n${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('测试崩了', e);
  process.exit(1);
});
