'use strict';

/*
 * LiveKit 语音/视频签发（房主端）
 * - 配置存 userData/livekit.json：{ url, apiKey, apiSecret }
 * - 签发 LiveKit join token（HS256，纯 Node crypto，无新依赖）
 * - 设计：密钥只存在房主电脑本地；成员经 TCP 房间拿到的是"门票"（token），
 *   门票只能进当前房间、到期自动失效，拿不到密钥。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

let cfgPath = ''; // 由 main.js 注入 userData 路径
let cfg = null; // { url, apiKey, apiSecret } | null

const TOKEN_TTL_SECONDS = 6 * 3600; // 门票 6 小时有效

function init(userDataDir) {
  try {
    cfgPath = path.join(userDataDir, 'livekit.json');
    if (fs.existsSync(cfgPath)) {
      const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      cfg = {
        url: String(raw.url || '').trim(),
        apiKey: String(raw.apiKey || '').trim(),
        apiSecret: String(raw.apiSecret || '').trim(),
      };
      if (!cfg.url || !cfg.apiKey || !cfg.apiSecret) cfg = null;
    }
  } catch (_) {
    cfg = null;
  }
}

function save(next) {
  cfg = {
    url: String(next.url || '').trim(),
    apiKey: String(next.apiKey || '').trim(),
    apiSecret: String(next.apiSecret || '').trim(),
  };
  if (!cfg.url || !cfg.apiKey || !cfg.apiSecret) {
    cfg = null;
    try { if (cfgPath && fs.existsSync(cfgPath)) fs.unlinkSync(cfgPath); } catch (_) {}
    return false;
  }
  try {
    fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
    return true;
  } catch (_) {
    return false;
  }
}

function available() {
  return !!cfg;
}

/* 脱敏状态给设置页展示 */
function status() {
  if (!cfg) return { ok: false, configured: false };
  return { ok: true, configured: true, url: cfg.url, apiKey: cfg.apiKey };
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

/* LiveKit join token：header.payload 签名结构，video 字段声明房间权限 */
function issueToken({ identity, name, room, ttlSeconds }) {
  if (!cfg) return null;
  const exp = Math.floor(Date.now() / 1000) + Math.min(Math.max(ttlSeconds || TOKEN_TTL_SECONDS, 60), 24 * 3600);
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    iss: cfg.apiKey,
    sub: identity,
    jti: identity,
    exp,
    nbf: 0,
    name: String(name || identity),
    video: {
      room: String(room),
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    },
  };
  const h = b64url(JSON.stringify(header));
  const p = b64url(JSON.stringify(payload));
  const sig = b64url(crypto.createHmac('sha256', cfg.apiSecret).update(`${h}.${p}`).digest());
  return { url: cfg.url, token: `${h}.${p}.${sig}`, room: String(room), exp };
}

/* 房主自己 / 成员统一入口；未配置时返回 null（房间照常，只是没语音） */
function grant({ identity, name, room }) {
  if (!cfg || !identity || !room) return null;
  try {
    return issueToken({ identity, name, room });
  } catch (_) {
    return null;
  }
}

module.exports = { init, save, status, available, grant };
