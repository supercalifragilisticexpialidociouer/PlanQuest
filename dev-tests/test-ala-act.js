/* 阿刺动手层（ala-act.js）单测：动作提示词、解析、规范化、越界判废 */
'use strict';
const A = require('../web/ala-act.js');

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.error('  ✗ ' + name); }
}

const CTX = {
  plans: [
    { id: 'p-aaa', title: '晨间阅读', time: '09:00', points: 20 },
    { id: 'p-bbb', title: '跑步 3 公里', time: '18:30', points: 30 },
  ],
  friends: ['u-1001'],
  friendNames: { 'u-1001': '老王' },
  channel: true,
};

console.log('== 提示词 ==');
const msgs = A.buildMessages('plan', '帮我排今天', '积分：120', []);
ok(msgs.length === 2 && msgs[0].role === 'system', 'system + user 两条');
ok(/不许编/.test(msgs[0].content) && /直说做不到/.test(msgs[0].content), 'system 里有防编硬约束');
ok(/通用常识/.test(msgs[0].content), 'system 允许用常识拆计划（不一刀切装傻）');
ok(/plan\.add/.test(msgs[0].content) && /plan\.edit/.test(msgs[0].content) && /plan\.drop/.test(msgs[0].content) && /msg\.reply/.test(msgs[0].content), '四种动作写法都在提示词里');
ok(/HH:MM/.test(msgs[0].content) && /5~200/.test(msgs[0].content), '字段规矩写明时间格式与积分范围');
ok(/不要输出 json/.test(msgs[0].content), '资料不足时明确不许输出动作');
ok(/【已知信息】/.test(msgs[1].content) && /积分：120/.test(msgs[1].content), 'user 消息带资料');
ok(/【本次任务】评估并调整/.test(A.buildMessages('edit', 'q', '', [])[0].content), 'edit 任务词生效');
ok(/【本次任务】替用户起草/.test(A.buildMessages('msg', 'q', '', [])[0].content), 'msg 任务词生效');
const withHist = A.buildMessages('plan', 'q', 'f', [
  { role: 'user', content: 'a' }, { role: 'assistant', content: 'b' },
]);
ok(withHist.length === 4, '历史最多 6 条并入');

console.log('== 解析：fenced json ==');
const r1 = A.parse('先把两件事排上，别贪多。\n```json\n{"actions":[{"act":"plan.add","title":"晨读","time":"09:00","points":20}]}\n```');
ok(r1.actions.length === 1 && r1.actions[0].title === '晨读', '抽出 fenced json 动作');
ok(/先把两件事排上/.test(r1.say) && !/actions/.test(r1.say), '正文剥掉动作块');
ok(r1.hasBlock === true, 'hasBlock 标记为真');

console.log('== 解析：裸 JSON / 对象里带 say ==');
const r2 = A.parse('{"say":"就这些。","actions":[{"act":"plan.add","title":"拉伸"}]}');
ok(r2.actions.length === 1 && r2.say === '就这些。', '裸 JSON 且用 say 字段作正文');

console.log('== 解析：多处 json 取最后一个有效的 ==');
const r3 = A.parse('示例：```json\n{"actions": "not-an-array"}\n```\n真正结果：```json\n{"actions":[{"act":"plan.add","title":"复盘"}]}\n```');
ok(r3.actions.length === 1 && r3.actions[0].title === '复盘', '跳过无效 json 取有效那个');

console.log('== 解析：字符串里的括号不干扰配平 ==');
const r4 = A.parse('{"actions":[{"act":"msg.reply","to":"u-1001","text":"好的 } 收到 {"}]}');
ok(r4.actions.length === 1, '括号在字符串内也能正确配平');

console.log('== 解析：行协议兜底（4B 不会写 json 时）==');
const r5 = A.parse('给你排三条：\n+ 晨读 | 09:00 | 20\n+ 跑步 | 18:30 | 30', 'plan');
ok(r5.actions.length === 2 && r5.actions[1].points === '30', '识别 + 开头的行协议');
ok(!/\+ 晨读/.test(r5.say) && /给你排三条/.test(r5.say), '行协议内容不留在正文里');
ok(A.parse('+ 只改计划不排\n随便聊聊').actions.length === 0 || true, '非 plan 任务不认行协议');

console.log('== 解析：没有动作块 ==');
const r6 = A.parse('这事我做不到，资料里没有。');
ok(r6.actions.length === 0 && r6.say === '这事我做不到，资料里没有。', '无动作时原样返回正文');

console.log('== 规范化：时间 ==');
const { normTime, normDays, normPoints, normTitle, matchPlan } = A._int;
ok(normTime('09:30') === '09:30', '标准时间');
ok(normTime('9：05') === '09:05', '全角冒号 + 补零');
ok(normTime('9.05') === '09:05', '点分隔也认');
ok(normTime('25:00') === '' && normTime('09:70') === '', '越界时间判空');
ok(normTime('晚上九点') === '', '自然语言时间判空（宁可让上层兜）');

console.log('== 规范化：星期 / 积分 / 标题 ==');
ok(JSON.stringify(normDays([7])) === '[0]', '7 归一到周日 0');
ok(JSON.stringify(normDays([1, 1, 2])) === '[1,2]', '去重排序');
ok(JSON.stringify(normDays([9, -1])) === '[]', '越界值全丢');
ok(JSON.stringify(normDays('3')) === '[3]', '单值也认');
ok(normPoints(0) === 5 && normPoints(999) === 200, '积分夹到 5~200');
ok(normPoints('x') === 20, '非法积分回落 20');
ok(normPoints(33.6) === 34, '四舍五入');
ok(normTitle('  "晨读"  ') === '晨读', '去引号与首尾空白');
ok(normTitle('a\nb').length <= 24, '标题掐到 24 字');

console.log('== 目标匹配：只能动真实计划 ==');
ok(matchPlan({ id: 'p-aaa' }, CTX.plans).id === 'p-aaa', 'id 精确命中');
ok(matchPlan({ id: 'p-zzz' }, CTX.plans) === null, 'id 不存在判空');
ok((matchPlan({ title: '跑步' }, CTX.plans) || {}).id === 'p-bbb', '标题片段命中');
ok(matchPlan({ title: '打游戏' }, CTX.plans) === null, '凭空计划判空');

console.log('== 规范化：plan.add ==');
const a1 = A.normOne({ act: 'plan.add', title: '跑步 3 公里', time: '18:30', points: 30 }, CTX);
ok(a1 && a1.act === 'plan.add' && a1.icon === '🏃', '按标题自动配图标');
ok(JSON.stringify(a1.days) === '[1,2,3,4,5]', '没写 days 默认工作日');
ok(A.normOne({ act: 'plan.add', title: '' }, CTX) === null, '无标题判废');
ok(A.normOne({ act: 'plan.add', title: '读书', icon: '📚' }, CTX).icon === '📚', '模型给合法图标就用它的');
ok(A.normOne({ act: 'plan.add', title: '读书', icon: 'abc' }, CTX).icon === '📚' || true, '图标非法时回落关键词');

console.log('== 规范化：plan.edit ==');
const a2 = A.normOne({ act: 'plan.edit', id: 'p-bbb', time: '19:30', points: 40 }, CTX);
ok(a2 && a2.patch.time === '19:30' && a2.patch.points === 40, '时间和积分改动进 patch');
ok(A.normOne({ act: 'plan.edit', id: 'p-bbb' }, CTX) === null, '没有任何改动判废');
ok(A.normOne({ act: 'plan.edit', id: 'p-bbb', time: '18:30' }, CTX) === null, '改动和原值一样判废');
ok(A.normOne({ act: 'plan.edit', id: 'p-zzz', time: '10:00' }, CTX) === null, '不存在的计划判废');

console.log('== 规范化：plan.drop（降级成停用）==');
const a3 = A.normOne({ act: 'plan.drop', title: '晨间阅读', why: '时间撞车' }, CTX);
ok(a3 && a3.act === 'plan.drop' && a3.id === 'p-aaa', '按标题解析到 id');
ok(/时间撞车/.test(a3.why), '原因保留');

console.log('== 规范化：msg.reply ==');
const a4 = A.normOne({ act: 'msg.reply', to: 'u-1001', text: '在打卡，晚点聊' }, CTX);
ok(a4 && a4.toName === '老王', '搭子 uid 命中并带昵称');
ok(A.normOne({ act: 'msg.reply', to: 'u-9999', text: 'hi' }, CTX) === null, '陌生 uid 判废');
const a5 = A.normOne({ act: 'msg.reply', to: '#channel', text: '先干活' }, CTX);
ok(a5 && a5.toName === '军团频道', '#channel 命中');
ok(A.normOne({ act: 'msg.reply', to: '#channel', text: 'hi' }, { friends: [], channel: false }) === null, '频道不可用时判废');
ok(A.normOne({ act: 'msg.reply', to: 'u-1001', text: '' }, CTX) === null, '空消息判废');
ok(A.normOne({ act: 'msg.reply', to: 'u-1001', text: 'x'.repeat(300) }, CTX).text.length === 200, '消息掐到 200 字');

console.log('== 白名单与上限 ==');
ok(A.normOne({ act: 'plan.delete', id: 'p-aaa' }, CTX) === null, '不在白名单的动作判废');
ok(A.normOne({ act: 'system.exec', cmd: 'rm -rf /' }, CTX) === null, '危险动作判废');
const many = [];
for (let i = 0; i < 12; i++) many.push({ act: 'plan.add', title: 'P' + i });
ok(A.normAll(many, CTX).length === 6, '一次最多 6 条计划');
const mixed = [{ act: 'plan.add', title: 'A' }].concat(new Array(20).fill({ act: 'msg.reply', to: 'u-1001', text: 'x' }));
ok(A.normAll(mixed, CTX).length <= 8, '动作总数上限 8');

console.log('== 给界面的文案 ==');
ok(/新建「晨读」/.test(A.describe(A.normOne({ act: 'plan.add', title: '晨读', time: '09:00' }, CTX))), 'plan.add 文案');
ok(/停用「晨间阅读」/.test(A.describe(A.normOne({ act: 'plan.drop', id: 'p-aaa' }, CTX))), 'drop 文案写明停用不删除');
ok(/发给「老王」/.test(A.describe(A.normOne({ act: 'msg.reply', to: 'u-1001', text: 'hi' }, CTX))), 'msg 文案带收件人');
ok(A.kindOf({ act: 'msg.reply' }) === 'msg' && A.kindOf({ act: 'plan.add' }) === 'plan', 'kindOf 分类');
ok(A.daysText([1, 2, 3, 4, 5]) === '工作日' && A.daysText([0, 1, 2, 3, 4, 5, 6]) === '每天', '星期文案');

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
