/* 冒烟：改名 / 换皮肤必须「通过聊天交互请求」
 * 用法：electron dev-tests/test-identity-chat.js
 * 断言：
 *   1 意图解析：改名（带名字 / 不带名字）、换皮肤、换成某皮肤，表情指令不误伤
 *   2 面板身份卡不再有「直接改名」的输入框 / 提交按钮
 *   3 点身份卡按钮 = 在聊天里开口：留下用户消息 + 阿刺在聊天里回一句
 *   4 换皮肤永远拒绝，且拒绝台词出现在聊天里（不是角落小字）
 *   5 「✏ 在聊天里改名」把聊天输入框预填成开口前缀，不直接改数据
 */
'use strict';
const path = require('path');
const assert = require('assert');
const { app, BrowserWindow } = require('electron');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
function ok(name, fn) {
  try {
    fn();
    pass += 1;
    console.log('  ✓ ' + name);
  } catch (e) {
    console.error('  ✗ ' + name + '\n    ' + e.message);
    process.exitCode = 1;
  }
}

app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 900, height: 700, webPreferences: { offscreen: false } });
  await win.loadFile(path.join(__dirname, 'identity-chat.html'));
  await sleep(900);
  let r;
  try {
    r = await win.webContents.executeJavaScript('window.__probe()');
  } catch (e) {
    console.error('页面执行失败:', e.message);
    process.exitCode = 1;
    app.quit();
    return;
  }

  if (r && r.error) {
    console.error('页面内错误:\n' + r.error);
    process.exitCode = 1;
    win.destroy();
    app.quit();
    return;
  }

  console.log('\n身份请求：聊天交互冒烟');
  console.log('  [诊断] name=' + r.name + ' renameBtn=' + r.renameBtn + ' inputPrefill=' + JSON.stringify(r.inputPrefill) + ' hasNameForm=' + r.hasNameForm);
  ok('「以后叫你刺头」解析成改名请求', () => {
    assert.strictEqual(r.parse.rename && r.parse.rename.type, 'rename');
    assert.strictEqual(r.parse.rename.payload.name, '刺头');
  });
  ok('「改个名」没带名字 → 阿刺在聊天里追问', () => {
    assert.strictEqual(r.parse.renameAsk && r.parse.renameAsk.type, 'renameNoName');
  });
  ok('「我想给你换个皮肤」解析成换皮肤请求', () => {
    assert.strictEqual(r.parse.skin && r.parse.skin.type, 'skin');
  });
  ok('「我想换成玫瑰」也解析成换皮肤请求', () => {
    assert.strictEqual(r.parse.skinRose && r.parse.skinRose.type, 'skin');
  });
  ok('「改名叫玫瑰」是改名，不是换皮肤', () => {
    assert.strictEqual(r.parse.nameRose && r.parse.nameRose.type, 'rename');
    assert.strictEqual(r.parse.nameRose.payload.name, '玫瑰');
  });
  ok('「跳一跳」不会被身份请求误伤（仍走表情指令）', () => {
    assert.strictEqual(r.parse.fun, null);
  });

  ok('身份卡不再有直接改名的输入框 / 提交按钮', () => {
    assert.strictEqual(r.hasNameForm, false);
  });
  ok('两次请求都留下了「我」的发言（真的走聊天，不是后台静默调用）', () => {
    const me = r.lines.filter((x) => x.who === 'me');
    assert.ok(me.length >= 2, JSON.stringify(r.lines));
    assert.ok(me.some((x) => x.text.includes('换个皮肤')));
    assert.ok(me.some((x) => x.text.includes('刺头')));
  });
  ok('阿刺在聊天里回了两句（有口型、有情绪的那条链路）', () => {
    const bud = r.lines.filter((x) => x.who === 'bud');
    assert.ok(bud.length >= 2, JSON.stringify(r.lines));
  });
  ok('换皮肤收到拒绝，且拒绝台词在聊天里', () => {
    const bud = r.lines.filter((x) => x.who === 'bud').map((x) => x.text).join('\n');
    assert.ok(/反悔|签了|合同|别想|皮肤|选/.test(bud), bud);
  });
  ok('点「在聊天里改名」只是预填聊天输入框，不直接改名', () => {
    assert.ok(/以后叫你/.test(r.inputPrefill), r.inputPrefill);
    /* 名字只有两种可能：没答应仍是阿刺，答应了是刺头（由聊天里那次掷骰子决定），
       但绝不可能由按钮直接写进去 */
    assert.ok(['阿刺', '刺头'].indexOf(r.name) >= 0, r.name);
  });

  console.log(`\n通过 ${pass} 项\n`);
  win.destroy();
  app.quit();
});
