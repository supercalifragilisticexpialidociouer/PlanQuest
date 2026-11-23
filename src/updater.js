'use strict';
/* ------------------------------------------------------------------ *
 * R2 直链版本更新 + 可选大模型下载（主进程侧，纯 Node，可单测）
 *
 * 边界（刻意不做的事）：
 *   1) 绝不覆盖正在运行的 exe —— 只下到新目录，提示用户自己切换；
 *   2) 绝不迁移数据 —— data.json 在 %APPDATA%\PlanQuest\，与 exe 目录解耦；
 *   3) 绝不代写注册表 —— 开机自启只由应用内开关写 HKCU Run；
 *   4) 可选大模型默认一个字节都不下，勾了才走官网直链。
 * ------------------------------------------------------------------ */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const https = require('node:https');
const http = require('node:http');

const MANIFEST = 'version.json';
const MAX_MANIFEST = 64 * 1024;
const TIMEOUT_MS = 15000;
const MAX_REDIRECT = 5;

/* 语义化版本比较：2.9.10 > 2.9.9，缺位按 0，非数字段按字典序 */
function cmpVersion(a, b) {
  const pa = String(a || '0').split('.').map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  const pb = String(b || '0').split('.').map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] === undefined ? 0 : pa[i];
    const y = pb[i] === undefined ? 0 : pb[i];
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x > y ? 1 : -1;
    return String(x) > String(y) ? 1 : -1;
  }
  return 0;
}

function manifestUrl(base) {
  const b = String(base || '').trim().replace(/\/+$/, '');
  if (!b) return '';
  if (!/^https?:\/\//i.test(b)) return '';
  return b + '/' + MANIFEST;
}

function get(url, opts, redirects) {
  const o = opts || {};
  const n = redirects || 0;
  return new Promise((resolve, reject) => {
    if (n > MAX_REDIRECT) return reject(new Error('重定向次数过多'));
    const mod = /^https:/i.test(url) ? https : http;
    const req = mod.get(url, { timeout: o.timeout || TIMEOUT_MS, headers: { 'User-Agent': 'PlanQuest-Updater/1' } }, (res) => {
      const code = res.statusCode || 0;
      if (code >= 300 && code < 400 && res.headers.location) {
        res.resume();
        return resolve(get(new URL(res.headers.location, url).href, o, n + 1));
      }
      if (code !== 200) {
        res.resume();
        return reject(new Error('HTTP ' + code));
      }
      const chunks = [];
      let len = 0;
      res.on('data', (c) => {
        len += c.length;
        if (o.maxBytes && len > o.maxBytes) {
          req.destroy(new Error('响应超过上限'));
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
  });
}

/* 只拉清单，不下载任何包 */
async function check(base, current, fetcher) {
  const url = manifestUrl(base);
  if (!url) return { ok: false, reason: '还没填 R2 直链域名', hasUpdate: false };
  let buf;
  try {
    buf = await (fetcher || ((u, o) => get(u, o)))(url, { maxBytes: MAX_MANIFEST, timeout: TIMEOUT_MS });
  } catch (e) {
    return { ok: false, reason: netReason(e), hasUpdate: false };
  }
  let m;
  try {
    m = JSON.parse(Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf));
  } catch (_) {
    return { ok: false, reason: '版本清单不是有效 JSON', hasUpdate: false };
  }
  if (!m || !m.version) return { ok: false, reason: '版本清单缺少版本号', hasUpdate: false };
  return {
    ok: true,
    reason: '',
    hasUpdate: cmpVersion(m.version, current) > 0,
    current,
    latest: m.version,
    manifest: m,
  };
}

/* 把底层 errno 说成人话（和设置页 netReason 同一口径） */
function netReason(e) {
  const s = String((e && e.message) || e || '');
  if (/ENOTFOUND|EAI_AGAIN/.test(s)) return '域名解析不到，检查直链地址';
  if (/ECONNREFUSED/.test(s)) return '对面没开门，检查直链是否可访问';
  if (/ETIMEDOUT|超时|timeout/i.test(s)) return '等太久没回应，稍后再试';
  if (/HTTP 40[13]/.test(s)) return '直链没权限，检查 R2 公开读设置';
  if (/HTTP 404/.test(s)) return '没找到 version.json，检查上传路径';
  if (/HTTP 5\d\d/.test(s)) return '对面出错了，稍后再试';
  return '连不上：' + s;
}

function verifySha256(file, expect) {
  if (!expect) return { ok: true, skipped: true };
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(1 << 20);
  try {
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  const got = h.digest('hex');
  return { ok: got.toLowerCase() === String(expect).toLowerCase(), got, expect };
}

/* 下载到 dest.part → 校验 → 改名；失败就把残片删掉，不留半个包 */
function download(url, dest, opts) {
  const o = opts || {};
  return new Promise((resolve, reject) => {
    if (!/^https?:\/\//i.test(String(url || ''))) return reject(new Error('只接受 http/https 直链'));
    const part = dest + '.part';
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    try { fs.unlinkSync(part); } catch (_) {}
    const out = fs.createWriteStream(part);
    const mod = /^https:/i.test(url) ? https : http;

    function run(u, n) {
      if (n > MAX_REDIRECT) return fail(new Error('重定向次数过多'));
      const req = mod.get(u, { timeout: TIMEOUT_MS, headers: { 'User-Agent': 'PlanQuest-Updater/1' } }, (res) => {
        const code = res.statusCode || 0;
        if (code >= 300 && code < 400 && res.headers.location) {
          res.resume();
          return run(new URL(res.headers.location, u).href, n + 1);
        }
        if (code !== 200) { res.resume(); return fail(new Error('HTTP ' + code)); }
        const total = Number(res.headers['content-length']) || o.size || 0;
        let got = 0;
        res.on('data', (c) => {
          got += c.length;
          if (o.onProgress) o.onProgress({ received: got, total });
        });
        res.pipe(out);
        res.on('end', () => {
          out.end(() => {
            if (o.size && fs.statSync(part).size !== o.size) return fail(new Error('大小对不上，包可能没下全'));
            const v = verifySha256(part, o.sha256);
            if (!v.ok) return fail(new Error('校验没过，包可能被改过'));
            try { fs.renameSync(part, dest); } catch (e) { return fail(e); }
            resolve({ ok: true, file: dest, size: fs.statSync(dest).size, checksum: v });
          });
        });
        res.on('error', fail);
      });
      req.on('timeout', () => req.destroy(new Error('下载超时')));
      req.on('error', fail);
    }
    function fail(e) {
      try { out.destroy(); } catch (_) {}
      try { fs.unlinkSync(part); } catch (_) {}
      reject(e);
    }
    run(url, 0);
  });
}

/* 只放行清单里存在的 id —— 前端传什么都不会凭空下载 */
function selectComponents(manifest, selected) {
  const list = (manifest && Array.isArray(manifest.components)) ? manifest.components : [];
  const want = Array.isArray(selected) ? selected : [];
  return list.filter((c) => c && want.indexOf(c.id) >= 0);
}

/* 勾选后的前置检查：只给结论，不偷偷替用户改系统 */
function precheck(c, env) {
  const e = env || {};
  const warn = [];
  if (!c || !c.official) return { allowed: false, reason: '这个组件没有官网直链' };
  if (c.id === 'ollama') {
    const need = Math.ceil((Number(c.size || 0) + Number(c.modelSize || 0)) / 1073741824) + 1;
    if (e.freeGB != null && e.freeGB < need) warn.push(`磁盘只剩 ${e.freeGB} GB，装完约需 ${need} GB`);
    if (e.hasGPU === false) warn.push('没有独显，CPU 推理一次要等几十秒');
  }
  if (c.id === 'melotts') {
    warn.push('官网只有源码，没有 Windows 运行包');
    if (e.python) warn.push(`本机 Python ${e.python}，需要 ${c.requires || 'Python <= 3.10'}，下载后仍跑不起来`);
    return { allowed: true, runnable: false, warn, reason: '只下源码，不代表能运行' };
  }
  return { allowed: true, runnable: true, warn };
}

/* 生成一次更新的下载计划：主包必下，组件按勾选，默认空 */
function buildPlan(manifest, selected) {
  const pack = manifest && manifest.installer && manifest.installer.built !== false ? manifest.installer : (manifest && manifest.portable);
  return {
    main: pack ? { url: pack.url, file: pack.file, size: pack.size, sha256: pack.sha256 } : null,
    components: selectComponents(manifest, selected).map((c) => ({
      id: c.id, url: c.official, file: c.file, size: c.size, sha256: c.sha256, dest: c.dest,
    })),
    dataMigration: 'none',
    note: '下到新目录，不覆盖正在运行的 exe；data.json 在 %APPDATA%\\PlanQuest\\，换版本自动沿用。',
  };
}

module.exports = {
  cmpVersion, manifestUrl, get, check, netReason, verifySha256,
  download, selectComponents, precheck, buildPlan,
};
