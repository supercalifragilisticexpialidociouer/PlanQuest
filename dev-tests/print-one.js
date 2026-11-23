'use strict';
const path = require('path'); const fs = require('fs');
const { app, BrowserWindow } = require('electron');
const src = process.argv[2], out = process.argv[3];
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1240, height: 1800 });
  win.webContents.on('did-fail-load', (_e, code, desc, url) => console.log('FAIL', code, desc, url));
  try {
    await win.loadFile(path.join(__dirname, '..', 'dist', src));
    await new Promise((r) => setTimeout(r, 2200));
    const pdf = await win.webContents.printToPDF({ printBackground: true, pageSize: 'A4', margins: { top: 0.5, bottom: 0.5, left: 0.4, right: 0.4 } });
    fs.writeFileSync(path.join(__dirname, '..', 'dist', out), pdf);
    console.log('PDF-OK', out, pdf.length);
  } catch (e) { console.log('PDF-FAIL', e.message); }
  app.quit();
});
