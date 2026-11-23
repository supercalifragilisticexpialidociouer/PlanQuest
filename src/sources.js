'use strict';
/* ------------------------------------------------------------------ *
 * 多源冗余下载层（主进程侧，纯 Node，可注入 fetcher 无网络单测）
 *
 * 支持 5 类源，按配置顺序尝试，任一源成功且校验通过即用：
 *   1) github    GitHub Releases —— 官方 API，永不过期，主源
 *   2) r2        任意直链 / R2 自定义域 —— 直链即文件
 *   3) pixeldrain 分享页/文件页/直链 —— GET /api/file/{id}
 *   4) mediafire  分享页 —— 网页解析出直链
 *   5) gofile     分享页 —— guest token + website-token 反爬（见 gofile.js）
 *
 * 边界：
 *   - 只解析「下载什么」，不碰系统、不写注册表、不迁移数据；
 *   - 失败原因逐条收集，全挂了给人话汇总 + 打开网页兜底；
 *   - 大模型组件仍由清单白名单控制，默认一个都不下。
 * ------------------------------------------------------------------ */
const crypto = require('node:crypto');
const gofile = require('./gofile');

const TIMEOUT = 20000;
const MAX_JSON = 2 * 1024 * 1024;

/* 默认 fetcher：fetch 拿文本/buffer；注入后可离线单测 */
async function defaultFetch(url, opts) {
  const o = opts || {};
  const r = await fetch(url, {
    method: o.method || 'GET',
    headers: Object.assign({ 'User-Agent': 'Mozilla/5.0', 'Accept': '*/*' }, o.headers || {}),
    body: o.body,
    signal: AbortSignal.timeout(o.timeout || TIMEOUT),
    redirect: 'follow',
  });
  if (!r.ok) { const e = new Error('HTTP ' + r.status); e.status = r.status; throw e; }
  const buf = Buffer.from(await r.arrayBuffer());
  if (o.maxBytes && buf.length > o.maxBytes) throw new Error('响应超过上限');
  return { code: r.status, headers: r.headers, text: () => buf.toString('utf8'), buffer: buf };
}

/* 识别源类型 */
function kindOf(input) {
  const s = String(input || '').toLowerCase();
  if (/api\.github\.com\/repos\//.test(s) || /github\.com\/[^/]+\/[^/]+\/releases/.test(s)) return 'github';
  if (/pixeldrain\.com/.test(s)) return 'pixeldrain';
  if (/mediafire\.com/.test(s)) return 'mediafire';
  if (/gofile\.io/.test(s)) return 'gofile';
  if (/^https?:\/\//.test(s)) return 'r2';
  return 'unknown';
}

function json(res) { try { return JSON.parse(res.text()); } catch (_) { return null; } }
function err(msg) { const e = new Error(msg); return e; }

/* ---- 1. GitHub Releases ---- */
/* 输入：https://github.com/o/r/releases/latest
 *   或 https://api.github.com/repos/o/r/releases/latest
 * 输出：assets 里匹配 wanted（文件名正则/子串）的文件；不匹配则取所有 zip/exe
 */
async function resolveGithub(input, fetch, wanted) {
  let api = String(input).trim();
  const m = /github\.com\/([^/]+)\/([^/]+)\/releases(?:\/(latest|tag\/([^/?#]+)))?/.exec(api);
  if (/^https?:\/\/api\.github\.com\//i.test(api)) {
    // 直接用
  } else if (m) {
    const owner = m[1], repo = m[2];
    const tag = m[4] ? '/tags/' + encodeURIComponent(m[4]) : '/latest';
    api = `https://api.github.com/repos/${owner}/${repo}/releases${tag}`;
  } else {
    throw err('不是 GitHub Releases 链接');
  }
  const res = await fetch(api, { maxBytes: MAX_JSON });
  const j = json(res);
  if (!j || !j.tag_name) throw err('GitHub 返回的内容不像 release');
  let assets = Array.isArray(j.assets) ? j.assets : [];
  let picked = [];
  if (wanted) {
    const re = wanted instanceof RegExp ? wanted : new RegExp(String(wanted).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    picked = assets.filter((a) => re.test(a.name || ''));
  }
  if (!picked.length) {
    /* 没有 wanted 或 wanted 没命中，都只取真正的压缩包/安装器，别把 md/txt 当下载物 */
    picked = assets.filter((a) => /\.(zip|exe|7z|tar|gz)$/i.test(a.name || ''));
  }
  if (!picked.length) throw err('这个 release 里没有可下载的包');
  return {
    source: 'github',
    version: String(j.tag_name).replace(/^v/i, ''),
    releasedAt: j.published_at || '',
    notes: String(j.body || '').slice(0, 2000),
    files: picked.map((a) => ({
      name: a.name || 'release.bin',
      url: a.browser_download_url,
      size: a.size || 0,
      sha256: '', // GitHub API 不返回 sha；有 sha256sum.txt 时客户端可选用，但不强制
    })),
  };
}

/* ---- 2. R2 / 任意直链 ---- */
async function resolveDirect(input, fetch) {
  return { source: 'r2', files: [{ name: fileNameOf(input) || 'download.bin', url: String(input), size: 0, sha256: '' }] };
}

function fileNameOf(url) {
  try { const u = new URL(url); const base = decodeURIComponent(u.pathname.split('/').pop() || ''); return base || ''; }
  catch (_) { return ''; }
}

/* ---- 3. pixeldrain ---- */
/* 输入：https://pixeldrain.com/u/{id} 或 .../api/file/{id} 或裸 id
 * 直链：https://pixeldrain.com/api/file/{id}
 */
async function resolvePixeldrain(input, fetch) {
  const s = String(input || '').trim();
  let id = '';
  let m = /pixeldrain\.com\/(?:u|api\/file)\/([A-Za-z0-9_-]+)/.exec(s);
  if (m) id = m[1];
  else if (/^[A-Za-z0-9_-]{6,}$/.test(s)) id = s;
  if (!id) throw err('不是 pixeldrain 链接');
  const api = 'https://pixeldrain.com/api/file/' + encodeURIComponent(id) + '/info';
  let name = id, size = 0;
  try {
    const res = await fetch(api, { maxBytes: MAX_JSON });
    const j = json(res);
    if (j && j.success) { name = j.name || j.id || name; size = j.size || 0; }
  } catch (_) { /* info 拿不到也能下，直链本身会告诉结果 */ }
  return {
    source: 'pixeldrain',
    files: [{
      name: name.toLowerCase().endsWith('.zip') ? name : name + '.zip',
      url: 'https://pixeldrain.com/api/file/' + encodeURIComponent(id),
      size, sha256: '',
      headers: { 'Referer': 'https://pixeldrain.com/u/' + id },
    }],
  };
}

/* ---- 4. MediaFire ---- */
/* 输入：https://www.mediafire.com/file/{id}/{name}/file
 * 网页里有 dlfkey + 直链；这里做尽力解析，失败就抛给上层切下一源
 */
async function resolveMediafire(input, fetch) {
  const res = await fetch(String(input), { maxBytes: 4 * 1024 * 1024 });
  const html = res.text();
  let url = '';
  let m = /https:\/\/download\d+\.mediafire\.com\/[^"'\s<>]+/i.exec(html);
  if (m) url = m[0];
  else { m = /"download_url"\s*:\s*"(https:[^"]+)"/i.exec(html); if (m) url = m[1]; }
  if (!url) throw err('MediaFire 页面里没找到直链（可能要登录或改版了）');
  url = url.replace(/\\u0026/g, '&').replace(/&amp;/g, '&');
  return { source: 'mediafire', files: [{ name: fileNameOf(url) || 'download.zip', url, size: 0, sha256: '' }] };
}

/* ---- 5. GoFile ---- */
async function resolveGofile(input, fetch) {
  const r = await gofile.resolve(input, {});
  if (!r.ok || !r.files.length) throw err(r.reason || 'GoFile 解析失败');
  return { source: 'gofile', files: r.files, needPage: r.page };
}

/* 统一入口 */
async function resolveSource(source, fetch, wanted) {
  const f = fetch || defaultFetch;
  const url = typeof source === 'string' ? source : (source && source.url);
  if (!url) throw err('源没有地址');
  const kind = (typeof source === 'object' && source.kind) || kindOf(url);
  switch (kind) {
    case 'github': return resolveGithub(url, f, wanted);
    case 'pixeldrain': return resolvePixeldrain(url, f);
    case 'mediafire': return resolveMediafire(url, f);
    case 'gofile': return resolveGofile(url, f);
    case 'r2': return resolveDirect(url, f);
    default: throw err('不认识的源类型：' + kind);
  }
}

/* 按序尝试多个源，返回第一个解析成功的；逐个记录失败原因 */
async function resolveFirst(sources, fetch, wanted) {
  const list = Array.isArray(sources) ? sources : [];
  const tried = [];
  for (const s of list) {
    const url = typeof s === 'string' ? s : (s && s.url);
    try {
      const r = await resolveSource(s, fetch, wanted);
      return { ok: true, result: r, tried };
    } catch (e) {
      tried.push({ url, kind: kindOf(url), reason: netReason(e) });
    }
  }
  return { ok: false, tried, reason: tried.length ? '所有源都没拿到文件' : '一个源都没配置' };
}

function netReason(e) {
  const s = String((e && e.message) || e || '');
  if (/ENOTFOUND|EAI_AGAIN/.test(s)) return '域名解析不到';
  if (/ECONNREFUSED/.test(s)) return '对面没开门';
  if (/timeout|超时|ETIMEDOUT|AbortError/i.test(s)) return '等太久没回应';
  if (/HTTP 40[13]/.test(s)) return '没权限或链接失效';
  if (/HTTP 404/.test(s)) return '没找到文件（可能过期）';
  if (/HTTP 5\d\d/.test(s)) return '对面出错了';
  return s || '未知错误';
}

/* ---- 多源冗余下载编排 ----
 * sources: 源列表（按优先级）
 * opts: {
 *   wanted,          // 文件名匹配（正则/子串），如 /portable.*\.zip/i
 *   dest,            // 最终落地路径
 *   size, sha256,    // 期望校验（可选，来自清单）
 *   downloader,      // (url, dest, fileOpts) => Promise<{ok,file,...}>，注入以便单测
 *   onStage,         // (text)=>void 进度文案回调
 * }
 * 返回 { ok, file, source, tried:[...], reason }
 */
async function downloadFirst(sources, opts) {
  const o = opts || {};
  const tried = [];
  /* 先按源解析，拿到每个源的候选直链 */
  const list = Array.isArray(sources) ? sources : [];
  for (const s of list) {
    const url = typeof s === 'string' ? s : (s && s.url);
    let parsed;
    try {
      parsed = await resolveSource(s, o.fetch, o.wanted);
    } catch (e) {
      tried.push({ url, kind: kindOf(url), stage: '解析', reason: netReason(e) });
      if (o.onStage) o.onStage('解析失败：' + kindOf(url) + ' — ' + netReason(e));
      continue;
    }
    for (const file of parsed.files) {
      if (o.onStage) o.onStage(`尝试下载：${parsed.source} · ${file.name}`);
      try {
        const dl = o.downloader || defaultDownloader;
        const got = await dl(file.url, o.dest, Object.assign({}, file, {
          size: o.size || file.size, sha256: o.sha256 || file.sha256,
        }));
        return { ok: true, file: got.file || o.dest, source: parsed.source, from: file.url, tried };
      } catch (e) {
        tried.push({ url, kind: parsed.source, stage: '下载', name: file.name, reason: netReason(e) });
        if (o.onStage) o.onStage(`下载失败：${parsed.source} — ${netReason(e)}，换下一个源`);
      }
    }
  }
  return {
    ok: false, tried,
    reason: tried.length
      ? '所有源都没成功：' + tried.map((t) => t.kind + '(' + t.reason + ')').join('、')
      : '一个源都没配置',
  };
}

/* 默认下载器：http(s) → .part → 校验 → 改名（注入 downloader 可绕过网络） */
async function defaultDownloader(url, dest, opts) {
  const fs = require('node:fs');
  const path = require('node:path');
  const o = opts || {};
  if (!/^https?:\/\//i.test(String(url || ''))) throw new Error('只接受 http/https 直链');
  const part = dest + '.part';
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try { fs.unlinkSync(part); } catch (_) {}
  const res = await fetch(url, {
    headers: Object.assign({ 'User-Agent': 'Mozilla/5.0' }, o.headers || {}),
    signal: AbortSignal.timeout(120000),
    redirect: 'follow',
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  if (o.size && buf.length !== o.size) throw new Error('大小对不上，包可能没下全');
  if (o.sha256) {
    const got = crypto.createHash('sha256').update(buf).digest('hex');
    if (got.toLowerCase() !== String(o.sha256).toLowerCase()) throw new Error('校验没过，包可能被改过');
  }
  fs.writeFileSync(part, buf);
  fs.renameSync(part, dest);
  return { ok: true, file: dest, size: buf.length };
}

module.exports = {
  kindOf, resolveSource, resolveFirst, downloadFirst, netReason, fileNameOf,
  resolveGithub, resolvePixeldrain, resolveMediafire, resolveGofile, resolveDirect,
  defaultFetch, defaultDownloader,
  GITHUB_API: 'https://api.github.com',
};
