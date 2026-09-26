// Writes public/mods/maps/index.json: every converted map with its display name, the kind of area it
// is, and its size, for laying the maps out as islands and for map menus.
//   node scripts/map-index.mjs
// Per map: footprint = size of its render cells ([x, z] m, the same extent GameMap.footprint() uses),
// bounds = those cells [minX, minZ, maxX, maxZ] in map-local coordinates, roadBox = the same for the
// road graph, roadMinY/roadMaxY = lowest/highest road node, water = the map's own water surface (if any).
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';

const DIR = 'public/mods/maps';
// Display names and the kind of area; maps not listed get their id title-cased
const INFO = {
  chicago: { name: 'Chicago', area: 'downtown: Loop high-rises, river bridges and the lakefront' },
  miami: { name: 'Miami', area: 'coastal city: beachfront boulevards and palms' },
  shibuya: { name: 'Shibuya', area: 'Japanese district: neon side streets around the scramble crossing' },
  'tokyo-shinjuku': { name: 'Shinjuku', area: 'Japanese district: skyscraper grid and wide avenues' },
  'midnight-shuto': { name: 'Shuto Expressway', area: 'expressway: elevated Tokyo loops and the Wangan over the bay' },
  'fukuoka-expressway': { name: 'Fukuoka', area: 'expressway: elevated urban expressway over the harbour' },
  'hong-kong': { name: 'Hong Kong', area: 'hillside city: towers, tunnels and switchbacks up the peak' },
  'monaco-gp': { name: 'Monaco', area: 'coastal street circuit: harbour, hairpins and hillside streets' },
  'dubai-highway': { name: 'Dubai Highway', area: 'desert highway: a 10 km straight lined with towers' },
  'dubai-islands': { name: 'Dubai Islands', area: 'coastal resort: palm island, marina and causeways' },
  'nfsu2-bayview': { name: 'Bayview', area: 'tuner city: downtown, beach, airport and hills' },
};
const FIRST = ['chicago', 'miami'];

const ids = readdirSync(DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory() && !d.name.startsWith('bridge-') && existsSync(`${DIR}/${d.name}/manifest.json`) && existsSync(`${DIR}/${d.name}/roads.json`))
  .map((d) => d.name)
  .sort((a, b) => (FIRST.includes(a) ? FIRST.indexOf(a) : 99) - (FIRST.includes(b) ? FIRST.indexOf(b) : 99) || a.localeCompare(b));

const round = (v) => Math.round(v * 10) / 10;
const out = ids.map((id) => {
  const manifest = JSON.parse(readFileSync(`${DIR}/${id}/manifest.json`, 'utf8'));
  const roads = JSON.parse(readFileSync(`${DIR}/${id}/roads.json`, 'utf8'));
  const s = manifest.cellSize;
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const c of manifest.cells) {
    if (!c.render) continue;
    b[0] = Math.min(b[0], c.x); b[1] = Math.min(b[1], c.z);
    b[2] = Math.max(b[2], c.x + s); b[3] = Math.max(b[3], c.z + s);
  }
  const r = [Infinity, Infinity, -Infinity, -Infinity];
  let minY = Infinity, maxY = -Infinity;
  for (const [x, y, z] of roads.nodes) {
    r[0] = Math.min(r[0], x); r[1] = Math.min(r[1], z); r[2] = Math.max(r[2], x); r[3] = Math.max(r[3], z);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  const info = INFO[id] ?? { name: id.replace(/(^|-)(\w)/g, (_, d, c) => (d ? ' ' : '') + c.toUpperCase()), area: '' };
  const w = manifest.stats?.water;
  return {
    id,
    name: info.name,
    area: info.area,
    footprint: [b[2] - b[0], b[3] - b[1]],
    roadMinY: round(minY),
    roadMaxY: round(maxY),
    bounds: b,
    roadBox: r.map(round),
    roadNodes: roads.nodes.length,
    roadsDerived: roads.derived === true,
    water: w ? { area: w.area, minY: round(w.minY), maxY: round(w.maxY), dropped: w.dropped } : null,
  };
});
writeFileSync(`${DIR}/index.json`, JSON.stringify(out, null, 2) + '\n');
for (const m of out) console.log(`${m.id.padEnd(20)} ${m.name.padEnd(18)} ${m.footprint.join('x').padEnd(12)} roads y ${m.roadMinY}..${m.roadMaxY}`);
