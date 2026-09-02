import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let crc = -1;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(width, height, pixelFn) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixelFn(x, y, width, height);
      const off = y * (stride + 1) + 1 + x * 4;
      raw[off] = r;
      raw[off + 1] = g;
      raw[off + 2] = b;
      raw[off + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const idat = deflateSync(raw, { level: 9 });
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

function pixel(x, y, w, h) {
  const t = (x + y) / (w + h - 2);
  const r = Math.round(168 - t * 69);
  const g = Math.round(85 + t * 17);
  const b = Math.round(247 - t * 6);
  const inset = Math.max(1, Math.round(w * 0.08));
  const radius = Math.max(2, Math.round(w * 0.2));
  const inside = x >= inset && x < w - inset && y >= inset && y < h - inset;
  const nearCorner = (x < inset + radius && y < inset + radius) ||
    (x >= w - inset - radius && y < inset + radius) ||
    (x < inset + radius && y >= h - inset - radius) ||
    (x >= w - inset - radius && y >= h - inset - radius);
  if (!inside || nearCorner) return [11, 8, 20, 255];

  const barWidth = Math.max(1, Math.round(w * 0.08));
  const bars = [0.34, 0.5, 0.66];
  for (let i = 0; i < bars.length; i++) {
    const bx = Math.round(w * bars[i]);
    const height = Math.round(w * [0.18, 0.34, 0.24][i]);
    if (Math.abs(x - bx) <= barWidth && y >= h / 2 - height && y <= h / 2 + height) return [255, 255, 255, 255];
  }
  if (w >= 32 && x > w * 0.68 && y > h * 0.68 && (Math.abs(y - (h * 0.82)) < w * 0.06 || Math.abs(x - (w * 0.82)) < w * 0.06)) return [255, 255, 255, 230];
  return [r, g, b, 255];
}

export async function generateIcons(dir) {
  mkdirSync(dir, { recursive: true });
  for (const size of [16, 32, 48, 128]) {
    const png = encodePng(size, size, pixel);
    writeFileSync(resolve(dir, `icon${size}.png`), png);
    console.log(`  icons/icon${size}.png`);
  }
}
