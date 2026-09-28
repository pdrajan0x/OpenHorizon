// A converted map's .gtx textures as PNG, to look at: node scripts/gtx-png.mjs <mapId> <out-dir> <name…>
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
// --- DXT (BC1/BC2/BC3) decode and BC1/BC3 encode ---
const rgb565 = (c) => [((c >> 11) & 31) * 255 / 31, ((c >> 5) & 63) * 255 / 63, (c & 31) * 255 / 31];
function decode(buf, format, w, h) {
  const out = new Uint8Array(w * h * 4);
  if (format === 0) { out.set(buf.subarray(0, w * h * 4)); return out; }
  const block = format === 1 ? 8 : 16;
  const bw = Math.max(1, Math.ceil(w / 4));
  const bh = Math.max(1, Math.ceil(h / 4));
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      const o = (by * bw + bx) * block;
      const alpha = new Uint8Array(16).fill(255);
      let c = o;
      if (format === 3) {
        for (let i = 0; i < 16; i++) alpha[i] = ((buf[o + (i >> 1)] >> ((i & 1) * 4)) & 15) * 17;
        c = o + 8;
      } else if (format === 5) {
        const a0 = buf[o];
        const a1 = buf[o + 1];
        const pal = [a0, a1];
        if (a0 > a1) for (let i = 1; i < 7; i++) pal.push(((7 - i) * a0 + i * a1) / 7);
        else { for (let i = 1; i < 5; i++) pal.push(((5 - i) * a0 + i * a1) / 5); pal.push(0, 255); }
        let bits = 0n;
        for (let i = 0; i < 6; i++) bits |= BigInt(buf[o + 2 + i]) << BigInt(8 * i);
        for (let i = 0; i < 16; i++) alpha[i] = pal[Number((bits >> BigInt(3 * i)) & 7n)];
        c = o + 8;
      }
      const c0 = buf[c] | (buf[c + 1] << 8);
      const c1 = buf[c + 2] | (buf[c + 3] << 8);
      const p0 = rgb565(c0);
      const p1 = rgb565(c1);
      const pal = [p0, p1];
      if (c0 > c1 || format !== 1) pal.push(p0.map((v, k) => (2 * v + p1[k]) / 3), p0.map((v, k) => (v + 2 * p1[k]) / 3));
      else pal.push(p0.map((v, k) => (v + p1[k]) / 2), [0, 0, 0]);
      const bits = buf[c + 4] | (buf[c + 5] << 8) | (buf[c + 6] << 16) | (buf[c + 7] << 24);
      for (let i = 0; i < 16; i++) {
        const x = bx * 4 + (i & 3);
        const y = by * 4 + (i >> 2);
        if (x >= w || y >= h) continue;
        const idx = (bits >>> (2 * i)) & 3;
        const q = (y * w + x) * 4;
        const col = pal[idx];
        out[q] = col[0]; out[q + 1] = col[1]; out[q + 2] = col[2];
        out[q + 3] = format === 1 && c0 <= c1 && idx === 3 ? 0 : alpha[i];
      }
    }
  }
  return out;
}

const to565 = (r, g, b) => ((Math.round(r * 31 / 255) << 11) | (Math.round(g * 63 / 255) << 5) | Math.round(b * 31 / 255));
function readGtx(file) {
  const b = fs.readFileSync(file);
  if (b.toString('latin1', 0, 4) !== 'GTX1') return null;
  return { format: b.readUInt32LE(4), w: b.readUInt16LE(8), h: b.readUInt16LE(10), mips: b.readUInt16LE(12), data: new Uint8Array(b.buffer, b.byteOffset + 16, b.length - 16) };
}

const [map, out, ...names] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
for (const n of names) {
  const t = readGtx(`public/mods/maps/${map}/tex/${n}.gtx`);
  const px = decode(t.data, t.format, t.w, t.h);
  fs.writeFileSync(`${out}/${n}.rgba`, px);
  execFileSync('magick', ['-size', `${t.w}x${t.h}`, '-depth', '8', `rgba:${out}/${n}.rgba`, `${out}/${n}.png`]);
  fs.unlinkSync(`${out}/${n}.rgba`);
}
