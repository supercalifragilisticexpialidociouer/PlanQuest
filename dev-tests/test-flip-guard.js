'use strict';
/* 翻案风控（FlipGuard）回归测试
   覆盖：信用分档位/名额、15 秒冷却、同条 24h 一次、本地垃圾过滤、
        行为不一致降权进候选池、冷静期二次确认、相似佐证、隐式反馈回滚、审计与去毒。
   运行：node dev-tests/test-flip-guard.js
*/
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

const RealDate = Date;
let NOW = RealDate.now();
class FakeDate extends RealDate {
  constructor(...a) {
    if (!a.length) super(NOW);
    else super(...a);
  }
  static now() {
    return NOW;
  }
}

const store = {};
const ctx = {
  console,
  Date: FakeDate,
  localStorage: {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => {
      store[k] = v;
    },
    removeItem: (k) => {
      delete store[k];
    },
  },
};
ctx.window = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync('web/flip-guard.js', 'utf8'), ctx);
const FG = ctx.window.FlipGuard;
assert.ok(FG, 'FlipGuard 未挂到 window');

/* 新号保护：首日最高「普通」、三日內最高「良好」 */
FG.setContext({ score: 130 });
assert.strictEqual(FG.status().tier, '普通', '首日高信用也只能到「普通」');
NOW += 2 * 86400000;
assert.strictEqual(FG.status().tier, '良好', '三日内最高「良好」');
NOW += 3 * 86400000; // 距首次使用 5 天：仍在新手期（7 天）内
/* 后面的用例都是「老号」口径，先把时间推过新手期，单独的新手期用例放在最后 */
NOW += 3 * 86400000;
assert.strictEqual(FG.status().rookie, false, '距首次使用 8 天，已过新手期');

let pass = 0;
const ok = (name, fn) => {
  fn();
  pass++;
  console.log('  ✓ ' + name);
};

/* 1. 信用分 → 档位 / 名额 / 权重 */
ok('信用分分档（受限 2 / 普通 5 / 良好 10 / 可信 20）', () => {
  FG.setContext({ score: 70 });
  let s = FG.status();
  assert.strictEqual(s.tier, '受限');
  assert.strictEqual(s.quota, 2);
  assert.strictEqual(s.weight, 0.2);

  FG.setContext({ score: 90 });
  s = FG.status();
  assert.strictEqual(s.tier, '普通');
  assert.strictEqual(s.quota, 5);
  assert.strictEqual(s.direct, false);

  FG.setContext({ score: 105 });
  s = FG.status();
  assert.strictEqual(s.tier, '良好');
  assert.strictEqual(s.quota, 10);
  assert.strictEqual(s.direct, true);

  FG.setContext({ score: 130 });
  s = FG.status();
  assert.strictEqual(s.tier, '可信');
  assert.strictEqual(s.quota, 20);
  assert.strictEqual(s.weight, 1);
});

/* 2. 必须选合法理由 */
ok('不给理由 / 乱填理由 → 拒绝', () => {
  FG.setContext({ score: 100, fishRatio: 0 });
  NOW += 60000;
  assert.strictEqual(FG.request({ kind: 'text', text: '今天做了三套题', from: 1, to: 0 }).code, 'reason');
  assert.strictEqual(FG.request({ kind: 'text', text: '今天做了三套题', from: 1, to: 0, reason: '随便' }).code, 'reason');
});

/* 3. 垃圾/广告先在本地拦掉，且不消耗名额 */
ok('广告 / 纯表情 / 太短 → blocked，且不占名额', () => {
  FG.setContext({ score: 130, fishRatio: 0 });
  NOW += 20000;
  const before = FG.status().used;
  assert.strictEqual(FG.request({ kind: 'text', text: '加微信 vx123 日赚500', from: 1, to: 0, reason: 'AI 误判' }).code, 'blocked');
  assert.strictEqual(FG.request({ kind: 'text', text: '😀😀', from: 1, to: 0, reason: 'AI 误判' }).code, 'blocked');
  assert.strictEqual(FG.request({ kind: 'text', text: '好', from: 1, to: 0, reason: 'AI 误判' }).code, 'blocked');
  assert.strictEqual(FG.status().used, before, '被拦下的请求不能消耗名额');
});

/* 4. 15 秒冷却 */
ok('15 秒冷却：连点第二次被挡', () => {
  FG.resetAll();
  FG.setContext({ score: 130, fishRatio: 0 });
  NOW += 60000;
  const a = FG.request({ kind: 'text', text: '我在推导公式', from: 1, to: 0, reason: 'AI 误判' });
  assert.strictEqual(a.ok, true);
  const b = FG.request({ kind: 'text', text: '另一句完全不一样的内容', from: 1, to: 0, reason: 'AI 误判' });
  assert.strictEqual(b.code, 'cooldown');
});

/* 5. 同一句 24h 只能翻一次 */
ok('同一条消息 24h 内只允许翻一次', () => {
  NOW += 20000;
  const dup = FG.request({ kind: 'text', text: '我在推导公式', from: 1, to: 0, reason: 'AI 误判' });
  assert.strictEqual(dup.code, 'dupe');
});

/* 6. 高信誉 + 行为一致 → 直接采纳 */
ok('可信 + 行为一致 → direct 直接进训练集', () => {
  FG.resetAll();
  FG.setContext({ score: 130, fishRatio: 0.1 });
  NOW += 60000;
  const r = FG.request({ kind: 'text', text: '刚看完一章线性代数', from: 1, to: 0, reason: 'AI 误判' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.status, 'direct');
  assert.strictEqual(r.weight, 1);
});

/* 7. 行为不一致 → 强制候选池 + 权重 0.3 倍 */
ok('历史 80% 是闲聊还标「正经事」→ 降权 ×0.3 且强制 pending', () => {
  FG.resetAll();
  FG.setContext({ score: 130, fishRatio: 0.9 });
  NOW += 60000;
  const r = FG.request({ kind: 'text', text: '我其实一直在学习别冤枉我', from: 1, to: 0, reason: 'AI 误判' });
  assert.strictEqual(r.status, 'pending');
  assert.strictEqual(r.inconsistent, true);
  assert.ok(Math.abs(r.weight - 0.3) < 1e-6, '权重应为 0.3');
});

/* 8. 候选池：冷静期未过不能确认；过了（或已有相似佐证）才能转正 */
ok('候选池：冷静期 30 分钟 + 二次确认 / 相似佐证', () => {
  FG.resetAll();
  FG.setContext({ score: 90, fishRatio: 0.1 }); // 普通用户 → 只能进候选池
  NOW += 60000;
  const r1 = FG.request({ kind: 'text', text: '这道题我在草稿纸上推的', from: 1, to: 0, reason: '上下文误解' });
  assert.strictEqual(r1.status, 'pending');
  assert.strictEqual(FG.confirm(r1.flip.id).ok, false, '冷静期未过且无佐证 → 不能确认');

  /* 相似内容的第二条同向翻案 → 佐证出现，立刻可确认 */
  NOW += 20000;
  const r2 = FG.request({ kind: 'text', text: '这道题我在草稿纸上推导', from: 1, to: 0, reason: '上下文误解' });
  assert.strictEqual(r2.status, 'pending');
  const c2 = FG.confirm(r2.flip.id);
  assert.strictEqual(c2.ok, true, '有相似佐证应可确认');
  assert.strictEqual(c2.via, 'peer');

  /* 冷静期满 30 分钟 → 自审二次确认 */
  NOW += 31 * 60000;
  const c1 = FG.confirm(r1.flip.id);
  assert.strictEqual(c1.ok, true);
  /* 此时既过冷静期、又有相似佐证：按 房间>佐证>冷静 的优先级命中 peer */
  assert.ok(c1.via === 'cool' || c1.via === 'peer');
});

/* 9. 名额用完 → 锁到次日 */
ok('日名额用完 → 锁定到次日', () => {
  FG.resetAll();
  FG.setContext({ score: 70, fishRatio: 0 }); // 受限：2 次/天
  const texts = ['第一个理由内容', '第二个理由内容', '第三个理由内容'];
  for (let i = 0; i < 2; i++) {
    NOW += 20000;
    const r = FG.request({ kind: 'text', text: texts[i], from: 1, to: 0, reason: 'AI 误判' });
    assert.strictEqual(r.ok, true, '第 ' + (i + 1) + ' 次应该成功');
  }
  NOW += 20000;
  const r3 = FG.request({ kind: 'text', text: texts[2], from: 1, to: 0, reason: 'AI 误判' });
  assert.strictEqual(r3.code, 'quota');
  assert.strictEqual(FG.status().locked, true);
});

/* 10. 失信期不能翻案 */
ok('信用失信期（blockUntil）内拒绝翻案', () => {
  FG.resetAll();
  FG.setContext({ score: 100, blockUntil: NOW + 86400000, fishRatio: 0 });
  NOW += 20000;
  const r = FG.request({ kind: 'text', text: '一句正常的话', from: 1, to: 0, reason: 'AI 误判' });
  assert.strictEqual(r.code, 'credit');
});

/* 11. 隐式反馈：翻案后 10 分钟内连续 3 次闲聊 → 回滚 + 扣分 */
ok('隐式反馈：翻案后又被判 3 次闲聊 → 自动回滚并扣信用分', () => {
  FG.resetAll();
  FG.setContext({ score: 130, blockUntil: 0, fishRatio: 0 });
  NOW += 60000;
  const r = FG.request({ kind: 'text', text: '我在认真看网课', from: 1, to: 0, reason: 'AI 误判' });
  assert.strictEqual(r.status, 'direct');
  FG.attachSample(r.flip.id, 'sample-1');

  assert.strictEqual(FG.onFishEvidence().rolled, 0);
  assert.strictEqual(FG.onFishEvidence().rolled, 0);
  const ev = FG.onFishEvidence();
  assert.strictEqual(ev.rolled, 1, '第三次证据应触发回滚');
  assert.strictEqual(JSON.stringify(ev.sampleIds), JSON.stringify(['sample-1']));
  assert.strictEqual(ev.penalty, 5);
  const st = FG.status();
  assert.strictEqual(st.rolledback, 1);
  assert.strictEqual(st.penaltiesToday, 1);
});

/* 12. 审计 / 去毒 */
ok('审计可查、已回滚记录可清理', () => {
  const log = FG.audit(10);
  assert.ok(log.length >= 1);
  assert.ok(log.some((x) => x.status === 'rollback'));
  const p = FG.purgeRolledBack();
  assert.ok(p.removed >= 1);
  assert.strictEqual(FG.status().rolledback, 0);
});

/* 13. 训练集隔离：pending / rollback 不进训练、不上传（源码口径） */
ok('训练集隔离：ai-train 只吃 direct/confirmed', () => {
  const src = fs.readFileSync('web/ai-train.js', 'utf8');
  assert.ok(/function trainable\(s\)/.test(src), '应有 trainable 过滤');
  assert.ok(/s\.kind === 'text' && s\.text && trainable\(s\)/.test(src), '文字训练需过滤');
  assert.ok(/isFinite\(s\.d\) && trainable\(s\)/.test(src), '画面训练需过滤');
  assert.ok(/!s\.up && trainable\(s\)/.test(src), '云端上传需过滤');
  assert.ok(/setSampleStatus/.test(src), '应提供状态回写');
});

/* 14. 众包：房间公投（取多数） */
ok('房间公投：≥1 位同学认可即可转正；2 人否决自动作废；同一人只能投一次', () => {
  FG.resetAll();
  FG.setContext({ score: 90, fishRatio: 0.1 }); // 普通 → 只能候选
  NOW += 60000;
  const a = FG.request({ kind: 'text', text: '我在抄写单词本', from: 1, to: 0, reason: 'AI 误判' });
  assert.strictEqual(a.status, 'pending');

  /* 冷静期未过、也没有相似佐证时，只靠公投 */
  assert.strictEqual(FG.confirm(a.flip.id).ok, false);
  const v1 = FG.addPeerVote(a.flip.id, 'm-2', true);
  assert.strictEqual(v1.ok, true);
  assert.strictEqual(v1.yes, 1);
  assert.strictEqual(FG.addPeerVote(a.flip.id, 'm-2', true).ok, false, '同一人不能重复投票');
  const c = FG.confirm(a.flip.id);
  assert.strictEqual(c.ok, true);
  assert.strictEqual(c.via, 'room');

  /* 另一条：两个人不认可 → 自动回滚（取多数） */
  NOW += 30000;
  const b = FG.request({ kind: 'text', text: '刚在整理错题本', from: 1, to: 0, reason: '上下文误解' });
  assert.strictEqual(b.status, 'pending');
  assert.strictEqual(FG.addPeerVote(b.flip.id, 'm-3', false).status, 'pending');
  const r2 = FG.addPeerVote(b.flip.id, 'm-4', false);
  assert.strictEqual(r2.status, 'rollback', '两票否决应直接作废');
});

/* 15. 新手期：前 7 天翻的案不进训练池 */
ok('新手期：前 7 天翻案记 probation、不进训练集；满 7 天后恢复 direct', () => {
  /* 换一份干净存储，模拟全新安装（firstAt = 现在） */
  const s2 = {};
  const c2 = {
    console,
    Date: FakeDate,
    localStorage: {
      getItem: (k) => (k in s2 ? s2[k] : null),
      setItem: (k, v) => {
        s2[k] = v;
      },
      removeItem: (k) => {
        delete s2[k];
      },
    },
  };
  c2.window = c2;
  vm.createContext(c2);
  vm.runInContext(fs.readFileSync('web/flip-guard.js', 'utf8'), c2);
  const F2 = c2.window.FlipGuard;

  F2.setContext({ score: 130, fishRatio: 0.1 });
  assert.strictEqual(F2.isRookie(), true, '全新安装应在新手期');
  assert.strictEqual(F2.status().rookieLeft, 7, '首日应剩 7 天');

  /* 第 2 天：信用 130 本可直接采纳，但新手期样本只进观察 —— 改判照旧生效 */
  NOW += 2 * 86400000;
  const a = F2.request({ kind: 'text', text: '在整理错题本，别打断', from: 1, to: 0, reason: 'AI 误判' });
  assert.strictEqual(a.ok, true);
  assert.strictEqual(a.direct, true, '改判本身照旧生效');
  assert.strictEqual(a.status, 'probation', '新手期直接采纳 → 观察集');
  assert.strictEqual(a.rookie, true);
  assert.strictEqual(F2.status().probation, 1, '观察样本应计数');

  /* 新手期的候选翻案：复核通过也只进观察，不因「确认过」就混进训练池 */
  NOW += 30000;
  F2.setContext({ score: 90, fishRatio: 0.1 }); // 普通档 → 只能进候选池
  const b = F2.request({ kind: 'text', text: '刚在背单词', from: 1, to: 0, reason: '上下文误解' });
  assert.strictEqual(b.status, 'pending');
  assert.strictEqual(F2.confirm(b.flip.id).ok, false, '冷静期未到不能确认');
  F2.addPeerVote(b.flip.id, 'peer-1', true);
  const cb = F2.confirm(b.flip.id);
  assert.strictEqual(cb.ok, true);
  assert.strictEqual(cb.status, 'probation', '新手期复核通过也进观察集');
  assert.strictEqual(cb.rookie, true);

  /* 满 7 天后：同样信用档位恢复 direct，正常进训练集 */
  NOW += 6 * 86400000;
  assert.strictEqual(F2.isRookie(), false, '第 8 天已过新手期');
  F2.setContext({ score: 130, fishRatio: 0.1 });
  const c = F2.request({ kind: 'text', text: '这段代码我在调试', from: 1, to: 0, reason: 'AI 误判' });
  assert.strictEqual(c.status, 'direct', '过了新手期恢复直接采纳');
  assert.strictEqual(c.rookie, false);

  /* 训练/上传侧口径：probation 不在 trainable 白名单里 */
  const src = fs.readFileSync('web/ai-train.js', 'utf8');
  assert.ok(/probation/.test(src), 'ai-train 应识别观察集');
  const body = /function trainable\(s\)[\s\S]*?\n  }/.exec(src)[0];
  assert.ok(!/probation/.test(body), 'trainable 不应放行 probation');
  assert.ok(/status === 'direct'/.test(body) && /status === 'confirmed'/.test(body), 'trainable 只认 direct/confirmed');
});

console.log('\n结果：' + pass + ' 项全部通过');
process.exit(0);
