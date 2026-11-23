# -*- coding: utf-8 -*-
"""v1.9：.pqplan 计划文件类型（导入/导出）+ 语音 ASR 声明等补丁
   - main.js: planfile:* IPC（build/export/pick/apply + sha256 校验 + 合并逻辑）
   - preload.js: 4 个新接口
   - app.js: 设置页「计划文件」面板（导出 + 导入，导入选合并/覆盖）
"""
import io

ROOT = r"C:\Users\18824\WorkBuddy\2026-10-27-21-28-50\planquest"


def patch(p, subs):
    s = io.open(ROOT + "\\" + p.replace("/", "\\"), encoding="utf-8", newline="").read()
    for old, new in subs:
        assert old in s, (p, old[:70])
        assert s.count(old) == 1, (p, old[:70], s.count(old))
        s = s.replace(old, new)
    io.open(ROOT + "\\" + p.replace("/", "\\"), "w", encoding="utf-8", newline="").write(s)
    print("patched", p)


MAIN_INSERT = r'''
  /* ---------------- 计划文件（.pqplan 专用格式） ----------------
   * 信封：{ magic, format, app, version, exportedAt, from, checksum, data }
   * checksum = sha256(JSON.stringify(data))，导入时重算比对，防篡改/损坏。
   * data 与「同步码」载荷一致（完整 data.json 结构），跨版本走 normalize。 */

  const PLAN_MAGIC = 'PLANQUEST-PLAN';
  const PLAN_FORMAT = 1;

  function planSha256(s) {
    return require('node:crypto').createHash('sha256').update(s, 'utf8').digest('hex');
  }

  function buildPlanEnvelope() {
    const payload = JSON.parse(JSON.stringify(data));
    return {
      magic: PLAN_MAGIC,
      format: PLAN_FORMAT,
      app: 'PlanQuest',
      version: '1.9.0',
      exportedAt: new Date().toISOString(),
      from: 'PlanQuest 桌面版',
      checksum: planSha256(JSON.stringify(payload)),
      data: payload,
    };
  }

  function validatePlanEnvelope(env) {
    if (!env || typeof env !== 'object') return { ok: false, error: '文件内容不是有效的 JSON' };
    if (env.magic !== PLAN_MAGIC) return { ok: false, error: '不是 PlanQuest 计划文件（应选 .pqplan 文件）' };
    if (Number(env.format) !== PLAN_FORMAT) return { ok: false, error: '格式版本不支持（format=' + env.format + '）' };
    if (!env.data || typeof env.data !== 'object' || !Array.isArray(env.data.plans)) {
      return { ok: false, error: '文件缺少计划数据' };
    }
    if (env.checksum) {
      const sum = planSha256(JSON.stringify(env.data));
      if (sum !== env.checksum) return { ok: false, error: '校验和不匹配：文件可能已损坏或被手动改动' };
    }
    return { ok: true, data: env.data };
  }

  function mergeListsMain(a, b) {
    const seen = new Set((a || []).map((x) => String(x).toLowerCase()));
    const out = [...(a || [])];
    for (const x of b || []) {
      const k = String(x).toLowerCase();
      if (!seen.has(k)) { seen.add(k); out.push(x); }
    }
    return out;
  }

  function mergeIncoming(inc) {
    inc = normalize(inc);
    const stats = { plans: 0, logs: 0, goals: 0, contracts: 0, shop: 0 };
    const byId = (arr) => new Map((arr || []).filter((x) => x && x.id).map((x) => [x.id, x]));
    const mergeArr = (key, incArr) => {
      const cur = byId(data[key]);
      let n = 0;
      for (const item of incArr || []) {
        if (item && item.id && !cur.has(item.id)) { cur.set(item.id, item); n++; }
      }
      data[key] = [...cur.values()];
      return n;
    };
    stats.plans = mergeArr('plans', inc.plans);
    stats.goals = mergeArr('goals', inc.goals);
    stats.contracts = mergeArr('contracts', inc.contracts);
    for (const [k, day] of Object.entries(inc.log || {})) {
      data.log[k] = data.log[k] || {};
      for (const [pid, rec] of Object.entries(day || {})) {
        const cur = data.log[k][pid];
        if (!cur || (rec?.at || 0) > (cur?.at || 0)) { data.log[k][pid] = rec; stats.logs++; }
      }
    }
    for (const k of ['fired', 'snooze', 'bonus', 'mits', 'diary', 'reviews', 'makeups', 'grayRedeem']) {
      for (const [k2, v] of Object.entries(inc[k] || {})) {
        if (data[k][k2] === undefined) data[k][k2] = v;
        else if (typeof v === 'object' && v && typeof data[k][k2] === 'object') Object.assign(data[k][k2], v);
      }
    }
    const pickBigger = (a, b) => (Math.abs(Number(b) || 0) > Math.abs(Number(a) || 0) ? Number(b) || 0 : Number(a) || 0);
    for (const k of ['points', 'totalDone', 'bestStreak', 'perfectDays', 'focusMinutes', 'pomodoros'])
      data.profile[k] = pickBigger(data.profile[k], inc.profile[k]);
    data.guardian.whitelist = mergeListsMain(data.guardian.whitelist, inc.guardian.whitelist);
    data.guardian.graylist = mergeListsMain(data.guardian.graylist, inc.guardian.graylist);
    data.guardian.blacklist = mergeListsMain(data.guardian.blacklist, inc.guardian.blacklist);
    data.guardian.enabled = data.guardian.enabled || inc.guardian.enabled;
    if (!data.guardian.hash && inc.guardian.hash) {
      data.guardian.user = inc.guardian.user; data.guardian.salt = inc.guardian.salt; data.guardian.hash = inc.guardian.hash;
    }
    const shopIds = new Set(data.shop.items.map((x) => x.id));
    for (const it of inc.shop.items || []) if (!shopIds.has(it.id)) { data.shop.items.push(it); stats.shop++; }
    const histKeys = new Set(data.shop.history.map((h) => JSON.stringify(h)));
    for (const h of inc.shop.history || []) { const k = JSON.stringify(h); if (!histKeys.has(k)) { data.shop.history.push(h); histKeys.add(k); } }
    return stats;
  }

  ipcMain.handle('planfile:build', () => ({ ok: true, json: JSON.stringify(buildPlanEnvelope(), null, 2) }));

  ipcMain.handle('planfile:export', async () => {
    const { dialog } = require('electron');
    const res = await dialog.showSaveDialog(mainWindow, {
      title: '导出计划文件（.pqplan）',
      defaultPath: `PlanQuest计划-${dateKey()}.pqplan`,
      filters: [{ name: 'PlanQuest 计划', extensions: ['pqplan'] }],
    });
    if (res.canceled || !res.filePath) return { ok: false };
    fs.writeFileSync(res.filePath, JSON.stringify(buildPlanEnvelope(), null, 2), 'utf8');
    return { ok: true, path: res.filePath };
  });

  ipcMain.handle('planfile:pick', async () => {
    const { dialog } = require('electron');
    const res = await dialog.showOpenDialog(mainWindow, {
      title: '导入计划文件（.pqplan）',
      filters: [{ name: 'PlanQuest 计划', extensions: ['pqplan', 'json'] }],
      properties: ['openFile'],
    });
    if (res.canceled || !res.filePaths || !res.filePaths[0]) return { ok: false };
    try {
      const env = JSON.parse(fs.readFileSync(res.filePaths[0], 'utf8'));
      const v = validatePlanEnvelope(env);
      if (!v.ok) return { ok: false, message: v.error };
      return { ok: true, data: v.data, source: path.basename(res.filePaths[0]) };
    } catch (e) {
      return { ok: false, message: '文件解析失败：' + e.message };
    }
  });

  ipcMain.handle('planfile:apply', (_e, { data: inc, mode }) => {
    try {
      const v = validatePlanEnvelope({ magic: PLAN_MAGIC, format: PLAN_FORMAT, data: inc });
      if (!v.ok) return { ok: false, message: v.error };
      if (mode === 'replace') {
        data = normalize(inc);
        saveNow();
        return { ok: true, message: `已覆盖导入：${data.plans.length} 个计划` };
      }
      const stats = mergeIncoming(inc);
      saveNow();
      return {
        ok: true,
        message: `合并完成：新增计划 ${stats.plans} · 合并打卡 ${stats.logs} · 新增目标 ${stats.goals} · 新增契约 ${stats.contracts}`,
      };
    } catch (e) {
      return { ok: false, message: e.message };
    }
  });
'''

PRELOAD_INSERT = r'''
  /* 计划文件（.pqplan）：导入 / 导出 / 校验应用 */
  planfileBuild: () => ipcRenderer.invoke('planfile:build'),
  planfileExport: () => ipcRenderer.invoke('planfile:export'),
  planfilePick: () => ipcRenderer.invoke('planfile:pick'),
  planfileApply: (args) => ipcRenderer.invoke('planfile:apply', args),
'''

UI_OLD = r'''      <div class="set-row">
        <div class="set-info">
          <div class="st">导出备份</div>
          <div class="sd">把全部数据导出为 JSON，换电脑时可以带走。</div>
        </div>
        <button class="btn small ghost" id="export-btn">导出</button>
      </div>'''
UI_NEW = r'''      <div class="set-row">
        <div class="set-info">
          <div class="st">计划文件（.pqplan）</div>
          <div class="sd">专用格式，带版本号与 SHA-256 校验和：备份全部计划、打卡记录、目标与契约，可导入合并或覆盖。</div>
        </div>
        <div style="display:flex;gap:8px">
          <button class="btn small" id="planfile-export">导出</button>
          <button class="btn small ghost" id="planfile-import">导入</button>
        </div>
      </div>'''

BIND_OLD = r'''  $('#export-btn').onclick = async () => {
    const r = await api.exportData();
    if (r.ok) toast('已导出', r.path);
  };'''
BIND_NEW = r'''  $('#planfile-export').onclick = async () => {
    const r = await api.planfileExport();
    if (r.ok) toast('计划文件已导出', r.path || '');
  };
  $('#planfile-import').onclick = async () => {
    const picked = await api.planfilePick();
    if (!picked || !picked.ok) {
      if (picked && picked.message) toast('导入失败', picked.message, true);
      return;
    }
    const mode = await chooseDialog(
      `导入计划文件（${picked.source || '.pqplan'}）`,
      `包含 ${(picked.data.plans || []).length} 个计划，选择导入方式`,
      ['合并导入（推荐，保留本机已有）', '覆盖导入（替换全部计划与记录）']
    );
    const r = await api.planfileApply({ data: picked.data, mode: mode === 1 ? 'replace' : 'merge' });
    if (r.ok) {
      toast(r.mode === 'replace' ? '已覆盖导入' : '已合并导入', r.message || '');
      renderAll();
    } else {
      toast('导入失败', r.message || '', true);
    }
  };'''

patch("src/main.js", [("  ipcMain.handle('reminder:action', (_e, { planId, action, test, password }) => {",
                       MAIN_INSERT + "\n  ipcMain.handle('reminder:action', (_e, { planId, action, test, password }) => {")])
patch("src/preload.js", [("  exportData: () => ipcRenderer.invoke('app:export'),",
                          "  exportData: () => ipcRenderer.invoke('app:export'),\n" + PRELOAD_INSERT)])
patch("src/renderer/app.js", [(UI_OLD, UI_NEW), (BIND_OLD, BIND_NEW)])
print("ALL DONE")
