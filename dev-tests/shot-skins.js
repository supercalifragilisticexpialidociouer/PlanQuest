/* 五种皮肤建模对照截图：确认几何体真的不一样，不是只换颜色 */
'use strict';
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const win = new BrowserWindow({
    show: true, width: 1090, height: 360, x: 40, y: 40, backgroundColor: '#0e1020',
    webPreferences: { contextIsolation: false, nodeIntegration: false },
  });
  win.webContents.on('console-message', (_e, _l, m) => {
    if (/error|Uncaught/i.test(m)) console.log('[page] ' + m);
  });
  await win.loadFile(path.join(__dirname, 'skins-grid.html'));
  await sleep(1600);
  const err = await win.webContents.executeJavaScript(`(function(){
      var out = [];
      document.querySelectorAll('.cell canvas').forEach(function(c,i){
        out.push({ i: i, w: c.width, h: c.height });
      });
      return out;
    })()`, true);
  console.log('canvases', JSON.stringify(err));
  win.show(); win.focus(); win.moveTop();
  await sleep(500);
  const img = await win.webContents.capturePage();
  const buf = img && img.toPNG ? img.toPNG() : Buffer.alloc(0);
  fs.writeFileSync(path.join(__dirname, 'skins-grid.png'), buf);
  console.log('shot skins-grid.png ' + buf.length + ' bytes');
  win.destroy();
  app.quit();
}
app.whenReady().then(main).catch((e) => { console.error(e); process.exit(1); });
