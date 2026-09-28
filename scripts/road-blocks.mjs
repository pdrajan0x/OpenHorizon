// Things standing on the roads: collision that rises out of the road surface where traffic drives (a wall,
// a hillside, a building's corner across a lane). Traffic follows the road network and drives through
// them; the player hits them. For every road link, a probe every STEP m along it: collision whose top lies
// between RISE_MIN and RISE_MAX m above the road there (the road surface itself, kerbs and overhead
// structures are left out), and across most of the road's width (not a centre barrier or a pillar).
//   node scripts/road-blocks.mjs [map…]   → public/mods/maps/<map>/blocks.json (the game clears them: islands.ts)
//                                           and test-results/road-blocks.json
import fs from 'node:fs';

const STEP = 3;
const RISE_MIN = 0.5; // m above the road: higher than a kerb
const RISE_MAX = 2.3; // m: lower than this blocks a car; an overhead surface higher up (a gallery, a gantry) lets it pass
const G = 25;
const index = JSON.parse(fs.readFileSync('public/mods/maps/index.json', 'utf8'));
const want = process.argv.slice(2);
const out = {};
for (const { id } of index) {
  if (want.length && !want.includes(id)) continue;
  const dir = `public/mods/maps/${id}`;
  const m = JSON.parse(fs.readFileSync(`${dir}/manifest.json`, 'utf8'));
  const roads = JSON.parse(fs.readFileSync(`${dir}/roads.json`, 'utf8'));
  // Collision triangles, bucketed by G m cells
  const tris = [];
  const grid = new Map();
  for (const c of m.cells) {
    if (!c.collision || !fs.existsSync(`${dir}/col/${c.id}.bin`)) continue;
    const b = fs.readFileSync(`${dir}/col/${c.id}.bin`);
    const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    const dv = new DataView(ab);
    const nv = dv.getUint32(0, true);
    const ni = dv.getUint32(4, true);
    const p = new Float32Array(ab, 8, nv * 3);
    const ix = new Uint32Array(ab, 8 + nv * 12, ni);
    for (let t = 0; t < ni; t += 3) {
      const tri = [0, 1, 2].map((k) => [p[ix[t + k] * 3], p[ix[t + k] * 3 + 1], p[ix[t + k] * 3 + 2]]);
      const k = tris.push(tri) - 1;
      const xs = tri.map((v) => v[0]);
      const zs = tri.map((v) => v[2]);
      for (let i = Math.floor(Math.min(...xs) / G); i <= Math.floor(Math.max(...xs) / G); i++) {
        for (let j = Math.floor(Math.min(...zs) / G); j <= Math.floor(Math.max(...zs) / G); j++) {
          const key = `${i},${j}`;
          if (!grid.has(key)) grid.set(key, []);
          grid.get(key).push(k);
        }
      }
    }
  }
  /** Heights of the collision surfaces over (x, z). */
  const heights = (x, z) => {
    const ys = [];
    for (const k of grid.get(`${Math.floor(x / G)},${Math.floor(z / G)}`) ?? []) {
      const [[x0, y0, z0], [x1, y1, z1], [x2, y2, z2]] = tris[k];
      const det = (z1 - z2) * (x0 - x2) + (x2 - x1) * (z0 - z2);
      if (Math.abs(det) < 1e-9) continue;
      const l0 = ((z1 - z2) * (x - x2) + (x2 - x1) * (z - z2)) / det;
      const l1 = ((z2 - z0) * (x - x2) + (x0 - x2) * (z - z2)) / det;
      const l2 = 1 - l0 - l1;
      if (l0 < -1e-4 || l1 < -1e-4 || l2 < -1e-4) continue;
      ys.push(l0 * y0 + l1 * y1 + l2 * y2);
    }
    return ys;
  };
  const blocked = [];
  const seen = new Set();
  for (const [a, b] of roads.links) {
    const p = roads.nodes[a];
    const q = roads.nodes[b];
    const len = Math.hypot(q[0] - p[0], q[2] - p[2]);
    for (let s = STEP / 2; s < len; s += STEP) {
      const t = s / len;
      const x = p[0] + (q[0] - p[0]) * t;
      const y = p[1] + (q[1] - p[1]) * t;
      const z = p[2] + (q[2] - p[2]) * t;
      const ys = heights(x, z);
      // The road surface: the collision closest to the line's height; blocked: something standing above it
      if (!ys.length) continue;
      const road = ys.reduce((best, h) => (Math.abs(h - y) < Math.abs(best - y) ? h : best), ys[0]);
      if (Math.abs(road - y) > 1.5) continue; // no surface at the road here (another check's business)
      // The lowest thing above the road: an obstacle when it's between RISE_MIN and RISE_MAX up
      const above = ys.filter((h) => h - road > RISE_MIN).sort((a, b) => a - b);
      const over = above.length && above[0] - road < RISE_MAX ? [above[0]] : [];
      if (!over.length) continue;
      // A wall or a barrier stands alone; a building has its next floor or its roof a few metres above
      if (above.length > 1 && above[1] - above[0] < 4) continue;
      // Across the road, not just on its line (a centre barrier, a bollard, a pillar in the middle): blocked
      // at 3 of 5 points from 4 m left to 4 m right
      const rx = -(q[2] - p[2]) / len;
      const rz = (q[0] - p[0]) / len;
      const across = [-4, -2, 0, 2, 4].filter((d) => {
        const up = heights(x + rx * d, z + rz * d).filter((h) => h - road > RISE_MIN).sort((a, b) => a - b);
        return up.length > 0 && up[0] - road < RISE_MAX;
      }).length;
      if (across < 3) continue;
      const key = `${Math.round(x / 10)},${Math.round(z / 10)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const lanes = Math.max(2, (roads.links.find((l) => (l[0] === a && l[1] === b))?.slice(2) ?? [1, 1]).reduce((x, y) => x + y, 0));
      blocked.push([+x.toFixed(1), +road.toFixed(2), +z.toFixed(1), +(Math.max(...over) - road).toFixed(2), +((q[0] - p[0]) / len).toFixed(3), +((q[2] - p[2]) / len).toFixed(3), +(lanes * 1.8 + 1).toFixed(1)]);
    }
  }
  out[id] = blocked;
  // For the game: what to clear off each road (islands.ts), [x, y, z, top, dir x, dir z, half width] in the map's frame
  fs.writeFileSync(`${dir}/blocks.json`, JSON.stringify(blocked.map(([x, y, z, top, dx, dz, half]) => [x, y, z, top, dx, dz, half])));
  console.log(`${id}: ${blocked.length} places where something stands on the road`);
}
fs.writeFileSync('test-results/road-blocks.json', JSON.stringify(out));
