# -*- coding: utf-8 -*-
"""v1.9：网页/APK 版 .pqplan 支持（pq-core 信封+校验+导入重构，api-bridge 三接口）"""

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


# pq-core：importData 拆成 importDataObj（复用合并逻辑）+ 信封/解析
PQ_OLD = """function importData(codeText, mode) {
  let incoming;
  try { incoming = decodeSyncCode(codeText); } catch (e) { return { ok: false, message: e.message }; }
  const inc = normalize(incoming);"""
PQ_NEW = """/* 计划文件（.pqplan）导入核心：同合并逻辑供文件导入与同步码共用 */
function importDataObj(obj, mode) {
  const inc = normalize(obj);"""
patch("web/core/pq-core.js", [(PQ_OLD, PQ_NEW)])

# importData 函数结尾 return 之后补回包装函数 + 信封/校验函数
PQ_TAIL_OLD = """  return {
    ok: true,
    message: `合并完成：新增计划 ${stats.plans} · 合并打卡 ${stats.logs} · 新增目标 ${stats.goals} · 新增商品 ${stats.shop}`,
    stats,
  };
}

/* ---------------- 初始化 ---------------- */"""
PQ_TAIL_NEW = """  return {
    ok: true,
    message: `合并完成：新增计划 ${stats.plans} · 合并打卡 ${stats.logs} · 新增目标 ${stats.goals} · 新增商品 ${stats.shop}`,
    stats,
  };
}

function importData(codeText, mode) {
  let incoming;
  try { incoming = decodeSyncCode(codeText); } catch (e) { return { ok: false, message: e.message }; }
  return importDataObj(incoming, mode);
}

/* ---------------- 计划文件（.pqplan 专用格式） ----------------
 * 信封：{ magic, format, app, version, exportedAt, from, checksum, data }
 * checksum = SHA-256(JSON.stringify(data))，缺 SubtleCrypto 时置 null（导入跳过校验）。 */

async function sha256Hex(text) {
  try {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch (_) {
    return null;
  }
}

async function planFileEnvelope() {
  const payload = JSON.parse(JSON.stringify(data));
  return {
    magic: 'PLANQUEST-PLAN',
    format: 1,
    app: 'PlanQuest',
    version: '1.9.0',
    exportedAt: new Date().toISOString(),
    from: 'PlanQuest 移动/网页版',
    checksum: await sha256Hex(JSON.stringify(payload)),
    data: payload,
  };
}

async function parsePlanFileText(text) {
  let env;
  try { env = JSON.parse(String(text || '')); } catch (_) { return { ok: false, message: '文件内容不是有效的 JSON' }; }
  if (!env || typeof env !== 'object') return { ok: false, message: '文件内容不是有效的 JSON' };
  if (env.magic !== 'PLANQUEST-PLAN') return { ok: false, message: '不是 PlanQuest 计划文件（应选 .pqplan 文件）' };
  if (Number(env.format) !== 1) return { ok: false, message: '格式版本不支持（format=' + env.format + '）' };
  if (!env.data || typeof env.data !== 'object' || !Array.isArray(env.data.plans)) return { ok: false, message: '文件缺少计划数据' };
  if (env.checksum) {
    const sum = await sha256Hex(JSON.stringify(env.data));
    if (sum && sum !== env.checksum) return { ok: false, message: '校验和不匹配：文件可能已损坏或被手动改动' };
  }
  return { ok: true, data: env.data };
}

/* ---------------- 初始化 ---------------- */"""
patch("web/core/pq-core.js", [(PQ_TAIL_OLD, PQ_TAIL_NEW)])

# api-bridge：三个新接口
BR_OLD = """    syncImport: async (text, mode) => { const r = importData(text, mode); refresh(); return r; },"""
BR_NEW = """    syncImport: async (text, mode) => { const r = importData(text, mode); refresh(); return r; },

    /* 计划文件（.pqplan）：导出下载 / 文件选择导入 / 应用 */
    planfileExport: async () => {
      try {
        const env = await planFileEnvelope();
        const json = JSON.stringify(env, null, 2);
        const name = 'PlanQuest计划-' + dateKey() + '.pqplan';
        const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 30000);
        return { ok: true, path: name };
      } catch (e) { return { ok: false, message: e.message }; }
    },
    planfilePick: () => new Promise((resolve) => {
      const inp = document.createElement('input');
      inp.type = 'file';
      inp.accept = '.pqplan,application/json';
      inp.onchange = async () => {
        const f = inp.files && inp.files[0];
        if (!f) return resolve({ ok: false });
        try {
          const r = await parsePlanFileText(await f.text());
          resolve(r.ok ? { ...r, source: f.name } : r);
        } catch (e) { resolve({ ok: false, message: '文件读取失败：' + e.message }); }
      };
      inp.click();
    }),
    planfileApply: async ({ data: inc, mode }) => {
      const r = importDataObj(inc, mode);
      refresh();
      return { ok: r.ok, message: r.message };
    },"""
patch("web/api-bridge.js", [(BR_OLD, BR_NEW)])
print("ALL DONE")
