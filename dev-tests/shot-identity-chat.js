/* 身份聊天效果图：聊天视图 + 养成页身份卡（确认没有直接改名表单）
 * 用法：electron dev-tests/shot-identity-chat.js
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const dir = path.join(__dirname, '..', '.workbuddy');
  fs.mkdirSync(dir, { recursive: true });
  const win = new BrowserWindow({ show: true, width: 900, height: 720, x: 60, y: 40, backgroundColor: '#0e1020' });
  await win.loadFile(path.join(__dirname, 'identity-chat.html'));
  await sleep(700);
  await win.webContents.executeJavaScript('window.__probe()');
  await sleep(1200);
  let img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(dir, 'identity-chat.png'), img.toPNG());
  await win.webContents.executeJavaScript("PQBuddy.aci.switchTab('grow')");
  await sleep(700);
  img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(dir, 'identity-card.png'), img.toPNG());
  console.log('shots ok');
  win.destroy();
  app.quit();
});
