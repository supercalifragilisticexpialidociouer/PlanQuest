/* PlanQuest 分享模块：成绩海报 + 链接 + 二维码
 *
 * 隐私原则（重要）：
 *  1) 所有数据项默认「不展示」，必须由用户逐项勾选才会画进海报；
 *  2) 不做「一键分享」——必须先看预览、先确认开关，再导出；
 *  3) 未勾选的字段根本不参与绘制（不是画完再遮挡，canvas 像素可还原）。
 */
(function () {
  'use strict';

  var SHARE_URL = window.PQ_SHARE_URL || 'https://planquest-pwa.app.workbuddy.host';

  /* ============================ 二维码编码器 ============================
   * byte 模式 / 纠错等级 L / version 1~6（最多 106 字节，足够放链接）
   * 实现依据 ISO/IEC 18004，包含 RS 纠错、掩码评分与格式信息。
   */
  var QR = (function () {
    var EXP = new Uint8Array(512);
    var LOG = new Uint8Array(256);
    (function () {
      var x = 1;
      for (var i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
      for (var j = 255; j < 512; j++) EXP[j] = EXP[j - 255];
    })();

    function mul(a, b) { return (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]]; }

    function genPoly(deg) {
      var poly = [1];
      for (var i = 0; i < deg; i++) {
        var next = new Array(poly.length + 1).fill(0);
        for (var j = 0; j < poly.length; j++) {
          next[j] ^= poly[j];
          next[j + 1] ^= mul(poly[j], EXP[i]);
        }
        poly = next;
      }
      return poly;
    }

    function ecc(dataBytes, ecCount) {
      var gen = genPoly(ecCount);
      var res = new Array(ecCount).fill(0);
      for (var d = 0; d < dataBytes.length; d++) {
        var factor = dataBytes[d] ^ res[0];
        res.shift(); res.push(0);
        for (var i = 0; i < ecCount; i++) res[i] ^= mul(gen[i + 1], factor);
      }
      return res;
    }

    // 纠错等级 L 的各版本参数：[每块纠错码字数, [[块数, 每块数据码字数], ...]]
    var VER = {
      1:  [7,  [[1, 19]]],
      2:  [10, [[1, 34]]],
      3:  [15, [[1, 55]]],
      4:  [20, [[1, 80]]],
      5:  [26, [[1, 108]]],
      6:  [18, [[2, 68]]]
    };
    var ALIGN = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34] };

    function utf8Bytes(str) {
      var out = [];
      for (var i = 0; i < str.length; i++) {
        var c = str.charCodeAt(i);
        if (c < 0x80) out.push(c);
        else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
        else if (c >= 0xd800 && c <= 0xdbff) {
          var c2 = str.charCodeAt(++i);
          var cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
          out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
        } else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
      }
      return out;
    }

    function maskFn(p, i, j) {
      switch (p) {
        case 0: return (i + j) % 2 === 0;
        case 1: return i % 2 === 0;
        case 2: return j % 3 === 0;
        case 3: return (i + j) % 3 === 0;
        case 4: return (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0;
        case 5: return ((i * j) % 2) + ((i * j) % 3) === 0;
        case 6: return (((i * j) % 2) + ((i * j) % 3)) % 2 === 0;
        default: return (((i + j) % 2) + ((i * j) % 3)) % 2 === 0;
      }
    }

    function formatBits(mask) {
      var data = (0x01 << 3) | mask; // 纠错等级 L 的编码为 01
      var bits = data << 10;
      for (var i = 4; i >= 0; i--) if (bits & (1 << (i + 10))) bits ^= 0x537 << i;
      return ((data << 10) | bits) ^ 0x5412;
    }

    function penalty(mods, size) {
      var p = 0, i, j, run;
      // 规则 1：连续同色
      for (i = 0; i < size; i++) {
        run = 1;
        for (j = 1; j < size; j++) {
          if (mods[i][j] === mods[i][j - 1]) { run++; if (run === 5) p += 3; else if (run > 5) p += 1; }
          else run = 1;
        }
        run = 1;
        for (j = 1; j < size; j++) {
          if (mods[j][i] === mods[j - 1][i]) { run++; if (run === 5) p += 3; else if (run > 5) p += 1; }
          else run = 1;
        }
      }
      // 规则 2：2x2 同色块
      for (i = 0; i < size - 1; i++) {
        for (j = 0; j < size - 1; j++) {
          var c = mods[i][j];
          if (c === mods[i][j + 1] && c === mods[i + 1][j] && c === mods[i + 1][j + 1]) p += 3;
        }
      }
      // 规则 3：类似定位图形的序列
      var pat = [true, false, true, true, true, false, true, false, false, false, false];
      var patR = pat.slice().reverse();
      function hit(line) {
        for (var a = 0; a + 11 <= line.length; a++) {
          var ok1 = true, ok2 = true;
          for (var b = 0; b < 11; b++) {
            if (line[a + b] !== pat[b]) ok1 = false;
            if (line[a + b] !== patR[b]) ok2 = false;
          }
          if (ok1 || ok2) p += 40;
        }
      }
      for (i = 0; i < size; i++) {
        hit(mods[i]);
        var col = [];
        for (j = 0; j < size; j++) col.push(mods[j][i]);
        hit(col);
      }
      // 规则 4：黑白比例
      var dark = 0;
      for (i = 0; i < size; i++) for (j = 0; j < size; j++) if (mods[i][j]) dark++;
      var pct = dark * 100 / (size * size);
      p += Math.floor(Math.abs(pct - 50) / 5) * 10;
      return p;
    }

    function build(text, forceMask) {
      var bytes = utf8Bytes(text);
      var version = 0, info;
      for (var v = 1; v <= 6; v++) {
        var totalData = 0;
        VER[v][1].forEach(function (g) { totalData += g[0] * g[1]; });
        // 4 bit 模式 + 8 bit 长度 + 数据 + 最多 4 bit 终止符
        if (bytes.length + 2 <= totalData) { version = v; info = { ec: VER[v][0], groups: VER[v][1], totalData: totalData }; break; }
      }
      if (!version) throw new Error('内容过长，无法生成二维码');

      // ---- 数据码字 ----
      var bits = [];
      function push(val, len) { for (var i = len - 1; i >= 0; i--) bits.push((val >> i) & 1); }
      push(4, 4);            // byte 模式
      push(bytes.length, 8); // version 1~9 长度字段为 8 位
      for (var i = 0; i < bytes.length; i++) push(bytes[i], 8);
      var term = Math.min(4, info.totalData * 8 - bits.length);
      push(0, term);
      while (bits.length % 8 !== 0) bits.push(0);
      var dataBytes = [];
      for (var b = 0; b < bits.length; b += 8) {
        var byte = 0;
        for (var k = 0; k < 8; k++) byte = (byte << 1) | bits[b + k];
        dataBytes.push(byte);
      }
      var padToggle = true;
      while (dataBytes.length < info.totalData) { dataBytes.push(padToggle ? 0xec : 0x11); padToggle = !padToggle; }

      // ---- 分块纠错 + 交织 ----
      var blocks = [], offset = 0;
      info.groups.forEach(function (g) {
        for (var n = 0; n < g[0]; n++) {
          var chunk = dataBytes.slice(offset, offset + g[1]);
          offset += g[1];
          blocks.push({ data: chunk, ec: ecc(chunk, info.ec) });
        }
      });
      var maxData = Math.max.apply(null, blocks.map(function (bl) { return bl.data.length; }));
      var finalBytes = [];
      for (var ci = 0; ci < maxData; ci++)
        for (var bi = 0; bi < blocks.length; bi++)
          if (ci < blocks[bi].data.length) finalBytes.push(blocks[bi].data[ci]);
      for (var ei = 0; ei < info.ec; ei++)
        for (var bj = 0; bj < blocks.length; bj++) finalBytes.push(blocks[bj].ec[ei]);

      // ---- 矩阵 ----
      var size = 17 + 4 * version;
      var mods = [], func = [];
      for (var y = 0; y < size; y++) {
        mods.push(new Array(size).fill(false));
        func.push(new Array(size).fill(false));
      }
      function set(r, c, v) { mods[r][c] = v; func[r][c] = true; }

      // 定位图形
      function finder(r0, c0) {
        for (var r = -1; r <= 7; r++) {
          for (var c = -1; c <= 7; c++) {
            var rr = r0 + r, cc = c0 + c;
            if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
            var on = (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
              (c >= 0 && c <= 6 && (r === 0 || r === 6)) ||
              (r >= 2 && r <= 4 && c >= 2 && c <= 4);
            set(rr, cc, on);
          }
        }
      }
      finder(0, 0); finder(0, size - 7); finder(size - 7, 0);

      // 定时图形
      for (var t = 8; t < size - 8; t++) { set(6, t, t % 2 === 0); set(t, 6, t % 2 === 0); }

      // 校准图形
      var ali = ALIGN[version];
      for (var ai = 0; ai < ali.length; ai++) {
        for (var aj = 0; aj < ali.length; aj++) {
          var ar = ali[ai], ac = ali[aj];
          if ((ar === 6 && ac === 6) || (ar === 6 && ac === size - 7) || (ar === size - 7 && ac === 6)) continue;
          for (var dr = -2; dr <= 2; dr++) {
            for (var dc = -2; dc <= 2; dc++) {
              var on = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
              set(ar + dr, ac + dc, on);
            }
          }
        }
      }

      // 预留格式信息区
      for (var f = 0; f < 9; f++) { if (!func[8][f]) set(8, f, false); if (!func[f][8]) set(f, 8, false); }
      for (var f2 = 0; f2 < 8; f2++) { set(8, size - 1 - f2, false); set(size - 1 - f2, 8, false); }
      set(size - 8, 8, true); // 暗模块

      // ---- 数据放置（之字形）----
      var inc = -1, row = size - 1, bitIndex = 7, byteIndex = 0;
      for (var col = size - 1; col > 0; col -= 2) {
        if (col === 6) col--;
        for (;;) {
          for (var cc2 = 0; cc2 < 2; cc2++) {
            if (!func[row][col - cc2]) {
              var dark = false;
              if (byteIndex < finalBytes.length) dark = ((finalBytes[byteIndex] >> bitIndex) & 1) === 1;
              mods[row][col - cc2] = dark;
              bitIndex--;
              if (bitIndex === -1) { byteIndex++; bitIndex = 7; }
            }
          }
          row += inc;
          if (row < 0 || row >= size) { row -= inc; inc = -inc; break; }
        }
      }

      // ---- 选择掩码 ----
      var best = 0, bestScore = Infinity;
      if (forceMask != null) {
        best = forceMask;
      } else {
        for (var p = 0; p < 8; p++) {
          var trial = mods.map(function (r) { return r.slice(); });
          applyMask(trial, size, p, func);
          var sc = penalty(trial, size);
          if (sc < bestScore) { bestScore = sc; best = p; }
        }
      }
      applyMask(mods, size, best, func);

      // ---- 写入格式信息 ----
      var fb = formatBits(best);
      for (var i2 = 0; i2 < 15; i2++) {
        var bit = ((fb >> i2) & 1) === 1;
        if (i2 < 6) mods[i2][8] = bit;
        else if (i2 < 8) mods[i2 + 1][8] = bit;
        else mods[size - 15 + i2][8] = bit;

        if (i2 < 8) mods[8][size - i2 - 1] = bit;
        else if (i2 < 9) mods[8][15 - i2 - 1 + 1] = bit;
        else mods[8][15 - i2 - 1] = bit;
      }
      mods[size - 8][8] = true;

      return mods;
    }

    function applyMask(mods, size, p, func) {
      for (var r = 0; r < size; r++) {
        for (var c = 0; c < size; c++) {
          if (func[r][c]) continue;
          if (maskFn(p, r, c)) mods[r][c] = !mods[r][c];
        }
      }
    }

    return { build: build };
  })();

  /* ============================ 海报绘制 ============================
   * 海报只画「做了什么」，不画「我多牛」：
   *   有：连续专注、本周帮了几个人、完成几个挑战、最长一次坐了多久、今天在做什么
   *   没有：信誉等级、具体分数、排名、可借额度
   * 后四样不是「画完打码」，是数据压根不往这里传 —— 传进来也没人取。
   * 底部 CTA 是邀请而不是炫耀：「扫码加入我的自习室」。
   */

  var POSTER_W = 750;
  var INV_KEY = 'pq-share-inv-v1';
  var INV_TTL = 24 * 3600 * 1000; // 海报有效期：24 小时
  var ALIAS_KEY = 'pq-share-alias-v1';

  function rr(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function maskText(s) {
    var t = String(s || '');
    if (!t) return '';
    return t[0] + '••';
  }

  /* 分钟 → 「1 小时 40 分」 */
  function fmtMin(m) {
    var n = Math.max(0, Math.round(Number(m) || 0));
    if (!n) return '—';
    var h = Math.floor(n / 60);
    var r = n % 60;
    if (!h) return n + ' 分钟';
    return h + ' 小时' + (r ? ' ' + r + ' 分' : '');
  }

  function randToken() {
    var a = '23456789abcdefghjkmnpqrstuvwxyz';
    var s = '';
    for (var i = 0; i < 8; i++) s += a[Math.floor(Math.random() * a.length)];
    return s;
  }

  /* 邀请码：24 小时有效。没过期就复用同一个，免得每刷一次海报换一个码。 */
  function invite() {
    var now = Date.now();
    var rec = null;
    try {
      rec = JSON.parse(localStorage.getItem(INV_KEY) || 'null');
    } catch (e) {
      rec = null;
    }
    if (!rec || !rec.token || Number(rec.exp) <= now) {
      rec = { token: randToken(), at: now, exp: now + INV_TTL };
      try {
        localStorage.setItem(INV_KEY, JSON.stringify(rec));
      } catch (e) {
        /* 存不下也照发：这一张仍然带 exp，过期方仍然会拒 */
      }
    }
    var join = SHARE_URL.indexOf('?') < 0 ? '?' : '&';
    return {
      token: rec.token,
      at: Number(rec.at) || now,
      exp: Number(rec.exp),
      url: SHARE_URL + join + 'inv=' + encodeURIComponent(rec.token) + '&exp=' + Number(rec.exp),
      leftMs: Math.max(0, Number(rec.exp) - now),
    };
  }

  function readAlias() {
    try {
      return String(localStorage.getItem(ALIAS_KEY) || '').slice(0, 12);
    } catch (e) {
      return '';
    }
  }

  function writeAlias(v) {
    try {
      if (v) localStorage.setItem(ALIAS_KEY, v);
      else localStorage.removeItem(ALIAS_KEY);
    } catch (e) {
      /* ignore */
    }
  }

  /* 过程数据卡：只取勾选了的。0 也照画 —— 0 是事实，不美化。 */
  function pickMetrics(d, o) {
    var out = [];
    if (o.streak) out.push({ k: 'streak', label: '连续专注', value: (Number(d.streak) || 0) + ' 天' });
    if (o.help) out.push({ k: 'help', label: '本周帮助战友', value: (Number(d.helpWeek) || 0) + ' 次' });
    if (o.challenge) out.push({ k: 'challenge', label: '完成的挑战', value: (Number(d.challengeDone) || 0) + ' 个' });
    if (o.focus) out.push({ k: 'focus', label: '单日最长专注', value: fmtMin(d.focusMax) });
    return out;
  }

  /* 叙事句：把勾选的项拼成一句「我做了什么」。一项没勾就不编。 */
  function narrative(d, o) {
    var bits = [];
    if (o.streak && Number(d.streak) > 0) bits.push('连续专注 ' + d.streak + ' 天');
    if (o.help && Number(d.helpWeek) > 0) bits.push('帮了 ' + d.helpWeek + ' 位战友');
    if (o.challenge && Number(d.challengeDone) > 0) bits.push('完成了 ' + d.challengeDone + ' 个挑战');
    if (o.focus && Number(d.focusMax) > 0) bits.push('最长一次坐了 ' + fmtMin(d.focusMax));
    if (!bits.length) return { main: '今天也在按计划前进', sub: '把想做的事，变成每天都会做的事' };
    return { main: '我' + bits.join('，'), sub: '自律的路上，我不是一个人在战斗' };
  }

  /* 中文按字断行（canvas 没有自动换行）。只有真的放不下才加省略号。 */
  function wrapText(ctx, text, maxW, maxLines) {
    var str = String(text || '');
    var NO_LEAD = '，。、；：！？）」』…·,.;:!?)'; // 这些不能出现在行首
    var lines = [];
    var cur = '';
    var i = 0;
    var truncated = false;
    while (i < str.length) {
      var ch = str[i];
      if (cur && ctx.measureText(cur + ch).width > maxW) {
        if (NO_LEAD.indexOf(ch) >= 0) {
          lines.push(cur + ch); // 标点吊在上一行行尾，别让它孤零零跑到下一行开头
          cur = '';
          i++;
        } else {
          /* 别把「1 小时」拆成「…坐了 1」+「小时」，数字跟着单位走 */
          var dm = /(\d+)\s*$/.exec(cur);
          if (dm && dm.index > 0 && !/\d$/.test(ch) && !/^\d+\s*$/.test(cur)) {
            lines.push(cur.slice(0, dm.index).replace(/\s+$/, ''));
            cur = cur.slice(dm.index);
          } else {
            lines.push(cur);
            cur = '';
          }
        }
        if (lines.length >= maxLines) {
          truncated = cur !== '' || i < str.length;
          break;
        }
      } else {
        cur += ch;
        i++;
      }
    }
    if (cur) {
      if (lines.length < maxLines) lines.push(cur);
      else truncated = true;
    }
    if (truncated && lines.length) {
      var last = lines[lines.length - 1];
      while (last && ctx.measureText(last + '…').width > maxW) last = last.slice(0, -1);
      lines[lines.length - 1] = last + '…';
    }
    return lines;
  }

  function drawPoster(canvas, d, o) {
    var fontCN = '"PingFang SC","Microsoft YaHei",system-ui,-apple-system,sans-serif';
    var metrics = pickMetrics(d, o);
    var listItems = [];
    if (o.plans) {
      listItems = (d.plans || []).slice(0, 5).map(function (p) {
        return { title: o.planMask ? maskText(p.title) : String(p.title || ''), done: !!p.done };
      });
    }
    var morePlans = o.plans && (d.plans || []).length > 5 ? d.plans.length - 5 : 0;
    var nar = narrative(d, o);
    var alias = readAlias();
    var inv = invite();

    /* ---- 先用 ctx 量文字，算出总高，再定型 ---- */
    canvas.width = POSTER_W;
    canvas.height = 10;
    var ctx = canvas.getContext('2d');

    ctx.font = '700 40px ' + fontCN;
    var narLines = wrapText(ctx, nar.main, POSTER_W - 120, 4);

    var padTop = 240;
    if (alias) padTop += 46;
    var narTop = padTop;
    var narBottom = narTop + (narLines.length - 1) * 56;
    var subY = narBottom + 52;
    var cardsTop = subY + 40;
    var cardH = 118;
    var cardRows = Math.ceil(metrics.length / 2);
    var afterCards = metrics.length ? cardsTop + cardRows * cardH + (cardRows - 1) * 16 + 34 : cardsTop;
    var afterPlans = afterCards;
    if (listItems.length) {
      afterPlans += 40 + listItems.length * 50 + (morePlans ? 34 : 0) + 12;
    }
    var contentEnd = afterPlans;
    var H = Math.max(1080, contentEnd + 440);

    canvas.height = H;
    ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, POSTER_W, H);

    /* ---- 背景 ---- */
    var bg = ctx.createLinearGradient(0, 0, POSTER_W, H);
    bg.addColorStop(0, '#12141c');
    bg.addColorStop(0.55, '#151926');
    bg.addColorStop(1, '#10121a');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, POSTER_W, H);

    var glow = ctx.createRadialGradient(POSTER_W / 2, 120, 20, POSTER_W / 2, 120, 520);
    glow.addColorStop(0, 'rgba(90,140,255,0.20)');
    glow.addColorStop(1, 'rgba(90,140,255,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, POSTER_W, 640);

    var line = ctx.createLinearGradient(60, 0, POSTER_W - 60, 0);
    line.addColorStop(0, 'rgba(120,160,255,0)');
    line.addColorStop(0.5, 'rgba(120,160,255,0.55)');
    line.addColorStop(1, 'rgba(120,160,255,0)');
    ctx.fillStyle = line;
    ctx.fillRect(60, 58, POSTER_W - 120, 1.5);

    /* ---- 品牌 ---- */
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#e8ecf6';
    ctx.font = '700 34px ' + fontCN;
    ctx.fillText('PlanQuest', 60, 128);
    ctx.fillStyle = 'rgba(160,175,205,0.85)';
    ctx.font = '400 22px ' + fontCN;
    ctx.fillText('计划打卡 · 每一步都算数', 60, 162);

    /* ---- 署名（别名，不是真名） ---- */
    if (alias) {
      ctx.fillStyle = 'rgba(150,165,195,0.9)';
      ctx.font = '400 21px ' + fontCN;
      ctx.fillText('来自「' + alias + '」的邀请', 60, 218);
    }

    /* ---- 主文案（叙事句） ---- */
    ctx.fillStyle = '#f2f5fb';
    ctx.font = '700 40px ' + fontCN;
    narLines.forEach(function (ln, i) {
      ctx.fillText(ln, 60, narTop + i * 56);
    });
    ctx.fillStyle = 'rgba(150,165,195,0.9)';
    ctx.font = '400 24px ' + fontCN;
    ctx.fillText(nar.sub, 60, subY);

    /* ---- 过程数据卡（两列） ---- */
    if (metrics.length) {
      var gap = 16;
      var cardW = (POSTER_W - 120 - gap) / 2;
      metrics.forEach(function (m, i) {
        var col = i % 2;
        var rowIdx = Math.floor(i / 2);
        var x = 60 + col * (cardW + gap);
        var y = cardsTop + rowIdx * (cardH + gap);
        ctx.fillStyle = 'rgba(255,255,255,0.055)';
        rr(ctx, x, y, cardW, cardH, 18);
        ctx.fill();
        ctx.strokeStyle = 'rgba(140,170,225,0.22)';
        ctx.lineWidth = 1.5;
        rr(ctx, x, y, cardW, cardH, 18);
        ctx.stroke();

        ctx.fillStyle = '#8fa3c8';
        ctx.font = '400 20px ' + fontCN;
        ctx.fillText(m.label, x + 22, y + 40);

        ctx.fillStyle = '#eef3ff';
        ctx.font = '700 34px ' + fontCN;
        ctx.fillText(m.value, x + 22, y + 88);
      });
    }

    /* ---- 今天在做什么（可选） ---- */
    var y = afterCards;
    if (listItems.length) {
      ctx.fillStyle = 'rgba(140,160,195,0.95)';
      ctx.font = '600 21px ' + fontCN;
      ctx.fillText('今天在做的事', 60, y + 6);
      y += 32;

      listItems.forEach(function (it) {
        ctx.fillStyle = 'rgba(255,255,255,0.045)';
        rr(ctx, 60, y, POSTER_W - 120, 42, 12);
        ctx.fill();

        ctx.beginPath();
        ctx.arc(86, y + 21, 8, 0, Math.PI * 2);
        ctx.fillStyle = it.done ? 'rgba(94,220,160,0.95)' : 'rgba(255,255,255,0.16)';
        ctx.fill();
        if (it.done) {
          ctx.strokeStyle = '#0f1720';
          ctx.lineWidth = 2.2;
          ctx.beginPath();
          ctx.moveTo(82, y + 21);
          ctx.lineTo(85.5, y + 25);
          ctx.lineTo(92, y + 16);
          ctx.stroke();
        }

        ctx.fillStyle = it.done ? 'rgba(223,232,246,0.95)' : 'rgba(150,163,186,0.8)';
        ctx.font = '400 22px ' + fontCN;
        ctx.fillText(it.title, 110, y + 28);
        y += 50;
      });

      if (morePlans) {
        ctx.fillStyle = 'rgba(130,148,180,0.9)';
        ctx.font = '400 20px ' + fontCN;
        ctx.fillText('…还有 ' + morePlans + ' 项', 60, y + 12);
      }
    }

    /* ---- 邀请区：CTA + 二维码 + 有效期 ---- */
    var qs = 200;
    var qx = (POSTER_W - qs) / 2;
    var qy = H - 336;

    ctx.textAlign = 'center';
    ctx.fillStyle = '#f2f5fb';
    ctx.font = '700 32px ' + fontCN;
    ctx.fillText('扫码加入我的自习室', POSTER_W / 2, H - 402);
    ctx.fillStyle = 'rgba(150,165,195,0.9)';
    ctx.font = '400 19px ' + fontCN;
    ctx.fillText('一起专注 · 互相监督 · 不收费', POSTER_W / 2, H - 368);

    ctx.fillStyle = '#ffffff';
    rr(ctx, qx - 16, qy - 16, qs + 32, qs + 32, 16);
    ctx.fill();

    try {
      var matrix = QR.build(inv.url);
      var n = matrix.length;
      var cell = qs / n;
      ctx.fillStyle = '#0d1017';
      for (var r = 0; r < n; r++) {
        for (var c = 0; c < n; c++) {
          if (!matrix[r][c]) continue;
          ctx.fillRect(Math.round(qx + c * cell), Math.round(qy + r * cell), Math.ceil(cell), Math.ceil(cell));
        }
      }
    } catch (e) {
      ctx.fillStyle = '#333';
      ctx.font = '400 18px ' + fontCN;
      ctx.fillText('二维码生成失败', POSTER_W / 2, qy + qs / 2);
    }

    ctx.fillStyle = 'rgba(150,165,195,0.9)';
    ctx.font = '400 20px ' + fontCN;
    ctx.fillText('一个人扛容易散，一群人扛才走得远', POSTER_W / 2, H - 100);
    ctx.fillStyle = 'rgba(120,138,170,0.75)';
    ctx.font = '400 17px ' + fontCN;
    ctx.fillText(inv.url.replace(/^https?:\/\//, '').split('?')[0], POSTER_W / 2, H - 66);
    ctx.fillStyle = 'rgba(120,138,170,0.6)';
    ctx.font = '400 15px ' + fontCN;
    ctx.fillText('这张海报 24 小时内有效 · 过期后二维码自动失效', POSTER_W / 2, H - 34);
    ctx.textAlign = 'left';
  }

  /* ============================ 面板与交互 ============================ */

  /* 可勾选项 = 全部是「过程」，没有一项是「我多牛」。
     积分、完成率、契约押金都拿掉了：那是账本，不是一起做事的证据。 */
  var OPTIONS = [
    { key: 'streak', label: '连续专注天数', desc: '例如「连续专注 21 天」' },
    { key: 'help', label: '本周帮过几个战友', desc: '被确认过的助人次数' },
    { key: 'challenge', label: '完成几个挑战', desc: '契约项目里已达标完结的数量' },
    { key: 'focus', label: '最长一次坐了多久', desc: '单日最长专注时长' },
    { key: 'plans', label: '今天在做的事', desc: '逐条列出完成情况', sub: { key: 'planMask', label: '名称打码（只留首字）' } }
  ];

  var STYLE_ID = 'pqs-style';
  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var css = ''
      + '.pqs-mask{position:fixed;inset:0;background:rgba(6,8,14,.72);backdrop-filter:blur(6px);z-index:9998;display:flex;align-items:center;justify-content:center;padding:16px;}'
      + '.pqs-panel{width:min(560px,100%);max-height:92vh;overflow:auto;background:#171b26;border:1px solid #2a3142;border-radius:18px;box-shadow:0 24px 60px rgba(0,0,0,.55);color:#e7ecf7;font-family:"PingFang SC","Microsoft YaHei",system-ui,sans-serif;}'
      + '.pqs-head{display:flex;align-items:center;justify-content:space-between;padding:16px 18px;border-bottom:1px solid #242b3a;position:sticky;top:0;background:#171b26;z-index:2;}'
      + '.pqs-head b{font-size:16px;}'
      + '.pqs-head .pqs-tip{font-size:12px;color:#8b9ab5;margin-left:8px;font-weight:400;}'
      + '.pqs-x{border:none;background:transparent;color:#93a1ba;font-size:22px;line-height:1;cursor:pointer;padding:2px 6px;}'
      + '.pqs-body{padding:16px 18px 8px;}'
      + '.pqs-prev{background:#0e1119;border:1px solid #242b3a;border-radius:14px;padding:12px;display:flex;justify-content:center;}'
      + '.pqs-prev canvas{width:100%;max-width:300px;height:auto;border-radius:10px;display:block;}'
      + '.pqs-sec{margin-top:18px;}'
      + '.pqs-sec h4{font-size:13px;color:#9aa8c2;margin:0 0 10px;font-weight:600;letter-spacing:.3px;}'
      + '.pqs-row{display:flex;align-items:flex-start;gap:10px;padding:9px 10px;border-radius:10px;}'
      + '.pqs-row:hover{background:rgba(255,255,255,.035);}'
      + '.pqs-row input[type=checkbox]{margin-top:3px;width:16px;height:16px;accent-color:#5b8cff;cursor:pointer;flex:none;}'
      + '.pqs-row .pqs-lab{font-size:14px;line-height:1.35;}'
      + '.pqs-row .pqs-desc{font-size:12px;color:#8593ad;margin-top:2px;}'
      + '.pqs-row.pqs-sub{margin-left:26px;padding:6px 10px;}'
      + '.pqs-row.pqs-sub .pqs-lab{font-size:13px;color:#b9c6dc;}'
      + '.pqs-inp{width:100%;box-sizing:border-box;padding:10px 12px;border-radius:10px;border:1px solid #2f3a4f;background:#0f131c;color:#e7ecf7;font-size:14px;font-family:inherit;}'
      + '.pqs-inp::placeholder{color:#6c7a94;}'
      + '.pqs-note{margin-top:16px;font-size:12px;line-height:1.7;color:#8593ad;border-top:1px dashed #2a3142;padding-top:12px;}'
      + '.pqs-actions{display:flex;gap:10px;padding:14px 18px 18px;border-top:1px solid #242b3a;position:sticky;bottom:0;background:#171b26;}'
      + '.pqs-btn{flex:1;padding:11px 12px;border-radius:11px;border:1px solid #2f3a4f;font-size:14px;cursor:pointer;font-family:inherit;}'
      + '.pqs-btn.ghost{background:#202634;border:1px solid #2f3a4f;color:#cfdaee;}'
      + '.pqs-btn.primary{background:linear-gradient(135deg,#4f7dff,#6b5cff);border:1px solid transparent;color:#fff;font-weight:600;}'
      + '.pqs-btn:disabled{opacity:.45;cursor:not-allowed;}'
      + '.pqs-toast{position:fixed;left:50%;bottom:36px;transform:translateX(-50%);background:#232a3a;color:#e8eefc;padding:10px 16px;border-radius:10px;font-size:13px;z-index:9999;box-shadow:0 10px 30px rgba(0,0,0,.4);}';
    var s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = css;
    document.head.appendChild(s);
  }

  function toast(msg) {
    var el = document.createElement('div');
    el.className = 'pqs-toast';
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(function () { el.remove(); }, 2200);
  }

  function nativePlugin() {
    try {
      if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.PQShare) return window.Capacitor.Plugins.PQShare;
    } catch (e) { /* ignore */ }
    return null;
  }

  function open(data) {
    injectStyle();

    /* 默认全关：不勾就只出品牌 + 邀请二维码，一个字的私人数据都不上 */
    var opts = {
      streak: false, help: false, challenge: false, focus: false,
      plans: false, planMask: true
    };

    var actionsHtml = nativePlugin()
      ? '<button class="pqs-btn primary" data-act="wechat">发微信好友</button>'
        + '<button class="pqs-btn primary" data-act="moments">发朋友圈</button>'
        + '<button class="pqs-btn ghost" data-act="save">保存海报</button>'
        + '<button class="pqs-btn ghost" data-act="copy">复制链接</button>'
      : '<button class="pqs-btn ghost" data-act="copy">复制链接</button>'
        + '<button class="pqs-btn ghost" data-act="save">保存海报</button>'
        + '<button class="pqs-btn primary" data-act="share">分享</button>';

    var mask = document.createElement('div');
    mask.className = 'pqs-mask';
    mask.innerHTML = ''
      + '<div class="pqs-panel" role="dialog" aria-modal="true">'
      + '  <div class="pqs-head"><div><b>分享</b><span class="pqs-tip">默认全部隐藏，勾选后才写进海报</span></div><button class="pqs-x" aria-label="关闭">×</button></div>'
      + '  <div class="pqs-body">'
      + '    <div class="pqs-prev"><canvas></canvas></div>'
      + '    <div class="pqs-sec"><h4>署名（可不填）</h4>'
      + '      <input class="pqs-inp" id="pqs-alias" maxlength="12" placeholder="留空 = 不署名。建议用别名，别写真名" />'
      + '    </div>'
      + '    <div class="pqs-sec"><h4>海报上显示什么（都是「做什么」，不是「多牛」）</h4><div class="pqs-rows"></div></div>'
      + '    <div class="pqs-note">信誉等级、具体分数、排名、可借额度一律不出现 —— 这几项数据根本不会传进绘制代码。<br/>'
      + '      底部是邀请二维码：<b>24 小时内有效</b>，过期后对方扫码会看到「邀请已过期」。</div>'
      + '  </div>'
      + '  <div class="pqs-actions">' + actionsHtml + '</div>'
      + '</div>';

    document.body.appendChild(mask);

    var canvas = mask.querySelector('canvas');
    var rowsBox = mask.querySelector('.pqs-rows');

    OPTIONS.forEach(function (opt) {
      var row = document.createElement('label');
      row.className = 'pqs-row';
      row.innerHTML = '<input type="checkbox" data-key="' + opt.key + '">'
        + '<div><div class="pqs-lab">' + opt.label + '</div><div class="pqs-desc">' + opt.desc + '</div></div>';
      rowsBox.appendChild(row);

      if (opt.sub) {
        var sub = document.createElement('label');
        sub.className = 'pqs-row pqs-sub';
        sub.style.display = 'none';
        sub.innerHTML = '<input type="checkbox" data-key="' + opt.sub.key + '" checked>'
          + '<div><div class="pqs-lab">' + opt.sub.label + '</div></div>';
        rowsBox.appendChild(sub);
        row._sub = sub;
      }
    });

    function redraw() {
      drawPoster(canvas, data, opts);
    }

    rowsBox.addEventListener('change', function (e) {
      var key = e.target.getAttribute('data-key');
      if (!key) return;
      opts[key] = e.target.checked;
      var row = e.target.closest('.pqs-row');
      if (row && row._sub) row._sub.style.display = e.target.checked ? 'flex' : 'none';
      // 昵称：海报暂不绘制头像，避免误判为已展示
      redraw();
    });

    /* 别名：存本机，下次自动带上；不跟账号昵称绑在一起 */
    var aliasInp = mask.querySelector('#pqs-alias');
    if (aliasInp) {
      aliasInp.value = readAlias();
      aliasInp.addEventListener('input', function () {
        writeAlias(aliasInp.value.trim());
        redraw();
      });
    }

    mask.querySelector('.pqs-x').addEventListener('click', function () { mask.remove(); });
    mask.addEventListener('click', function (e) { if (e.target === mask) mask.remove(); });

    mask.querySelector('[data-act="copy"]').addEventListener('click', function () {
      /* 复制的是带邀请码的地址，不是首页：这样对方点开也知道是谁喊他来的 */
      copyText(invite().url).then(function () { toast('邀请链接已复制', '24 小时内有效'); }).catch(function () { toast('复制失败，请手动复制'); });
    });

    mask.querySelector('[data-act="save"]').addEventListener('click', function () {
      savePoster(canvas);
    });

    function bind(act, fn) {
      var el = mask.querySelector('[data-act="' + act + '"]');
      if (el) el.addEventListener('click', fn);
    }

    bind('share', function () { doShare(canvas, opts); });
    bind('wechat', function () { shareNative(canvas, 'wechat'); });
    bind('moments', function () { shareNative(canvas, 'moments'); });

    redraw();
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
    return new Promise(function (resolve, reject) {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); resolve(); } catch (e) { reject(e); }
      ta.remove();
    });
  }

  function fileName() {
    var d = new Date();
    return 'PlanQuest-' + d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0') + '.png';
  }

  function savePoster(canvas) {
    var dataUrl = canvas.toDataURL('image/png');
    var plugin = nativePlugin();
    if (plugin && plugin.saveImage) {
      plugin.saveImage({ dataUrl: dataUrl, fileName: fileName() })
        .then(function () { toast('已保存到相册'); })
        .catch(function () { toast('保存失败'); });
      return;
    }
    var a = document.createElement('a');
    a.href = dataUrl;
    a.download = fileName();
    document.body.appendChild(a);
    a.click();
    a.remove();
    toast('海报已保存');
  }

  function shareNative(canvas, target) {
    var plugin = nativePlugin();
    if (!plugin) return;
    plugin.shareImage({ dataUrl: canvas.toDataURL('image/png'), target: target, text: '扫码加入我的自习室，一起专注' })
      .then(function (r) {
        toast(r && r.fallback ? '已打开系统分享' : '已打开' + (target === 'moments' ? '朋友圈' : '微信'));
      })
      .catch(function () { toast('分享失败'); });
  }

  function doShare(canvas, opts) {
    var plugin = nativePlugin();
    if (plugin && plugin.shareImage) {
      plugin.shareImage({ dataUrl: canvas.toDataURL('image/png'), text: '扫码加入我的自习室，一起专注', target: 'system' })
        .then(function () { toast('已打开分享'); })
        .catch(function () { toast('分享失败'); });
      return;
    }
    if (navigator.share) {
      var payload = { title: 'PlanQuest · 一起专注', text: '自律的路上，别一个人扛', url: invite().url };
      canvas.toBlob(function (blob) {
        var file = blob ? new File([blob], fileName(), { type: 'image/png' }) : null;
        if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
          payload.files = [file];
        }
        navigator.share(payload).catch(function () { /* 用户取消 */ });
      }, 'image/png');
      return;
    }
    // 桌面端：没有系统分享面板，改为「复制链接 + 保存海报」
    copyText(invite().url).then(function () {
      savePoster(canvas);
      toast('已复制邀请链接并保存海报', '24 小时内有效，发朋友圈也行');
    });
  }

  /* 落地校验：链接带 inv + exp。过期就明说过期，不装作还能用。 */
  function checkLink(search) {
    var q;
    try {
      q = new URLSearchParams(search == null ? location.search || '' : search);
    } catch (e) {
      return { state: 'none' };
    }
    var inv = q.get('inv');
    var exp = Number(q.get('exp'));
    if (!inv || !Number.isFinite(exp) || !exp) return { state: 'none' };
    if (Date.now() > exp) return { state: 'expired', inv: inv, at: exp };
    return { state: 'ok', inv: inv, at: exp, leftH: Math.max(1, Math.round((exp - Date.now()) / 3600e3)) };
  }

  window.PQShare = { open: open, url: SHARE_URL, invite: invite, checkLink: checkLink, __qr: QR };
})();
