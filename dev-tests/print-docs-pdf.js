/* 把三份文档分别打成 PDF（Electron 自己渲染，不依赖 Edge） */
'use strict';
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');

const DOCS = [
  ['PlanQuest-快速上手.html', 'PlanQuest-快速上手.pdf'],
  ['PlanQuest-完整手册.html', 'PlanQuest-完整手册.pdf'],
  ['PlanQuest-更新日志.html', 'PlanQuest-更新日志.pdf'],
];

app.whenReady().then(async () => {
  for (const [src, out] of DOCS) {
    const win = new BrowserWindow({ show: false, width: 1240, height: 1800 });
    await win.loadFile(path.join(__dirname, '..', 'dist', src));
    await new Promise((r) => setTimeout(r, 1500));
    const pdf = await win.webContents.printToPDF({
      printBackground: true, pageSize: 'A4',
      margins: { top: 0.5, bottom: 0.5, left: 0.4, right: 0.4 },
    });
    fs.writeFileSync(path.join(__dirname, '..', 'dist', out), pdf);
    console.log('PDF-OK', out, pdf.length);
    win.destroy();
  }
  app.quit();
}).catch((e) => { console.log('PDF-FAIL', e.message); app.quit(); });
