/* 不爽微表情对照截图：确认半睁眼/斜眼笑/撇嘴/翻白眼在建模上真的看得出来 */
'use strict';
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const win = new BrowserWindow({
    show: true, width: 1290, height: 360, x: 40, y: 40, backgroundColor: '#0e1020',
    webPreferences: { contextIsolation: false, nodeIntegration: false },
  });
  win.webContents.on('console-message', (_e, _l, m) => {
    if (/error|Uncaught/i.test(m)) console.log('[page] ' + m);
  });
  await win.loadFile(path.join(__dirname, 'expressions-grid2.html'));
  await sleep(1700);
  const probe = await win.webContents.executeJavaScript(`(function(){
      var out = [];
      document.querySelectorAll('.cell canvas').forEach(function(c,i){
        out.push({ i:i, w:c.width, h:c.height, mood: window.__insts[i] ? window.__insts[i].mood() : 'none' });
      });
      return out;
    })()`, true);
  console.log('probe', JSON.stringify(probe));
  /* 表情平滑要时间，等它演到位再截 */
  win.show(); win.focus(); win.moveTop();
  await sleep(700);
  let buf = Buffer.alloc(0);
  for (let tries = 0; tries < 3; tries++) {
    const img = await win.webContents.capturePage();
    buf = img && img.toPNG ? img.toPNG() : Buffer.alloc(0);
    console.log('capture ' + tries + ': ' + buf.length + ' bytes');
    await sleep(350);
  }
  fs.writeFileSync(path.join(__dirname, 'expressions-grid2.png'), buf);
  console.log('shot expressions-grid2.png ' + buf.length + ' bytes');
  win.destroy();
  app.quit();
}
app.whenReady().then(main).catch((e) => { console.error(e); process.exit(1); });
