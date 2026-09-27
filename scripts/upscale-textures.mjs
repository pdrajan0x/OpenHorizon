// Remaster a converted city's small textures: every diffuse texture of at most MAX_SOURCE px is upscaled
// 4× with Real-ESRGAN (tools/vendor/realesrgan, on the GPU), scaled to TARGET× its size (Lanczos),
// given a fresh mip chain and compressed back to DXT, in place of the original .gtx (kept under
// .build/work/up/<id>/orig/). Low-resolution facades then read as sharp stone, brick and glass.
// Re-running skips textures already done (public/mods/maps/<id>/upscaled.json); --redo does them again.
// Only the full-size level is new: the mips below it are the original texture's, so it never looks softer.
// Usage: node scripts/upscale-textures.mjs <mapId> [...] [--redo]   (needs ImageMagick)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const MAX_SOURCE = 512; // px, longest edge: bigger textures are sharp enough as they are
const MIN_SOURCE = 64; // px: smaller ones are tiling detail, left alone
const TARGET = 2; // × the original size
const ESRGAN = 'tools/vendor/realesrgan/realesrgan-ncnn-vulkan';
const GPU_ENV = { ...process.env, __NV_PRIME_RENDER_OFFLOAD: '1', __VK_LAYER_NV_optimus: 'NVIDIA_only' };

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
function encode(px, w, h, withAlpha) {
  const block = withAlpha ? 16 : 8;
  const bw = Math.max(1, Math.ceil(w / 4));
  const bh = Math.max(1, Math.ceil(h / 4));
  const out = new Uint8Array(bw * bh * block);
  const pix = new Array(16);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      for (let i = 0; i < 16; i++) {
        const x = Math.min(w - 1, bx * 4 + (i & 3));
        const y = Math.min(h - 1, by * 4 + (i >> 2));
        const q = (y * w + x) * 4;
        pix[i] = [px[q], px[q + 1], px[q + 2], px[q + 3]];
      }
      let o = (by * bw + bx) * block;
      if (withAlpha) {
        let a0 = 0;
        let a1 = 255;
        for (const p of pix) { a0 = Math.max(a0, p[3]); a1 = Math.min(a1, p[3]); }
        out[o] = a0; out[o + 1] = a1;
        const pal = [a0, a1];
        for (let i = 1; i < 7; i++) pal.push(((7 - i) * a0 + i * a1) / 7);
        let bits = 0n;
        pix.forEach((p, i) => {
          let best = 0;
          for (let k = 1; k < 8; k++) if (Math.abs(pal[k] - p[3]) < Math.abs(pal[best] - p[3])) best = k;
          bits |= BigInt(a0 === a1 ? 0 : best) << BigInt(3 * i);
        });
        for (let i = 0; i < 6; i++) out[o + 2 + i] = Number((bits >> BigInt(8 * i)) & 255n);
        o += 8;
      }
      // Endpoints: the block's extremes along its main colour axis (luminance), inset a little
      let lo = pix[0];
      let hi = pix[0];
      const lum = (p) => p[0] * 0.3 + p[1] * 0.59 + p[2] * 0.11;
      for (const p of pix) { if (lum(p) < lum(lo)) lo = p; if (lum(p) > lum(hi)) hi = p; }
      const inset = (a, b) => a.slice(0, 3).map((v, k) => v + (b[k] - v) / 16);
      let e0 = to565(...inset(hi, lo));
      let e1 = to565(...inset(lo, hi));
      if (e0 < e1) [e0, e1] = [e1, e0];
      const p0 = rgb565(e0);
      const p1 = rgb565(e1);
      const pal = [p0, p1, p0.map((v, k) => (2 * v + p1[k]) / 3), p0.map((v, k) => (v + 2 * p1[k]) / 3)];
      let bits = 0;
      if (e0 !== e1) {
        pix.forEach((p, i) => {
          let best = 0;
          let bd = Infinity;
          for (let k = 0; k < 4; k++) {
            const d = (pal[k][0] - p[0]) ** 2 + (pal[k][1] - p[1]) ** 2 + (pal[k][2] - p[2]) ** 2;
            if (d < bd) { bd = d; best = k; }
          }
          bits |= best << (2 * i);
        });
      }
      out[o] = e0 & 255; out[o + 1] = e0 >> 8; out[o + 2] = e1 & 255; out[o + 3] = e1 >> 8;
      out[o + 4] = bits & 255; out[o + 5] = (bits >>> 8) & 255; out[o + 6] = (bits >>> 16) & 255; out[o + 7] = (bits >>> 24) & 255;
    }
  }
  return out;
}

function readGtx(file) {
  const b = fs.readFileSync(file);
  if (b.toString('latin1', 0, 4) !== 'GTX1') return null;
  return { format: b.readUInt32LE(4), w: b.readUInt16LE(8), h: b.readUInt16LE(10), mips: b.readUInt16LE(12), data: new Uint8Array(b.buffer, b.byteOffset + 16, b.length - 16) };
}

function writeGtx(file, format, levels) {
  const head = Buffer.alloc(16);
  head.write('GTX1', 0, 'latin1');
  head.writeUInt32LE(format, 4);
  head.writeUInt16LE(levels[0].w, 8);
  head.writeUInt16LE(levels[0].h, 10);
  head.writeUInt16LE(levels.length, 12);
  fs.writeFileSync(file, Buffer.concat([head, ...levels.map((l) => Buffer.from(l.data))]));
}

// ImageMagick 7's `magick`, or 6's `convert` (Ubuntu)
const MAGICK = (() => { try { execFileSync('magick', ['-version'], { stdio: 'ignore' }); return 'magick'; } catch { return 'convert'; } })();
const magick = (...args) => execFileSync(MAGICK, args, { stdio: ['ignore', 'ignore', 'inherit'], maxBuffer: 1 << 30 });


const KEEP_GRAIN = 40; // % of the original (Lanczos-scaled) blended back into the AI upscale: ESRGAN smooths grain away
const levelSize = (format, w, h) => (format === 0 ? w * h * 4 : Math.ceil(w / 4) * Math.ceil(h / 4) * (format === 1 ? 8 : 16));

/** A texture's mip levels as stored: { w, h, raw }. */
function levelsOf(t) {
  const out = [];
  for (let k = 0, o = 0, w = t.w, h = t.h; k < t.mips && o < t.data.length; k++, w = Math.max(1, w >> 1), h = Math.max(1, h >> 1)) {
    const n = levelSize(t.format, w, h);
    out.push({ w, h, raw: t.data.subarray(o, o + n) });
    o += n;
  }
  return out;
}

/** Half size, 2×2 box filter. */
function half(px, w, h) {
  const nw = Math.max(1, w >> 1);
  const nh = Math.max(1, h >> 1);
  const next = new Uint8Array(nw * nh * 4);
  const at = (xx, yy, k) => px[(Math.min(h - 1, yy) * w + Math.min(w - 1, xx)) * 4 + k];
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      for (let k = 0; k < 4; k++) {
        next[(y * nw + x) * 4 + k] = (at(2 * x, 2 * y, k) + at(2 * x + 1, 2 * y, k) + at(2 * x, 2 * y + 1, k) + at(2 * x + 1, 2 * y + 1, k) + 2) >> 2;
      }
    }
  }
  return { px: next, w: nw, h: nh };
}

// --redo: remaster again the textures already done (from the originals kept under orig/)
const redo = process.argv.includes('--redo');
for (const id of process.argv.slice(2).filter((a) => !a.startsWith('--'))) {
  const dir = `public/mods/maps/${id}`;
  const work = `.build/work/up/${id}`;
  for (const d of ['in', 'src', 'out', 'orig']) fs.mkdirSync(`${work}/${d}`, { recursive: true });
  for (const f of fs.readdirSync(`${work}/src`)) fs.rmSync(`${work}/src/${f}`);
  const doneFile = `${dir}/upscaled.json`;
  const done = new Set(!redo && fs.existsSync(doneFile) ? JSON.parse(fs.readFileSync(doneFile, 'utf8')) : []);
  const manifest = JSON.parse(fs.readFileSync(`${dir}/manifest.json`, 'utf8'));
  const names = [...new Set(manifest.materials.map((m) => m.diffuse).filter(Boolean))].filter((n) => !done.has(n));
  const jobs = [];
  for (const name of names) {
    const file = `${dir}/tex/${name}.gtx`;
    const kept = `${work}/orig/${name}.gtx`;
    if (!fs.existsSync(file)) continue;
    const cur = readGtx(file);
    const saved = fs.existsSync(kept) ? readGtx(kept) : null;
    // The original: the kept copy when the texture in place is our own upscale of it
    const t = saved && cur && cur.w === saved.w * TARGET && cur.h === saved.h * TARGET ? saved : cur;
    if (!t || ![0, 1, 3, 5].includes(t.format)) continue;
    const size = Math.max(t.w, t.h);
    if (size > MAX_SOURCE || size < MIN_SOURCE) continue;
    if (t === cur) fs.copyFileSync(file, kept);
    const px = decode(t.data, t.format, t.w, t.h);
    const hasAlpha = px.some((v, i) => i % 4 === 3 && v < 250);
    fs.writeFileSync(`${work}/in/${name}.rgba`, px);
    magick('-size', `${t.w}x${t.h}`, '-depth', '8', `rgba:${work}/in/${name}.rgba`, `${work}/in/${name}.png`);
    fs.rmSync(`${work}/in/${name}.rgba`);
    if (!fs.existsSync(`${work}/out/${name}.png`)) fs.copyFileSync(`${work}/in/${name}.png`, `${work}/src/${name}.png`);
    jobs.push({ name, file, t, hasAlpha });
  }
  const queued = fs.readdirSync(`${work}/src`).length;
  console.log(`${id}: ${jobs.length} textures to remaster, ${queued} through Real-ESRGAN`);
  if (!jobs.length) continue;
  if (queued) {
    execFileSync(ESRGAN, ['-i', `${work}/src`, '-o', `${work}/out`, '-n', 'realesrgan-x4plus', '-s', '4', '-f', 'png'], {
      env: GPU_ENV, cwd: '.', stdio: ['ignore', 'ignore', 'ignore'],
    });
  }
  for (const { name, file, t, hasAlpha } of jobs) {
    const up = `${work}/out/${name}.png`;
    if (!fs.existsSync(up)) { console.log(`  ! ${name}: no output`); continue; }
    const w = t.w * TARGET;
    const h = t.h * TARGET;
    const raw = `${work}/out/${name}.rgba`;
    // The AI upscale with some of the original's grain back, lightly sharpened
    magick(up, '-filter', 'Lanczos', '-resize', `${w}x${h}!`,
      '(', `${work}/in/${name}.png`, '-filter', 'Lanczos', '-resize', `${w}x${h}!`, ')',
      '-compose', 'blend', '-define', `compose:args=${KEEP_GRAIN}`, '-composite',
      '-channel', 'RGB', '-unsharp', '0x1+0.6+0.01', '+channel', '-depth', '8', `rgba:${raw}`);
    const px = new Uint8Array(fs.readFileSync(raw));
    fs.rmSync(raw);
    // Level 0 is the new detail; below it the original's own mips, so from a distance nothing changes
    const format = hasAlpha ? 5 : 1;
    const levels = [{ w, h, data: encode(px, w, h, hasAlpha) }];
    let last = null;
    for (const l of levelsOf(t)) {
      last = { px: decode(l.raw, t.format, l.w, l.h), w: l.w, h: l.h };
      levels.push({ w: l.w, h: l.h, data: t.format === format ? l.raw : encode(last.px, l.w, l.h, hasAlpha) });
    }
    while (last && (last.w > 4 || last.h > 4)) {
      last = half(last.px, last.w, last.h);
      levels.push({ w: last.w, h: last.h, data: encode(last.px, last.w, last.h, hasAlpha) });
    }
    writeGtx(file, format, levels);
    done.add(name);
  }
  fs.writeFileSync(doneFile, JSON.stringify([...done].sort()));
  console.log(`${id}: done, ${done.size} textures remastered`);
}
