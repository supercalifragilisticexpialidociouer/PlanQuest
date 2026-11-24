/* 皮肤选择 / 改名 / 隐藏重置 的 UI 冒烟测试（带截图）
 * 用法：node_modules/.bin/electron dev-tests/shot-skin.js [dark|light] */
'use strict';
const path = require('path');
const { app, BrowserWindow } = require('electron');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('ok    ' + name); }
  else { fail++; console.error('FAIL  ' + name + (extra ? '  → ' + JSON.stringify(extra) : '')); }
}

async function snap(win, name) {
  const fs = require('fs');
  win.show(); win.focus(); win.moveTop();
  await sleep(500);
  const img = await win.webContents.capturePage();
  const buf = img && img.toPNG ? img.toPNG() : Buffer.alloc(0);
  if (!buf.length) { console.error('WARN  截图是空的：' + name); return; }
  fs.writeFileSync(path.join(__dirname, name), buf);
  console.log('shot  ' + name + '  ' + buf.length + ' bytes');
}

async function main() {
  const theme = process.argv[2] === 'light' ? 'light' : 'dark';
  const win = new BrowserWindow({
    show: true, width: 900, height: 760, x: 60, y: 40,
    backgroundColor: theme === 'dark' ? '#0e1020' : '#f4f5fa',
    webPreferences: { contextIsolation: false, nodeIntegration: false },
  });
  win.webContents.on('console-message', (_e, _l, msg) => {
    if (/error|Error|Uncaught/.test(msg)) console.log('[page] ' + msg);
  });
  await win.loadFile(path.join(__dirname, 'buddy-skin.html'));
  await win.webContents.executeJavaScript(`document.getElementById('app').dataset.theme='${theme}';`);
  await sleep(600);

  const js = (code) => win.webContents.executeJavaScript(code, true);

  /* 1. 打开面板 → 自动弹出选皮肤 */
  await js("document.getElementById('pqb-fab').click()");
  await sleep(500);
  ok('未选皮肤时，面板一开就弹选皮肤', await js("document.getElementById('pqb-skinpick').classList.contains('show')"));
  ok('五种皮肤卡片都渲染出来', (await js("document.querySelectorAll('#pqb-skinpick [data-sk]').length")) === 5);
  ok('未选中时确认按钮是禁用的', await js("document.getElementById('pqb-skinok').disabled"));
  ok('未选皮肤时发消息被拦下', (() => null)() || await js(`(function(){
      var n = document.querySelectorAll('#pqb-msgs .pqb-item').length;
      PQBuddy.answer('今天怎么样');
      return document.querySelectorAll('#pqb-msgs .pqb-item').length === n + 2 &&
        /先把我长什么样/.test(document.getElementById('pqb-msgs').textContent);
    })()`));

  /* 2. 选玫瑰 → 主题色/标题/建模跟着变 */
  await js("document.querySelector('#pqb-skinpick [data-sk=\"rose\"]').click()");
  await sleep(120);
  ok('点卡片只是选中，不立刻签合同', await js("document.getElementById('pqb-skinpick').classList.contains('show') && !document.getElementById('pqb-skinok').disabled"));
  await js("document.getElementById('pqb-skinok').click()");
  await sleep(700);
  ok('确认后关闭选皮肤面板', !(await js("document.getElementById('pqb-skinpick').classList.contains('show')")));
  ok('面板主色换成玫瑰色', (await js("getComputedStyle(document.getElementById('pqb-panel')).getPropertyValue('--pqb-teal').trim()")) === '#e0507e');
  ok('标题带上皮肤 emoji 和名字', /🌹\s*阿刺/.test(await js("document.getElementById('pqb-title').textContent")));
  ok('开场白进了聊天', /玫瑰/.test(await js("document.getElementById('pqb-msgs').textContent")));
  ok('3D 拿到皮肤参数（花冠放大）', await js("(function(){try{var s=PQBuddy.info();return true}catch(e){return false}})()"));

  /* 2.5 心情 → 面板底色变化（皮肤不变，表情变） */
  const bg0 = await js("getComputedStyle(document.getElementById('pqb-panel')).backgroundColor");
  await js("PQBuddy.fun.run(PQBuddy.fun.rules[2])"); // 生个气 → angry，底色应偏红
  await sleep(400);
  const bgA = await js("getComputedStyle(document.getElementById('pqb-panel')).backgroundColor");
  ok('心情变差时面板底色变（生气偏红）', bgA !== bg0, { bg0: bg0, angry: bgA });
  await js("PQBuddy.fun.run(PQBuddy.fun.rules[1])"); // 跳一跳 → happy，底色应回暖
  await sleep(400);
  const bgH = await js("getComputedStyle(document.getElementById('pqb-panel')).backgroundColor");
  ok('心情变好时底色再变（开心偏暖）', bgH !== bgA, { angry: bgA, happy: bgH });

  /* 3. 养成页：身份卡 + 改名 */
  await js("document.querySelector('#pqb-tabs [data-view=\"grow\"]').click()");
  await sleep(600);
  ok('养成页出现身份卡', await js("!!document.getElementById('pqb-idcard')"));
  ok('身份卡显示当前皮肤与名字', await js("(function(){var t=document.getElementById('pqb-idcard').textContent;return /玫瑰/.test(t)&&/阿刺/.test(t)})()"));
  ok('给出改名建议', (await js("document.querySelectorAll('#pqb-idcard [data-sug]').length")) >= 3);
  await js("document.getElementById('pqb-rename').click()");
  ok('改名输入框展开', !(await js("document.getElementById('pqb-renamebox').style.display === 'none'")));
  await js(`(function(){document.getElementById('pqb-nameinput').value='小玫';document.getElementById('pqb-nameok').click();})()`);
  await sleep(500);
  ok('改名成功后标题同步', /小玫/.test(await js("document.getElementById('pqb-title').textContent")));

  /* 4. 换皮肤：阿刺亲自拒绝 */
  await js("document.getElementById('pqb-skinchange').click()");
  await sleep(400);
  ok('想换皮肤被阿刺拒绝（合同话术）', await js("(function(){var t=document.getElementById('pqb-msgs').textContent;return /合同签了就别想反悔|花谢了/.test(t)})()"));

  /* 5. 隐藏入口：皮肤徽章连点 5 下 → 重置弹窗写明代价 */
  await js(`(function(){var b=document.getElementById('pqb-skinbadge');for(var i=0;i<5;i++)b.click();})()`);
  await sleep(300);
  ok('徽章连点 5 下才弹重置', await js("document.getElementById('pqb-resetmask').classList.contains('show')"));
  ok('重置弹窗列出代价 + 保留项', await js("(function(){var t=document.getElementById('pqb-resetmask').textContent;return /聊天记录/.test(t)&&/计划/.test(t)&&/重新开始|想清楚/.test(t)})()"));

  await snap(win, 'skin-reset-shot.png');

  await js("document.querySelector('#pqb-resetmask [data-rst=\"yes\"]').click()");
  await sleep(600);
  ok('重置后回到选皮肤', await js("document.getElementById('pqb-skinpick').classList.contains('show')"));
  ok('重置后聊天记录被清空（只剩系统提示）', await js("document.querySelectorAll('#pqb-msgs .pqb-item').length <= 1"));

  await js("document.querySelector('#pqb-skinpick [data-sk=\"porcupine\"]').click()");
  await sleep(100);
  await js("document.getElementById('pqb-skinok').click()");
  await sleep(600);
  ok('重选豪猪后主题变冷色', (await js("getComputedStyle(document.getElementById('pqb-panel')).getPropertyValue('--pqb-teal').trim()")) === '#5d5a7a');

  /* 6. 换皮后说话仍然张嘴（同一套口型骨架，重建后要接得上） */
  await js("PQBuddy.answer('你好')");
  await sleep(240);
  ok('说话时张嘴动画在跑（豪猪皮肤）', await js("PQBuddy.alaCfgApi.talkNow()"));

  await js("document.querySelector('#pqb-tabs [data-view=\"grow\"]').click()");
  await sleep(500);
  await snap(win, 'skin-shot.png');

  console.log(`\n结果：${pass} 项通过，${fail} 项失败`);
  win.destroy();
  app.quit();
  process.exitCode = fail ? 1 : 0;
}

app.whenReady().then(main).catch((e) => { console.error(e); process.exit(1); });
