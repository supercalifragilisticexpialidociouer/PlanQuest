const { app, BrowserWindow } = require('electron');
const path = require('path');
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 620, height: 980, show: false });
  await win.loadFile(path.join(__dirname, '..', 'web', 'index.html'));
  await new Promise(r => setTimeout(r, 1200));
  const info = await win.webContents.executeJavaScript(`
    (function(){
      try {
        window.PQShare.open({ date:'2026-11-17', name:'我', done:4, total:6, streak:12, points:340,
          plans:[{title:'晨间阅读',done:true}], contracts:[{name:'考研冲刺',stake:20,owe:45}] });
        const m = document.querySelector('.pqs-mask');
        if (!m) return 'NO MASK IN DOM';
        const cs = getComputedStyle(m);
        const cv = m.querySelector('canvas');
        const rows = m.querySelectorAll('.pqs-row').length;
        return JSON.stringify({
          display: cs.display, zIndex: cs.zIndex,
          rect: m.getBoundingClientRect().width + 'x' + m.getBoundingClientRect().height,
          canvasW: cv ? cv.width : null, canvasH: cv ? cv.height : null,
          rows, styleInjected: !!document.getElementById('pqs-style'),
          bodyChildren: document.body.children.length
        });
      } catch (e) { return 'ERR ' + e.message; }
    })()
  `);
  console.log(info);
  app.quit();
}).catch(e => { console.error('ERR', e); app.quit(); });
