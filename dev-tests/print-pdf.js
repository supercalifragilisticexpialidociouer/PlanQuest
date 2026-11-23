/* 工具：把介绍 HTML 打印成 PDF
 * 用法：node dev-tests/print-pdf.js <in.html> <out.pdf>
 */
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const [, , inHtml, outPdf] = process.argv;
if (!inHtml || !outPdf) {
  console.error('用法: node dev-tests/print-pdf.js <in.html> <out.pdf>');
  process.exit(1);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1200, height: 900, webPreferences: { offscreen: true } });
  await win.loadFile(path.resolve(inHtml));
  await new Promise((r) => setTimeout(r, 2000)); // 等字体/图片
  const pdf = await win.webContents.printToPDF({
    printBackground: true,
    pageSize: 'A4',
    margins: { top: 0.6, bottom: 0.6, left: 0.5, right: 0.5 },
  });
  fs.writeFileSync(path.resolve(outPdf), pdf);
  console.log('PDF 已生成:', outPdf, (pdf.length / 1024 / 1024).toFixed(2) + 'MB');
  app.exit(0);
});
