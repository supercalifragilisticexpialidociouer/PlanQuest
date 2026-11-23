const { app, BrowserWindow } = require('electron');
const fs = require('fs');

const src = process.argv[2];
const out = process.argv[3];
const needle = process.argv[4] || '';

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1000, height: 1250, show: false });
  await win.loadFile(src);
  await new Promise((r) => setTimeout(r, 900));
  if (needle) {
    await win.webContents.executeJavaScript(
      `(() => { const hs=[...document.querySelectorAll('h3,h2')]; const t=hs.find(h=>h.textContent.includes(${JSON.stringify(needle)})); if(t) t.scrollIntoView({block:'start'}); return !!t; })()`
    );
    await new Promise((r) => setTimeout(r, 500));
  }
  const img = await win.webContents.capturePage();
  fs.writeFileSync(out, img.toPNG());
  console.log('SHOT_OK ' + out);
  app.quit();
}).catch((e) => {
  console.error('ERR', e.message);
  app.quit();
});
