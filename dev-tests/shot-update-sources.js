/* 实机截图 + 断言：设置页「版本更新」面板（已精简：不再填源，源写在使用说明.txt）
 * 运行：env -u ELECTRON_RUN_AS_NODE npx electron dev-tests/shot-update-sources.js
 */
'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const root = path.join(__dirname, '..');
const out = path.join(__dirname, 'shot-update-sources.png');
const INDEX = path.join(root, 'web', 'index.html');

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 900, height: 900, show: false, webPreferences: { partition: 'pqsrc' + Date.now() } });
  await win.loadFile(INDEX);
  await new Promise((r) => setTimeout(r, 2600));

  /* 独立窗口没有 preload，state 未被 boot 填充：注入最小 state 后直接渲染面板函数 */
  const probe = await win.webContents.executeJavaScript(`(function(){
    try {
      state = { settings: { updateSources: [
        'https://github.com/supercalifragilisticexpialidociouer/PlanQuest/releases/latest',
        'https://pixeldrain.com/u/xxxxx'
      ] } };
    } catch (e) { return { error: 'set state: ' + e.message }; }
    try {
      var html = updatePanelHTML();
      return {
        hasTitle: html.indexOf('版本更新') >= 0,
        noSourceBox: html.indexOf('pq-up-sources') < 0 && html.indexOf('保存源') < 0,
        pointsToDoc: html.indexOf('使用说明.txt') >= 0,
        hasAI: html.indexOf('可选大模型') >= 0 && html.indexOf('不勾选就一个字节都不下') >= 0,
        hasCompDir: html.indexOf('components') >= 0,
        checkboxes: (html.match(/type="checkbox"/g)||[]).length,
        html: html.slice(0, 160),
      };
    } catch (e) { return { error: 'render: ' + e.message }; }
  })()`);
  if (probe.error) { console.log('PROBE-ERR', probe.error); }

  console.log('PROBE', JSON.stringify(probe));
  let fail = 0;
  const ok = (n, c) => { console.log((c ? '  ✓ ' : '  ✗ ') + n); if (!c) fail++; };
  ok('面板标题含「版本更新」', probe.hasTitle);
  ok('不再有下载源输入框/保存源按钮', probe.noSourceBox);
  ok('指向使用说明.txt', probe.pointsToDoc);
  ok('默认都不下载大模型', probe.hasAI);
  ok('写明 AI 装到 components 目录', probe.hasCompDir);
  ok('两个复选框', probe.checkboxes === 2);

  /* 用面板 HTML 造一个覆盖层来截图（state 已注入） */
  await win.webContents.executeJavaScript(`(function(){
    var html = updatePanelHTML();
    var ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;background:#0e1020;z-index:99999;padding:26px;overflow:auto';
    ov.innerHTML = '<div style="max-width:840px;margin:0 auto;color:#e8eaf0">' + html + '</div>';
    document.body.appendChild(ov);
    return 'ok';
  })()`);
  await new Promise((r) => setTimeout(r, 600));
  const img = await win.webContents.capturePage();
  fs.writeFileSync(out, img.toPNG());
  console.log('SHOT', out, fail ? ('FAIL ' + fail) : 'ALL PASS');
  win.destroy();
  app.exit(fail ? 1 : 0);
}).catch((e) => { console.error('FAIL', e && e.stack); app.exit(1); });
