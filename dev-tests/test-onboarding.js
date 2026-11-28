/* test-onboarding.js —— 新手引导状态机单测（纯逻辑，无 DOM） */
const assert = require('assert');
const G = require('../src/onboarding');

let pass = 0, total = 0;
function t(name, fn) {
  total++;
  try { fn(); pass++; console.log('  PASS ' + name); }
  catch (e) { console.log('  FAIL ' + name + ' -> ' + e.message); }
}

console.log('=== 新手引导状态机 ===');

t('步骤表 6 步且 id 唯一', () => {
  assert.strictEqual(G.count, 6);
  const ids = G.STEPS.map((s) => s.id);
  assert.strictEqual(new Set(ids).size, ids.length);
  assert.ok(ids.includes('welcome') && ids.includes('nav') && ids.includes('buddy') && ids.includes('settings'));
});

t('每步都有标题与文字（箭头引导要有内容）', () => {
  G.STEPS.forEach((s) => {
    assert.ok(s.title && s.title.length > 0, s.id + ' 缺标题');
    assert.ok(s.text && s.text.length > 8, s.id + ' 缺说明文字');
  });
});

t('首次判定：guideDone 缺失或 false 显示，true 隐藏', () => {
  assert.strictEqual(G.shouldShow(undefined), true);
  assert.strictEqual(G.shouldShow({}), true);
  assert.strictEqual(G.shouldShow({ guideDone: false }), true);
  assert.strictEqual(G.shouldShow({ guideDone: true }), false);
});

t('步骤索引回绕与边界', () => {
  assert.strictEqual(G.stepAt(0).id, 'welcome');
  assert.strictEqual(G.stepAt(G.count).id, 'welcome'); // 回绕
  assert.strictEqual(G.stepAt(-1).id, G.STEPS[G.count - 1].id);
  assert.strictEqual(G.prevIndex(0), 0); // 第一步上一步不越界
  assert.strictEqual(G.prevIndex(3), 2);
  assert.strictEqual(G.nextIndex(0), 1);
  assert.strictEqual(G.nextIndex(G.count - 1), -1); // 走完
});

t('居中步骤：welcome 无高亮块、箭头 none', () => {
  const pos = G.place(null, { w: 1200, h: 800 }, { w: 340, h: 178 }, 'center');
  assert.strictEqual(pos.arrow, 'none');
  assert.strictEqual(pos.highlight, null);
  assert.ok(pos.left > 0 && pos.top > 0);
});

t('右侧有空间：气泡放右边，箭头向左指', () => {
  const pos = G.place({ left: 80, top: 200, width: 200, height: 300 }, { w: 1200, h: 800 }, { w: 340, h: 178 }, 'right');
  assert.strictEqual(pos.arrow, 'left');
  assert.ok(pos.left >= 80 + 200, '气泡应在高亮块右侧');
  assert.ok(pos.highlight && pos.highlight.width === 210);
});

t('右侧空间不足：自动翻到左边，箭头向右指', () => {
  const pos = G.place({ left: 1000, top: 200, width: 150, height: 200 }, { w: 1200, h: 800 }, { w: 340, h: 178 }, 'right');
  assert.strictEqual(pos.arrow, 'right');
  assert.ok(pos.left + 340 <= 1200, '气泡不能超出视口');
});

t('上下贴边：气泡被钳在视口内', () => {
  const pos = G.place({ left: 500, top: 10, width: 120, height: 40 }, { w: 1000, h: 700 }, { w: 340, h: 178 }, 'bottom');
  assert.ok(pos.top >= 14 && pos.top + 178 <= 700 - 14, '气泡纵向不能出视口');
  assert.ok(['up', 'down', 'none'].includes(pos.arrow));
});

t('小窗口：气泡宽度自适应且不出界', () => {
  const pos = G.place(null, { w: 320, h: 480 }, { w: 340, h: 178 }, 'center');
  assert.ok(pos.left >= 0 && pos.left <= 320);
});

console.log('\n结果：' + pass + '/' + total + ' 项通过' + (pass === total ? ' ✅' : ' ❌'));
process.exit(pass === total ? 0 : 1);
