/* 截图：信誉三档特权卡 + 军团内我的信誉位置（不依赖主进程，直接喂 state） */
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const out = path.join(__dirname, 'shot-rep.png');

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1080, height: 1200, show: false, webPreferences: { partition: 'pqv' + Date.now() } });
  await win.loadFile(path.join(root, 'web', 'index.html'));
  await new Promise((r) => setTimeout(r, 1200));

  const r = await win.webContents.executeJavaScript(`
    (function () {
      if (typeof window.PQCreditPriv === 'undefined') return 'NO PRIV MODULE';
      state = { credit: { score: 105, limit: 80, rate: 0.15,
        rep: { flips:{ok:4,bad:1}, reports:{ok:2,bad:0}, loans:{ok:1,bad:0}, help:{ok:5}, online:{ok:9,bad:1}, growth:{ok:3} },
        ledger: [{ at:new Date().toISOString(), type:'help_ok', delta:2, pillar:'ally', note:'助人被确认' }] } };
      var rankHtml = govRepRankHTML({
        self: { uid: 'me', credit: 105 },
        roster: [
          { uid: 'a', alias: '阿七', credit: 130 },
          { uid: 'b', alias: '老陈', credit: 118 },
          { uid: 'me', alias: '我', credit: 105 },
          { uid: 'c', alias: '小满', credit: 96 },
          { uid: 'd', alias: '阿吉', credit: 88 }
        ]
      });
      document.body.innerHTML = '<div id="app" data-theme="dark" style="max-width:960px;margin:28px auto;padding:0 16px">'
        + '<div class="panel">' + creditLevelHTML() + '</div>'
        + '<div class="panel" style="margin-top:16px"><h3>团内治理（节选）</h3>' + rankHtml + '</div>'
        + '</div>';
      const cs = getComputedStyle(document.body);
      return JSON.stringify({ op: cs.opacity, filter: cs.filter, bg: cs.backgroundColor, appOp: getComputedStyle(document.getElementById('app')).opacity });
    })()
  `);
  console.log('build=', r);
  await new Promise((r2) => setTimeout(r2, 1800));
  const img = await win.webContents.capturePage();
  fs.writeFileSync(out, img.toPNG());
  console.log('SHOT_OK', out);
  app.quit();
}).catch((e) => { console.error('ERR', e.message); app.quit(); });
