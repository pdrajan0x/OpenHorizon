// Draws the world layout (src/layout.ts) from each converted city's outline, without starting the game:
// land, names, and a line for every designed link. For judging the design before the bridges are built.
// Usage: node scripts/layout-preview.mjs [out.png]   (needs ImageMagick)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { worldLayout } from '../src/layout.ts';

const out = process.argv[2] ?? 'layout-preview.png';
const dir = 'public/mods/maps';
const index = JSON.parse(fs.readFileSync(`${dir}/index.json`, 'utf8'));
const names = new Map(index.map((m) => [m.id, m.name]));
const area = (p) => Math.abs(p.reduce((s, [x1, z1], i) => { const [x2, z2] = p[(i + 1) % p.length]; return s + x1 * z2 - x2 * z1; }, 0) / 2);

const cities = [];
for (const { id } of index) {
  const f = `${dir}/${id}/island.json`;
  if (!fs.existsSync(f)) continue;
  const loops = JSON.parse(fs.readFileSync(f, 'utf8')).loops.filter((l) => area(l.points) > 20000);
  const rect = [Infinity, Infinity, -Infinity, -Infinity];
  for (const l of loops) {
    if (!l.outer || area(l.points) < 50000) continue;
    for (const [x, z] of l.points) {
      rect[0] = Math.min(rect[0], x); rect[1] = Math.min(rect[1], z);
      rect[2] = Math.max(rect[2], x); rect[3] = Math.max(rect[3], z);
    }
  }
  if (Number.isFinite(rect[0])) cities.push({ id, rect, loops });
}
const { placed, links } = worldLayout(cities);

// World x is north (up), z east (right)
let [minX, minZ, maxX, maxZ] = [Infinity, Infinity, -Infinity, -Infinity];
cities.forEach((c, k) => {
  const o = placed[k] ?? [0, 0];
  minX = Math.min(minX, c.rect[0] + o[0]); maxX = Math.max(maxX, c.rect[2] + o[0]);
  minZ = Math.min(minZ, c.rect[1] + o[1]); maxZ = Math.max(maxZ, c.rect[3] + o[1]);
});
const pad = 1500;
const W = 1600;
const scale = W / (maxZ - minZ + 2 * pad);
const H = Math.round((maxX - minX + 2 * pad) * scale);
const px = (x, z) => [((z - minZ + pad) * scale).toFixed(1), ((maxX + pad - x) * scale).toFixed(1)];
const centre = (k) => {
  const c = cities[k];
  const o = placed[k] ?? [0, 0];
  return [(c.rect[0] + c.rect[2]) / 2 + o[0], (c.rect[1] + c.rect[3]) / 2 + o[1]];
};
let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="100%" height="100%" fill="#0b2233"/>`;
cities.forEach((c, k) => {
  const o = placed[k];
  if (!o) return;
  const d = c.loops.map((l) => 'M' + l.points.map(([x, z]) => px(x + o[0], z + o[1]).join(',')).join('L') + 'Z').join('');
  svg += `<path d="${d}" fill="#2c4a3c" fill-rule="evenodd" stroke="#6f9f86" stroke-width="1"/>`;
});
for (const l of links) {
  const [a, b] = [centre(l.a), centre(l.b)];
  const colour = l.rank === 3 ? '#e0b43a' : '#ffffff';
  svg += `<line x1="${px(...a)[0]}" y1="${px(...a)[1]}" x2="${px(...b)[0]}" y2="${px(...b)[1]}" stroke="${colour}" stroke-width="2" stroke-dasharray="${l.rank === 3 ? '8,6' : ''}" opacity="0.8"/>`;
}
cities.forEach((c, k) => {
  if (!placed[k]) return;
  const [x, y] = px(...centre(k));
  svg += `<text x="${x}" y="${y}" fill="#fff" font-family="sans-serif" font-size="16" font-weight="bold" text-anchor="middle">${names.get(c.id) ?? c.id}</text>`;
});
// 5 km scale bar
svg += `<line x1="30" y1="${H - 30}" x2="${30 + 5000 * scale}" y2="${H - 30}" stroke="#fff" stroke-width="3"/><text x="30" y="${H - 40}" fill="#fff" font-family="sans-serif" font-size="14">5 km</text>`;
svg += '</svg>';
fs.writeFileSync(out.replace(/\.png$/, '.svg'), svg);
execFileSync('magick', [out.replace(/\.png$/, '.svg'), out]);
const unplaced = cities.filter((_, k) => !placed[k]).map((c) => c.id);
console.log(`${out}: ${cities.length} cities, ${links.length} links${unplaced.length ? `; not in the design: ${unplaced.join(', ')}` : ''}`);
