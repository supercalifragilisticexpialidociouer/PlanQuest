/* 五种皮肤 × 冷漠表情对照：确认半睁眼/翻白眼/撇嘴在每套建模上都成立 */
'use strict';
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const win = new BrowserWindow({
    show: true, width: 560, height: 1330, x: 40, y: 30, backgroundColor: '#0e1020',
    webPreferences: { contextIsolation: false, nodeIntegration: false },
  });
  win.webContents.on('console-message', (_e, _l, m) => {
    if (/error|Uncaught/i.test(m)) console.log('[page] ' + m);
  });
  await win.loadFile(path.join(__dirname, 'expressions-skins.html'));
  await sleep(2200);
  const probe = await win.webContents.executeJavaScript(`(function(){
      return Array.from(document.querySelectorAll('.cell')).map(function(c,i){
        return { i:i, skin:c.dataset.skin, mood:c.dataset.mood, w:c.querySelector('canvas').width };
      });
    })()`, true);
  console.log('probe ' + JSON.stringify(probe.slice(0, 5)) + ' …共 ' + probe.length + ' 个');
  win.show(); win.focus(); win.moveTop();
  await sleep(800);
  let buf = Buffer.alloc(0);
  for (let i = 0; i < 2; i++) {
    const img = await win.webContents.capturePage();
    buf = img && img.toPNG ? img.toPNG() : buf;
    await sleep(300);
  }
  fs.writeFileSync(path.join(__dirname, 'expressions-skins.png'), buf);
  console.log('shot expressions-skins.png ' + buf.length + ' bytes');
  win.destroy();
  app.quit();
}
app.whenReady().then(main).catch((e) => { console.error(e); process.exit(1); });
