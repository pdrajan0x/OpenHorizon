// Organic coastlines for maps whose land is a square block (a city grid, a race track's terrain tile):
// the land outline inset by a noisy distance, so the edge gets bays and headlands, written as the clip
// loops the converter takes (gta5conv map … --clip assets/coast-shapes/<id>.json). The converter then
// leaves out the buildings outside, trims the ground, and src/coast.ts builds beach, sea wall or cliff
// along the new edge. Run once per map on its first (unclipped) conversion; the shapes are committed.
// Usage: node scripts/shape-coast.mjs [id ...] [--force]   (reads public/mods/maps/<id>/island.json, roads.json)
import fs from 'node:fs';
import { cleanMask, traceLoops } from '../src/outline.ts';

const CELL = 20; // m per mask cell
const OUT = 'assets/coast-shapes';
// Per map: mean inset from the old edge (m), how far it swings either way, the size of the bays (m),
// and how wide a strip either side of its roads stays whole (a mountain pass mustn't be cut; a city
// grid's streets may end at the new shore)
const SHAPES = {
  'tokyo-shinjuku': { inset: 240, vary: 200, bay: 900, keepRoads: 0, seed: 3 },
  shibuya: { inset: 80, vary: 70, bay: 350, keepRoads: 0, seed: 5 },
  tsukuba: { inset: 650, vary: 450, bay: 1800, keepRoads: 80, seed: 7 },
};

const args = process.argv.slice(2);
const force = args.includes('--force');
const ids = args.filter((a) => !a.startsWith('--'));

function random(seed) {
  let a = seed * 2654435761;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Smooth noise in [-1, 1]: a few plane waves in random directions, big bays plus smaller wiggles. */
function noise(seed, bay) {
  const rnd = random(seed);
  const waves = [1, 0.5, 0.25].map((amp, k) => {
    const a = rnd() * Math.PI * 2;
    return { amp, dx: Math.cos(a), dz: Math.sin(a), f: (Math.PI * 2) / (bay / [1, 2.1, 4.3][k]), phase: rnd() * Math.PI * 2 };
  });
  const total = waves.reduce((s, w) => s + w.amp, 0);
  return (x, z) => waves.reduce((s, w) => s + w.amp * Math.sin((w.dx * x + w.dz * z) * w.f + w.phase), 0) / total;
}

function area(p) {
  let s = 0;
  for (let i = 0; i < p.length; i++) {
    const a = p[i];
    const b = p[(i + 1) % p.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
}

for (const id of ids.length ? ids : Object.keys(SHAPES)) {
  const shape = SHAPES[id];
  const out = `${OUT}/${id}.json`;
  if (!shape) { console.log(`${id}: no shape settings`); continue; }
  if (fs.existsSync(out) && !force) { console.log(`${id}: ${out} exists (--force to redo)`); continue; }
  const dir = `public/mods/maps/${id}`;
  const loops = JSON.parse(fs.readFileSync(`${dir}/island.json`, 'utf8')).loops.filter((l) => Math.abs(area(l.points)) > 20000);
  const roads = JSON.parse(fs.readFileSync(`${dir}/roads.json`, 'utf8'));

  // The old land, rasterized (even-odd over its loops)
  let [minX, minZ, maxX, maxZ] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const l of loops) for (const [x, z] of l.points) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
  }
  const x0 = Math.floor(minX / CELL) * CELL - CELL * 2;
  const z0 = Math.floor(minZ / CELL) * CELL - CELL * 2;
  const nx = Math.ceil((maxX - x0) / CELL) + 3;
  const nz = Math.ceil((maxZ - z0) / CELL) + 3;
  const old = new Uint8Array(nx * nz);
  for (let i = 0; i < nx; i++) {
    const x = x0 + (i + 0.5) * CELL;
    const zs = [];
    for (const l of loops) {
      const p = l.points;
      for (let k = 0; k < p.length; k++) {
        const a = p[k];
        const b = p[(k + 1) % p.length];
        if ((a[0] <= x) !== (b[0] <= x)) zs.push(a[1] + ((x - a[0]) / (b[0] - a[0])) * (b[1] - a[1]));
      }
    }
    zs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < zs.length; k += 2) {
      for (let j = Math.max(0, Math.ceil((zs[k] - z0) / CELL - 0.5)); j < nz && z0 + (j + 0.5) * CELL <= zs[k + 1]; j++) old[i * nz + j] = 1;
    }
  }

  // Distance (m) from each land cell to the old edge: two-pass chamfer
  const dist = new Float32Array(nx * nz).map((_, k) => (old[k] ? Infinity : 0));
  const D = Math.SQRT2;
  const pass = (fwd) => {
    const [i0, i1, s] = fwd ? [0, nx, 1] : [nx - 1, -1, -1];
    for (let i = i0; i !== i1; i += s) {
      for (let j = fwd ? 0 : nz - 1; fwd ? j < nz : j >= 0; j += s) {
        const k = i * nz + j;
        if (!dist[k]) continue;
        for (const [di, dj, w] of [[-s, 0, 1], [0, -s, 1], [-s, -s, D], [-s, s, D]]) {
          const a = i + di;
          const b = j + dj;
          const v = a < 0 || b < 0 || a >= nx || b >= nz ? 0 : dist[a * nz + b];
          if (v + w < dist[k]) dist[k] = v + w;
        }
      }
    }
  };
  pass(true);
  pass(false);

  // The new land: deeper than the noisy inset, or near a road that must stay whole
  const n = noise(shape.seed, shape.bay);
  const land = new Uint8Array(nx * nz);
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < nz; j++) {
      const k = i * nz + j;
      if (old[k] && dist[k] * CELL > shape.inset + shape.vary * n(x0 + (i + 0.5) * CELL, z0 + (j + 0.5) * CELL)) land[k] = 1;
    }
  }
  if (shape.keepRoads) {
    const r = Math.ceil(shape.keepRoads / CELL);
    for (const [a, b] of roads.links) {
      const p = roads.nodes[a];
      const q = roads.nodes[b];
      const steps = Math.max(1, Math.ceil(Math.hypot(q[0] - p[0], q[2] - p[2]) / CELL));
      for (let s = 0; s <= steps; s++) {
        const ci = Math.floor((p[0] + ((q[0] - p[0]) * s) / steps - x0) / CELL);
        const cj = Math.floor((p[2] + ((q[2] - p[2]) * s) / steps - z0) / CELL);
        for (let i = ci - r; i <= ci + r; i++) for (let j = cj - r; j <= cj + r; j++) {
          if (i >= 0 && j >= 0 && i < nx && j < nz && (i - ci) ** 2 + (j - cj) ** 2 <= r * r && old[i * nz + j]) land[i * nz + j] = 1;
        }
      }
    }
  }

  // One island: the biggest piece, its small lakes filled
  const mask = { nx, nz, x0, z0, cell: CELL, land, height: new Float32Array(nx * nz) };
  cleanMask(mask, 60000, 60000);
  const label = new Int32Array(nx * nz).fill(-1);
  const sizes = [];
  for (let k0 = 0; k0 < nx * nz; k0++) {
    if (!land[k0] || label[k0] >= 0) continue;
    const id2 = sizes.length;
    let count = 0;
    const stack = [k0];
    label[k0] = id2;
    while (stack.length) {
      const k = stack.pop();
      count++;
      const i = Math.floor(k / nz);
      const j = k % nz;
      for (const [a, b] of [[i + 1, j], [i - 1, j], [i, j + 1], [i, j - 1]]) {
        const kk = a * nz + b;
        if (a >= 0 && b >= 0 && a < nx && b < nz && land[kk] && label[kk] < 0) { label[kk] = id2; stack.push(kk); }
      }
    }
    sizes.push(count);
  }
  const biggest = sizes.indexOf(Math.max(...sizes));
  for (let k = 0; k < nx * nz; k++) if (land[k] && label[k] !== biggest) land[k] = 0;

  const traced = traceLoops(mask, 16).filter((l) => Math.abs(area(l.points)) > 20000);
  const before = old.reduce((s, v) => s + v, 0) * CELL * CELL;
  const after = land.reduce((s, v) => s + v, 0) * CELL * CELL;
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(out, JSON.stringify({
    version: 1,
    note: 'Clip loops for the converter (game frame, map-local): made by scripts/shape-coast.mjs',
    loops: traced.map((l) => ({ outer: l.outer, points: l.points.map(([x, z]) => [Math.round(x * 10) / 10, Math.round(z * 10) / 10]) })),
  }));
  console.log(`${id}: land ${(before / 1e6).toFixed(2)} → ${(after / 1e6).toFixed(2)} km², ${traced.length} loops → ${out}`);
}
