// Cross-check of the built-in QR encoder against independent decoders (macOS only, not part of `npm test`).
// Writes PNG symbols for versions 1-40 x L/M/Q/H (all 8 masks get exercised) plus a UTF-8 payload,
// then tools/verify-macos.swift decodes each PNG with CoreImage (CIDetector) and Vision and compares the text.
//
//   mkdir -p /tmp/qr-check && node tools/verify-macos.mjs /tmp/qr-check && swift tools/verify-macos.swift /tmp/qr-check/manifest.json
//
// Expected last line: TOTAL ok=268 bad=0
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { encodeQr, numDataCodewords } from '../mcp-qris.mjs';

const out = process.argv[2];
if (!out || !fs.existsSync(out)) { console.error('usage: node tools/verify-macos.mjs <existing output dir>'); process.exit(2); }

const table = [];
for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
const crc32 = buf => { let x = 0xffffffff; for (const b of buf) x = table[(x ^ b) & 0xff] ^ (x >>> 8); return (x ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, c]);
}
function png(qr, px = 4, margin = 4) {
  const dim = (qr.size + 2 * margin) * px;
  const rows = [];
  for (let y = 0; y < dim; y++) {
    const r = Buffer.alloc(dim + 1);
    for (let x = 0; x < dim; x++) {
      const mx = Math.floor(x / px) - margin, my = Math.floor(y / px) - margin;
      r[x + 1] = mx >= 0 && my >= 0 && mx < qr.size && my < qr.size && qr.modules[my][mx] ? 0 : 255;
    }
    rows.push(r);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(dim, 0); ihdr.writeUInt32BE(dim, 4); ihdr[8] = 8;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

let seed = 12345;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 .-*/:';
const cases = [];
for (const ecc of ['L', 'M', 'Q', 'H']) for (let v = 1; v <= 40; v++) {
  const cap = Math.floor((numDataCodewords(v, ecc) * 8 - 4 - (v <= 9 ? 8 : 16)) / 8);
  cases.push([ecc, cap]); // exactly fills version v
  if (v <= 25) cases.push([ecc, Math.max(1, cap - Math.floor(rnd() * 5))]);
}
const manifest = [];
const add = (text, ecc) => {
  const qr = encodeQr(text, ecc);
  const f = path.join(out, `q${String(manifest.length).padStart(3, '0')}.png`);
  fs.writeFileSync(f, png(qr, qr.size > 120 ? 3 : 4));
  manifest.push({ f, t: text, ecc, v: qr.version, mask: qr.mask });
};
for (const [ecc, len] of cases) { let t = ''; for (let k = 0; k < len; k++) t += alphabet[Math.floor(rnd() * alphabet.length)]; add(t, ecc); }
for (const t of ['Halo dunia, ini QR UTF-8: Rp1.000 éè 测试', 'x']) for (const ecc of ['L', 'M', 'Q', 'H']) add(t, ecc);
fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest));
console.log(`${manifest.length} symbols, masks used: ${[...new Set(manifest.map(m => m.mask))].sort().join(',')}`);
