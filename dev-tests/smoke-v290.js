/* v2.9.1 冒烟：好友区三档 / 集体任务 / .pqplan 沙箱 / 闲聊档位 / 申诉表单 */
'use strict';
const target = process.argv[2] || 'http://127.0.0.1:9347';

(async () => {
  const list = await (await fetch(target + '/json/list')).json();
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('no page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  });
  await new Promise((r) => ws.addEventListener('open', r));
  const send = (method, params) =>
    new Promise((res) => {
      const n = ++id;
      pending.set(n, res);
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    const v = r.result && r.result.result;
    return v && v.value !== undefined ? v.value : v && (v.description || v.type);
  };

  let pass = 0, fail = 0;
  const ok = (name, cond) => {
    if (cond) { pass++; console.log('  ✓', name); }
    else { fail++; console.log('  ✗', name); }
  };

  ok('api / PQFriend / PQBuddy / PQLegionTier 都在', await ev(`[typeof window.api, typeof window.PQFriend, typeof window.PQBuddy, typeof window.PQLegionTier].join(',')`) === 'object,object,object,object');
  ok('导航里有「好友」按钮', !!(await ev(`!!document.querySelector('[data-view="friends"]')`)));

  // 切到好友视图（boot 完成前 nav 没绑 click，轮询等首屏出现）
  let friendsReady = false;
  for (let i = 0; i < 10 && !friendsReady; i++) {
    await new Promise((r) => setTimeout(r, 500));
    await ev(`(document.querySelector('[data-view="friends"]')||{}).click ? document.querySelector('[data-view="friends"]').click() : 0; 1`);
    friendsReady = String(await ev(`($('#view h2')||{}).textContent||''`)).includes('好友区');
  }
  ok('好友视图渲染出标题', friendsReady);
  ok('未结缘说明在（防约炮防微商）', String(await ev(`$('#view').textContent`)).includes('防微商'));

  // 结缘（走问答申请 via）→ F1
  const bond = await ev(`window.api.friendBond({ uid:'smoke-u1', alias:'冒烟搭子', via:'gate' })`);
  ok('结缘成功（F1 搭子档）', bond && bond.ok && bond.friend && Number(bond.friend.tier) === 1);
  const st1 = await ev(`window.api.friendState()`);
  ok('friendState 里能看到这位搭子', st1 && st1.friends && !!st1.friends['smoke-u1']);

  // 完成率门禁：我 0%、对方 0% → 拒发
  const blocked = await ev(`window.api.friendSend({ uid:'smoke-u1', text:'在吗', kind:'text' })`);
  ok('完成率 <50% 被拒（先各自干活）', blocked && !blocked.ok && /先各自干活|完成率/.test(blocked.message || ''));

  // 把自己完成率拉上去（写两条已打卡记录走不了 IPC，直接给对方报 100 再看仍拒：我的率还是 0）
  await ev(`window.api.friendPeerRate({ uid:'smoke-u1', rate:100 })`);
  const blocked2 = await ev(`window.api.friendSend({ uid:'smoke-u1', text:'在吗', kind:'text' })`);
  ok('对方 100%、我 0% → 仍拒（两边都要 ≥50%）', blocked2 && !blocked2.ok);

  // F1 权限：text 可以（过了率门槛才行，这里只验证 shot 在 F1 被拒的文案不同）
  const st2 = await ev(`window.api.friendState()`);
  const f = st2.friends['smoke-u1'];
  ok('对方完成率已记账 100', Number(f.peerRate) === 100);

  // 问答申请（提问者自带答案键，全对才放行；答错一次即作废，得重发）
  const gate = await ev(`window.api.friendGateNew({ uid:'smoke-u2', alias:'答题人', questions:[{ q:'你为什么想和我组队？', a:'监督' }] })`);
  ok('问答申请已发出（答案键不透出）', gate && gate.ok && gate.gate && gate.gate.questions[0] && !gate.gate.questions[0].a);
  const ans = await ev(`window.api.friendGateAnswer({ uid:'smoke-u2', answers:['想找个监督 搭子！'] })`);
  ok('答案不匹配 → 不放行且作废', ans && ans.ok && ans.pass === false);
  const GATEUID = 'smk-' + Date.now().toString(36);
  const gate2 = await ev(`window.api.friendGateNew({ uid:'${GATEUID}', alias:'答题人2', questions:[{ q:'你能坚持几天？', a:'三十天' }] })`);
  const ans2 = await ev(`window.api.friendGateAnswer({ uid:'${GATEUID}', answers:['三十天'] })`);
  ok('答案匹配 → 自动结缘', gate2 && gate2.ok && ans2 && ans2.ok && ans2.pass === true);
  const st3 = await ev(`window.api.friendState()`);
  ok('答题人出现在好友列表', !!(st3.friends && st3.friends[GATEUID]));

  // 集体任务：未入军团 → 明确拒绝
  const col = await ev(`window.api.govCollectiveSet({ title:'全员出操', target:90 })`);
  ok('未入军团发集体任务被拒（有提示）', col && !col.ok && /军团|加入/.test(col.message || ''));

  // .pqplan 四件套：预览 → 沙箱 → 转正（先清掉上次冒烟残留的沙箱）
  await ev(`window.api.planSandboxDrop()`);
  const envelope = JSON.stringify({ magic: 'PLANQUEST-PLAN', format: 1, data: { plans: [{ id: 'p-smoke-1', title: '冒烟计划', kind: 'plan', status: 'todo', remind: '08:00' }], logs: [], goals: [], contracts: [], shop: [] } });
  const pv = await ev(`window.api.planPreview({ text: ${JSON.stringify(envelope)}, from:'smoke-u1', fromAlias:'冒烟搭子' })`);
  ok('计划预览出条目与来源标记', pv && pv.ok && pv.preview && pv.preview.items && pv.preview.items.some((x) => /冒烟计划/.test(x.title)) && /冒烟搭子/.test(pv.sourceText || ''));
  const imp = await ev(`window.api.planfileImportText({ text: ${JSON.stringify(envelope)}, from:'smoke-u1', fromAlias:'冒烟搭子' })`);
  ok('导入进 24h 沙箱（不落主计划）', imp && imp.ok && imp.sandboxed === true);
  const sb = await ev(`window.api.planSandbox()`);
  ok('沙箱状态可见（含剩余时间）', sb && sb.ok && sb.present && /小时|分/.test(sb.leftText || ''));
  const promo = await ev(`window.api.planSandboxPromote()`);
  ok('手动转正成功', promo && promo.ok);
  const sb2 = await ev(`window.api.planSandbox()`);
  ok('转正后沙箱清空', sb2 && sb2.ok && !sb2.present);

  // 黑名单：没建团时只有军团长能改 → 未入团时验证「被拒且有提示」，入团后才能真拦
  const ban = await ev(`window.api.planBanToggle({ uid:'smoke-u1', on:true })`);
  if (ban && ban.ok) {
    ok('计划文件黑名单可设置', true);
    const banned = await ev(`window.api.planPreview({ text: ${JSON.stringify(envelope)}, from:'smoke-u1', fromAlias:'冒烟搭子' })`);
    ok('黑名单后计划包被拦截（连预览都看不到）', banned && !banned.ok && banned.blocked === true);
    await ev(`window.api.planBanToggle({ uid:'smoke-u1', on:false })`);
  } else {
    ok('黑名单权限校验：未入团被明确拒绝', ban && !ban.ok && /军团长/.test(ban.message || ''));
  }

  // 闲聊档位（未入军团也应能算 L0/L1）
  const tier = await ev(`window.api.legionTierInfo()`);
  ok('闲聊档位信息可取（含 key/note/radar）', tier && tier.key && tier.note !== undefined && ['L0', 'L1', 'L2', 'L3'].includes(tier.key));

  // 任务排行 + 互相契约 + 提醒
  const rank = await ev(`window.api.friendRank()`);
  ok('排行可取且包含我', rank && rank.ok && rank.rows && rank.rows.some((x) => x.isMe));
  const pact = await ev(`window.api.friendPactSet({ uid:'smoke-u1', deposit:30, days:7 })`);
  ok('互相契约能立（押金/天数入档）', pact && pact.ok && pact.pact && pact.pact.deposit === 30 && pact.pact.days === 7);
  const pactDup = await ev(`window.api.friendPactSet({ uid:'smoke-u1', deposit:10, days:7 })`);
  ok('生效中不能重复立', pactDup && !pactDup.ok);
  const pactEnd = await ev(`window.api.friendPactSettle({ uid:'smoke-u1' })`);
  ok('提前结算返回罚扣明细', pactEnd && pactEnd.ok && pactEnd.missed === 0 && pactEnd.penalty === 0);
  ok('21 点前不会自动提醒（今日零条 remind）', (await ev(`(window.api.friendMsgs('smoke-u1').msgs || []).filter(m => m.kind === 'remind').length`)) === 0);

  // 阿刺：加油池 + 代填 + 代回三个意图可被命中（直接调内部函数不可行，验证 UI 存在 + 内存挂载）
  ok('阿刺浮标在页面上', !!(await ev(`!!document.querySelector('#pqb-fab')`)));

  // 治理面板渲染（未入军团也应渲染基础结构）
  await ev(`document.querySelector('[data-view="legion"]').click(); 1`);
  await new Promise((r) => setTimeout(r, 500));
  ok('军团视图可渲染', String(await ev(`$('#view').textContent.length`)) > 0);

  console.log(`\n冒烟结果：${pass} 通过 / ${fail} 失败`);
  ws.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('SMOKE-ERROR', e && e.message);
  process.exit(2);
});
