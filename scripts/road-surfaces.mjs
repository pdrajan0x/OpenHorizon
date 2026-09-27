// Which of each city's materials are its road surface and which its footpaths, read from the converted
// cells: under every road node, the topmost opaque surface (not a decal: lane markings stay the map's
// own) is road; beside each street, a surface standing kerb-high above the road is footpath. The game
// draws these with the shared road and footpath materials (src/roadSurface.ts) instead of each map's own.
//   node scripts/road-surfaces.mjs  → public/mods/roads/surfaces.json
import fs from 'node:fs';

const DIR = 'public/mods/maps';
const OUT = 'public/mods/roads/surfaces.json';
const ROAD_SHARE = 0.02; // (0.5% for a texture named as asphalt or road) // of a city's road hits, for a material to count as road
const WALK_SHARE = 0.04;
const index = JSON.parse(fs.readFileSync(`${DIR}/index.json`, 'utf8'));
const result = {};

for (const { id } of index) {
  const m = JSON.parse(fs.readFileSync(`${DIR}/${id}/manifest.json`, 'utf8'));
  const roads = JSON.parse(fs.readFileSync(`${DIR}/${id}/roads.json`, 'utf8'));
  const S = m.cellSize;
  const opaque = (mi) => {
    const mat = m.materials[mi];
    return mat && mat.diffuse && !mat.blend && !mat.mask && !mat.emissive && !/water|glass|emissive|decal/i.test(mat.shader);
  };
  // Probe points per cell: road nodes, and kerb points either side of each link's middle
  const probes = new Map(); // cell key → [{ x, y, z, kind }]
  const add = (x, y, z, kind) => {
    const key = `${Math.floor(x / S)},${Math.floor(z / S)}`;
    if (!probes.has(key)) probes.set(key, []);
    probes.get(key).push({ x, y, z, kind });
  };
  roads.nodes.forEach(([x, y, z], i) => { if (i % 2 === 0) add(x, y, z, 'road'); });
  for (const [a, b, ab, ba] of roads.links) {
    const p = roads.nodes[a];
    const q = roads.nodes[b];
    const dx = q[0] - p[0];
    const dz = q[2] - p[2];
    const len = Math.hypot(dx, dz);
    if (len < 8) continue;
    const half = Math.max(3.5, ((ab + ba) * 3.5) / 2);
    const mx = (p[0] + q[0]) / 2;
    const my = (p[1] + q[1]) / 2;
    const mz = (p[2] + q[2]) / 2;
    for (const side of [-1, 1]) for (const d of [1.5, 3, 4.5]) {
      add(mx - (dz / len) * side * (half + d), my, mz + (dx / len) * side * (half + d), 'walk');
    }
  }
  const hits = { road: new Map(), walk: new Map() };
  const count = { road: 0, walk: 0 };
  for (const c of m.cells) {
    if (!c.render) continue;
    const list = probes.get(`${Math.floor((c.x + S / 2) / S)},${Math.floor((c.z + S / 2) / S)}`);
    if (!list) continue;
    const file = `${DIR}/${id}/cells/${c.id}.bin`;
    if (!fs.existsSync(file)) continue;
    const buf = fs.readFileSync(file);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const view = new DataView(ab);
    const jsonLength = view.getUint32(0, true);
    const header = JSON.parse(new TextDecoder().decode(new Uint8Array(ab, 4, jsonLength)));
    let offset = 4 + jsonLength;
    offset += (4 - (offset % 4)) % 4;
    // Per probe: the topmost opaque surface in its height window
    const best = list.map(() => ({ y: -Infinity, mat: -1 }));
    for (const b of header.batches) {
      const stride = b.colors ? 9 : 8;
      const v = new Float32Array(ab, offset, b.vertices * stride);
      offset += b.vertices * stride * 4;
      const idx = new Uint32Array(ab, offset, b.indices);
      offset += b.indices * 4;
      if (!opaque(b.material)) continue;
      for (let t = 0; t + 2 < idx.length; t += 3) {
        const i0 = idx[t] * stride, i1 = idx[t + 1] * stride, i2 = idx[t + 2] * stride;
        const x0 = v[i0], z0 = v[i0 + 2], x1 = v[i1], z1 = v[i1 + 2], x2 = v[i2], z2 = v[i2 + 2];
        const minX = Math.min(x0, x1, x2), maxX = Math.max(x0, x1, x2), minZ = Math.min(z0, z1, z2), maxZ = Math.max(z0, z1, z2);
        const det = (z1 - z2) * (x0 - x2) + (x2 - x1) * (z0 - z2);
        if (Math.abs(det) < 1e-9) continue;
        list.forEach((p, k) => {
          if (p.x < minX || p.x > maxX || p.z < minZ || p.z > maxZ) return;
          const l0 = ((z1 - z2) * (p.x - x2) + (x2 - x1) * (p.z - z2)) / det;
          const l1 = ((z2 - z0) * (p.x - x2) + (x0 - x2) * (p.z - z2)) / det;
          const l2 = 1 - l0 - l1;
          if (l0 < 0 || l1 < 0 || l2 < 0) return;
          const y = l0 * v[i0 + 1] + l1 * v[i1 + 1] + l2 * v[i2 + 1];
          // Road: at the node's height (± a little); footpath: a kerb above the road
          const ok = p.kind === 'road' ? y > p.y - 1.5 && y < p.y + 0.6 : y > p.y + 0.06 && y < p.y + 0.6;
          if (ok && y > best[k].y) best[k] = { y, mat: b.material };
        });
      }
    }
    list.forEach((p, k) => {
      if (best[k].mat < 0) return;
      const name = m.materials[best[k].mat].diffuse;
      hits[p.kind].set(name, (hits[p.kind].get(name) ?? 0) + 1);
      count[p.kind]++;
    });
  }
  const pick = (kind, share, not = new Set()) => [...hits[kind]]
    .filter(([n, h]) => h >= (kind === 'road' ? 6 : 20) && h / Math.max(1, count[kind]) >= (kind === 'road' && /asp|road|tarmac|douro/i.test(n) ? 0.005 : share) && !not.has(n))
    .sort((a, b) => b[1] - a[1]);
  // Beside a mountain road it's ground, not footpath (lane markings painted into a road texture are kept by
  // the shader: its bright paint shows through)
  const GROUND = /ground|grass|dirt|cliff|wheat|crs|gutter|soil|sand|asp|road|jimen|line|lane/i;
  // Grass and bare ground at a road's verge are under some road nodes too: never road
  const road = pick('road', ROAD_SHARE).filter(([n]) => !/ground|grass|crs|dirt|cliff|soil|wheat/i.test(n));
  const walk = pick('walk', WALK_SHARE, new Set(road.map(([n]) => n))).filter(([n]) => !GROUND.test(n));
  result[id] = { road: road.map(([n]) => n), walk: walk.map(([n]) => n) };
  const pct = (list, kind) => list.map(([n, h]) => `${n} ${((100 * h) / count[kind]).toFixed(0)}%`).join(', ');
  console.log(`${id}: road (${count.road} probes) ${pct(road, 'road')}\n   walk (${count.walk}) ${pct(walk, 'walk')}`);
}
fs.mkdirSync('public/mods/roads', { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(result, null, 1));
console.log(`→ ${OUT}`);
