/* 用 Electron 自己把介绍 HTML 打成 PDF（Edge headless 在沙箱里不可用） */
'use strict';
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');

app.whenReady().then(async () => {
  try {
    const src = path.join(__dirname, '..', 'dist', 'PlanQuest-全面介绍.html');
    const out = path.join(__dirname, '..', 'dist', 'PlanQuest-全面介绍.pdf');
    const win = new BrowserWindow({ show: false, width: 1240, height: 1800 });
    await win.loadFile(src);
    await new Promise((r) => setTimeout(r, 1800)); // 等字体与图片
    const pdf = await win.webContents.printToPDF({
      printBackground: true,
      pageSize: 'A4',
      margins: { top: 0.5, bottom: 0.5, left: 0.4, right: 0.4 },
    });
    fs.writeFileSync(out, pdf);
    console.log('PDF-OK', pdf.length, 'bytes');
    app.exit(0);
  } catch (e) {
    console.error('PDF-FAIL', e && e.message);
    app.exit(1);
  }
});
