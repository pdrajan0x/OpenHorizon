// Where a converted map already has painted markings (materials whose texture is a lane marking), as a
// set of 1 m cells: scripts drop the markings they add where paint is already there.
//   import { existingPaint } from './existing-paint.mjs'; const has = existingPaint('carla-town12'); has(x, z)
//   node scripts/existing-paint.mjs <map…>           how much of each map's markings.json is painted already
//   node scripts/existing-paint.mjs <map…> --apply   and drop that from markings.json
import fs from 'node:fs';

export function existingPaint(id, pattern = /lanemarking|line_|_line|marking|zebra|crosswalk|stopline/i) {
  const dir = `public/mods/maps/${id}`;
  const m = JSON.parse(fs.readFileSync(`${dir}/manifest.json`, 'utf8'));
  const paint = new Set(m.materials.map((x, i) => (x.diffuse && pattern.test(x.diffuse) ? i : -1)).filter((i) => i >= 0));
  const cells = new Set();
  let tris = 0;
  for (const c of m.cells) {
    if (!c.render) continue;
    const file = `${dir}/cells/${c.id}.bin`;
    if (!fs.existsSync(file)) continue;
    const buf = fs.readFileSync(file);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const view = new DataView(ab);
    const jl = view.getUint32(0, true);
    const header = JSON.parse(new TextDecoder().decode(new Uint8Array(ab, 4, jl)));
    let off = 4 + jl;
    off += (4 - (off % 4)) % 4;
    for (const b of header.batches) {
      const stride = b.colors ? 9 : 8;
      const v = new Float32Array(ab, off, b.vertices * stride);
      off += b.vertices * stride * 4;
      const idx = new Uint32Array(ab, off, b.indices);
      off += b.indices * 4;
      if (!paint.has(b.material)) continue;
      for (let t = 0; t + 2 < idx.length; t += 3) {
        tris++;
        // Every metre over the triangle's bounds (paint strips are thin: bounds are close enough)
        const xs = [0, 1, 2].map((k) => v[idx[t + k] * stride]);
        const zs = [0, 1, 2].map((k) => v[idx[t + k] * stride + 2]);
        for (let x = Math.floor(Math.min(...xs)); x <= Math.floor(Math.max(...xs)); x++) {
          for (let z = Math.floor(Math.min(...zs)); z <= Math.floor(Math.max(...zs)); z++) cells.add(`${x},${z}`);
        }
      }
    }
  }
  const has = (x, z) => {
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) if (cells.has(`${Math.floor(x) + i},${Math.floor(z) + j}`)) return true;
    return false;
  };
  has.triangles = tris;
  has.cells = cells.size;
  return has;
}

if (process.argv[1]?.endsWith('existing-paint.mjs')) {
  const apply = process.argv.includes('--apply');
  for (const id of process.argv.slice(2).filter((a) => !a.startsWith('--'))) {
    if (apply) { console.log(`${id}: ${dropPainted(id)} points and patches already painted, dropped`); continue; }
    const has = existingPaint(id);
    const mk = JSON.parse(fs.readFileSync(`public/mods/maps/${id}/markings.json`, 'utf8'));
    let pts = 0;
    let covered = 0;
    for (const [, , , f] of mk.lines) for (let i = 0; i + 2 < f.length; i += 3) { pts++; if (has(f[i], f[i + 2])) covered++; }
    console.log(`${id}: ${has.triangles} paint triangles over ${has.cells} m²; ${covered} of ${pts} marking points already painted`);
  }
}

/** Drop from a map's markings.json what the map has painted already: line points (splitting the line) and patches. */
export function dropPainted(id) {
  const has = existingPaint(id);
  const file = `public/mods/maps/${id}/markings.json`;
  const mk = JSON.parse(fs.readFileSync(file, 'utf8'));
  const lines = [];
  let dropped = 0;
  for (const [yellow, width, type, f, dash, gap] of mk.lines) {
    let run = [];
    const flush = () => { if (run.length >= 6) lines.push([yellow, width, type, run, dash, gap]); run = []; };
    for (let i = 0; i + 2 < f.length; i += 3) {
      if (has(f[i], f[i + 2])) { dropped++; flush(); } else run.push(f[i], f[i + 1], f[i + 2]);
    }
    flush();
  }
  const patches = (mk.patches ?? []).filter(([, c]) => !has(c[0], c[2]) || !++dropped);
  fs.writeFileSync(file, JSON.stringify({ lines, patches }));
  return dropped;
}
