const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const OUT = path.join(__dirname, '..', 'shots');

async function shot(url, file) {
  const w = new BrowserWindow({ width: 1280, height: 900, show: false, webPreferences: { nodeIntegration: false } });
  await w.loadURL(url);
  await new Promise((r) => setTimeout(r, 2200));
  const img = await w.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, file), img.toPNG());
  console.log('SHOT', file);
  w.close();
}

app.whenReady().then(async () => {
  await shot('http://127.0.0.1:18922/index.html#/home', 'site-home.png');
  await shot('http://127.0.0.1:18922/index.html#/download', 'site-download.png');
  await shot('http://127.0.0.1:18922/community.html', 'site-community.png');
  app.quit();
});
