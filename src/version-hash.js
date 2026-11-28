'use strict';
/* ------------------------------------------------------------------ *
 * 轻量「版本哈希」更新检查（主进程侧，纯 Node，可注入、可单测）
 *
 * 流程（网络开销极小：一次几百字节的 GET）：
 *   本地 version.hash 存 { version, hash, skipUntil }
 *   启动时/定时拉远端纯文本（同一格式，几百字节）
 *   hash 一致 → 无事发生
 *   不一致   → 弹窗「检测到新版本 (vX.X.X)，是否下载？」
 *              否 → 关闭，下次启动再问；或「一周内不再提醒」
 *
 * 远端文件放 dist/version.hash（随源码一起进仓库），固定 URL 直读。
 * hash 取发布包（portable zip）的 sha256，改包必变，比版本号更难糊弄。
 * ------------------------------------------------------------------ */
const fs = require('node:fs');
const https = require('node:https');
const http = require('node:http');

const MAX_BYTES = 4 * 1024;          // 远端文件就几百字节，超了必有诈
const TIMEOUT_MS = 10000;
const WEEK_MS = 7 * 24 * 3600 * 1000;

/* 解析远端/本地哈希文本。宽容三种写法：
 *   {"version":"2.9.12","hash":"sha256:abc..."}
 *   version=2.9.12
 *   hash=sha256:abc...
 *   2.9.12 sha256:abc...                              */
function parseHashText(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  let version = '', hash = '';
  if (s[0] === '{') {
    try {
      const o = JSON.parse(s);
      version = String(o.version || '');
      hash = String(o.hash || '');
    } catch (_) { return null; }
  } else {
    const mV = /version\s*[=:]\s*([^\s;，,]+)/i.exec(s);
    const mH = /hash\s*[=:]\s*([^\s;，,]+)/i.exec(s);
    if (mV) version = mV[1];
    if (mH) hash = mH[1];
    if (!mV && !mH) {
      const m2 = /^(\S+)\s+(sha256:\S+)$/i.exec(s);
      if (m2) { version = m2[1]; hash = m2[2]; }
    }
  }
  version = version.replace(/^v/i, '');
  if (!version && !hash) return null;
  return { version, hash: normalizeHash(hash) };
}

function normalizeHash(h) {
  const s = String(h || '').trim().toLowerCase();
  if (!s) return '';
  return /^sha256:/.test(s) ? s : 'sha256:' + s.replace(/^sha256\s*/i, '');
}

function readLocal(file) {
  try {
    const o = parseHashText(fs.readFileSync(file, 'utf8'));
    if (!o) return { version: '', hash: '', skipUntil: 0 };
    let skipUntil = 0;
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      skipUntil = Number(raw.skipUntil) || 0;
    } catch (_) {}
    return { version: o.version, hash: o.hash, skipUntil };
  } catch (_) {
    return { version: '', hash: '', skipUntil: 0 };
  }
}

function writeLocal(file, rec) {
  const r = rec || {};
  fs.writeFileSync(file, JSON.stringify({
    version: String(r.version || ''),
    hash: String(r.hash || ''),
    skipUntil: Number(r.skipUntil) || 0,
  }, null, 2));
}

/* 要不要提醒：hash 不同才算新包；「一周内不再提醒」在有效期内静默 */
function shouldRemind(local, remote, now) {
  const l = local || {};
  const r = remote || {};
  if (!r.hash) return { remind: false, reason: '远端没有哈希，跳过' };
  if (!l.hash) return { remind: true, reason: '本地还没有基准哈希（首次运行）' };
  if (l.hash === r.hash) return { remind: false, reason: '哈希一致，无事发生' };
  if (l.skipUntil && Number(now) < l.skipUntil) {
    return { remind: false, reason: '用户选了一周内不再提醒（还剩 ' + Math.ceil((l.skipUntil - now) / 864e5) + ' 天）' };
  }
  return { remind: true, reason: '哈希不一致' };
}

/* 「一周内不再提醒」：以远端哈希为键，换新版本后重新开始提醒 */
function snooze(local, remoteHash, now) {
  return { skipUntil: Number(now) + WEEK_MS, hash: remoteHash };
}

/* 拉远端哈希。fetch 可注入（单测不联网）。 */
function fetchRemote(url, fetchFn) {
  if (fetchFn) return fetchFn(url);
  return new Promise((resolve, reject) => {
    let req;
    const done = (fn, arg) => { try { fn(arg); } catch (_) {} };
    try {
      const mod = /^https:/i.test(url) ? https : http;
      req = mod.get(url, { timeout: TIMEOUT_MS, headers: { 'User-Agent': 'PlanQuest-HashCheck/1' } }, (res) => {
        const code = res.statusCode || 0;
        if (code !== 200) { res.resume(); return reject(new Error('HTTP ' + code)); }
        const chunks = [];
        let len = 0;
        res.on('data', (c) => {
          len += c.length;
          if (len > MAX_BYTES) { req.destroy(new Error('响应超过 4KB，不是哈希文件')); return; }
          chunks.push(c);
        });
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        res.on('error', reject);
      });
      req.on('timeout', () => req.destroy(new Error('超时')));
      req.on('error', (e) => done(reject, e));
    } catch (e) { done(reject, e); }
  });
}

/* 一次完整检查：远端拉取 → 解析 → 与本地比对。任何失败都静默降级为「不提醒」。 */
async function check(opts) {
  const o = opts || {};
  const now = o.now || Date.now();
  let remote = null, err = '';
  try {
    remote = parseHashText(await fetchRemote(o.url, o.fetch));
  } catch (e) { err = e.message; }
  if (!remote) return { ok: false, remind: false, error: err || '远端哈希解析失败' };
  const local = readLocal(o.file);
  const verdict = shouldRemind(local, remote, now);
  return {
    ok: true,
    remind: !!verdict.remind,
    reason: verdict.reason,
    version: remote.version,
    hash: remote.hash,
    local: { version: local.version, hash: local.hash },
  };
}

module.exports = {
  MAX_BYTES, WEEK_MS,
  parseHashText, normalizeHash, readLocal, writeLocal,
  shouldRemind, snooze, fetchRemote, check,
};
