/* PlanQuest · PK 数据签名（防篡改）
 *
 * 威胁模型：布告栏放在别人能改的地方（哪怕私有仓库，也可能是账号被盗、误提交、
 * 或者中间人替换了响应）。所以「能读到」不等于「可信」。
 *
 * 做法：
 *   1. 每个军团主第一次参加 PK 时生成一对 Ed25519 密钥，私钥只留在本机；
 *   2. 上报时对「规范化 JSON」签名，把签名和公钥一起写进去；
 *   3. 读取时先验签，再比对「首次见到的公钥」（TOFU 固定），
 *      公钥变了但签名有效 → 不是随机损坏，而是「换了一把钥匙」，必须告警。
 *
 * 签名不能防「军团主自己撒谎」，但能防「别人替他改」—— 后者才是布告栏的真实风险。
 */
'use strict';

const crypto = require('node:crypto');

/* 规范化：键名排序、去掉 sig 字段本身，保证两端算出同一串字节 */
function canonical(obj) {
  const walk = (v) => {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(walk);
    const out = {};
    for (const k of Object.keys(v).sort()) {
      if (k === 'sig') continue;
      out[k] = walk(v[k]);
    }
    return out;
  };
  return JSON.stringify(walk(obj));
}

const b64u = (buf) => Buffer.from(buf).toString('base64url');

function newKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pub = publicKey.export({ format: 'jwk' }).x;
  const priv = privateKey.export({ format: 'jwk' }).d;
  return { pub, priv, at: Date.now() };
}

function keyIdOf(pub) {
  return crypto.createHash('sha256').update(String(pub || '')).digest('hex').slice(0, 16);
}

function importPub(pub) {
  return crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: String(pub) }, format: 'jwk' });
}

function importPriv(priv, pub) {
  return crypto.createPrivateKey({ key: { kty: 'OKP', crv: 'Ed25519', x: String(pub), d: String(priv) }, format: 'jwk' });
}

function sign(payload, key) {
  if (!key || !key.priv || !key.pub) return '';
  try {
    const data = Buffer.from(canonical(payload), 'utf8');
    return b64u(crypto.sign(null, data, importPriv(key.priv, key.pub)));
  } catch (_) {
    return '';
  }
}

function verify(payload, sig, pub) {
  if (!sig || !pub) return false;
  try {
    const data = Buffer.from(canonical(payload), 'utf8');
    return crypto.verify(null, data, importPub(pub), Buffer.from(String(sig), 'base64url'));
  } catch (_) {
    return false;
  }
}

/* 一个「已签名文件」的标准形状：payload 里不放 sig / pub，避免自引用 */
function seal(payload, key) {
  const body = { ...(payload || {}) };
  delete body.sig;
  delete body.pub;
  delete body.keyId;
  return {
    payload: body,
    pub: key.pub,
    keyId: keyIdOf(key.pub),
    sig: sign(body, key),
  };
}

/* 返回 { ok, payload, why, pubChanged } —— pubChanged 由调用方拿本地固定的公钥判断 */
function openSealed(file) {
  const f = file && typeof file === 'object' ? file : null;
  if (!f || !f.payload || !f.sig || !f.pub) {
    /* 兼容早期没有签名的档案：不判死，只标 unsiged，让上层决定要不要收 */
    if (f && f.code) return { ok: false, unsigned: true, payload: f, why: '这个档案没有签名（可能是旧版本写的）' };
    return { ok: false, payload: null, why: '档案结构不对' };
  }
  if (f.keyId && f.keyId !== keyIdOf(f.pub)) return { ok: false, payload: null, why: '公钥指纹与声明不一致' };
  if (!verify(f.payload, f.sig, f.pub)) return { ok: false, payload: null, why: '签名校验失败，内容被改过' };
  return { ok: true, payload: f.payload, pub: f.pub, keyId: keyIdOf(f.pub), why: '' };
}

module.exports = {
  canonical,
  newKeyPair,
  keyIdOf,
  sign,
  verify,
  seal,
  openSealed,
};
