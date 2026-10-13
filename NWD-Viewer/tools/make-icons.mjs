import { fileURLToPath } from 'url';
// Draws icon-192.png and icon-512.png (navy tile, red stripe, white isometric cube). node tools/make-icons.mjs
import fs from 'fs'; import zlib from 'zlib'; import path from 'path';
const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function png(w, h, rgba) {
  const crcT = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
  const crc = b => { let c = -1; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
  const chunk = (t, d) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h); for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4); }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
function inPoly(x, y, P) { let c = false; for (let i = 0, j = P.length - 1; i < P.length; j = i++) { const [xi, yi] = P[i], [xj, yj] = P[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c; } return c; }
function segDist(px, py, [ax, ay], [bx, by]) { const dx = bx - ax, dy = by - ay, t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy))); return Math.hypot(px - ax - t * dx, py - ay - t * dy); }

function draw(S) {
  const buf = Buffer.alloc(S * S * 4), SS = 4;
  const navy = [11, 35, 57], red = [189, 29, 35], white = [255, 255, 255], light = [159, 179, 200];
  const c = S / 2, r = S * 0.27, h = r * Math.sqrt(3) / 2;
  const top = [c, c - r * 0.95 - S * 0.03], L = [c - h, c - r * 0.45 - S * 0.03], R = [c + h, c - r * 0.45 - S * 0.03], M = [c, c + 0.05 * r - S * 0.03];
  const BL = [c - h, c + r * 0.55 - S * 0.03], BR = [c + h, c + r * 0.55 - S * 0.03], B = [c, c + r * 1.05 - S * 0.03];
  const topFace = [top, R, M, L], leftFace = [L, M, B, BL], rightFace = [M, R, BR, B];
  const edges = [[top, R], [R, M], [M, L], [L, top], [L, BL], [BL, B], [B, BR], [BR, R], [M, B]];
  const lw = S * 0.022;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const acc = [0, 0, 0];
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const px = x + (sx + 0.5) / SS, py = y + (sy + 0.5) / SS;
      let col = navy;
      if (py > S * 0.86) col = red;
      if (inPoly(px, py, topFace)) col = [40, 72, 104];
      else if (inPoly(px, py, leftFace)) col = [26, 54, 82];
      else if (inPoly(px, py, rightFace)) col = [189, 29, 35];
      for (const [a, b] of edges) if (segDist(px, py, a, b) < lw) { col = white; break; }
      acc[0] += col[0]; acc[1] += col[1]; acc[2] += col[2];
    }
    const i = (y * S + x) * 4; buf[i] = acc[0] / (SS * SS); buf[i + 1] = acc[1] / (SS * SS); buf[i + 2] = acc[2] / (SS * SS); buf[i + 3] = 255;
  }
  return png(S, S, buf);
}
for (const S of [192, 512]) { fs.writeFileSync(path.join(out, `icon-${S}.png`), draw(S)); console.log('icon', S); }
