/* 联网检索层（ala-web.js）单测：解析、去重、失败要老实说失败 */
'use strict';
const W = require('../src/ala-web.js');

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.error('  ✗ ' + name); }
}

const DDG = `
<div class="result">
  <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&amp;rut=x">示例 A &amp; 标题</a>
  <a class="result__snippet" href="#">A 的摘要&nbsp;文字</a>
  <a class="result__a" href="https://example.com/b">示例 B</a>
  <a class="result__snippet" href="#">B 的摘要</a>
</div>`;

const BING = `
<li class="b_algo"><h2><a href="https://example.com/c">示例 C</a></h2><p> C 的摘要 </p></li>
<li class="b_algo"><h2><a href="https://example.com/d">示例 D</a></h2><div><p>D 的摘要</p></div></li>`;

(async () => {
  console.log('== DDG 解析 ==');
  const d = W.parseDdg(DDG);
  ok(d.length === 2, '解出两条');
  ok(d[0].url === 'https://example.com/a', 'uddg 跳转链还原成真实地址');
  ok(/示例 A & 标题/.test(d[0].title), '实体解码 + 去标签');
  ok(/A 的摘要 文字/.test(d[0].snippet), '摘要解码（&nbsp; → 空格）');

  console.log('== Bing 解析 ==');
  const b = W.parseBing(BING);
  ok(b.length === 2 && b[0].url === 'https://example.com/c', '解出 Bing 结果');
  ok(/C 的摘要/.test(b[0].snippet), '摘要取 <p>');

  console.log('== 清洗：去重 / 丢非法地址 / 截断 ==');
  const many = [];
  for (let i = 0; i < 12; i++) many.push({ title: 'T' + i, url: 'https://x.com/' + i, snippet: 's' });
  many.push({ title: 'dup', url: 'https://x.com/1', snippet: 's' });
  many.push({ title: 'js 注入', url: 'javascript:alert(1)', snippet: '' });
  const fake = { status: 200, text: '' };
  const cleaned = await (async () => {
    const t = async () => ({ status: 200, text: many.map((m) => `<a class="result__a" href="${m.url}">${m.title}</a>`).join('') });
    return W.search(t, 'q');
  })();
  ok(cleaned.ok && cleaned.results.length === 5, '最多 5 条');
  ok(new Set(cleaned.results.map((r) => r.url)).size === cleaned.results.length, '去重');
  ok(!cleaned.results.some((r) => /^javascript:/.test(r.url)), 'javascript: 地址被丢掉');

  console.log('== 失败要老实说 ==');
  const tDown = async () => { throw new Error('ECONNREFUSED'); };
  const rDown = await W.search(tDown, 'q');
  ok(!rDown.ok && /连不上/.test(rDown.detail), '连不上 → ok:false 且说明原因');
  const t404 = async () => ({ status: 404, text: 'not found' });
  const r404 = await W.search(t404, 'q');
  ok(!r404.ok && /HTTP 404/.test(r404.detail), 'HTTP 404 → 明说');
  const tEmpty = async () => ({ status: 200, text: '<html>nothing here</html>' });
  const rEmpty = await W.search(tEmpty, 'q');
  ok(!rEmpty.ok && /没解析出结果/.test(rEmpty.detail), '页面没结果 → 不编');
  const rNoQ = await W.search(tDown, '   ');
  ok(!rNoQ.ok && /没有检索词/.test(rNoQ.detail), '空检索词直接拒');

  console.log('== 自定义端点 ==');
  let seenUrl = '';
  const tCustom = async (req) => { seenUrl = req.url; return { status: 200, text: DDG }; };
  await W.search(tCustom, '天气 北京', { endpoint: 'http://127.0.0.1:9/ddg?lang=zh' });
  ok(/^http:\/\/127\.0\.0\.1:9\/ddg\?lang=zh&q=/.test(seenUrl), '已有 ? 时用 & 拼 q');
  let seen2 = '';
  const tCustom2 = async (req) => { seen2 = req.url; return { status: 200, text: DDG }; };
  await W.search(tCustom2, 'abc', { endpoint: 'http://h/s?x={q}' });
  ok(/x=abc$/.test(seen2), '{q} 占位可替换');

  console.log('== 只取摘要，不抓正文 ==');
  const r1 = await W.search(async () => ({ status: 200, text: DDG }), 'q');
  ok(r1.results.every((x) => Object.keys(x).sort().join(',') === 'snippet,title,url'), '结果对象只有 title/snippet/url');

  console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})();
