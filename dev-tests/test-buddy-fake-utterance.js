/* 回归：阿刺面板不许伪造用户发言
 * 背景：曾有点开面板（红点亮时）自动 answer('我不太想动') 的调试遗留，
 *       它会 pushMsg('me','我不太想动')，再让闲聊雷达对着这句程序自己编的
 *       话判摸鱼 99%，阿刺跟着"顺嘴一提" —— 看着就像用户没说话它自言自语。
 * 用法：env -u ELECTRON_RUN_AS_NODE npx electron dev-tests/test-buddy-fake-utterance.js
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false, width: 820, height: 720,
    webPreferences: { offscreen: true },
  });
  let pass = 0, fail = 0;
  const ok = (name, cond) => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name); } };

  try {
    await win.loadFile(path.join(__dirname, 'buddy-shot.html'));
    await sleep(500);

    /* 1. 静态断言：源码里不能再有伪造的那句 */
    const src = fs.readFileSync(path.join(__dirname, '..', 'web', 'buddy.js'), 'utf8');
    ok('源码无伪造发言 answer(我不太想动)', !/answer\(\s*['"]我不太想动['"]\s*\)/.test(src));

    /* 2. 模拟 red 亮起（面板关着时来一条真实提醒），再点开浮标 */
    const res = await win.webContents.executeJavaScript(`(async () => {
      var fab = document.getElementById('pqb-fab');
      var badge = fab && fab.querySelector('.pqb-badge');
      var msgs = document.getElementById('pqb-msgs');
      /* 收件箱先清空，只留下测试要放进去的一条真实提醒 */
      if (msgs) msgs.innerHTML = '';
      /* 面板应该是关着的 */
      var panel = document.getElementById('pqb-panel');
      var wasOpen = panel && (panel.style.display === 'flex' || panel.classList.contains('on'));
      /* 亮红点 + 放一条真实的 bud 提醒（模拟 scold/nudge 已 pushMsg） */
      if (badge) badge.style.display = 'block';
      var realNote = document.createElement('div');
      realNote.className = 'pqb-m bud';
      realNote.textContent = '⚠️ 测试用真实提醒';
      if (msgs) msgs.appendChild(realNote);
      /* 点开面板 */
      if (fab) fab.click();
      await new Promise(function (r) { setTimeout(r, 600); });
      var text = msgs ? msgs.textContent : '';
      return {
        wasOpen: !!wasOpen,
        badgeAfter: badge ? (badge.style.display || 'none') : 'no-badge',
        hasFake: text.indexOf('我不太想动') >= 0,
        hasReal: text.indexOf('测试用真实提醒') >= 0,
        meCount: document.querySelectorAll('#pqb-msgs .pqb-m.me').length,
        text: text.slice(0, 400),
      };
    })()`);

    ok('点开前 badge 是亮的（测试前置）', !res.wasOpen);
    ok('点开后无伪造的「我不太想动」', !res.hasFake);
    ok('点开后 me 气泡数量为 0（未冒充用户）', res.meCount === 0);
    ok('点开后真实提醒仍在', res.hasReal);
    ok('点开后红点被清掉', res.badgeAfter === 'none' || res.badgeAfter === '');

    console.log('\n面板文字片段：' + res.text.replace(/\s+/g, ' '));
  } catch (e) {
    fail++;
    console.error('  ✗ 异常：', e && e.message);
  }

  console.log('\n结果：' + pass + ' 项通过，' + fail + ' 项失败');
  win.destroy();
  app.exit(fail ? 1 : 0);
}).catch((e) => { console.error('BOOT-FAIL', e && e.message); app.exit(1); });
