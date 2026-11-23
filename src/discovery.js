'use strict';

/*
 * 局域网发现 + 邀请（UDP）
 * - 每个实例把「我是谁 + 我房间房号」每 4 秒广播到 48900 端口
 * - 同一个 WiFi 下的其他实例会自动出现在「发现同学」列表里
 * - 「拉人」= 直接向对方发送邀请包，对方弹窗确认后加入
 * - 只用于局域网、不联网、不经过任何服务器
 */

const dgram = require('node:dgram');

const DISCOVERY_PORT = 48900;
const BEACON_MS = 4000;
const PEER_TTL_MS = 15000;

let sendSock = null; // 收发都用它（绑定随机端口，能收到回信）
let listenSock = null; // 尽量再绑 48900，用于接收他人广播
let timer = null;
let me = { name: '同学', avatar: '🙂', room: null }; // room: { code, type, port } | null
let peers = new Map(); // key(ip:port) -> { name, avatar, room, ip, port, ts }
let onInvite = () => {};

function setEmitter(fn) {
  onInvite = fn || (() => {});
}

function broadcastBeacon() {
  if (!sendSock) return;
  const payload = Buffer.from(
    JSON.stringify({
      app: 'PlanQuest',
      v: 1,
      kind: 'beacon',
      name: me.name,
      avatar: me.avatar,
      room: me.room,
      ts: Date.now(),
    })
  );
  for (const target of ['255.255.255.255', '127.0.0.1']) {
    try {
      sendSock.send(payload, DISCOVERY_PORT, target);
    } catch (_) {}
  }
}

function handlePacket(buf, rinfo) {
  let msg;
  try {
    msg = JSON.parse(buf.toString('utf8'));
  } catch (_) {
    return;
  }
  if (!msg || msg.app !== 'PlanQuest') return;
  if (rinfo.address === '127.0.0.1' && msg.ts && Date.now() - msg.ts > PEER_TTL_MS) return;

  if (msg.kind === 'beacon') {
    const key = `${rinfo.address}:${rinfo.port}`;
    peers.set(key, {
      key,
      name: String(msg.name || '同学').slice(0, 12),
      avatar: String(msg.avatar || '🙂').slice(0, 4),
      room: msg.room || null,
      ip: rinfo.address,
      port: rinfo.port,
      ts: Date.now(),
    });
  } else if (msg.kind === 'invite') {
    onInvite({
      from: String(msg.name || '同学').slice(0, 12),
      avatar: String(msg.avatar || '🙂').slice(0, 4),
      ip: rinfo.address,
      port: Number(msg.roomPort) || 48765,
      code: String(msg.code || ''),
      roomType: msg.roomType === 'fun' ? 'fun' : 'study',
    });
  } else if (msg.kind === 'bye') {
    peers.delete(`${rinfo.address}:${rinfo.port}`);
  }
}

function start(info) {
  if (info) me = { ...me, ...info };
  if (sendSock) return;
  try {
    sendSock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    sendSock.on('message', handlePacket);
    sendSock.on('error', () => {});
    sendSock.bind(0, () => {
      try {
        sendSock.setBroadcast(true);
      } catch (_) {}
      broadcastBeacon();
    });
  } catch (_) {
    sendSock = null;
  }
  // 再尝试独占 48900 接收广播（失败无所谓：可能同一台机器已有实例占用）
  try {
    listenSock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    listenSock.on('message', handlePacket);
    listenSock.on('error', () => {
      try {
        listenSock.close();
      } catch (_) {}
      listenSock = null;
    });
    listenSock.bind(DISCOVERY_PORT, () => {
      try {
        listenSock.setBroadcast(true);
      } catch (_) {}
    });
  } catch (_) {
    listenSock = null;
  }
  if (!timer) {
    timer = setInterval(() => {
      broadcastBeacon();
      const now = Date.now();
      for (const [k, v] of peers) if (now - v.ts > PEER_TTL_MS) peers.delete(k);
    }, BEACON_MS);
    timer.unref && timer.unref();
  }
}

/* 更新自己的名片与房间信息（进/出房间、切房间时调用） */
function update(info) {
  me = { ...me, ...(info || {}) };
  broadcastBeacon();
}

function list() {
  const myPort = sendSock ? sendSock.address().port : 0;
  const now = Date.now();
  return [...peers.values()]
    .filter((p) => now - p.ts <= PEER_TTL_MS && p.port !== myPort)
    .sort((a, b) => b.ts - a.ts)
    .map(({ key, name, avatar, room, ip, port }) => ({ key, name, avatar, room, ip, port }));
}

/* 邀请某位同学进我的房间 */
function invite(ip, port) {
  if (!sendSock || !me.room) return { ok: false, message: '还没有房间可以邀请' };
  const payload = Buffer.from(
    JSON.stringify({
      app: 'PlanQuest',
      v: 1,
      kind: 'invite',
      name: me.name,
      avatar: me.avatar,
      code: me.room.code,
      roomType: me.room.type || 'study',
      roomPort: me.room.port,
    })
  );
  try {
    sendSock.send(payload, Number(port) || DISCOVERY_PORT, ip);
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  for (const s of [sendSock, listenSock]) {
    try {
      s && s.close();
    } catch (_) {}
  }
  sendSock = null;
  listenSock = null;
  peers = new Map();
}

module.exports = { start, stop, update, list, invite, setEmitter, DISCOVERY_PORT };
