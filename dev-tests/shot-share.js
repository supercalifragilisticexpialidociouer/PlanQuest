const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const outDir = __dirname;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 620,
    height: 980,
    show: true, x: -3000,
    webPreferences: { offscreen: false },
  });
  await win.loadFile(path.join(root, 'web', 'index.html'));
  await new Promise((r) => setTimeout(r, 1500));

  const hasShare = await win.webContents.executeJavaScript('!!window.PQShare');
  console.log('PQShare 已加载:', hasShare);

  if (!hasShare) {
    console.log('FAIL 分享模块未加载');
    app.quit();
    return;
  }

  // 用一组测试数据打开面板（默认全部隐藏）；先放一个别名，验证署名
  await win.webContents.executeJavaScript(`
    localStorage.setItem('pq-share-alias-v1', '阿七');
    localStorage.removeItem('pq-share-inv-v1');
    window.PQShare.open({
      streak: 21, helpWeek: 5, challengeDone: 3, focusMax: 100,
      done: 4, total: 6,
      plans: [
        { title: '晨间阅读 20 页', done: true },
        { title: '核心训练', done: true },
        { title: '背单词 50 个', done: true },
        { title: '写代码 2 小时', done: true },
        { title: '睡前复盘', done: false },
        { title: '练琴 30 分钟', done: false }
      ]
    });
  `);
  await new Promise((r) => setTimeout(r, 600));

  let img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(outDir, 'share-default.png'), img.toPNG());
  console.log('已截图 share-default.png（默认全隐藏）');

  // 勾选：连续 + 助人 + 挑战 + 最长专注 + 计划（打码）
  await win.webContents.executeJavaScript(`
    (function(){
      const keys = ['streak','help','challenge','focus','plans'];
      keys.forEach(k => {
        const el = document.querySelector('.pqs-row input[data-key="'+k+'"]');
        if (el) { el.checked = true; el.dispatchEvent(new Event('change', { bubbles: true })); }
      });
    })();
  `);
  await new Promise((r) => setTimeout(r, 800));

  img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(outDir, 'share-checked.png'), img.toPNG());
  console.log('已截图 share-checked.png（勾选后）');

  // 导出海报本体（不经过面板），单独存一张验证
  const dataUrl = await win.webContents.executeJavaScript(`
    document.querySelector('.pqs-prev canvas').toDataURL('image/png')
  `);
  fs.writeFileSync(path.join(outDir, 'share-poster.png'), Buffer.from(dataUrl.split(',')[1], 'base64'));
  console.log('已导出 share-poster.png');

  app.quit();
}).catch((e) => { console.error('ERR', e); app.quit(); });
