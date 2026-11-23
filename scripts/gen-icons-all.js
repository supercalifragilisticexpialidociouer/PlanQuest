'use strict';
/*
 * 统一三端图标：全部从同一套「渐变圆角方块 + 白色对勾」矢量绘制生成
 * 输出：
 *   assets/icon.png                                   256（网页 / 桌面通用，保持原有）
 *   android res mipmap 各密度                          安卓启动图标（legacy + round + adaptive 前景）
 *   android res drawable 各启动屏                      安卓启动屏（深色底 + 居中图标）
 *   dist/PlanQuest-win64/PlanQuest.ico                Windows 多尺寸图标（给 exe / 快捷方式用）
 * 无第三方依赖，纯 zlib 手写 PNG / ICO。
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const RES = path.join(__dirname, '..', 'android-app', 'android', 'app', 'src', 'main', 'res');
const DIST = path.join(__dirname, '..', 'dist', 'PlanQuest-win64');

/* ---------- PNG / ICO 编码 ---------- */
function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = (crc ^ b) & 0xffffffff, crc = table[crc & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function encodePNG(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}
function encodeICO(entries) {
  // entries: [{ size, png:Buffer }]（全部用 PNG 内嵌，Vista+ 支持）
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  const dir = Buffer.alloc(16 * entries.length);
  let offset = 6 + 16 * entries.length;
  const blobs = [];
  entries.forEach((e, i) => {
    const o = i * 16;
    dir[o] = e.size >= 256 ? 0 : e.size;
    dir[o + 1] = e.size >= 256 ? 0 : e.size;
    dir[o + 2] = 0;
    dir[o + 3] = 0;
    dir.writeUInt16LE(1, o + 4);
    dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(e.png.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += e.png.length;
    blobs.push(e.png);
  });
  return Buffer.concat([header, dir, ...blobs]);
}

/* ---------- 绘制（与 assets/icon.png 同一套设计） ---------- */
const C1 = [124, 108, 255]; // indigo
const C2 = [23, 205, 168]; // mint
const BG = [18, 20, 28]; // #12141c 启动屏底色
const SS = 3;

const insideRoundRect = (px, py, x, y, w, h, r) => {
  const cx = Math.max(x + r, Math.min(px, x + w - r));
  const cy = Math.max(y + r, Math.min(py, y + h - r));
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy <= r * r;
};
const distToSegment = (px, py, ax, ay, bx, by) => {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const t = Math.max(0, Math.min(1, (wx * vx + wy * vy) / (vx * vx + vy * vy)));
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
};
const mix = (a, b, t) => [
  Math.round(a[0] + (b[0] - a[0]) * t),
  Math.round(a[1] + (b[1] - a[1]) * t),
  Math.round(a[2] + (b[2] - a[2]) * t),
];

/* 在 256 设计坐标系里画一个完整的图标（圆角方块 + 对勾），返回 [r,g,b,a] */
function iconSample256(x, y, opt = {}) {
  const pad = opt.pad == null ? 6 : opt.pad;
  const S = 256;
  if (!insideRoundRect(x, y, pad, pad, S - pad * 2, S - pad * 2, 58)) return [0, 0, 0, 0];
  const t = Math.min(1, Math.max(0, (x + y) / (S * 2)));
  let col = mix(C1, C2, t * 0.95);
  const glow = Math.max(0, 1 - Math.hypot(x - S * 0.28, y - S * 0.18) / (S * 0.55));
  col = mix(col, [255, 255, 255], glow * 0.22);
  const th = 15;
  const d1 = distToSegment(x, y, 74, 132, 112, 170);
  const d2 = distToSegment(x, y, 112, 170, 186, 88);
  const d = Math.min(d1, d2);
  if (d <= th) col = mix(col, [255, 255, 255], 1);
  else if (d <= th + 2.2) col = mix(col, [255, 255, 255], (1 - (d - th) / 2.2) * 0.9);
  return [col[0], col[1], col[2], 255];
}

/*
 * 通用渲染器
 * mode: 'square' 圆角方块（带透明边距） | 'circle' 圆形裁切 | 'adaptive' 安卓自适应前景（66% 安全区）
 * bg:  { color:[r,g,b] } 启动屏底色；iconFrac 图标占短边比例
 */
function render(size, mode, opts = {}) {
  const out = Buffer.alloc(size * size * 4);
  const k = size / 256;
  const cx = size / 2;
  const radius = cx - 1;
  const iconSpan = opts.iconSpan || 1; // 图标占画布比例
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS;
          const py = y + (sy + 0.5) / SS;
          // 底色（启动屏用；其余透明）
          let base = opts.bg ? [opts.bg[0], opts.bg[1], opts.bg[2], 255] : [0, 0, 0, 0];
          // 图标采样：画布坐标映回 256 设计坐标
          const ux = (px - cx) / k / iconSpan + 128;
          const uy = (py - cx) / k / iconSpan + 128;
          let ic = [0, 0, 0, 0];
          if (ux >= -4 && uy >= -4 && ux <= 260 && uy <= 260) ic = iconSample256(ux, uy, { pad: opts.pad });
          // 形状裁切
          if (mode === 'circle') {
            const dx = px - cx;
            const dy = py - cx;
            const edge = Math.min(1.6, Math.max(0, radius - Math.hypot(dx, dy)));
            ic[3] = Math.round(ic[3] * Math.min(1, edge));
          } else if (mode === 'adaptive') {
            // 安全区：中央 66/108，内容再缩到安全区的 ~92%，出界部分淡出
            const safe = ((size * 66) / 108 / 2) * 0.92;
            const dx = Math.abs(px - cx);
            const dy = Math.abs(py - cx);
            let over = 0;
            if (dx > safe && dy > safe) over = Math.min(dx, dy) - safe;
            else if (dx > safe) over = dx - safe;
            else if (dy > safe) over = dy - safe;
            if (over > 0) ic[3] = Math.round(ic[3] * Math.max(0, 1 - over * 0.8));
          }
          // ic 叠到 base 上（普通 alpha 混合）
          const ia = ic[3] / 255;
          const ba = base[3] / 255;
          const oa = ia + ba * (1 - ia);
          if (oa > 0) {
            r += ((ic[0] * ia + base[0] * ba * (1 - ia)) / oa) * (oa * 255);
            g += ((ic[1] * ia + base[1] * ba * (1 - ia)) / oa) * (oa * 255);
            b += ((ic[2] * ia + base[2] * ba * (1 - ia)) / oa) * (oa * 255);
            a += oa * 255;
          }
        }
      }
      const n = SS * SS;
      const i = (y * size + x) * 4;
      if (a === 0) out[i] = out[i + 1] = out[i + 2] = out[i + 3] = 0;
      else {
        out[i] = Math.round(r / a);
        out[i + 1] = Math.round(g / a);
        out[i + 2] = Math.round(b / a);
        out[i + 3] = Math.round(a / n);
      }
    }
  }
  return out;
}

const writeP = (p, buf) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, buf);
  console.log('✓', path.relative(process.cwd(), p));
};

/* ---------- 1. 网页 / 桌面主图标（保持 256 设计原样） ---------- */
writeP(path.join(__dirname, '..', 'assets', 'icon.png'), encodePNG(256, 256, render(256, 'square')));

/* ---------- 2. 安卓启动图标 ---------- */
const DENS = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
for (const [d, m] of Object.entries(DENS)) {
  const s = Math.round(48 * m);
  writeP(path.join(RES, `mipmap-${d}`, 'ic_launcher.png'), encodePNG(s, s, render(s, 'square', { pad: 10 })));
  writeP(path.join(RES, `mipmap-${d}`, 'ic_launcher_round.png'), encodePNG(s, s, render(s, 'circle')));
  const f = Math.round(108 * m);
  // 自适应前景：整个圆角方块要落在 66/108 安全区内
  writeP(path.join(RES, `mipmap-${d}`, 'ic_launcher_foreground.png'), encodePNG(f, f, render(f, 'adaptive', { iconSpan: 0.62 })));
}

/* ---------- 3. 安卓启动屏 ---------- */
const SPLASH = {
  'drawable/splash.png': [480, 800],
  'drawable-port-mdpi/splash.png': [320, 480],
  'drawable-port-hdpi/splash.png': [480, 800],
  'drawable-port-xhdpi/splash.png': [720, 1280],
  'drawable-port-xxhdpi/splash.png': [960, 1600],
  'drawable-port-xxxhdpi/splash.png': [1280, 1920],
  'drawable-land-mdpi/splash.png': [480, 320],
  'drawable-land-hdpi/splash.png': [800, 480],
  'drawable-land-xhdpi/splash.png': [1280, 720],
  'drawable-land-xxhdpi/splash.png': [1600, 960],
  'drawable-land-xxxhdpi/splash.png': [1920, 1280],
};
for (const [rel, [w, h]] of Object.entries(SPLASH)) {
  const size = Math.max(w, h);
  const out = Buffer.alloc(w * h * 4);
  const icon = render(Math.round(size * 0.16), 'square', { pad: 10 });
  const iw = Math.round(size * 0.16);
  const ox = Math.round((w - iw) / 2);
  const oy = Math.round((h - iw) / 2);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      out[i] = BG[0];
      out[i + 1] = BG[1];
      out[i + 2] = BG[2];
      out[i + 3] = 255;
    }
  }
  for (let y = 0; y < iw; y++) {
    for (let x = 0; x < iw; x++) {
      const si = (y * iw + x) * 4;
      const a = icon[si + 3] / 255;
      if (!a) continue;
      const di = ((oy + y) * w + ox + x) * 4;
      out[di] = Math.round(icon[si] * a + out[di] * (1 - a));
      out[di + 1] = Math.round(icon[si + 1] * a + out[di + 1] * (1 - a));
      out[di + 2] = Math.round(icon[si + 2] * a + out[di + 2] * (1 - a));
      out[di + 3] = 255;
    }
  }
  writeP(path.join(RES, rel), encodePNG(w, h, out));
}

/* ---------- 4. Windows .ico（16/24/32/48/64/128/256） ---------- */
const ico = encodeICO(
  [16, 24, 32, 48, 64, 128, 256].map((s) => ({ size: s, png: encodePNG(s, s, render(s, 'square', { pad: Math.max(2, 6 * (s / 256)) })) }))
);
writeP(path.join(DIST, 'PlanQuest.ico'), ico);

console.log('\n全部图标生成完成');
