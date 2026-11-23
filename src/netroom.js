'use strict';

/* 异地联机 · 本地连接码编解码（不联网）
 *
 * 设计原则：信令绝不经过任何第三方服务器。
 * WebRTC 建立连接需要交换一段 SDP，这里把它压成一个"连接码"文本，
 * 由用户自己用微信/QQ 发给对方，粘回来即可 —— 全程不经过任何公网服务。
 *
 * 连接码格式：z + base64url(gzip(JSON))，一段典型的 datachannel-only SDP
 * 压缩后约 500~800 字符，微信里发一条消息完全放得下。
 *
 * 真正的数据（聊天、画面、状态）走 WebRTC DataChannel，强制 DTLS 加密，点对点直传，
 * 不经过任何中继（除非用户主动配置 TURN）。
 */

const zlib = require('node:zlib');
const crypto = require('node:crypto');

/* 连接码版本号：将来格式变化时用于向后兼容 */
const CODE_VERSION = 1;

function pack(obj) {
  const payload = { v: CODE_VERSION, ...(obj || {}) };
  const raw = Buffer.from(JSON.stringify(payload), 'utf8');
  return 'z' + zlib.gzipSync(raw, { level: 9 }).toString('base64url');
}

function unpack(text) {
  const t = String(text || '')
    .replace(/\s+/g, '')
    .trim();
  if (!t) return { ok: false, msg: '连接码是空的' };
  if (!t.startsWith('z')) return { ok: false, msg: '这不像是 PlanQuest 的连接码' };
  const body = t.slice(1);
  // 一位校验码：防止复制时漏字/多字导致莫名其妙连不上
  if (body.length < 8) return { ok: false, msg: '连接码不完整，请重新复制' };
  try {
    const obj = JSON.parse(zlib.gunzipSync(Buffer.from(body, 'base64url')).toString('utf8'));
    if (!obj || obj.v !== CODE_VERSION) return { ok: false, msg: '连接码版本不匹配，请双方都更新到最新版' };
    return { ok: true, obj };
  } catch (_) {
    return { ok: false, msg: '连接码已损坏（可能复制不全），请重新复制' };
  }
}

/* 创建房间：只生成一个房间号（纯展示 + 连接码里带，用于双方核对），不联网 */
function createRoom() {
  const alphabet = '23456789';
  const buf = crypto.randomBytes(6);
  let code = '';
  for (let i = 0; i < 6; i++) code += alphabet[buf[i] % alphabet.length];
  const myId = 'h-' + crypto.randomBytes(4).toString('hex');
  return { ok: true, code, myId };
}

function newPeerId(prefix) {
  return (prefix || 'c-') + crypto.randomBytes(4).toString('hex');
}

module.exports = {
  pack,
  unpack,
  createRoom,
  newPeerId,
};
