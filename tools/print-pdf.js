const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const src = process.argv[2];
const out = process.argv[3];

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1000, height: 1400, show: false, webPreferences: { offscreen: false } });
  await win.loadFile(src);
  await new Promise((r) => setTimeout(r, 1200));
  const buf = await win.webContents.printToPDF({
    printBackground: true,
    pageSize: 'A4',
    margins: { marginType: 'custom', top: 0.4, bottom: 0.4, left: 0.4, right: 0.4 },
  });
  fs.writeFileSync(out, buf);
  console.log('PDF_OK ' + out + ' ' + buf.length);
  app.quit();
}).catch((e) => { console.error('ERR', e); app.quit(); });
