/* PlanQuest · 阿刺的联网检索层（仅主进程用）
 *
 * 为什么要单独一层：渲染层是 file:// 页面，直接 fetch 外站会被跨域拦死，
 * 所以检索放主进程做，走 node 的 http/https。
 *
 * 设计取舍（和「不编」这条底线对齐）：
 *   - 默认**不联网**，只有用户在设置里手动打开才会走到这里；
 *   - 只取标题 + 摘要 + 链接，不抓正文、不落库、不留存；
 *   - 抓不到就老实返回 ok:false，让上层说"这次没搜到"，绝不用旧知识冒充搜索结果；
 *   - 不用任何需要 API Key 的商业搜索服务，也不引第三方中转：默认直接打
 *     DuckDuckGo 的轻量 HTML 页，失败再试 Bing。用户也可以自己填端点（走企业内网代理等）。
 */
'use strict';

var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
var MAX_RESULTS = 5;

function decodeEntities(s) {
  return String(s == null ? '' : s)
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&#x27;|&apos;/g, "'")
    .replace(/&#(\d+);/g, function (_, d) { return String.fromCharCode(Number(d)); })
    .replace(/\s+/g, ' ')
    .trim();
}

/* DuckDuckGo 轻量页：/html/?q=... */
function parseDdg(html) {
  var out = [];
  var re = /<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  var m;
  while ((m = re.exec(html)) && out.length < MAX_RESULTS * 2) {
    var url = m[1] || '';
    var uddg = /[?&]uddg=([^&]+)/.exec(url);
    if (uddg) { try { url = decodeURIComponent(uddg[1]); } catch (e) {} }
    if (/^\/\//.test(url)) url = 'https:' + url;
    out.push({ url: url, title: decodeEntities(m[2]), snippet: '' });
  }
  var sre = /<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
  var i = 0, sm;
  while ((sm = sre.exec(html)) && i < out.length) {
    out[i].snippet = decodeEntities(sm[1]);
    i++;
  }
  return out;
}

/* Bing 国内可访问的页面：/search?q=... */
function parseBing(html) {
  var out = [];
  var re = /<li[^>]+class="[^"]*b_algo[^"]*"[\s\S]*?<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h2>([\s\S]*?)<\/li>/g;
  var m;
  while ((m = re.exec(html)) && out.length < MAX_RESULTS * 2) {
    var body = m[3] || '';
    var pm = /<p[^>]*>([\s\S]*?)<\/p>/.exec(body);
    out.push({ url: m[1], title: decodeEntities(m[2]), snippet: pm ? decodeEntities(pm[1]) : '' });
  }
  return out;
}

function clean(list) {
  var seen = {}, out = [];
  for (var i = 0; i < list.length; i++) {
    var x = list[i] || {};
    var t = String(x.title || '').slice(0, 80);
    var s = String(x.snippet || '').slice(0, 160);
    var u = String(x.url || '');
    if (!t || !/^https?:/i.test(u)) continue;
    if (seen[u]) continue;
    seen[u] = 1;
    out.push({ title: t, snippet: s, url: u.slice(0, 200) });
    if (out.length >= MAX_RESULTS) break;
  }
  return out;
}

function host(u) {
  try { return new URL(u).host; } catch (e) { return ''; }
}

/* 返回 { ok, results:[{title,snippet,url}], via, detail } */
async function search(transport, query, opts) {
  opts = opts || {};
  var q = String(query || '').trim().slice(0, 120);
  if (!q) return { ok: false, results: [], detail: '没有检索词' };

  var custom = String(opts.endpoint || '').trim();
  var customUrl = '';
  if (custom) {
    customUrl = custom.indexOf('{q}') >= 0
      ? custom.replace(/\{q\}/g, encodeURIComponent(q))
      : custom + (custom.indexOf('?') >= 0 ? '&' : '?') + 'q=' + encodeURIComponent(q);
  }
  var targets = custom
    ? [{ via: '你配的搜索源', url: customUrl, parse: opts.parse === 'bing' ? parseBing : parseDdg }]
    : [
        { via: 'DuckDuckGo', url: 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q), parse: parseDdg },
        { via: 'Bing', url: 'https://cn.bing.com/search?q=' + encodeURIComponent(q) + '&setlang=zh-CN', parse: parseBing },
      ];

  var lastErr = '';
  for (var i = 0; i < targets.length; i++) {
    var t = targets[i];
    try {
      var res = await transport({
        url: t.url,
        method: 'GET',
        headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.6' },
        timeoutMs: Math.max(4000, Number(opts.timeout) || 12000),
      });
      var html = (res && res.text) || '';
      if (res.status !== 200 || !html) { lastErr = t.via + ' 返回 HTTP ' + (res && res.status); continue; }
      var list = clean(t.parse(html));
      if (list.length) return { ok: true, results: list, via: t.via };
      lastErr = t.via + ' 没解析出结果';
    } catch (e) {
      lastErr = t.via + ' 连不上（' + (e && e.message ? e.message : '网络错误') + '）';
    }
  }
  return { ok: false, results: [], detail: lastErr || '搜不到' };
}

module.exports = { search: search, parseDdg: parseDdg, parseBing: parseBing, decodeEntities: decodeEntities, host: host, MAX_RESULTS: MAX_RESULTS };
