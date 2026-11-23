# -*- coding: utf-8 -*-
"""把桌面版 app.js 的新 UI（开机时触发 + 新扣分说明）移植到 web / android 两端。"""
import io, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TARGETS = [
    os.path.join(ROOT, 'web', 'app.js'),
    os.path.join(ROOT, 'android-app', 'www', 'app.js'),
]

def rep(s, old, new, tag):
    if old not in s:
        print('  MISS  ' + tag)
        return s, False
    print('  OK    ' + tag)
    return s.replace(old, new, 1), True

for path in TARGETS:
    print('=== ' + os.path.relpath(path, ROOT))
    s = io.open(path, encoding='utf-8').read()
    ok = True

    # 1) draft 默认值加 when
    s, r = rep(s,
        """    ? { ...plan, days: [...(plan.days || [])], needConfirm: !!plan.needConfirm }""",
        """    ? { ...plan, days: [...(plan.days || [])], needConfirm: !!plan.needConfirm, when: plan.when || 'time' }""",
        'draft 编辑态 when')
    ok &= r
    s, r = rep(s,
        """        time: '09:00',
        days: [1, 2, 3, 4, 5],""",
        """        time: '09:00',
        when: 'time',
        days: [1, 2, 3, 4, 5],""", 'draft 新建态 when')
    ok &= r

    # 2) 表单加「触发时机」
    s, r = rep(s,
        """      <div class="form-row" style="display:flex;gap:14px">
        <div style="flex:1">
          <label class="form-label">提醒时间</label>
          <input type="time" class="input" id="f-time" value="${esc(draft.time)}"/>
        </div>""",
        """      <div class="form-row">
        <label class="form-label">触发时机</label>
        <div class="day-picker" id="f-when">
          <button class="day-opt ${draft.when !== 'boot' ? 'sel' : ''}" data-v="time">⏰ 定时时间</button>
          <button class="day-opt ${draft.when === 'boot' ? 'sel' : ''}" data-v="boot">🚀 开机时</button>
        </div>
        <div class="form-hint">选「开机时」：每次打开应用（含开机自启）就自动弹窗提醒，不需要固定时间。</div>
      </div>
      <div class="form-row" style="display:flex;gap:14px">
        <div style="flex:1">
          <label class="form-label">提醒时间</label>
          <input type="time" class="input" id="f-time" value="${esc(draft.time)}" ${draft.when === 'boot' ? 'disabled style="opacity:.4"' : ''}/>
        </div>""", '表单 f-when')
    ok &= r

    # 3) pick('#f-when') 交互
    s, r = rep(s,
        """  pick('#f-emoji');
  pick('#f-color');""",
        """  pick('#f-emoji');
  pick('#f-color');
  // 触发时机：切到「开机时」时禁用时间输入
  pick('#f-when');
  $$('#f-when [data-v]', mask).forEach((b) => {
    b.onclick = () => {
      $$('#f-when .sel', mask).forEach((x) => x.classList.remove('sel'));
      b.classList.add('sel');
      const t = $('#f-time', mask);
      if (t) {
        if (b.dataset.v === 'boot') {
          t.setAttribute('disabled', '');
          t.style.opacity = '.4';
        } else {
          t.removeAttribute('disabled');
          t.style.opacity = '';
        }
      }
    };
  });""", 'f-when 交互')
    ok &= r

    # 4) payload 带 when
    s, r = rep(s,
        """      time: $('#f-time', mask).value || '09:00',""",
        """      when: $('#f-when .sel', mask)?.dataset.v === 'boot' ? 'boot' : 'time',
      time: $('#f-time', mask).value || '09:00',""", 'payload when')
    ok &= r

    # 5) 保存成功提示（按 isBoot 判断 + 新扣分说明）
    s, r = rep(s,
        """    mask.remove();
    if (res.rejected && res.rejected.length) {
      toast(
        '计划已保存，但部分软件被剔除',
        `${res.rejected.join('、')} 在黑名单或灰名单里，不能作为计划放行项`
      );
      return;
    }
    toast(draft.id ? `计划已更新（-10 积分）` : '计划已创建', '到点会自动弹窗提醒');""",
        """    mask.remove();
    const deducted = Number(res.deducted) || 0;
    const procNote = (res.normalProcs || []).join('、');
    const rejected = res.rejected && res.rejected.length ? res.rejected : null;
    const whenNote = planPayload.when === 'boot' ? '打开应用时会自动弹窗提醒' : '到点会自动弹窗提醒';
    if (deducted) {
      // 计划里新放了非白名单普通软件 —— 这是唯一会扣分的计划操作
      toast(
        `${draft.id ? '计划已更新' : '计划已创建'}（-${deducted} 积分）`,
        `${procNote} 不是白名单软件，已计入计划放行项` +
          (rejected ? `；${rejected.join('、')} 在黑/灰名单里，已剔除` : '')
      );
    } else if (rejected) {
      toast('计划已保存，但部分软件被剔除', `${rejected.join('、')} 在黑名单或灰名单里，不能作为计划放行项`);
    } else {
      toast(draft.id ? '计划已更新' : '计划已创建', whenNote + '（不扣积分）');
    }""", '保存提示')
    ok &= r

    # 6) 暂停 / 启用不扣分
    s, r = rep(s,
        """      const turningOff = el.classList.contains('on');
      const isTemp = !!state.plans.find((p) => p.id === el.dataset.toggle && p.temp);
      const ok = turningOff
        ? await confirmDialog('暂停这个计划？', isTemp ? '临时计划暂停不扣分。' : '暂停后当天不再提醒，并扣除 10 积分。')
        : await confirmDialog('重新启用这个计划？', isTemp ? '临时计划重新启用不扣分。' : '启用后恢复提醒，同样扣除 10 积分。');""",
        """      const turningOff = el.classList.contains('on');
      const ok = turningOff
        ? await confirmDialog('暂停这个计划？', '暂停后当天不再提醒。暂停不扣积分。')
        : await confirmDialog('重新启用这个计划？', '启用后恢复提醒。重新启用不扣积分。');""", '暂停/启用文案')
    ok &= r

    # 7) 删除不扣分
    s, r = rep(s,
        """        `删除「${p.title}」？`,
        p.temp
          ? '临时计划删除不扣分。'
          : '删除后该计划的历史打卡记录会保留，但不再提醒。此操作将扣除 10 积分。'""",
        """        `删除「${p.title}」？`,
        '删除后该计划的历史打卡记录会保留，但不再提醒。删除不扣积分。'""", '删除文案')
    ok &= r

    # 8) 改计划密码提示
    s, r = rep(s,
        "const pw = await askPassword('更改计划需要验证（-10 积分）');",
        "const pw = await askPassword('更改计划需要验证');", '改密码提示')
    ok &= r

    # 9) 表单 hint
    s, r = rep(s,
        """          计划时段内放行这些软件，累计使用不超过 <b>1 小时</b>；用满后按普通软件处理。<br/>
          不能与黑名单 / 灰名单重叠，重叠的会被自动剔除。""",
        """          计划时段内放行这些软件，累计使用不超过 <b>1 小时</b>；用满后按普通软件处理。<br/>
          不能与黑名单 / 灰名单重叠，重叠的会被自动剔除。<br/>
          只有这里<b>新增非白名单普通软件</b>时才扣 10 积分；改标题、时间、星期不扣分。""", '表单 hint')
    ok &= r

    # 10) 设置页规则
    s, r = rep(s,
        """      <div class="set-row"><div class="set-info"><div class="st">更改计划</div><div class="sd">每次编辑已存在的计划扣 10 积分，且需输入密码。</div></div></div>
      <div class="set-row"><div class="set-info"><div class="st">关闭 / 重新启用计划</div><div class="sd">暂停计划和重新启用都扣 10 积分，避免「关掉再打开」白赚一次暂停。</div></div></div>
      <div class="set-row"><div class="set-info"><div class="st">计划内需要的软件</div><div class="sd">计划里可以指定放行的进程，计划时段内可用；同一进程累计不超过 1 小时，用满后按普通软件处理。不能与黑/灰名单重叠。新建需要放行进程的计划扣 10 积分。</div></div></div>""",
        """      <div class="set-row"><div class="set-info"><div class="st">名单外普通软件</div><div class="sd">只弹提醒，<b>不扣积分</b>。常用就加白名单；只是某个计划要用，就写进那个计划的「计划内需要的软件」。</div></div></div>
      <div class="set-row"><div class="set-info"><div class="st">唯一会扣积分的计划操作</div><div class="sd">计划里<b>新放行非白名单普通软件</b>扣 10 积分（修改标题 / 时间 / 星期、只放行白名单软件、暂停、重新启用、删除，全部不扣分）。</div></div></div>
      <div class="set-row"><div class="set-info"><div class="st">计划内需要的软件</div><div class="sd">计划里可以指定放行的进程，计划时段内可用；同一进程累计不超过 1 小时，用满后按普通软件处理。不能与黑/灰名单重叠。</div></div></div>""", '设置页规则')
    ok &= r

    # 11) 时间线显示「开机时」
    s, r = rep(s,
        """      <div class="tl-time"><div class="t">${esc(p.time)}</div><div class="d">提醒</div></div>""",
        """      <div class="tl-time"><div class="t">${p.when === 'boot' ? '🚀' : esc(p.time)}</div><div class="d">${p.when === 'boot' ? '开机时' : '提醒'}</div></div>""", '时间线')
    ok &= r

    # 12) 计划卡片
    s, r = rep(s,
        """        <span class="pc-chip time">⏰ ${esc(p.time)}</span>""",
        """        <span class="pc-chip time">${p.when === 'boot' ? '🚀 开机时' : `⏰ ${esc(p.time)}`}</span>""", '卡片时间 chip')
    ok &= r

    s, r = rep(s,
        """        <span class="pc-chip">${p.temp ? '时段结束后失效 · 明天自动删除' : p.enabled ? '到点自动弹窗提醒' : '提醒已关闭'}</span>""",
        """        <span class="pc-chip">${p.temp ? '时段结束后失效 · 明天自动删除' : p.when === 'boot' ? '打开应用时自动弹窗提醒' : p.enabled ? '到点自动弹窗提醒' : '提醒已关闭'}</span>""", '卡片状态 chip')
    ok &= r

    io.open(path, 'w', encoding='utf-8', newline='\n').write(s)
    print('  -> ' + ('完成' if ok else '有未匹配项，需要人工检查'))
