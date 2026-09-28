// Floating structures the audit found (a building missing its lower storeys, a wall hanging in the air)
// → public/mods/maps/<map>/floating.json, which the game leaves out when it loads the cell (map.ts): with
// what should hold them up not in the mod, the piece in the air is removed rather than left floating.
//   node scripts/floating.mjs [audit dir…]   (default test-results/audit-float; adds to what's there)
import fs from 'node:fs';

const dirs = process.argv.slice(2).length ? process.argv.slice(2) : ['test-results/audit-float'];
const per = new Map();
for (const dir of dirs) {
  const { issues } = JSON.parse(fs.readFileSync(`${dir}/issues.json`, 'utf8'));
  for (const i of issues) {
    for (const [map, cell, name, ...box] of i.pieces ?? []) {
      if (!per.has(map)) per.set(map, new Map());
      per.get(map).set(`${cell}|${name}|${box.join(',')}`, [cell, name, ...box]);
    }
  }
}
for (const [map, pieces] of per) {
  const file = `public/mods/maps/${map}/floating.json`;
  const old = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
  const all = new Map(old.map((p) => [p.join('|'), p]));
  for (const p of pieces.values()) all.set(p.join('|'), p);
  fs.writeFileSync(file, JSON.stringify([...all.values()]));
  console.log(`${map}: ${all.size} floating pieces left out`);
}
