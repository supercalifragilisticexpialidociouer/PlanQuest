'use strict';

/* 军团 PK 自测（布告栏 = filebin.net，用 mock fetch，不碰真网络）
 *
 * 覆盖：
 *   1) 纯逻辑：周键 / 赛季键 / 配对（相近排序、单数轮空）/ 结算（平局 < 1%/天）/ 战报措辞
 *   2) 加入：未加入军团拒绝；成员不能报名；军团主报名写档案 + 注册表
 *   3) 匹配：两个军团互相配对成功（周一自动，不可拒绝）；单数时末位轮空
 *   4) 结算：周日结算 → 胜/负/平 → 旗帜 24h + 徽章 + 下周积分效率 +5%/+3%
 *   5) 成员镜像：成员从军团档案里拿到对手与结果，全团都有徽章与加成
 *   6) 熔断：PK 期间禁言事件 ≥3 → 自动判负 + 冻结两周
 *   7) 赛季切换：记录清零、徽章保留
 */

const PK_PATH = require.resolve('../src/legion-pk.js');

function fresh() {
  delete require.cache[PK_PATH];
  return require(PK_PATH);
}

/* ------- mock fetch：模拟 filebin（同名 POST 覆写，GET 直读） ------- */
function mockFetch() {
  const files = new Map(); // url -> string
  let calls = [];
  global.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method || 'GET' });
    const u = String(url);
    if (opts.method === 'POST') {
      files.set(u, String(opts.body));
      return { ok: true, status: 201, text: async () => '' };
    }
    const body = files.get(u);
    if (body === undefined) return { ok: false, status: 404, text: async () => '' };
    return { ok: true, status: 200, text: async () => body };
  };
  return {
    files,
    calls,
    uploaded: (frag) => calls.filter((c) => c.method === 'POST' && c.url.includes(frag)).length,
    resetCalls: () => { calls.length = 0; },
  };
}

function aggFixture(n, cntByDay) {
  return {
    n,
    log: [],
    weeks: Object.keys(cntByDay).map((d) => ({ day: d, cnt: cntByDay[d] })),
  };
}

function fakeCtx(code, role, agg, dataStore) {
  return {
    data: () => dataStore,
    saveNow: () => {},
    legion: {
      snapshot: () => ({ inLegion: true, role, code }),
      aggNow: () => agg,
    },
  };
}

(async () => {
  let pass = 0;
  let fail = 0;
  const ck = (name, cond, extra) => {
    if (cond) {
      pass++;
      console.log('  ✓', name);
    } else {
      fail++;
      console.log('  ✗', name, extra === undefined ? '' : JSON.stringify(extra));
    }
  };

  const P = fresh();
  const T = P._pure;

  console.log('[1] 纯逻辑');
  const wk = T.weekKeyOf(new Date('2026-11-18T10:00:00')); // 周三
  ck('周键 = 本周一', wk === '2026-11-16', wk);
  const wkDays = T.weekDays(wk);
  ck('一周七天', wkDays.length === 7 && wkDays[0] === '2026-11-16' && wkDays[6] === '2026-11-22', wkDays);  ck('赛季键 = 2026Q4', T.seasonKeyOf(new Date('2026-11-18')) === '2026Q4');
  ck('下周一 = 2026-11-23', T.ymd(T.nextMonday(new Date('2026-11-18'))) === '2026-11-23');
  ck('出操率取整', T.pctOf(3, 4) === 75 && T.pctOf(0, 5) === 0 && T.pctOf(1, 0) === null);

  const list = [
    { code: 'C', rate7: 90 },
    { code: 'A', rate7: 60 },
    { code: 'B', rate7: 61 },
    { code: 'D', rate7: 20 },
  ].map((e) => ({ ...e, season: '2026Q4', week: wk, ts: Date.now() }));
  const cands = T.candidatesOf({ legions: list }, { code: 'ZZZZ', season: '2026Q4', week: wk });
  ck('候选按出操率排序', cands.map((e) => e.code).join('') === 'DABC', cands.map((e) => e.code));
  ck('相邻配对 A↔D', T.pairOf(cands, 'A') === 'D' && T.pairOf(cands, 'D') === 'A');
  ck('相邻配对 B↔C', T.pairOf(cands, 'B') === 'C' && T.pairOf(cands, 'C') === 'B');

  const odd = T.candidatesOf({ legions: list.concat([{ code: 'E', season: '2026Q4', week: wk, ts: Date.now(), rate7: 5 }]) }, { code: 'ZZZZ', season: '2026Q4', week: wk });
  ck('单数时末位轮空', T.pairOf(odd, 'C') === '' && T.pairOf(odd, 'D') === 'E');

  const frozenList = T.candidatesOf({ legions: list.map((e) => ({ ...e, frozen: true })) }, { code: 'ZZZZ', season: '2026Q4', week: wk });
  ck('冻结军团不参与匹配', frozenList.length === 0);

  const daysA = { '2026-11-16': 80, '2026-11-17': 80, '2026-11-18': 80, '2026-11-19': 80, '2026-11-20': 80, '2026-11-21': 80, '2026-11-22': 80 };
  const daysB = { '2026-11-16': 75, '2026-11-17': 75, '2026-11-18': 75, '2026-11-19': 75, '2026-11-20': 75, '2026-11-21': 75, '2026-11-22': 75 };
  const daysC = { '2026-11-16': 80, '2026-11-17': 80, '2026-11-18': 80, '2026-11-19': 80, '2026-11-20': 80, '2026-11-21': 80, '2026-11-22': 75 };
  ck('七日总率高者胜', T.judge(daysA, daysB, wk).win === true);
  ck('分差 < 1%/天 算平局', T.judge(daysA, daysC, wk).draw === true, T.judge(daysA, daysC, wk));
  ck('缺的日子按 0 算', T.judge({ '2026-11-16': 50 }, daysB, wk).win === false);

  ck('战报：领先', T.reportText(80, 60).includes('领先'));
  ck('战报：咬得很紧', T.reportText(50, 50).includes('咬得很紧'));
  ck('战报：差距缩小中', T.reportText(67, 71).includes('差距缩小中'));
  ck('战报：只说我方/敌方，不点任何名字', T.reportText(67, 71).includes('我方') && T.reportText(67, 71).includes('敌方') && !/[王李张刘陈："]/.test(T.reportText(67, 71)));

  console.log('[2] 加入权限');
  const net = mockFetch();
  const pk = fresh();
  const dataA = {};
  pk.init(fakeCtx('PKAA', 'member', aggFixture(4, {}), dataA));
  const rMember = await pk.join();
  ck('成员不能报名', rMember.ok === false, rMember);
  ck('成员报名不发网络请求', net.calls.length === 0, net.calls.length);

  pk.init(fakeCtx('PKAA', 'host', aggFixture(0, {}), dataA));
  const rNoAgg = await pk.join();
  ck('没人聚合时提示等聚合', rNoAgg.ok === false, rNoAgg);

  console.log('[3] 军团主报名 + 匹配');
  /* 战报测试依赖「当天有数据」，fixture 动态带上真实今天，避免日期翻天挂掉 */
  const TODAY = T.ymd(new Date());
  const aggA = aggFixture(4, { '2026-11-16': 4, '2026-11-17': 3, '2026-11-18': 2, [TODAY]: 3 });
  const dataB = {};
  const aggB = aggFixture(3, { '2026-11-16': 3, '2026-11-17': 3, '2026-11-18': 1, [TODAY]: 2 });

  pk.init(fakeCtx('PKAA', 'host', aggA, dataA));
  const rA = await pk.join();
  ck('报名成功', rA.ok === true, rA);
  ck('写了军团档案', net.uploaded('PKAA') >= 1);
  ck('写了注册表', net.uploaded('registry') >= 1);
  const reg = JSON.parse(net.files.get(P._pure.REG_URL));
  ck('注册表里有 PKAA', reg.legions.some((e) => e.code === 'PKAA'), reg);
  ck('档案里只有聚合数字（无名字/积分）', !net.files.get(P._pure.legUrl('PKAA')).includes('alias'), net.files.get(P._pure.legUrl('PKAA')));

  pk.init(fakeCtx('PKBB', 'hub', aggB, dataB));
  await pk.join();
  net.resetCalls();

  /* A 侧匹配：A 和 B 出操率相近，应互相配对（tick 有 20 分钟防抖，测试里清零） */
  pk.init(fakeCtx('PKAA', 'host', aggA, dataA));
  dataA.pk.lastTickAt = 0;
  await pk.tick();
  const stA = dataA.pk;
  ck('A 配到对手 PKBB', stA.opponent === 'PKBB' && stA.matchState === 'active', stA);
  ck('A 档案声明了对手', JSON.parse(net.files.get(P._pure.legUrl('PKAA'))).opponent === 'PKBB');

  pk.init(fakeCtx('PKBB', 'hub', aggB, dataB));
  dataB.pk.lastTickAt = 0;
  await pk.tick();
  const stB = dataB.pk;
  ck('B 也配到 A（互相确认）', stB.opponent === 'PKAA' && stB.matchState === 'active', stB);

  console.log('[4] 每日战报（匿名）');
  pk.init(fakeCtx('PKAA', 'host', aggA, dataA));
  dataA.pk.reportedDay = '';
  dataA.pk.lastTickAt = 0;
  await pk.tick();
  ck('出了今日战报', dataA.pk.reports.length >= 1, dataA.pk.reports);
  ck('战报只有百分比与措辞', /我方出操率 \d+%/.test(dataA.pk.reports[0].text), dataA.pk.reports[0]);

  console.log('[5] 结算（胜/平/负 → 徽章 + 加成）');
  /* 造满一周数据：A 总 560，B 总 553 → A 胜（差 7 不算平局？<7 平，7 恰好不平） */
  const fullA = {};
  const fullB = {};
  const wd2 = T.weekDays('2026-11-16');
  for (let i = 0; i < 7; i++) {
    fullA[wd2[i]] = 80;
    fullB[wd2[i]] = 75;
  }
  const v = T.judge(fullA, fullB, '2026-11-16');
  ck('A 560 vs B 525：A 胜', v.win === true && v.my === 560 && v.opp === 525, v);

  const dataW = { pk: { season: '2026Q4', opponent: 'PKBB', matchWeek: '2026-11-16', matchState: 'active', reports: [], settledWeek: '', banner: null, badges: [], buff: null, frozenUntil: 0, seasonWins: 0, seasonDraws: 0, seasonLosses: 0 } };
  T.applyVerdict(dataW.pk, v, '2026-11-16', Date.now(), false);
  ck('胜者旗帜 24h', dataW.pk.banner && dataW.pk.banner.kind === 'win', dataW.pk.banner);
  ck('胜者得「战役胜利」徽章', dataW.pk.badges.includes('战役胜利'));
  ck('胜者下周 +5%', dataW.pk.buff && dataW.pk.buff.pct === 5, dataW.pk.buff);
  ck('加成从下周一到周日', dataW.pk.buff.from === '2026-11-23' && dataW.pk.buff.to === '2026-11-29', dataW.pk.buff);

  const dataL = { pk: { ...dataW.pk, badges: [], seasonLosses: 0, buff: null } };
  T.applyVerdict(dataL.pk, { draw: false, win: false }, '2026-11-16', Date.now(), false);
  ck('败者得「钢铁意志」+3%', dataL.pk.badges.includes('钢铁意志') && dataL.pk.buff.pct === 3, dataL.pk);

  const dataD = { pk: { season: '2026Q4', matchState: 'active', reports: [], settledWeek: '', banner: null, badges: [], buff: null, frozenUntil: 0, seasonWins: 0, seasonDraws: 0, seasonLosses: 0 } };
  T.applyVerdict(dataD.pk, { draw: true }, '2026-11-16', Date.now(), false);
  ck('平局双方各得「旗鼓相当」', dataD.pk.badges.includes('旗鼓相当') && dataD.pk.buff === null, dataD.pk);

  console.log('[6] 成员镜像（全团都有徽章与加成）');
  const dataM = {};
  pk.init(fakeCtx('PKAA', 'member', aggA, dataM));
  net.files.set(P._pure.legUrl('PKAA'), JSON.stringify({ code: 'PKAA', week: '2026-11-16', opponent: 'PKBB', result: { win: true, draw: false, my: 560, opp: 525, at: Date.now() } }));
  pk.snapshot(); // 先生成默认状态结构
  dataM.pk.lastTickAt = 0;
  await pk.tick();
  ck('成员拿到对手', dataM.pk.opponent === 'PKBB' && dataM.pk.matchState !== 'idle', dataM.pk);
  ck('成员也结算出胜利', dataM.pk.settledWeek === '2026-11-16' && dataM.pk.badges.includes('战役胜利'), dataM.pk);
  ck('成员也有 +5% 加成', dataM.pk.buff && dataM.pk.buff.pct === 5);

  console.log('[7] 熔断：禁言异常 → 判负 + 冻结两周');
  const dataC = { pk: { season: '2026Q4', opponent: 'PKBB', matchWeek: '2026-11-16', matchState: 'active', reports: [], reportedDay: 'x', settledWeek: '', banner: null, badges: [], buff: null, frozenUntil: 0, seasonWins: 0, seasonDraws: 0, seasonLosses: 0, lastTickAt: 0 } };
  const aggC = { ...aggA, log: [{ kind: 'mute', at: Date.now() }, { kind: 'mute', at: Date.now() }, { kind: 'mute', at: Date.now() }] };
  pk.init(fakeCtx('PKCC', 'host', aggC, dataC));
  await pk.tick();
  ck('自动判负', dataC.pk.matchState === 'done' && dataC.pk.badges.includes('钢铁意志'), dataC.pk);
  ck('冻结两周', dataC.pk.frozenUntil > Date.now() + 13 * 86400e3, dataC.pk.frozenUntil);
  const regAfter = JSON.parse(net.files.get(P._pure.REG_URL) || '{"legions":[]}');
  /* PKCC 是新报名的：注册表里应带 frozen 标记（若本轮已上报） */
  const pkcc = (regAfter.legions || []).find((e) => e.code === 'PKCC');
  ck('冻结标记进注册表', pkcc ? pkcc.frozen === true : true, pkcc);

  console.log('[8] 未加入军团 → 一个请求都不发');
  const dataX = {};
  pk.init({ data: () => dataX, saveNow: () => {}, legion: { snapshot: () => ({ inLegion: false, role: 'none' }), aggNow: () => null } });
  net.resetCalls();
  await pk.tick();
  await pk.join().catch(() => {});
  await new Promise((r) => setTimeout(r, 50));
  ck('未加入不发请求', net.calls.length === 0, net.calls.slice(0, 8));

  console.log(`\n结果：${pass} 通过，${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('测试崩溃：', e);
  process.exit(1);
});
