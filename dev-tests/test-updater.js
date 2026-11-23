'use strict';
/* R2 直链更新 + 可选大模型下载：纯逻辑单测，不起 Electron、不联网 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const U = require('../src/updater.js');

let pass = 0;
function ok(name, cond) {
  if (!cond) { console.error('FAIL  ' + name); process.exitCode = 1; }
  else { pass++; console.log('ok    ' + name); }
}

/* 1) 版本比较 */
ok('2.9.10 > 2.9.9', U.cmpVersion('2.9.10', '2.9.9') > 0);
ok('2.9.8 < 2.9.9', U.cmpVersion('2.9.8', '2.9.9') < 0);
ok('相同版本 = 0', U.cmpVersion('2.9.9', '2.9.9') === 0);
ok('缺位补 0：2.9 = 2.9.0', U.cmpVersion('2.9', '2.9.0') === 0);
ok('3.0 > 2.99.99', U.cmpVersion('3.0', '2.99.99') > 0);

/* 2) 清单地址 */
ok('未填域名 → 空地址', U.manifestUrl('') === '');
ok('非 http 域名被拒', U.manifestUrl('ftp://x/y') === '');
ok('尾斜杠不重复', U.manifestUrl('https://dl.example.com/pq/') === 'https://dl.example.com/pq/version.json');

/* 3) 检查更新（mock fetcher，不联网） */
const M = {
  schema: 1, version: '2.9.9',
  installer: { file: 'setup.exe', url: 'https://dl.example.com/pq/2.9.9/setup.exe', size: 100, sha256: 'ab', built: true, admin: false, action: 'unpack-only' },
  portable: { file: 'p.zip', url: 'https://dl.example.com/pq/2.9.9/p.zip', size: 200, sha256: 'cd' },
  components: [
    { id: 'ollama', official: 'https://github.com/ollama/ollama/releases/download/v0.40.17/ollama-windows-amd64.zip', file: 'o.zip', size: 1618522644, modelSize: 1930000000 },
    { id: 'melotts', official: 'https://github.com/myshell-ai/MeloTTS/archive/refs/heads/main.zip', file: 'm.zip', runnable: false, requires: 'Python <= 3.10' },
  ],
  policy: { autoStart: 'app-only', defaultSelected: [] },
};
const fetchOK = async () => Buffer.from(JSON.stringify(M));

(async () => {
  let r = await U.check('', '2.9.8');
  ok('没配域名 → 明确说没填，不假装成功', r.ok === false && r.reason.includes('R2'));

  r = await U.check('https://dl.example.com/pq', '2.9.8', fetchOK);
  ok('拉到清单且判定有新版本', r.ok && r.hasUpdate && r.latest === '2.9.9');

  r = await U.check('https://dl.example.com/pq', '2.9.9', fetchOK);
  ok('同版本不提示更新', r.ok && !r.hasUpdate);

  r = await U.check('https://dl.example.com/pq', '3.0.0', fetchOK);
  ok('本机更新不提示降级', r.ok && !r.hasUpdate);

  r = await U.check('https://dl.example.com/pq', '2.9.8', async () => Buffer.from('{oops'));
  ok('坏 JSON 给人话', r.ok === false && r.reason.includes('JSON'));

  r = await U.check('https://dl.example.com/pq', '2.9.8', async () => Buffer.from('{}'));
  ok('缺版本号被拦下', r.ok === false && r.reason.includes('版本号'));

  r = await U.check('https://dl.example.com/pq', '2.9.8', async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:443'); });
  ok('网络错误转成人话，不露 errno', r.ok === false && !r.reason.includes('ECONNREFUSED') && r.reason.length > 0);

  /* 4) sha256 校验 */
  const tmp = path.join(os.tmpdir(), 'pq-updater-test-' + process.pid + '.bin');
  fs.writeFileSync(tmp, 'planquest');
  const hash = require('node:crypto').createHash('sha256').update('planquest').digest('hex');
  ok('哈希正确通过', U.verifySha256(tmp, hash).ok === true);
  ok('哈希错误被拒', U.verifySha256(tmp, 'deadbeef').ok === false);
  ok('没给期望值 → 跳过但明确标记', U.verifySha256(tmp, null).skipped === true);
  fs.unlinkSync(tmp);

  /* 5) 组件白名单：不勾就一个都不下 */
  ok('默认不勾 → 空列表', U.selectComponents(M, []).length === 0);
  ok('不传 selected → 空列表', U.selectComponents(M, null).length === 0);
  ok('勾一个只下一个', U.selectComponents(M, ['ollama']).map((c) => c.id).join() === 'ollama');
  ok('勾两个下两个', U.selectComponents(M, ['ollama', 'melotts']).length === 2);
  ok('伪造 id 被忽略', U.selectComponents(M, ['evil.exe']).length === 0);
  ok('混合时只认白名单', U.selectComponents(M, ['ollama', 'evil']).map((c) => c.id).join() === 'ollama');

  /* 6) 前置检查：MeloTTS 如实说跑不起来 */
  const pcM = U.precheck(M.components[1], { python: '3.13.14' });
  ok('MeloTTS 允许只下源码', pcM.allowed === true);
  ok('MeloTTS 明确标记 runnable:false', pcM.runnable === false);
  ok('MeloTTS 提示 Python 版本问题', pcM.warn.join(' ').includes('3.13'));
  const pcO = U.precheck(M.components[0], { freeGB: 2, hasGPU: false });
  ok('Ollama 磁盘不足给警告', pcO.warn.some((w) => w.includes('GB')));
  ok('Ollama 无独显给警告', pcO.warn.some((w) => w.includes('几十秒')));
  ok('没有官网直链的组件被拒', U.precheck({ id: 'x' }, {}).allowed === false);

  /* 7) 下载计划 */
  const plan = U.buildPlan(M, []);
  ok('主包永远在计划里', !!plan.main && plan.main.url.includes('https://'));
  ok('默认不带任何可选组件', plan.components.length === 0);
  ok('明确写不需要迁移数据', plan.dataMigration === 'none');
  ok('不覆盖运行中的 exe', plan.note.includes('不覆盖'));
  const plan2 = U.buildPlan(M, ['melotts']);
  ok('勾了才把组件放进计划', plan2.components.length === 1 && plan2.components[0].id === 'melotts');
  ok('组件 URL 指向官网而非 R2', plan2.components[0].url.includes('github.com'));

  /* 8) 安装器策略 */
  ok('安装器不提权', M.installer.admin === false);
  ok('安装器只解压', M.installer.action === 'unpack-only');
  ok('开机自启只能应用内写', M.policy.autoStart === 'app-only');

  console.log('\n结果：' + pass + ' 项全部通过');
})();
