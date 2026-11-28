/* 「娇脸 + 傲话」反差对照卡截图。用法：electron dev-tests/shot-voice-card.js */
'use strict';
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function shot(theme, out) {
  const bg = theme === 'dark' ? '#0e1020' : '#f4f5fa';
  const win = new BrowserWindow({ show: true, width: 1040, height: 470, x: 40, y: 40,
    backgroundColor: bg, webPreferences: { offscreen: false } });
  await win.loadFile(path.join(__dirname, 'voice-card.html'));
  await win.webContents.executeJavaScript(
    `document.getElementById('app').dataset.theme='${theme}';`
    + (theme === 'light'
      ? `document.body.style.background='${bg}';document.body.style.color='#1a1c33';`
        + `document.querySelectorAll('.line').forEach(function(e){e.style.color='#1a1c33'});`
        + `document.querySelectorAll('.sub').forEach(function(e){e.style.color='#5a6088'});`
        + `document.querySelectorAll('.cell').forEach(function(e){e.style.background='rgba(124,108,255,.06)';e.style.borderColor='rgba(0,0,0,.09)'});`
      : '')
  );
  win.show(); win.focus(); win.moveTop();
  await sleep(1300);
  let buf = Buffer.alloc(0);
  for (let i = 0; i < 4; i++) {
    const img = await win.webContents.capturePage();
    const b = img && img.toPNG ? img.toPNG() : Buffer.alloc(0);
    if (b.length) { buf = b; break; }
    await sleep(400);
  }
  if (buf.length) { fs.writeFileSync(out, buf); console.log('shot', out, buf.length); }
  else console.error('WARN empty', out);
  win.destroy();
}

app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const dir = path.join(__dirname, '..', '.workbuddy');
  fs.mkdirSync(dir, { recursive: true });
  try {
    await shot('dark', path.join(dir, 'voice-card-dark.png'));
    await sleep(400);
    await shot('light', path.join(dir, 'voice-card-light.png'));
    console.log('done');
  } catch (e) { console.error('SHOT FAIL:', e && e.message); process.exitCode = 1; }
  app.quit();
});
