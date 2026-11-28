/* 消息弹窗效果图：深色 / 浅色各一张，确认泡泡不黑底黑字、层级不叠成一坨
 * 用法：electron dev-tests/shot-msgpop.js
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const W = 860;
const H = 620;

async function shot(theme, out) {
  const bg = theme === 'dark' ? '#0e1020' : '#f4f5fa';
  const win = new BrowserWindow({
    show: true,
    width: W,
    height: H,
    x: 60,
    y: 60,
    backgroundColor: bg,
    webPreferences: { offscreen: false },
  });
  for (let i = 0; i < 3; i++) {
    try {
      await win.loadFile(path.join(__dirname, 'msgpop-shot.html'));
      break;
    } catch (e) {
      if (i === 2) throw e;
      await sleep(300);
    }
  }
  await sleep(150);
  await win.webContents.executeJavaScript(
    `document.getElementById('app').dataset.theme='${theme}';document.body.style.background='${bg}';`
  );
  await win.webContents.executeJavaScript('window.__seed()');
  await sleep(900);
  const img = await win.webContents.capturePage();
  fs.writeFileSync(out, img.toPNG());
  win.destroy();
}

app.on('window-all-closed', () => {}); // destroy 窗口后别让 electron 自动退出，浅色主题还要截

app.whenReady().then(async () => {
  const dir = path.join(__dirname, '..', '.workbuddy');
  fs.mkdirSync(dir, { recursive: true });
  try {
    await shot('dark', path.join(dir, 'msgpop-dark.png'));
    console.log('dark ok');
    await sleep(500);
    await shot('light', path.join(dir, 'msgpop-light.png'));
    console.log('light ok');
  } catch (e) {
    console.error('SHOT FAIL:', e && e.message);
    process.exitCode = 1;
  }
  app.quit();
});
