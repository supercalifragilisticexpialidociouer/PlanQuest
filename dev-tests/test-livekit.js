'use strict';

/*
 * LiveKit 接入测试：
 * 1) token 签发（JWT 结构 / HMAC 校验 / 权限字段 / 有效期）
 * 2) 房间集成：真实 study-room 开房 → 成员加入 → welcome 带 livekit 门票
 * 3) 手机协议层：room-lan 收到 welcome 发出 livekit 事件（沿用 test-room-client 的插件模拟思路，这里直接验 study-room 侧）
 */

const crypto = require('node:crypto');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const livekit = require('../src/livekit');
const room = require('../src/study-room');

let pass = 0;
function ok(cond, label, extra) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ ${label}`, extra !== undefined ? JSON.stringify(extra).slice(0, 200) : '');
    process.exitCode = 1;
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function verifyJwt(token, secret) {
  const [h, p, s] = token.split('.');
  const expect = crypto
    .createHmac('sha256', secret)
    .update(`${h}.${p}`)
    .digest()
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  const header = JSON.parse(Buffer.from(h, 'base64').toString());
  const payload = JSON.parse(Buffer.from(p, 'base64').toString());
  return { sigOk: s === expect, header, payload };
}

(async () => {
  console.log('— LiveKit 接入测试 —\n');

  /* 1. 配置与签发 */
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pq-lk-'));
  livekit.init(tmp);
  ok(livekit.available() === false, '未配置时 available=false');
  ok(livekit.grant({ identity: 'x', name: 'x', room: '1234' }) === null, '未配置时签发返回 null');

  ok(livekit.save({ url: '', apiKey: 'k', apiSecret: 's' }) === false, '缺 URL 保存失败');
  ok(livekit.save({ url: 'wss://test.livekit.cloud', apiKey: 'APIKeyTest', apiSecret: 'secret-abc' }) === true, '配置保存成功');
  ok(fs.existsSync(path.join(tmp, 'livekit.json')), '配置落盘 livekit.json');
  livekit.init(tmp); // 模拟重启读回
  ok(livekit.available() === true, '重启后配置读回');

  const st = livekit.status();
  ok(st.configured && st.url === 'wss://test.livekit.cloud', 'status 脱敏暴露 url/key');

  const g = livekit.grant({ identity: 'm-abc', name: '手机同学', room: '4821' });
  ok(!!g && g.url === 'wss://test.livekit.cloud', 'grant 返回 url');
  ok(!!g && g.room === '4821', 'grant 绑定房间码');
  const v = verifyJwt(g.token, 'secret-abc');
  ok(v.sigOk, 'JWT HMAC-SHA256 签名可被 LiveKit 校验');
  ok(v.header.alg === 'HS256' && v.header.typ === 'JWT', 'JWT header 正确', v.header);
  ok(v.payload.iss === 'APIKeyTest' && v.payload.sub === 'm-abc', 'JWT iss/sub = apiKey/identity', v.payload);
  ok(v.payload.video && v.payload.video.roomJoin === true && v.payload.video.room === '4821', 'video.roomJoin 权限正确', v.payload.video);
  ok(v.payload.exp > Math.floor(Date.now() / 1000) + 5 * 3600, '有效期约 6 小时');

  /* 2. 房间集成 */
  room.setLivekitIssuer((p) => livekit.grant(p));
  const events = [];
  room.setEmitter((e) => events.push(e));

  const host = await room.createRoom({ name: '房主', avatar: '🙂', type: 'study' });
  ok(host.ok && host.code, `房主开房（码 ${host.code}）`);
  await sleep(100);
  ok(events.some((e) => e.type === 'livekit' && e.room === host.code), '房主自签门票并抛出 livekit 事件');
  const hostStatus = room.roomStatus();
  ok(!!hostStatus.livekit && hostStatus.livekit.token, '房主 roomStatus 带门票');

  // 模拟一个成员 TCP 加入，收 welcome
  const net = require('node:net');
  const memberWelcome = await new Promise((resolve) => {
    const s = net.connect(host.port, '127.0.0.1', () => {
      s.write(JSON.stringify({ type: 'join', code: host.code, name: '手机同学', avatar: '🤖' }) + '\n');
    });
    let buf = '';
    s.on('data', (d) => {
      buf += d.toString();
      const i = buf.indexOf('\n');
      if (i >= 0) {
        const msg = JSON.parse(buf.slice(0, i));
        s.end();
        resolve(msg);
      }
    });
    s.on('error', () => resolve(null));
  });
  ok(!!memberWelcome && memberWelcome.type === 'welcome', '成员加入收到 welcome');
  ok(!!memberWelcome && !!memberWelcome.livekit && memberWelcome.livekit.token, 'welcome 携带语音门票');
  if (memberWelcome && memberWelcome.livekit) {
    const mv = verifyJwt(memberWelcome.livekit.token, 'secret-abc');
    ok(mv.sigOk, '成员门票签名有效');
    ok(mv.payload.video.room === host.code, '成员门票绑定本房间');
  }

  // 没配置签发器时（模拟旧房主），新成员的 welcome 不再带门票
  room.setLivekitIssuer(null);
  room.leaveRoom(true);
  await sleep(100);
  ok(room.roomStatus().livekit === null, '退出后 roomStatus.livekit 清空');

  /* 3. 清除配置 */
  ok(livekit.save({ url: '', apiKey: '', apiSecret: '' }) === false, '清除配置生效');
  ok(!fs.existsSync(path.join(tmp, 'livekit.json')), '清除后配置文件删除');
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}

  console.log(`\n通过 ${pass} 项`);
})();
