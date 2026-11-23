/* 元素级截图：加载页面 → 滚动到指定选择器 → 截图（Electron 冒烟用） */
const { app, BrowserWindow } = require('electron');
const fs = require('fs');

const url = process.argv[2];
const out = process.argv[3] || 'shot.png';
const selector = process.argv[4] || '#view';
const width = Number(process.argv[5]) || 430;
const height = Number(process.argv[6]) || 900;

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width, height, show: false, webPreferences: { partition: 'pqel' + Date.now() } });
  const errors = [];
  win.webContents.on('console-message', (...args) => {
    const d = args[1];
    const level = typeof d === 'object' && d !== null ? d.level : args[1];
    const message = typeof d === 'object' && d !== null ? d.message : args[2];
    if (level === 'error' || level === 3 || level === 2) errors.push('[console] ' + message);
  });
  win.webContents.on('did-fail-load', (_e, code, desc) => errors.push('FAIL-LOAD ' + code + ' ' + desc));
  try {
    await win.loadURL(url);
  } catch (e) {
    errors.push('loadURL: ' + e.message);
  }
  await new Promise((r) => setTimeout(r, 3500));
  let found = false;
  try {
    found = await win.webContents.executeJavaScript(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.scrollIntoView({ block: 'start' });
      window.scrollBy(0, -8);
      return true;
    })()`);
  } catch (e) {
    errors.push('scroll: ' + e.message);
  }
  await new Promise((r) => setTimeout(r, 600));
  try {
    const img = await win.webContents.capturePage();
    fs.writeFileSync(out, img.toPNG());
  } catch (e) {
    errors.push('shot: ' + e.message);
  }
  try {
    fs.writeFileSync(out.replace(/\.png$/, '.json'), JSON.stringify({ url, selector, found, errors }, null, 2));
  } catch (e) {}
  app.quit();
});
setTimeout(() => app.exit(2), 30000);
