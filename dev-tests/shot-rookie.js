/* 截图 + 实机断言：新手期（前 7 天）翻案不进训练池
   做法：把首次使用时间改到 3 天前（信用 130 → 本该 direct），重新加载后提交一条翻案，
   看它是否落到 probation、训练面板是否只说「观察」。
   运行：npx electron dev-tests/shot-rookie.js */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const root = path.join(__dirname, '..');
const out = path.join(__dirname, 'shot-rookie.png');
const INDEX = path.join(root, 'web', 'index.html');

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1080, height: 1100, show: false, webPreferences: { partition: 'pqr' + Date.now() } });

  /* 第一次加载：只为了能写 localStorage；写完再真正加载一次，让 FlipGuard 读到 3 天前 */
  await win.loadFile(INDEX);
  await new Promise((r) => setTimeout(r, 900));
  await win.webContents.executeJavaScript(`
    localStorage.setItem('pq-flip-guard-v1', JSON.stringify({
      v: 1, firstAt: Date.now() - 3 * 86400000, flips: [],
      day: { date: '', n: 0 }, lockUntil: 0, pen: { date: '', n: 0 }
    }));
    'ok'
  `);
  await win.loadFile(INDEX);
  await new Promise((r) => setTimeout(r, 3200));

  const probe = await win.webContents.executeJavaScript(`
    (function () {
      if (!window.FlipGuard) return JSON.stringify({ err: 'FlipGuard 未加载' });
      FlipGuard.setContext({ score: 130, fishRatio: 0.1 });
      var st0 = FlipGuard.status();
      var g = FlipGuard.request({ kind: 'text', text: '在整理错题本，别打断我', from: 1, to: 0, reason: 'AI 误判' });
      if (g.ok && window.AITrain) {
        var s = AITrain.addTextSample('在整理错题本，别打断我', 0, '聊天纠错', { status: g.status, weight: g.weight });
        FlipGuard.attachSample(g.flip.id, s && s.id);
      }
      var c = window.AITrain ? AITrain.counts() : null;
      window.__robe = {
        st0: { rookie: st0.rookie, left: st0.rookieLeft, days: st0.days, tier: st0.tier },
        g: { ok: g.ok, status: g.status, direct: g.direct, rookie: g.rookie, message: g.message },
        c: c ? { text: c.text, probation: c.probation, trainable: c.trainable } : null
      };
      return JSON.stringify(window.__robe);
    })()
  `);
  console.log('probe=', probe);

  /* 页面启动后的首次渲染可能把我们塞的内容冲掉，所以等它稳定后再画一次，紧接着截图 */
  await new Promise((r) => setTimeout(r, 1500));
  await win.webContents.executeJavaScript(`
    (function () {
      var p = window.__robe, g = p.g, c = p.c || {};
      var old = document.getElementById('robe-overlay');
      if (old) old.remove();
      var box = document.createElement('div');
      box.id = 'robe-overlay';
      box.setAttribute('data-theme', 'dark');
      box.style.cssText = 'position:fixed;inset:0;z-index:99999;overflow:auto;background:#0b0f1a;padding:26px 0';
      box.innerHTML =
        '<div id="app" data-theme="dark" style="max-width:960px;margin:0 auto;padding:0 16px;position:relative">' +
        '<div class="panel" style="margin-bottom:16px"><h3>新手期翻案 · 实机结果</h3>' +
        '<div class="sd" style="line-height:1.9">' +
        '首次使用：3 天前 · 信用 130（本该按「可信」直接采纳）<br/>' +
        '翻案返回：<b>status = ' + g.status + '</b> · direct = ' + g.direct + ' · rookie = ' + g.rookie + '<br/>' +
        '提示语：' + g.message + '<br/>' +
        '样本：文字 ' + (c.text || 0) + ' 条 · 观察 ' + (c.probation || 0) + ' 条 · 可训练 ' + (c.trainable || 0) + ' 条' +
        '</div></div>' + aiTrainPanelHTML() + '</div>';
      document.body.appendChild(box);
      return 'drawn';
    })()
  `);
  await new Promise((r) => setTimeout(r, 400));
  /* app 可能还在重绘，截图前再挂一次（幂等），并回报是否还在 */
  const still = await win.webContents.executeJavaScript(`
    (function () {
      var el = document.getElementById('robe-overlay');
      if (!el) return 'GONE';
      return 'OK ' + el.getBoundingClientRect().width + 'x' + el.getBoundingClientRect().height + ' text=' + el.innerText.length;
    })()
  `);
  console.log('overlay=', still);
  win.show();
  win.focus();
  await new Promise((r) => setTimeout(r, 900));
  const img = await win.capturePage();
  fs.writeFileSync(out, img.toPNG());
  console.log('saved', out);
  app.quit();
});
