'use strict';

/* 异地通道网络层单测：端到端加密（AES-GCM）+ 中继模式配置。
 * 在 Node 里跑：mock window，crypto/btoa/atob 用 Node 自带的。 */

const assert = (cond, msg, extra) => {
  if (!cond) {
    console.error('FAIL:', msg, extra !== undefined ? extra : '');
    process.exitCode = 1;
  } else console.log('PASS:', msg);
};

global.window = {};

require('../web/legion-p2p.js');
const T = window.PQLegionNet && window.PQLegionNet._test;
assert(!!T, '加载 legion-p2p.js 并暴露 _test');

(async () => {
  /* ---- 加密 ---- */
  const key = T.randHex(32);
  assert(/^[0-9a-f]{64}$/.test(key), '密钥是 64 位 hex（256 bit）');

  const sealed = await T.sealMsg(key, { t: 'push', uid: 'u-1', bundle: { checked: 1 } });
  assert(typeof sealed === 'string' && sealed.startsWith('E1:'), '密文带 E1: 前缀');
  assert(!sealed.includes('push') && !sealed.includes('u-1'), '密文不含明文字段');

  const opened = await T.openMsg(key, sealed);
  assert(opened && opened.t === 'push' && opened.uid === 'u-1' && opened.bundle.checked === 1, '解密还原完整消息', opened);

  const tampered = sealed.slice(0, -4) + (sealed.endsWith('AAAA') ? 'BBBB' : 'AAAA');
  assert((await T.openMsg(key, tampered)) === null, '篡改密文 → 拒绝');

  const key2 = T.randHex(32);
  assert((await T.openMsg(key2, sealed)) === null, '错误密钥 → 拒绝');

  assert((await T.openMsg(key, '{"t":"hello","uid":"evil"}')) === null, '明文消息 → 拒绝（不接受未加密通道）');

  assert((await T.openMsg(key, 'E1:!!!not-base64!!!')) === null, '损坏密文 → 拒绝不抛异常');

  /* nonce 每条不同：同一条消息封两次，密文应当不一样 */
  const s2 = await T.sealMsg(key, { t: 'ping' });
  const s3 = await T.sealMsg(key, { t: 'ping' });
  assert(s2 !== s3, '每条消息用不同随机 nonce');

  /* ---- 中继配置 ---- */
  T.setNetPrefs({ mode: 'direct' });
  let cfg = T.buildRtcConfig();
  assert(!cfg.iceTransportPolicy, '直连模式：不限制传输策略');
  assert(cfg.iceServers.length === 1 && cfg.iceServers[0].urls.length >= 3, '直连模式：STUN 多冗余');
  assert(cfg.iceServers.every((s) => !s.urls.join().includes('turn:')), '直连模式：不含 TURN');

  T.setNetPrefs({ mode: 'relay' });
  cfg = T.buildRtcConfig();
  assert(cfg.iceTransportPolicy === 'relay', '中继模式：强制 iceTransportPolicy=relay');
  assert(cfg.iceServers.some((s) => s.urls.join().includes('turn:')), '中继模式：自动带上内置公共 TURN');

  T.setNetPrefs({ mode: 'relay', turn: { urls: 'turn:turn.a.com:3478  turns:turn.b.com:5349?transport=tcp', username: 'u', credential: 'p' } });
  cfg = T.buildRtcConfig();
  const tu = cfg.iceServers.find((s) => s.username === 'u');
  assert(tu && Array.isArray(tu.urls) && tu.urls.length === 2, '自定义 TURN：urls 按空白拆分', tu && tu.urls);
  assert(cfg.iceTransportPolicy === 'relay', '自定义 TURN：仍然强制中继');

  T.setNetPrefs({ mode: 'relay', turn: null });
  cfg = T.buildRtcConfig();
  assert(cfg.iceServers.some((s) => s.urls.join().includes('openrelay')), '中继模式无自填：回退内置公共 TURN');

  T.setNetPrefs({ mode: 'weird' });
  assert(T.buildRtcConfig() && !T.buildRtcConfig().iceTransportPolicy, '未知模式 → 按直连处理');

  console.log(process.exitCode ? '结果：有失败' : '结果：全部通过');
})().catch((e) => {
  console.error('TEST-ERROR', e);
  process.exit(1);
});
