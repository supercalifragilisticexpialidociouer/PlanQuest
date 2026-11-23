/* 截阿刺 Pro 的效果图：整窗一张 + 3D 模型放大一张，自己看形象有没有跑偏
 * 用法：electron dev-tests/shot-buddy.js [light] */
'use strict';
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const W = 800, H = 720, BIG = { x: 440, y: 0, w: 340, h: 360 };

async function shot(theme, outFull, outBig) {
  const bg = theme === 'dark' ? '#0e1020' : '#f4f5fa';
  const win = new BrowserWindow({
    show: true, width: W, height: H, x: 40, y: 40, backgroundColor: bg,
    webPreferences: { offscreen: false },
  });
  await win.loadFile(path.join(__dirname, 'buddy-shot.html'));
  await win.webContents.executeJavaScript(`document.getElementById('app').dataset.theme='${theme}';document.body.style.background='${bg}';`);
  await sleep(700);
  await win.webContents.executeJavaScript("document.getElementById('pqb-fab').click()");
  await sleep(1000);

  /* 放大一个独立 3D 舞台，方便看建模细节 */
  await win.webContents.executeJavaScript(`(function(){
    var d=document.createElement('div');
    d.id='big'; d.style.cssText='position:fixed;left:440px;top:0;width:340px;height:360px;background:${bg};z-index:99999';
    var c=document.createElement('canvas'); c.style.cssText='width:100%;height:100%;display:block';
    d.appendChild(c); document.body.appendChild(d);
    window.__big = window.PQBuddy3D ? PQBuddy3D.create(c) : null;
    if (window.__big) { window.__big.setRotY(-16); window.__big.setMood('happy'); }
    return !!window.__big;
  })()`);
  await sleep(1400);

  const img = await win.webContents.capturePage();
  fs.writeFileSync(outFull, img.toPNG());
  if (outBig) {
    const img2 = await win.webContents.capturePage({ x: BIG.x, y: BIG.y, width: BIG.w, height: BIG.h });
    fs.writeFileSync(outBig, img2.toPNG());
  }
  win.destroy();
}

app.whenReady().then(async () => {
  const dir = path.join(__dirname, '..', '.workbuddy');
  fs.mkdirSync(dir, { recursive: true });
  /* 一个进程只截一套：同进程第二次 loadFile 会 ERR_FAILED，保险起见按参数跑 */
  const light = process.argv.includes('light');
  const theme = light ? 'light' : 'dark';
  const full = path.join(dir, light ? 'buddy-light.png' : 'buddy-dark.png');
  const big = path.join(dir, light ? 'buddy3d-light.png' : 'buddy3d-dark.png');
  await shot(theme, full, big);
  console.log('SHOT-OK', theme);
  app.exit(0);
}).catch((e) => { console.error('SHOT-FAIL', e && e.message); app.exit(1); });
