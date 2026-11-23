const { app, BrowserWindow } = require('electron');
const fs = require('fs');

const src = process.argv[2];
const out = process.argv[3];
const needle = process.argv[4] || '';

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1000, height: 1250, show: false });
  win.webContents.setBackgroundThrottling(false);
  await win.loadFile(src);
  await new Promise((r) => setTimeout(r, 800));
  if (needle) {
    await win.webContents.executeJavaScript(
      `(() => {
         document.documentElement.style.scrollBehavior='auto';
         const hs=[...document.querySelectorAll('h2,h3')];
         const t=hs.find(h=>h.textContent.includes(${JSON.stringify(needle)}));
         if(!t) return 'no-target';
         const y=t.getBoundingClientRect().top + window.scrollY - 70;
         window.scrollTo(0, y);
         return 'y='+Math.round(y);
       })()`
    );
    await new Promise((r) => setTimeout(r, 1800));
  }
  const img = await win.webContents.capturePage();
  fs.writeFileSync(out, img.toPNG());
  console.log('SHOT_OK ' + out);
  app.quit();
}).catch((e) => {
  console.error('ERR', e.message);
  app.quit();
});
