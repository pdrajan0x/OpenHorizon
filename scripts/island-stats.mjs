// Per-map data for placing a city as an island (src/islands.ts, src/coast.ts), from its collision:
// the 2nd percentile of ground height, the vertical offset that puts it on the shared sea, and a coarse
// land outline (coast.json schema) used until scripts/map-extras.mjs writes the finer coast.json.
// Usage: node scripts/island-stats.mjs [id ...]   → public/mods/maps/<id>/island.json
import fs from 'node:fs';
import { cleanMask, traceLoops, verticalOffset } from '../src/outline.ts';

const CELL = 20; // m per mask cell
const root = 'public/mods/maps';
const ids = process.argv.slice(2).length ? process.argv.slice(2)
  : JSON.parse(fs.readFileSync(`${root}/index.json`, 'utf8')).map((i) => i.id);

function* triangles(id) {
  const dir = `${root}/${id}/col`;
  for (const f of fs.readdirSync(dir)) {
    let b;
    try { b = fs.readFileSync(`${dir}/${f}`); } catch { continue; } // mid re-conversion
    if (b.length < 8) continue;
    const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.length);
    const v = new DataView(ab);
    const nv = v.getUint32(0, true);
    const ni = v.getUint32(4, true);
    if (8 + nv * 12 + ni * 4 > ab.byteLength) continue;
    yield [new Float32Array(ab, 8, nv * 3), new Uint32Array(ab, 8 + nv * 12, ni)];
  }
}

for (const id of ids) {
  const t0 = Date.now();
  const manifest = JSON.parse(fs.readFileSync(`${root}/${id}/manifest.json`, 'utf8'));
  const roads = JSON.parse(fs.readFileSync(`${root}/${id}/roads.json`, 'utf8'));
  // Pass 1: heights of up-facing collision, and the bounds
  const hs = [];
  let [minX, minZ, maxX, maxZ] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [p, ix] of triangles(id)) {
    for (let t = 0; t < ix.length; t += 3) {
      const a = ix[t] * 3, b = ix[t + 1] * 3, c = ix[t + 2] * 3;
      const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
      const wx = p[c] - p[a], wy = p[c + 1] - p[a + 1], wz = p[c + 2] - p[a + 2];
      const ny = uz * wx - ux * wz;
      const l = Math.hypot(uy * wz - uz * wy, ny, ux * wy - uy * wx) || 1;
      if (ny / l < 0.8) continue;
      if (t % 21 === 0) hs.push((p[a + 1] + p[b + 1] + p[c + 1]) / 3);
      for (const k of [a, b, c]) {
        minX = Math.min(minX, p[k]); maxX = Math.max(maxX, p[k]);
        minZ = Math.min(minZ, p[k + 2]); maxZ = Math.max(maxZ, p[k + 2]);
      }
    }
  }
  if (!hs.length) { console.log(id, 'no collision'); continue; }
  hs.sort((a, b) => a - b);
  const groundP2 = hs[Math.floor(hs.length * 0.02)];
  const ry = roads.nodes.map((n) => n[1]).sort((a, b) => a - b);
  const roadP1 = ry[Math.floor(ry.length * 0.01)] ?? groundP2;
  const water = manifest.stats?.water ?? null;
  const dy = verticalOffset(water, groundP2, roadP1);
  const floor = -2 - dy; // land is anything up-facing above 2 m under the shared sea level

  // Pass 2: rasterize up-facing surfaces into the land mask, lowest surface per cell
  const x0 = Math.floor(minX / CELL) * CELL - CELL * 2;
  const z0 = Math.floor(minZ / CELL) * CELL - CELL * 2;
  const nx = Math.ceil((maxX - x0) / CELL) + 3;
  const nz = Math.ceil((maxZ - z0) / CELL) + 3;
  const land = new Uint8Array(nx * nz);
  const height = new Float32Array(nx * nz).fill(Infinity);
  const mark = (i, j, y) => {
    if (i < 0 || j < 0 || i >= nx || j >= nz || y < floor) return;
    const k = i * nz + j;
    land[k] = 1;
    if (y < height[k]) height[k] = y;
  };
  for (const [p, ix] of triangles(id)) {
    for (let t = 0; t < ix.length; t += 3) {
      const a = ix[t] * 3, b = ix[t + 1] * 3, c = ix[t + 2] * 3;
      const ax = p[a], ay = p[a + 1], az = p[a + 2];
      const ux = p[b] - ax, uy = p[b + 1] - ay, uz = p[b + 2] - az;
      const wx = p[c] - ax, wy = p[c + 1] - ay, wz = p[c + 2] - az;
      const ny = uz * wx - ux * wz;
      const l = Math.hypot(uy * wz - uz * wy, ny, ux * wy - uy * wx) || 1;
      if (ny / l < 0.5) continue;
      const lo = [Math.min(ax, ax + ux, ax + wx), Math.min(az, az + uz, az + wz)];
      const hi = [Math.max(ax, ax + ux, ax + wx), Math.max(az, az + uz, az + wz)];
      const i0 = Math.floor((lo[0] - x0) / CELL), i1 = Math.floor((hi[0] - x0) / CELL);
      const j0 = Math.floor((lo[1] - z0) / CELL), j1 = Math.floor((hi[1] - z0) / CELL);
      if (i0 === i1 && j0 === j1) { mark(i0, j0, ay + (uy + wy) / 3); continue; }
      const det = ux * wz - uz * wx;
      if (Math.abs(det) < 1e-9) continue;
      for (let i = i0; i <= i1; i++) {
        for (let j = j0; j <= j1; j++) {
          const px = x0 + (i + 0.5) * CELL - ax, pz = z0 + (j + 0.5) * CELL - az;
          const s = (px * wz - pz * wx) / det;
          const r = (ux * pz - uz * px) / det;
          if (s >= 0 && r >= 0 && s + r <= 1) mark(i, j, ay + s * uy + r * wy);
        }
      }
    }
  }
  const mask = { nx, nz, x0, z0, cell: CELL, land, height };
  cleanMask(mask);
  const loops = traceLoops(mask).filter((l) => l.points.length >= 6);
  const out = {
    version: 1, cellSize: CELL, groundP2: +groundP2.toFixed(2), roadP1: +roadP1.toFixed(2), dy: +dy.toFixed(2),
    water: water ? { minY: water.minY } : null,
    landBounds: [minX, minZ, maxX, maxZ].map((v) => +v.toFixed(1)),
    loops: loops.map((l) => ({ outer: l.outer, points: l.points.map(([x, z, y]) => [+x.toFixed(1), +z.toFixed(1), y]) })),
  };
  fs.writeFileSync(`${root}/${id}/island.json`, JSON.stringify(out));
  const land0 = land.reduce((s, v) => s + v, 0) * CELL * CELL / 1e6;
  console.log(`${id}: p2 ${groundP2.toFixed(1)} road p1 ${roadP1.toFixed(1)} dy ${dy.toFixed(1)} land ${land0.toFixed(1)} km² loops ${loops.length} (${loops.filter((l) => l.outer).length} outer, ${loops.reduce((s, l) => s + l.points.length, 0)} pts) ${Date.now() - t0} ms`);
}
