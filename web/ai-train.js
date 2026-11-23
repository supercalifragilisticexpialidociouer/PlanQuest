'use strict';
/* AITrain —— AI 自训练中心（三端共用）
 *
 * 能训什么：
 *   1) 闲聊雷达（文字）：官方特征层（gte-small-zh）冻结，只用你自己的「纠正样本」
 *      重训 512→2 的输出层，得到「我的模型」；权重约 5KB，训练 1 秒内完成。
 *   2) AI 盯学（画面）：整只 CNN 无法在手机/浏览器里重训，这里学的是
 *      「温度 + 偏置」校准（2 个参数）：把官方 logit 差按你的习惯重新映射成摸鱼概率，
 *      同时隐含地学出你自己的判定阈值。样本来自每次抓包时你的「确实 / 误判」反馈。
 *
 * 训练集：
 *   · 默认只存本机（localStorage）；
 *   · 用户在设置里显式允许后才上传到云端 pq_ai_samples 表，按账号隔离（服务端 RLS）；
 *   · 还可选择「参与公共训练集」——上传的样本标记 shared=true，可被其他开启该选项的用户读取。
 *
 * 依赖：AIChat（取隐层特征 / 切换输出层）、AIWatch（切换校准）、PQCloud（云端读写）。
 */
const AITrain = (() => {
  const S_KEY = 'pq-ai-samples-v1';
  const M_KEY = 'pq-ai-models-v1';
  const A_KEY = 'pq-ai-active-v1';
  const C_KEY = 'pq-ai-traincfg-v1';
  const TABLE = 'pq_ai_samples';

  const MAX_TEXT = 2000;
  const MAX_IMAGE = 300;
  const MIN_TEXT = 10;
  const MIN_IMAGE = 10;

  let samples = [];   // { id, kind:'text'|'image', y:0|1, text?, thumb?, d?, at, src, up }
  let models = [];    // { id, kind, name, at, n, acc, hold, w }
  let active = { text: 'official', image: 'official' };
  let cfg = { cloud: false, shared: false };
  let lastSync = 0;
  let busy = null;
  let deletedIds = new Set();   // 本机删掉的样本 id（落盘合并时跳过）
  let cleared = {};             // 各类型最后一次清空时间

  /* ---------------- 存储 ---------------- */

  /* 桌面版：file:// 下每个窗口的 localStorage 是隔离的（主窗口 / 异地联机窗口），
     所以训练集与模型改由主进程落盘，两个窗口共用同一份；网页版/安卓仍用 localStorage。 */
  const FILE_STORE = !!(window.api && window.api.aiStore);
  const LS_TS = 'pq-ai-lastsync-v1';

  function readFileStore() {
    try {
      const raw = window.api.aiStore.load();
      return raw ? JSON.parse(raw) : {};
    } catch (e) {
      return {};
    }
  }
  /* 落盘前先与磁盘上的状态合并：主窗口和异地联机窗口可能各自新增了样本/模型，
     直接覆盖会把对方刚记的样本弄丢 */
  function writeFileStore() {
    try {
      const disk = readFileStore() || {};
      if (Array.isArray(disk.samples)) {
        const known = new Set(samples.map((x) => x.id));
        for (const x of disk.samples) {
          if (x && x.id && x.kind && !known.has(x.id) && !deletedIds.has(x.id)) {
            samples.push(x);
            known.add(x.id);
          }
        }
      }
      if (Array.isArray(disk.models)) {
        const known = new Set(models.map((x) => x.id));
        for (const x of disk.models) {
          if (x && x.id && x.kind && x.w && !known.has(x.id)) {
            models.push(x);
            known.add(x.id);
          }
        }
      }
      /* 合并后兜底限量，防两个窗口来回加导致无限膨胀 */
      if (samples.length > MAX_TEXT + MAX_IMAGE + 200) {
        samples = samples.sort((a, b) => b.at - a.at).slice(0, MAX_TEXT + MAX_IMAGE);
      }
      if (models.length > 16) models = models.sort((a, b) => b.at - a.at).slice(0, 16);
      if (deletedIds.size > 1000) deletedIds = new Set([...deletedIds].slice(-1000));
      window.api.aiStore.save(
        JSON.stringify({ v: 1, samples, models, active, cfg, lastSync, deleted: [...deletedIds], cleared })
      );
    } catch (e) {}
  }

  function readJson(key, def) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : def;
    } catch (e) {
      return def;
    }
  }
  function writeJson(key, v) {
    if (FILE_STORE) {
      /* 调用方已更新内存变量，这里只负责整体落盘 */
      if (key === S_KEY) samples = v;
      else if (key === M_KEY) models = v;
      else if (key === A_KEY) active = v;
      else if (key === C_KEY) cfg = v;
      else if (key === LS_TS) lastSync = Number(v) || 0;
      writeFileStore();
      return true;
    }
    try {
      localStorage.setItem(key, JSON.stringify(v));
      return true;
    } catch (e) {
      return false;
    }
  }

  function load() {
    if (FILE_STORE) {
      const d = readFileStore();
      if (d && typeof d === 'object' && (Array.isArray(d.samples) || Array.isArray(d.models))) {
        samples = Array.isArray(d.samples) ? d.samples.filter((x) => x && x.id && x.kind) : [];
        models = Array.isArray(d.models) ? d.models.filter((x) => x && x.id && x.kind && x.w) : [];
        if (d.active && typeof d.active === 'object') active = { text: d.active.text || 'official', image: d.active.image || 'official' };
        if (d.cfg && typeof d.cfg === 'object') cfg = { cloud: !!d.cfg.cloud, shared: !!d.cfg.shared };
        lastSync = Number(d.lastSync) || 0;
        deletedIds = new Set(Array.isArray(d.deleted) ? d.deleted : []);
        cleared = d.cleared && typeof d.cleared === 'object' ? d.cleared : {};
        return;
      }
    }
    const s = readJson(S_KEY, []);
    samples = Array.isArray(s) ? s.filter((x) => x && x.id && x.kind) : [];
    const m = readJson(M_KEY, []);
    models = Array.isArray(m) ? m.filter((x) => x && x.id && x.kind && x.w) : [];
    const a = readJson(A_KEY, null);
    if (a && typeof a === 'object') active = { text: a.text || 'official', image: a.image || 'official' };
    const c = readJson(C_KEY, null);
    if (c && typeof c === 'object') cfg = { cloud: !!c.cloud, shared: !!c.shared };
    lastSync = Number(readJson(LS_TS, 0)) || 0;
  }
  load();

  function persistSamples() {
    /* 超上限先丢最老的、且已上传过的（没上传的先留着，别丢用户数据） */
    const keep = [];
    for (const kind of ['text', 'image']) {
      const cap = kind === 'text' ? MAX_TEXT : MAX_IMAGE;
      const list = samples.filter((s) => s.kind === kind);
      if (list.length <= cap) {
        keep.push(...list);
        continue;
      }
      const sorted = list.slice().sort((a, b) => (a.up ? 0 : 1) - (b.up ? 0 : 1) || b.at - a.at);
      keep.push(...sorted.slice(0, cap));
    }
    samples = keep;
    if (!writeJson(S_KEY, samples)) {
      /* 配额满了：丢掉最早的画面样本再试一次 */
      samples = samples.filter((s, i) => s.kind !== 'image' || i > 50);
      writeJson(S_KEY, samples);
    }
  }
  function persistModels() {
    /* 每类只留最近 8 个模型 */
    for (const kind of ['text', 'image']) {
      const list = models.filter((m) => m.kind === kind).sort((a, b) => b.at - a.at);
      const drop = list.slice(8).map((m) => m.id);
      if (drop.length) models = models.filter((m) => !drop.includes(m.id));
    }
    writeJson(M_KEY, models);
    writeJson(A_KEY, active);
  }

  function uid(prefix) {
    return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  /* ---------------- 样本 ---------------- */

  function counts() {
    const text = samples.filter((s) => s.kind === 'text');
    const image = samples.filter((s) => s.kind === 'image');
    return {
      text: text.length,
      image: image.length,
      textFish: text.filter((s) => s.y === 1).length,
      imageFish: image.filter((s) => s.y === 1).length,
      /* 「待上传」只算真会上传的：候选 / 回滚 / 新手观察永远不上传，别让数字虚高 */
      pending: samples.filter((s) => !s.up && trainable(s)).length,
      /* 翻案候选池：待确认 / 已回滚 / 新手观察 —— 都不进训练、不上传 */
      pool: samples.filter((s) => s.status === 'pending').length,
      rolledback: samples.filter((s) => s.status === 'rollback').length,
      probation: samples.filter((s) => s.status === 'probation').length,
      trainable: samples.filter(trainable).length,
    };
  }

  /* 只有直接采纳（direct）、冷静期确认（confirmed）或历史老样本（无 status）能进训练集。
     probation = 新手期（前 7 天）的翻案，只在本机改判，不进训练池、不上传。 */
  function trainable(s) {
    if (!s) return false;
    return !s.status || s.status === 'direct' || s.status === 'confirmed';
  }

  /* 文字纠错样本：y=1 闲聊 / y=0 正经事。meta: { status, weight }（翻案风控写入） */
  function addTextSample(text, y, note, meta) {
    const t = String(text || '').trim().slice(0, 300);
    if (!t) return null;
    const yv = y ? 1 : 0;
    const mv = meta || {};
    /* 同一句只留一条，重复标注以最新为准 */
    const hit = samples.find((s) => s.kind === 'text' && s.text === t);
    if (hit) {
      hit.y = yv;
      hit.at = Date.now();
      hit.up = 0;
      hit.note = note || '';
      if (mv.status) hit.status = mv.status;
      if (typeof mv.weight === 'number') hit.weight = mv.weight;
      persistSamples();
      return hit;
    }
    const s = { id: uid('s'), kind: 'text', y: yv, text: t, at: Date.now(), src: 'local', up: 0, note: note || '' };
    if (mv.status) s.status = mv.status;
    if (typeof mv.weight === 'number') s.weight = mv.weight;
    samples.push(s);
    persistSamples();
    return s;
  }

  /* 画面纠错样本：d=官方 logit 差（ln p1 - ln p0），thumb=缩略图，y=1 摸鱼 / 0 认真 */
  function addImageSample(shot, y, meta) {
    if (!shot || !isFinite(shot.d)) return null;
    const mv = meta || {};
    const s = {
      id: uid('i'),
      kind: 'image',
      y: y ? 1 : 0,
      d: Number(shot.d.toFixed(4)),
      thumb: String(shot.thumb || '').slice(0, 20000),
      at: Date.now(),
      src: 'local',
      up: 0,
    };
    if (mv.status) s.status = mv.status;
    if (typeof mv.weight === 'number') s.weight = mv.weight;
    samples.push(s);
    persistSamples();
    return s;
  }

  /* 翻案风控用：改样本状态（pending / confirmed / rollback / direct） */
  function setSampleStatus(id, status) {
    const s = samples.find((x) => x.id === id);
    if (!s) return false;
    s.status = status;
    s.up = 0; // 状态变了要重新同步（rollback 的不会上传）
    persistSamples();
    return true;
  }

  /* 候选池样本（待确认） */
  function pendingSamples(n) {
    return samples
      .filter((s) => s.status === 'pending')
      .sort((a, b) => b.at - a.at)
      .slice(0, n || 10);
  }

  function removeSample(id) {
    deletedIds.add(id);
    samples = samples.filter((s) => s.id !== id);
    persistSamples();
  }

  function clearSamples(kind) {
    for (const s of samples) if (!kind || s.kind === kind) deletedIds.add(s.id);
    cleared[kind || 'all'] = Date.now();
    samples = kind ? samples.filter((s) => s.kind !== kind) : [];
    persistSamples();
  }

  function latest(kind, n) {
    return samples
      .filter((s) => s.kind === kind)
      .sort((a, b) => b.at - a.at)
      .slice(0, n || 20);
  }

  /* ---------------- 云端同步（用户显式允许才走） ---------------- */

  function cloudReady() {
    return !!(window.PQCloud && typeof PQCloud.database === 'function' && PQCloud.database());
  }

  function setConfig(patch) {
    cfg = { ...cfg, ...(patch || {}) };
    writeJson(C_KEY, cfg);
    return cfg;
  }

  async function sync() {
    if (!cfg.cloud) return { ok: false, message: '还没允许云端同步训练集' };
    const db = cloudReady() ? PQCloud.database() : null;
    if (!db) return { ok: false, message: '请先在设置里登录云账号' };
    if (busy === 'sync') return { ok: false, message: '正在同步中' };
    busy = 'sync';
    const out = { ok: true, up: 0, down: 0, message: '' };
    try {
      const acct = (PQCloud.account && PQCloud.account()) || {};
      const pend = samples.filter((s) => !s.up && trainable(s)).slice(0, 200);
      for (let i = 0; i < pend.length; i += 50) {
        const rows = pend.slice(i, i + 50).map((s) => ({
          id: s.id,
          kind: s.kind,
          label: s.y,
          payload:
            s.kind === 'text'
              ? { text: s.text, note: s.note || '' }
              : /* 摄像头缩略图只在「自己账号」内同步；进入公共训练集只带数值，不带画面 */
                { d: s.d, thumb: cfg.shared ? '' : String(s.thumb || '').slice(0, 20000) },
          shared: !!cfg.shared,
          owner_name: acct.name || null,
        }));
        /* upsert：断网重试时同一 id 不会撞主键 */
        const { error } = await db.from(TABLE).upsert(rows, { onConflict: 'id' });
        if (error) throw error;
        pend.slice(i, i + 50).forEach((s) => (s.up = 1));
        out.up += Math.min(50, pend.length - i);
      }

      const { data: rows, error: e2 } = await db
        .from(TABLE)
        .select('id,kind,label,payload,created_at,owner_id')
        .order('created_at', { ascending: false })
        .limit(800);
      if (e2) throw e2;
      const known = new Set(samples.map((s) => s.id));
      for (const r of rows || []) {
        if (!r || !r.id || known.has(r.id)) continue;
        /* 没开「参与公共训练集」就只认自己账号的样本，别把别人的悄悄拉下来训练 */
        if (!cfg.shared && acct.id && String(r.owner_id || '') !== String(acct.id)) continue;
        const p = r.payload || {};
        const kind = r.kind === 'image' ? 'image' : 'text';
        if (kind === 'text' && !p.text) continue;
        if (kind === 'image' && !isFinite(p.d)) continue;
        samples.push({
          id: r.id,
          kind,
          y: r.label ? 1 : 0,
          text: kind === 'text' ? String(p.text).slice(0, 300) : undefined,
          thumb: kind === 'image' ? String(p.thumb || '').slice(0, 20000) : undefined,
          d: kind === 'image' ? Number(p.d) : undefined,
          at: new Date(r.created_at || Date.now()).getTime(),
          src: 'cloud',
          up: 1,
        });
        out.down += 1;
      }
      persistSamples();
      lastSync = Date.now();
      writeJson(LS_TS, lastSync);
      const c = counts();
      out.message = `上传 ${out.up} 条 · 拉取 ${out.down} 条 · 本机样本 文字 ${c.text} / 画面 ${c.image}`;
      return out;
    } catch (err) {
      const msg = String((err && err.message) || err);
      out.ok = false;
      out.message =
        /relation|does not exist/i.test(msg)
          ? '云端训练集表还没准备好'
          : /permission|policy|42501/i.test(msg)
            ? '当前账号无权访问训练集'
            : '同步失败：' + msg.slice(0, 60);
      return out;
    } finally {
      busy = null;
    }
  }

  /* ---------------- 训练：文字输出层 ---------------- */

  function encF32(arr) {
    const u = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
    let s = '';
    const CH = 4096;
    for (let i = 0; i < u.length; i += CH) {
      s += String.fromCharCode.apply(null, u.subarray(i, Math.min(i + CH, u.length)));
    }
    return btoa(s);
  }
  function decF32(b64) {
    const bin = atob(b64);
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return new Float32Array(u.buffer, 0, Math.floor(u.byteLength / 4));
  }

  function softmax2(a, b) {
    const m = Math.max(a, b);
    const e0 = Math.exp(a - m);
    const e1 = Math.exp(b - m);
    return [e0 / (e0 + e1), e1 / (e0 + e1)];
  }

  function accOf(rows, predict) {
    if (!rows.length) return 0;
    let ok = 0;
    for (const r of rows) if (predict(r) === r.y) ok += 1;
    return ok / rows.length;
  }

  /* 全批 Adam，训练 k2(512×2)+b2(2)，特征层与 k1 冻结 */
  function fitOutputLayer(rows, k20, b20, epochs, lr, l2) {
    const D = 512;
    const k2 = k20.slice();
    const b2 = b20.slice();
    const nPos = rows.filter((r) => r.y === 1).length;
    const nNeg = rows.length - nPos;
    const wPos = nPos ? rows.length / (2 * nPos) : 1;
    const wNeg = nNeg ? rows.length / (2 * nNeg) : 1;
    const mk = new Float32Array(k2.length);
    const mb = new Float32Array(2);
    const vk = new Float32Array(k2.length);
    const vb = new Float32Array(2);
    const b1 = 0.9;
    const b2m = 0.999;
    const eps = 1e-8;
    const gk = new Float32Array(k2.length);
    const gb = new Float32Array(2);

    for (let ep = 0; ep < epochs; ep++) {
      gk.fill(0);
      gb.fill(0);
      let loss = 0;
      for (const r of rows) {
        const h = r.x;
        let z0 = b2[0];
        let z1 = b2[1];
        for (let j = 0; j < D; j++) {
          const hj = h[j];
          if (!hj) continue;
          z0 += hj * k2[j * 2];
          z1 += hj * k2[j * 2 + 1];
        }
        const p = softmax2(z0, z1);
        const w = r.y === 1 ? wPos : wNeg;
        loss -= w * Math.log(Math.max(p[r.y], 1e-9));
        const g0 = (p[0] - (r.y === 0 ? 1 : 0)) * w;
        const g1 = (p[1] - (r.y === 1 ? 1 : 0)) * w;
        gb[0] += g0;
        gb[1] += g1;
        for (let j = 0; j < D; j++) {
          const hj = h[j];
          if (!hj) continue;
          gk[j * 2] += hj * g0;
          gk[j * 2 + 1] += hj * g1;
        }
      }
      const t = ep + 1;
      const c1 = 1 - Math.pow(b1, t);
      const c2 = 1 - Math.pow(b2m, t);
      for (let i = 0; i < k2.length; i++) {
        const g = gk[i] / rows.length + l2 * k2[i];
        mk[i] = b1 * mk[i] + (1 - b1) * g;
        vk[i] = b2m * vk[i] + (1 - b2m) * g * g;
        k2[i] -= (lr * (mk[i] / c1)) / (Math.sqrt(vk[i] / c2) + eps);
      }
      for (let i = 0; i < 2; i++) {
        const g = gb[i] / rows.length;
        mb[i] = b1 * mb[i] + (1 - b1) * g;
        vb[i] = b2m * vb[i] + (1 - b2m) * g * g;
        b2[i] -= (lr * (mb[i] / c1)) / (Math.sqrt(vb[i] / c2) + eps);
      }
    }
    return { k2, b2 };
  }

  async function trainText(onProgress) {
    if (!window.AIChat) return { ok: false, message: '闲聊雷达还没加载' };
    const rows = samples.filter((s) => s.kind === 'text' && s.text && trainable(s));
    if (rows.length < MIN_TEXT) return { ok: false, message: `至少需要 ${MIN_TEXT} 条文字样本（现在 ${rows.length} 条）` };
    const pos = rows.filter((r) => r.y === 1).length;
    if (pos < 3 || rows.length - pos < 3) {
      return { ok: false, message: '「闲聊」和「正经事」各至少要有 3 条样本，否则学不出边界' };
    }
    const feats = [];
    for (let i = 0; i < rows.length; i++) {
      try {
        const h = await AIChat.features(rows[i].text);
        if (h) feats.push({ x: h, y: rows[i].y });
      } catch (_) {}
      if (onProgress) onProgress(i + 1, rows.length);
    }
    if (feats.length < MIN_TEXT) return { ok: false, message: '可用的文字样本太少（分词后为空）' };

    /* ≥40 条时留 20% 做验证，否则用训练集自身精度（会偏乐观，界面上标注） */
    const shuffled = feats.slice().sort(() => Math.random() - 0.5);
    const hold = feats.length >= 40 ? shuffled.slice(0, Math.round(feats.length * 0.2)) : [];
    const train = hold.length ? shuffled.slice(hold.length) : shuffled;

    const base = AIChat.officialOut();
    if (!base) return { ok: false, message: '官方权重没加载' };
    const fit = fitOutputLayer(train, base.k2, base.b2, 260, 0.02, 1e-4);
    const predict = (r) => {
      let z0 = fit.b2[0];
      let z1 = fit.b2[1];
      for (let j = 0; j < 512; j++) {
        const hj = r.x[j];
        if (!hj) continue;
        z0 += hj * fit.k2[j * 2];
        z1 += hj * fit.k2[j * 2 + 1];
      }
      return z1 > z0 ? 1 : 0;
    };
    const accTrain = accOf(train, predict);
    const accHold = hold.length ? accOf(hold, predict) : null;
    const before = {
      accTrain: accOf(train, (r) => {
        let z0 = base.b2[0];
        let z1 = base.b2[1];
        for (let j = 0; j < 512; j++) {
          const hj = r.x[j];
          if (!hj) continue;
          z0 += hj * base.k2[j * 2];
          z1 += hj * base.k2[j * 2 + 1];
        }
        return z1 > z0 ? 1 : 0;
      }),
      accHold: hold.length
        ? accOf(hold, (r) => {
            let z0 = base.b2[0];
            let z1 = base.b2[1];
            for (let j = 0; j < 512; j++) {
              const hj = r.x[j];
              if (!hj) continue;
              z0 += hj * base.k2[j * 2];
              z1 += hj * base.k2[j * 2 + 1];
            }
            return z1 > z0 ? 1 : 0;
          })
        : null,
    };

    const m = {
      id: uid('m'),
      kind: 'text',
      name: '我的文字模型',
      at: Date.now(),
      n: feats.length,
      acc: +accTrain.toFixed(3),
      hold: accHold == null ? null : +accHold.toFixed(3),
      w: { k2: encF32(fit.k2), b2: encF32(fit.b2) },
    };
    models.push(m);
    active.text = m.id; // 训练完默认就用它，用户可在设置里切回官方
    persistModels();
    applyActive();
    return { ok: true, model: m, before, after: { acc: accTrain, hold: accHold } };
  }

  /* ---------------- 训练：画面校准（温度 + 偏置） ---------------- */

  function trainImage() {
    const rows = samples.filter((s) => s.kind === 'image' && isFinite(s.d) && trainable(s));
    if (rows.length < MIN_IMAGE) return { ok: false, message: `至少需要 ${MIN_IMAGE} 条画面样本（现在 ${rows.length} 条）` };
    const pos = rows.filter((r) => r.y === 1).length;
    if (pos < 3 || rows.length - pos < 3) return { ok: false, message: '「摸鱼」和「认真」各至少要有 3 条样本' };

    const sig = (x) => 1 / (1 + Math.exp(-x));
    const nPos = pos;
    const nNeg = rows.length - pos;
    const wPos = rows.length / (2 * nPos);
    const wNeg = rows.length / (2 * nNeg);

    const start = activeImageW();
    let logT = start && start.T > 0 ? Math.log(start.T) : 0; // T=1
    let b = start && isFinite(start.b) ? start.b : 0;
    let mT = 0;
    let vT = 0;
    let mb = 0;
    let vb = 0;
    const lr = 0.05;
    for (let it = 1; it <= 500; it++) {
      const T = Math.exp(logT);
      let gT = 0;
      let gb = 0;
      for (const r of rows) {
        const p = sig(r.d / T + b);
        const w = r.y === 1 ? wPos : wNeg;
        const e = (p - r.y) * w;
        gT += (e * -r.d) / (T * T);
        gb += e;
      }
      gT /= rows.length;
      gb /= rows.length;
      mT = 0.9 * mT + 0.1 * gT;
      vT = 0.999 * vT + 0.001 * gT * gT;
      mb = 0.9 * mb + 0.1 * gb;
      vb = 0.999 * vb + 0.001 * gb * gb;
      const c1 = 1 - Math.pow(0.9, it);
      const c2 = 1 - Math.pow(0.999, it);
      /* 梯度是对 logT 的（dT = T·dlogT），这里换算一下 */
      logT -= (lr * (mT / c1) * Math.exp(logT)) / (Math.sqrt(vT / c2) + 1e-8);
      b -= (lr * (mb / c1)) / (Math.sqrt(vb / c2) + 1e-8);
      logT = Math.max(-3, Math.min(3, logT)); // T ∈ [0.05, 20]，防数值跑飞
    }
    const T = Math.exp(logT);
    const accBefore = accOf(rows, (r) => (sig(r.d) > 0.5 ? 1 : 0)); // 官方：T=1,b=0
    const accAfter = accOf(rows, (r) => (sig(r.d / T + b) > 0.5 ? 1 : 0));
    const m = {
      id: uid('m'),
      kind: 'image',
      name: '我的画面校准',
      at: Date.now(),
      n: rows.length,
      acc: +accAfter.toFixed(3),
      hold: null,
      w: { T: +T.toFixed(4), b: +b.toFixed(4) },
    };
    models.push(m);
    active.image = m.id;
    persistModels();
    applyActive();
    return { ok: true, model: m, before: { acc: accBefore }, after: { acc: accAfter }, T, b };
  }

  /* ---------------- 模型切换 / 应用 ---------------- */

  function modelList(kind) {
    return models.filter((m) => m.kind === kind).sort((a, b) => b.at - a.at);
  }

  function activeId(kind) {
    return (active && active[kind]) || 'official';
  }

  function textW() {
    const id = activeId('text');
    if (id === 'official') return null;
    const m = models.find((x) => x.id === id && x.kind === 'text');
    if (!m) return null;
    try {
      return { k2: decF32(m.w.k2), b2: decF32(m.w.b2) };
    } catch (e) {
      return null;
    }
  }

  function activeImageW() {
    const id = activeId('image');
    if (id === 'official') return null;
    const m = models.find((x) => x.id === id && x.kind === 'image');
    return m && m.w && m.w.T > 0 ? { T: m.w.T, b: m.w.b || 0 } : null;
  }

  /* 把当前选中的模型装进两个 AI 模块（切换后立刻生效，无需重启） */
  function applyActive() {
    if (window.AIChat && AIChat.setHead) AIChat.setHead(textW());
    if (window.AIWatch && AIWatch.setCalib) AIWatch.setCalib(activeImageW());
  }

  function setActive(kind, id) {
    active[kind] = id || 'official';
    persistModels();
    applyActive();
  }

  function removeModel(id) {
    models = models.filter((m) => m.id !== id);
    if (active.text === id) active.text = 'official';
    if (active.image === id) active.image = 'official';
    persistModels();
    applyActive();
  }

  function info() {
    const c = counts();
    const t = modelList('text').find((m) => m.id === activeId('text'));
    const i = modelList('image').find((m) => m.id === activeId('image'));
    return {
      counts: c,
      cfg: { ...cfg },
      cloudReady: cloudReady(),
      lastSync,
      text: { active: activeId('text'), model: t || null, models: modelList('text').length },
      image: { active: activeId('image'), model: i || null, models: modelList('image').length },
    };
  }

  return {
    counts,
    info,
    addTextSample,
    addImageSample,
    setSampleStatus,
    pendingSamples,
    trainable,
    removeSample,
    clearSamples,
    latest,
    setConfig,
    sync,
    trainText,
    trainImage,
    applyActive,
    setActive,
    activeId,
    modelList,
    removeModel,
    list: () => samples,
  };
})();
window.AITrain = AITrain;
