'use strict';
/* 安装助手（Inno Setup 脚本）静态回归测试：不联网、不装程序，只读 .iss 断言关键约束。
 * 用法：node dev-tests/test-assistant.js
 */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const ISS = fs.readFileSync(path.join(__dirname, '..', 'tools', 'PlanQuest-Assistant.iss'), 'utf8');
const DOC = fs.readFileSync(path.join(__dirname, '..', '使用说明.txt'), 'utf8');
const APP = fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8');

let pass = 0, fail = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log('  ✓', name); }
  catch (e) { fail++; console.log('  ✗', name, '—', e.message); }
}

console.log('\n== 安装助手：免管理员 / 不改系统 ==');
ok('普通用户权限（不弹 UAC）', () => assert.match(ISS, /PrivilegesRequired=lowest/));
ok('不写卸载注册表', () => assert.match(ISS, /CreateUninstallRegKey=no/));
ok('不生成卸载程序', () => assert.match(ISS, /Uninstallable=no/));
ok('不建开始菜单', () => assert.match(ISS, /DisableProgramGroupPage=yes/));
ok('没有 [Registry] 段', () => assert.doesNotMatch(ISS, /^\[Registry\]/mi));
ok('没有 [Run] 段（不代写开机自启）', () => assert.doesNotMatch(ISS, /^\[Run\]/mi));
ok('桌面建快捷方式', () => {
  assert.match(ISS, /^\[Icons\]/mi);
  assert.match(ISS, /\{autodesktop\}\\PlanQuest/);
  assert.match(ISS, /Filename: "?\{app\}\\PlanQuest\.exe/);
});
ok('下载失败时删除桌面快捷方式（不留死链）', () => assert.match(ISS, /DeleteFile\(ExpandConstant\('\{autodesktop\}\\PlanQuest\.lnk'\)\)/));
ok('[Files] 为空（引导器不内嵌主程序）', () => {
  const m = /\[Files\]([\s\S]*?)(?=\n\[|$)/.exec(ISS);
  const body = m ? m[1].split('\n').filter((l) => /^\s*Source:/i.test(l)) : [];
  assert.equal(body.length, 0, '存在内嵌 Source:' + body.join(','));
});

console.log('\n== 安装助手：选版本 / 选 AI / 换源 ==');
ok('内置多个版本可选', () => {
  const hits = ISS.match(/AvailVersions\[\d+\] := '\d+\.\d+/g) || [];
  assert.ok(hits.length >= 3, '版本数 ' + hits.length);
});
ok('Ollama 勾选框默认不勾', () => assert.match(ISS, /OllamaCheck\.Checked := False/));
ok('MeloTTS 勾选框默认不勾', () => assert.match(ISS, /MeloTsCheck\.Checked := False/));
ok('AI 只下载到 components 目录', () => assert.match(ISS, /components/));
ok('支持外部 assistant-sources.txt 换源', () => assert.match(ISS, /assistant-sources\.txt/));
ok('启动时不联网拉版本列表（离线不卡向导）', () => {
  const init = /procedure InitializeWizard;([\s\S]*?)end;/.exec(ISS);
  assert.ok(init, '找不到 InitializeWizard');
  assert.doesNotMatch(init[1], /FetchVersions/, '启动时仍调用 FetchVersions');
});
ok('curl 带低速超时（离线不长时间卡死）', () => assert.match(ISS, /--speed-time/));

console.log('\n== 设置页「版本更新」不再填源 ==');
ok('没有下载源 textarea', () => assert.doesNotMatch(APP, /pq-up-sources/));
ok('没有「保存源」按钮', () => assert.doesNotMatch(APP, /pq-up-save/));
ok('保留检查更新按钮', () => assert.match(APP, /pq-up-check/));
ok('提示用户去看使用说明.txt', () => assert.match(APP, /使用说明\.txt/));

console.log('\n== 使用说明：源写进文档 ==');
ok('有「安装源」一节', () => assert.match(DOC, /【安装源/));
ok('写明五类源', () => {
  for (const k of ['GitHub', 'R2', 'pixeldrain', 'MediaFire', 'GoFile']) assert.ok(DOC.includes(k), '缺 ' + k);
});
ok('写明安装助手 exe', () => assert.match(DOC, /PlanQuest-安装助手\.exe/));

console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (fail) process.exitCode = 1;
