const { app, BrowserWindow } = require('electron');

app.whenReady().then(async () => {
  const w = new BrowserWindow({ width: 1280, height: 900, show: false, webPreferences: { nodeIntegration: false } });
  await w.loadURL('http://127.0.0.1:18922/index.html#/download');
  await new Promise((r) => setTimeout(r, 2000));
  const out = await w.webContents.executeJavaScript(`(() => {
    const btn = [...document.querySelectorAll('[data-platform]')].find(b => b.dataset.platform === 'windows');
    btn.click();
    return new Promise(res => setTimeout(() => res({
      title: document.getElementById('platform-title')?.textContent,
      buttons: [...document.querySelectorAll('.download-card .btn')].map(a => ({ text: a.textContent.trim(), href: a.href }))
    }), 300));
  })()`);
  console.log('PROBE', JSON.stringify(out, null, 2));
  app.quit();
});
