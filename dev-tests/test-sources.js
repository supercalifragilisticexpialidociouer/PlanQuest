/* 多源冗余下载层单测：全注入 mock，不碰真实网络
 * 用法：node dev-tests/test-sources.js
 */
'use strict';
const assert = require('node:assert/strict');
const S = require('../src/sources');

let pass = 0, fail = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log('  ✓', name); }
  catch (e) { fail++; console.log('  ✗', name, '—', e.message); }
}
async function aok(name, fn) {
  try { await fn(); pass++; console.log('  ✓', name); }
  catch (e) { fail++; console.log('  ✗', name, '—', e.message); }
}
const jsonRes = (obj) => ({ text: () => JSON.stringify(obj), ok: true });

(async () => {
  console.log('\n== 源类型识别 ==');
  ok('GitHub releases 链接', () => assert.equal(S.kindOf('https://github.com/o/r/releases/latest'), 'github'));
  ok('GitHub API 链接', () => assert.equal(S.kindOf('https://api.github.com/repos/o/r/releases/latest'), 'github'));
  ok('pixeldrain', () => assert.equal(S.kindOf('https://pixeldrain.com/u/AbCd1234'), 'pixeldrain'));
  ok('mediafire', () => assert.equal(S.kindOf('https://www.mediafire.com/file/x/y/file'), 'mediafire'));
  ok('gofile', () => assert.equal(S.kindOf('https://gofile.io/d/AbCdEf'), 'gofile'));
  ok('R2/直链', () => assert.equal(S.kindOf('https://dl.example.com/planquest.zip'), 'r2'));
  ok('未知', () => assert.equal(S.kindOf('not a url'), 'unknown'));

  console.log('\n== 各源解析 ==');
  await aok('GitHub：按 wanted 精确选包、version 去 v 前缀', async () => {
    const fetch = async (u) => jsonRes({
      tag_name: 'v2.9.11', published_at: '2026-11-22T00:00:00Z', body: '修复',
      assets: [
        { name: 'PlanQuest-win64-portable.zip', size: 203451423, browser_download_url: 'https://github.com/o/r/releases/download/v2.9.11/PlanQuest-win64-portable.zip' },
        { name: 'PlanQuest-2.9.11-setup.exe', size: 168643829, browser_download_url: 'https://github.com/o/r/releases/download/v2.9.11/PlanQuest-2.9.11-setup.exe' },
      ],
    });
    const r = await S.resolveSource('https://github.com/o/r/releases/latest', fetch, /portable.*\.zip/i);
    assert.equal(r.source, 'github');
    assert.equal(r.version, '2.9.11');
    assert.equal(r.files.length, 1);
    assert.match(r.files[0].name, /portable/);
  });

  await aok('GitHub：无 wanted 时取所有 zip/exe', async () => {
    const fetch = async () => jsonRes({
      tag_name: 'v1.0', assets: [
        { name: 'a.zip', browser_download_url: 'u1' }, { name: 'b.exe', browser_download_url: 'u2' },
        { name: 'notes.md', browser_download_url: 'u3' },
      ],
    });
    const r = await S.resolveSource('https://github.com/o/r/releases/latest', fetch);
    assert.equal(r.files.length, 2);
  });

  await aok('R2：直链原样返回', async () => {
    const r = await S.resolveSource('https://dl.example.com/pq/PlanQuest-win64-portable.zip', async () => { throw new Error('不该请求'); });
    assert.equal(r.source, 'r2');
    assert.match(r.files[0].url, /portable\.zip$/);
  });

  await aok('pixeldrain：拼接 api/file/{id} 直链', async () => {
    const fetch = async (u) => {
      if (/api\/file\/.+\/info/.test(u)) return jsonRes({ success: true, name: 'PlanQuest.zip', size: 100 });
      throw new Error('unexpected ' + u);
    };
    const r = await S.resolveSource('https://pixeldrain.com/u/AbCd1234', fetch);
    assert.equal(r.source, 'pixeldrain');
    assert.equal(r.files[0].url, 'https://pixeldrain.com/api/file/AbCd1234');
    assert.equal(r.files[0].headers.Referer, 'https://pixeldrain.com/u/AbCd1234');
  });

  await aok('mediafire：从网页抠出直链', async () => {
    const fetch = async () => ({ text: () => '<a href="https://download4321.mediafire.com/abc/pq.zip">下</a>' });
    const r = await S.resolveSource('https://www.mediafire.com/file/xyz/pq/file', fetch);
    assert.equal(r.source, 'mediafire');
    assert.match(r.files[0].url, /mediafire/);
  });

  await aok('mediafire：找不到直链则失败', async () => {
    let threw = false;
    try { await S.resolveSource('https://www.mediafire.com/file/x/y/file', async () => ({ text: () => '<html>无</html>' })); }
    catch (e) { threw = true; }
    assert.ok(threw);
  });

  console.log('\n== 多源 fallback ==');
  await aok('GitHub 解析失败 → pixeldrain 成功', async () => {
    const fetch = async (u) => {
      if (/api\.github\.com/.test(u)) throw new Error('HTTP 404');
      if (/pixeldrain/.test(u)) return jsonRes({ success: true, name: 'pq.zip', size: 100 });
      throw new Error('unexpected');
    };
    const r = await S.resolveFirst([
      'https://github.com/o/r/releases/latest',
      'https://pixeldrain.com/u/AbCd1234',
    ], fetch);
    assert.equal(r.ok, true);
    assert.equal(r.result.source, 'pixeldrain');
    assert.equal(r.tried.length, 1);
    assert.equal(r.tried[0].kind, 'github');
  });

  await aok('全部源解析失败 → ok:false + 逐条原因', async () => {
    const fetch = async (u) => {
      if (/api\.github\.com/.test(u)) throw new Error('HTTP 404');
      if (/mediafire/.test(u)) return { text: () => '<html>无直链</html>' };
      throw new Error('HTTP 403');
    };
    const r = await S.resolveFirst([
      'https://github.com/o/r/releases/latest',
      'https://www.mediafire.com/file/x/y/file',
    ], fetch);
    assert.equal(r.ok, false);
    assert.equal(r.tried.length, 2);
    assert.match(r.reason, /所有源/);
  });

  await aok('没配置源 → ok:false', async () => {
    const r = await S.resolveFirst([], async () => {});
    assert.equal(r.ok, false);
    assert.match(r.reason, /一个源都没配置/);
  });

  console.log('\n== 下载编排 fallback ==');
  await aok('第一源下载校验失败 → 自动换第二源成功', async () => {
    const calls = [];
    const dl = async (url, dest) => {
      calls.push(url);
      if (/pixeldrain/.test(url)) throw new Error('校验没过');
      return { ok: true, file: dest };
    };
    const fetch = async (u) => {
      if (/api\.github\.com/.test(u)) return jsonRes({ tag_name: 'v2.9.11', assets: [{ name: 'pq.zip', browser_download_url: 'https://gh/pq.zip' }] });
      if (/pixeldrain/.test(u)) return jsonRes({ success: true, name: 'pq.zip' });
      throw new Error('unexpected');
    };
    const r = await S.downloadFirst([
      'https://pixeldrain.com/u/AbCd1234',
      'https://github.com/o/r/releases/latest',
    ], { wanted: /pq\.zip/i, dest: 'C:\\tmp\\pq.zip', fetch, downloader: dl });
    assert.equal(r.ok, true);
    assert.equal(r.source, 'github');
    assert.equal(calls.length, 2);
    assert.equal(r.tried.length, 1);
    assert.equal(r.tried[0].stage, '下载');
  });

  await aok('所有源下载都失败 → ok:false + 汇总', async () => {
    const dl = async () => { throw new Error('HTTP 500'); };
    const fetch = async (u) => {
      if (/api\.github\.com/.test(u)) return jsonRes({ tag_name: 'v2.9.11', assets: [{ name: 'pq.zip', browser_download_url: 'https://gh/pq.zip' }] });
      if (/pixeldrain/.test(u)) return jsonRes({ success: true, name: 'pq.zip' });
      throw new Error('unexpected');
    };
    const r = await S.downloadFirst([
      'https://github.com/o/r/releases/latest',
      'https://pixeldrain.com/u/AbCd1234',
    ], { dest: 'C:\\tmp\\pq.zip', fetch, downloader: dl });
    assert.equal(r.ok, false);
    assert.equal(r.tried.length, 2);
    assert.match(r.reason, /所有源都没成功/);
  });

  await aok('onStage 收到阶段文案', async () => {
    const stages = [];
    await S.downloadFirst(['https://github.com/o/r/releases/latest'], {
      dest: 'C:\\tmp\\pq.zip',
      fetch: async () => jsonRes({ tag_name: 'v1', assets: [{ name: 'pq.zip', browser_download_url: 'https://gh/pq.zip' }] }),
      downloader: async (u, d) => ({ ok: true, file: d }),
      onStage: (t) => stages.push(t),
    });
    assert.ok(stages.some((t) => /尝试下载/.test(t)));
  });

  console.log('\n结果：' + pass + ' 项通过，' + fail + ' 项失败');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('BOOT-FAIL', e && e.stack); process.exit(1); });
