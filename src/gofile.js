'use strict';
/* ------------------------------------------------------------------ *
 * GoFile 分享链接 → 直链解析（主进程侧，纯 Node，可单测）
 *
 * 为什么需要这层：GoFile 免费账户没有「真直链」，官方 getContent/contents
 * 接口要 Premium。但网页下载页能让免费用户下载 —— 它靠一个动态的
 * X-Website-Token。本模块复刻这套免费流程：
 *   1) POST /accounts              → guest token（无需注册）
 *   2) sha256(UA::locale::token::时间窗::盐) → X-Website-Token
 *   3) GET /contents/{code}        → data.contents[*].link（这才是文件直链）
 *
 * 重要边界：
 *   - 盐值 12af056dacea0b 是社区逆向的，GoFile 改版会失效；
 *     失效时 resolve() 返回 needPage:true，让上层打开下载页兜底，
 *     绝不把「打不开」伪装成成功。
 *   - 不缓存 token 到磁盘（guest token 丢了就重新建，无所谓）。
 *   - 不写入任何系统位置；只解析、只返回。
 * ------------------------------------------------------------------ */
const crypto = require('node:crypto');
const https = require('node:https');
const http = require('node:http');

const API = 'https://api.gofile.io';
const UA = 'Mozilla/5.0';
const LOCALE = 'en-US';
const WINDOW_SEC = 14400;          // 4 小时
const SECRET = '12af056dacea0b';   // 社区逆向盐，可被 opts.secret 覆盖
const TIMEOUT = 20000;

/* 从各种 GoFile 链接里抠出 code：
 *   https://gofile.io/d/abc123  → abc123
 *   https://gofile.io/d/abc123/ → abc123
 *   abc123                      → abc123
 *   https://gofile.io/d/abc123?x=1 → abc123
 */
function parseCode(input) {
  const s = String(input || '').trim();
  if (!s) return '';
  let m = /gofile\.io\/d\/([A-Za-z0-9]+)/i.exec(s);
  if (m) return m[1];
  m = /gofile\.io\/([A-Za-z0-9]{6,})/i.exec(s);
  if (m && !/^(api|d|download|myfiles)$/i.test(m[1])) return m[1];
  if (/^[A-Za-z0-9]{6,}$/.test(s)) return s;
  return '';
}

/* website-token 算法（可被单测直接调用验证） */
function websiteToken(token, secret, timestampMs, ua, locale) {
  const win = Math.floor((Number(timestampMs) || Date.now()) / 1000 / WINDOW_SEC);
  const seed = [ua || UA, locale || LOCALE, token, win, secret || SECRET].join('::');
  return crypto.createHash('sha256').update(seed).digest('hex');
}

/* 底层 GET/POST，跟随重定向，返回 buffer */
function request(url, opts, redirects) {
  const o = opts || {};
  const n = redirects || 0;
  return new Promise((resolve, reject) => {
    if (n > 5) return reject(new Error('重定向次数过多'));
    let u;
    try { u = new URL(url); } catch (_) { return reject(new Error('地址不合法')); }
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || undefined,
      path: u.pathname + u.search,
      method: o.method || 'GET',
      headers: Object.assign({ 'User-Agent': UA, 'Accept': '*/*' }, o.headers || {}),
      timeout: o.timeout || TIMEOUT,
    }, (res) => {
      const code = res.statusCode || 0;
      if (code >= 300 && code < 400 && res.headers.location) {
        res.resume();
        return resolve(request(new URL(res.headers.location, url).href, o, n + 1));
      }
      const chunks = [];
      let len = 0;
      res.on('data', (c) => {
        len += c.length;
        if (o.maxBytes && len > o.maxBytes) { req.destroy(new Error('响应过大')); return; }
        chunks.push(c);
      });
      res.on('end', () => resolve({ code, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    if (o.body) req.write(o.body);
    req.end();
  });
}

function parseJSON(s) {
  try { return JSON.parse(s); } catch (_) { return null; }
}

/* 建 guest 账号；opts.token 可跳过（用户有自己的账号 token 时） */
async function guestToken(opts) {
  if (opts && opts.token) return opts.token;
  const r = await request(API + '/accounts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  const j = parseJSON(r.body);
  if (r.code === 200 && j && j.status === 'ok' && j.data && j.data.token) return j.data.token;
  throw new Error('建临时账号失败（' + (j && j.status || 'HTTP ' + r.code) + '）');
}

/* 主入口：分享链接 → { ok, page, files:[{name,url,size,md5}], folder, needPage, reason }
 * files 的 url 就是能直接喂给下载器的文件直链。
 */
async function resolve(input, opts) {
  const o = opts || {};
  const code = parseCode(input);
  if (!code) return { ok: false, needPage: false, reason: '这不是 GoFile 链接', files: [] };
  const page = 'https://gofile.io/d/' + code;

  let token;
  try {
    token = await guestToken(o);
  } catch (e) {
    return { ok: false, needPage: true, page, reason: e.message, files: [] };
  }

  const wt = websiteToken(token, o.secret || SECRET, o.now || Date.now());
  const headers = {
    'Authorization': 'Bearer ' + token,
    'X-Website-Token': wt,
    'X-BL': LOCALE,
    'Cookie': 'accountToken=' + token,
  };
  let r;
  try {
    r = await request(API + '/contents/' + encodeURIComponent(code) + '?cache=true&sortField=createTime&sortDirection=1', { headers });
  } catch (e) {
    return { ok: false, needPage: true, page, reason: '连不上 GoFile：' + e.message, files: [] };
  }
  const j = parseJSON(r.body);
  const status = j && j.status;
  if (!j || status !== 'ok') {
    /* 盐失效 / 接口改版 / 文件过期 —— 一律降级到下载页，不假装成功 */
    const why = status === 'error-notPremium' ? '免费账户接口受限'
      : /expired|notFound|error-notFound/i.test(String(status)) ? '文件可能已过期（免费版 10 天没人下载会进冷存储）'
        : status === 'error-passwordRequired' ? '分享需要密码'
          : '接口暂时不可用（' + String(status || 'HTTP ' + r.code) + '）';
    return { ok: false, needPage: true, page, reason: why, files: [] };
  }
  const data = j.data || {};
  const files = [];
  function walk(d) {
    if (!d) return;
    if (d.type === 'file') {
      if (d.link) files.push({ name: d.name || '', url: d.link, size: d.size || 0, md5: d.md5 || '' });
      return;
    }
    const ch = d.children || {};
    Object.keys(ch).forEach((k) => walk(ch[k]));
  }
  walk(data);
  if (!files.length) return { ok: false, needPage: true, page, reason: '分享里没找到文件（可能已过期）', files: [] };
  return {
    ok: true, page, files,
    folder: data.name || '',
    note: '文件直链有时效；下载若失败请重新检查更新以刷新链接。',
  };
}

/* 报错说人话 */
function netReason(e) {
  const s = String((e && e.message) || e || '');
  if (/ENOTFOUND|EAI_AGAIN/.test(s)) return '域名解析不到，检查网络';
  if (/ECONNREFUSED/.test(s)) return '对面没开门，稍后再试';
  if (/超时|timeout|ETIMEDOUT/i.test(s)) return '等太久没回应，稍后再试';
  if (/HTTP 5\d\d/.test(s)) return 'GoFile 出错了，稍后再试';
  return s || '未知错误';
}

module.exports = { parseCode, websiteToken, resolve, netReason, API, SECRET, WINDOW_SEC };
