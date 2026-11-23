'use strict';
/*
 * 生成应用图标（无第三方依赖，纯 zlib 手写 PNG）
 * 输出: assets/icon.png (256x256)
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const SIZE = 256;
const SS = 3; // 超采样倍数

function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
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

function encodePNG(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

/* ---------- 形状 ---------- */

function insideRoundRect(px, py, x, y, w, h, r) {
  const cx = Math.max(x + r, Math.min(px, x + w - r));
  const cy = Math.max(y + r, Math.min(py, y + h - r));
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy <= r * r;
}

function distToSegment(px, py, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const t = Math.max(0, Math.min(1, (wx * vx + wy * vy) / (vx * vx + vy * vy)));
  const dx = px - (ax + t * vx);
  const dy = py - (ay + t * vy);
  return Math.sqrt(dx * dx + dy * dy);
}

function mix(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

const C1 = [124, 108, 255]; // indigo
const C2 = [23, 205, 168]; // mint
const WHITE = [255, 255, 255];

function sample(x, y) {
  // 背景圆角方块（含 1px 内缩留白）
  const pad = 6;
  if (!insideRoundRect(x, y, pad, pad, SIZE - pad * 2, SIZE - pad * 2, 58)) {
    return [0, 0, 0, 0];
  }
  const t = Math.min(1, Math.max(0, (x + y) / (SIZE * 2)));
  let col = mix(C1, C2, t * 0.95);
  let alpha = 255;

  // 底部柔和高光
  const glow = Math.max(0, 1 - Math.hypot(x - SIZE * 0.28, y - SIZE * 0.18) / (SIZE * 0.55));
  col = mix(col, [255, 255, 255], glow * 0.22);

  // 白色对勾
  const th = 15;
  const d1 = distToSegment(x, y, 74, 132, 112, 170);
  const d2 = distToSegment(x, y, 112, 170, 186, 88);
  const d = Math.min(d1, d2);
  if (d <= th) {
    col = mix(col, WHITE, 1);
  } else if (d <= th + 2.2) {
    const k = 1 - (d - th) / 2.2;
    col = mix(col, WHITE, k * 0.9);
  }
  return [col[0], col[1], col[2], alpha];
}

const out = Buffer.alloc(SIZE * SIZE * 4);
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const px = x + (sx + 0.5) / SS;
        const py = y + (sy + 0.5) / SS;
        const c = sample(px, py);
        r += c[0] * c[3];
        g += c[1] * c[3];
        b += c[2] * c[3];
        a += c[3];
      }
    }
    const n = SS * SS;
    const i = (y * SIZE + x) * 4;
    if (a === 0) {
      out[i] = out[i + 1] = out[i + 2] = out[i + 3] = 0;
    } else {
      out[i] = Math.round(r / a);
      out[i + 1] = Math.round(g / a);
      out[i + 2] = Math.round(b / a);
      out[i + 3] = Math.round(a / n);
    }
  }
}

const dir = path.join(__dirname, '..', 'assets');
fs.mkdirSync(dir, { recursive: true });
const png = encodePNG(SIZE, SIZE, out);
fs.writeFileSync(path.join(dir, 'icon.png'), png);
console.log('icon.png 已生成', png.length, 'bytes');
