'use strict';
/* AIChat —— 自习房「闲聊雷达」：本地文本分类，判断发言是「工作/学习」还是「摸鱼闲聊」
 *
 * 模型链路（全部本地，不联网）：
 *   WordPiece 分词 → gte-small-zh 编码器（vendor/pq-text/encoder.onnx，int8）
 *   → 512 维 L2 归一化句向量 → 两层 MLP（vendor/pq-text/weights.bin）
 *   → softmax[工作, 摸鱼]
 * 置信度 < 0.8 判「不确定」不表态（避免硬判，模型抓的是词汇表面特征）。
 * 资源加载：桌面 file:// 禁 fetch → 走 preload 的 readVendorFile 读盘；
 *          安卓 WebView / 网页（https）→ 直接 fetch。
 */
const AIChat = (() => {
  const DIR = 'vendor/pq-text/';
  const CONF_MIN = 0.8;    // 低于此置信度 → 不确定
  const MAX_TOKENS = 96;   // 聊天一句话截断（BERT 上限 512，够用即可省算力）
  const CACHE_MAX = 500;   // 判定结果缓存条数
  const CLS = 101, SEP = 102, UNK = 100, PAD = 0;

  let session = null;
  let vocab = null;        // Map<string, id>
  let head = null;         // 官方头：{ k1: Float32Array, b1, k2, b2 }
  let override = null;     // 自训练头：只覆盖输出层 { k2, b2 }
  let booting = null;
  let bootErr = null;

  const cache = new Map(); // text -> { label, p }
  const queue = [];
  let busy = false;

  /* ---------------- 资源加载 ---------------- */

  function b64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  /* 桌面走 preload 直接读盘（省一次 base64 膨胀），其余走 fetch */
  async function readBytes(name) {
    const api = window.api;
    if (api && typeof api.readVendorFile === 'function') {
      const bytes = await api.readVendorFile(DIR + name).catch(() => null);
      if (bytes && bytes.byteLength) return new Uint8Array(bytes);
    }
    const res = await fetch(DIR + name);
    if (!res.ok) throw new Error('读取失败 ' + name + ' (' + res.status + ')');
    return new Uint8Array(await res.arrayBuffer());
  }

  function ensureOrt() {
    const ort = window.ort;
    if (!ort) throw new Error('onnxruntime 未加载');
    ort.env.wasm.proxy = false;
    ort.env.wasm.numThreads = 1;
    if (!ort.env.wasm.wasmBinary) {
      if (window.__ORT_WASM_B64) {
        ort.env.wasm.wasmBinary = b64ToBytes(window.__ORT_WASM_B64); // 桌面：内嵌 wasm
        window.__ORT_WASM_B64 = null;
      } else {
        ort.env.wasm.wasmPaths = new URL('vendor/ort/', location.href).href; // 绝对地址（相对解析会拼错目录）
      }
    }
    return ort;
  }

  function parseHead(buf) {
    const f = new Float32Array(buf.buffer ? buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) : buf);
    const D = 512;
    let o = 0;
    const k1 = f.subarray(o, (o += D * D));   // [in][out]
    const b1 = f.subarray(o, (o += D));
    const k2 = f.subarray(o, (o += D * 2));   // [in][out]
    const b2 = f.subarray(o, (o += 2));
    return { k1, b1, k2, b2 };
  }

  async function boot() {
    if (session && vocab && head) return;
    if (booting) return booting;
    booting = (async () => {
      try {
        const ort = ensureOrt();
        const [vocabBytes, headBytes, modelBytes] = await Promise.all([
          readBytes('vocab.txt'),
          readBytes('weights.bin'),
          readBytes('encoder.onnx'),
        ]);
        const text = new TextDecoder('utf-8').decode(vocabBytes);
        const map = new Map();
        text.split('\n').forEach((w, i) => {
          if (w !== undefined) map.set(w.replace(/\r$/, ''), i);
        });
        vocab = map;
        head = parseHead(headBytes);
        session = await ort.InferenceSession.create(modelBytes, { executionProviders: ['wasm'] });
        bootErr = null;
      } catch (err) {
        bootErr = err;
        booting = null;
        throw err;
      }
    })();
    return booting;
  }

  /* ---------------- 分词（复刻 HF BertNormalizer + BertPreTokenizer + WordPiece） ---------------- */

  function isControlChar(ch) {
    if (ch === '\t' || ch === '\n' || ch === '\r') return false;
    return /\p{C}/u.test(ch);
  }
  function isWhitespaceChar(ch) {
    return /\s/u.test(ch) || /\p{Zs}/u.test(ch);
  }
  function isChineseChar(cp) {
    return (
      (cp >= 0x4e00 && cp <= 0x9fff) ||
      (cp >= 0x3400 && cp <= 0x4dbf) ||
      (cp >= 0x20000 && cp <= 0x2a6df) ||
      (cp >= 0x2a700 && cp <= 0x2b73f) ||
      (cp >= 0x2b740 && cp <= 0x2b81f) ||
      (cp >= 0x2b820 && cp <= 0x2ceaf) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0x2f800 && cp <= 0x2fa1f)
    );
  }
  function isPunc(ch) {
    const cp = ch.codePointAt(0);
    if ((cp >= 33 && cp <= 47) || (cp >= 58 && cp <= 64) || (cp >= 91 && cp <= 96) || (cp >= 123 && cp <= 126)) return true;
    return /\p{P}/u.test(ch);
  }

  function normalizeText(text) {
    // 1) clean_text：丢控制符，空白统一成单个空格
    let s = '';
    for (const ch of String(text)) {
      const cp = ch.codePointAt(0);
      if (cp === 0 || cp === 0xfffd || isControlChar(ch)) continue;
      s += isWhitespaceChar(ch) ? ' ' : ch;
    }
    // 2) 汉字两侧加空格
    let t = '';
    for (const ch of s) {
      if (isChineseChar(ch.codePointAt(0))) t += ' ' + ch + ' ';
      else t += ch;
    }
    // 3) 小写 + 去重音符
    t = t.toLowerCase().normalize('NFD').replace(/\p{Mn}/gu, '');
    return t;
  }

  function preTokenize(s) {
    const words = [];
    for (const chunk of s.split(/\s+/)) {
      if (!chunk) continue;
      let cur = '';
      for (const ch of chunk) {
        if (isPunc(ch)) {
          if (cur) words.push(cur);
          cur = '';
          words.push(ch);
        } else {
          cur += ch;
        }
      }
      if (cur) words.push(cur);
    }
    return words;
  }

  function wordPiece(word) {
    if (word.length > 100) return [UNK];
    const ids = [];
    let start = 0;
    while (start < word.length) {
      let end = word.length;
      let hit = null;
      while (start < end) {
        const sub = (start > 0 ? '##' : '') + word.slice(start, end);
        if (vocab.has(sub)) {
          hit = vocab.get(sub);
          break;
        }
        end -= 1;
      }
      if (hit == null) return [UNK];
      ids.push(hit);
      start = end;
    }
    return ids;
  }

  /* 文本 → { ids, tokens }（含特殊符号，已截断） */
  function encodeText(text) {
    const words = preTokenize(normalizeText(text));
    const ids = [CLS];
    const tokens = ['[CLS]'];
    for (const w of words) {
      for (const id of wordPiece(w)) {
        if (ids.length >= MAX_TOKENS + 1) break;
        ids.push(id);
        tokens.push(w);
      }
      if (ids.length >= MAX_TOKENS + 1) break;
    }
    ids.push(SEP);
    tokens.push('[SEP]');
    return { ids, tokens };
  }

  /* ---------------- 推理 ---------------- */

  async function embed(ids) {
    const ort = window.ort;
    const n = ids.length;
    const inputIds = new BigInt64Array(n);
    const mask = new BigInt64Array(n);
    const types = new BigInt64Array(n);
    for (let i = 0; i < n; i++) {
      inputIds[i] = BigInt(ids[i]);
      mask[i] = 1n;
      types[i] = 0n;
    }
    const feeds = {
      input_ids: new ort.Tensor('int64', inputIds, [1, n]),
      attention_mask: new ort.Tensor('int64', mask, [1, n]),
      token_type_ids: new ort.Tensor('int64', types, [1, n]),
    };
    const out = await session.run(feeds);
    return out.embedding.data; // Float32Array(512)，已 L2 归一化
  }

  /* 头部 MLP：relu(x·k1 + b1) · k2 + b2 → softmax
   * 自训练只替换输出层 k2/b2（官方特征层冻结），因此单次训练只需几百毫秒 */
  function headForward(vec) {
    const D = 512;
    const { k1, b1 } = head;
    const k2 = override ? override.k2 : head.k2;
    const b2 = override ? override.b2 : head.b2;
    const hid = new Float32Array(D);
    for (let o = 0; o < D; o++) {
      let sum = b1[o];
      const base = o;
      for (let i = 0; i < D; i++) sum += vec[i] * k1[i * D + base];
      hid[o] = sum > 0 ? sum : 0;
    }
    const logits = [b2[0], b2[1]];
    for (let k = 0; k < 2; k++) {
      let sum = logits[k];
      const base = k;
      for (let j = 0; j < D; j++) sum += hid[j] * k2[j * 2 + base];
      logits[k] = sum;
    }
    const m = Math.max(logits[0], logits[1]);
    const e0 = Math.exp(logits[0] - m);
    const e1 = Math.exp(logits[1] - m);
    const s = e0 + e1;
    return { work: e0 / s, fish: e1 / s };
  }

  async function runOne(text) {
    const { ids, tokens } = encodeText(text);
    if (ids.length <= 2) return { label: 'uncertain', p: 0.5, tokens };
    const vec = await embed(ids);
    const p = headForward(vec);
    const pFish = p.fish;
    let label = 'uncertain';
    if (Math.max(pFish, 1 - pFish) >= CONF_MIN) label = pFish > 0.5 ? 'fish' : 'work';
    return { label, p: pFish, tokens };
  }

  /* 串行队列，避免多句同时跑 wasm 抢线程；结果进 LRU 式缓存 */
  function enqueue(text) {
    return new Promise((resolve) => {
      queue.push({ text, resolve });
      pump();
    });
  }

  async function pump() {
    if (busy) return;
    const job = queue.shift();
    if (!job) return;
    busy = true;
    try {
      const hit = cache.get(job.text);
      if (hit) {
        job.resolve(hit);
      } else {
        await boot();
        const r = await runOne(job.text);
        if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
        cache.set(job.text, r);
        job.resolve(r);
      }
    } catch (err) {
      job.resolve({ label: 'error', p: 0.5, error: String((err && err.message) || err) });
    } finally {
      busy = false;
      if (queue.length) pump();
    }
  }

  /* 对外：判定一句话，返回 { label: 'fish'|'work'|'uncertain', p, tokens } */
  function classify(text) {
    const clean = String(text || '').trim();
    if (!clean) return Promise.resolve({ label: 'uncertain', p: 0.5, tokens: [] });
    return enqueue(clean);
  }

  function preload() {
    return boot().catch((err) => {
      console.warn('[AIChat] 预热失败', err);
    });
  }

  function status() {
    return { ready: !!session, error: bootErr ? String(bootErr.message || bootErr) : null, queued: queue.length };
  }

  /* ---------------- 自训练支持 ---------------- */

  /* 返回 512 维隐层特征 h = relu(x·k1 + b1)：训练输出层时的输入（官方特征层冻结） */
  async function features(text) {
    await boot();
    const clean = String(text || '').trim();
    if (!clean) return null;
    const { ids } = encodeText(clean);
    if (ids.length <= 2) return null;
    const vec = await embed(ids);
    const D = 512;
    const { k1, b1 } = head;
    const hid = new Float32Array(D);
    for (let o = 0; o < D; o++) {
      let sum = b1[o];
      for (let i = 0; i < D; i++) sum += vec[i] * k1[i * D + o];
      hid[o] = sum > 0 ? sum : 0;
    }
    return hid;
  }

  /* 切模型：传 null 回到官方；只接自训练出来的输出层 */
  function setHead(o) {
    override = o && o.k2 && o.b2 ? { k2: o.k2, b2: o.b2 } : null;
    cache.clear();
  }

  /* 官方输出层（训练时的热启动初值） */
  function officialOut() {
    return head ? { k2: head.k2.slice(), b2: head.b2.slice() } : null;
  }

  /* _encode 仅供测试脚本核对分词结果（需先 preload） */
  return {
    classify,
    preload,
    status,
    ready: () => !!(session && vocab && head),
    features,
    setHead,
    officialOut,
    confMin: CONF_MIN,
    _encode: (t) => (vocab ? encodeText(t) : null),
  };
})();
window.AIChat = AIChat;
