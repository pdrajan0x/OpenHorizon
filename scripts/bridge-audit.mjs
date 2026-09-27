// What a bridge audit (BRIDGES=1 node scripts/audit.mjs) found, sorted into what's the bridges' doing and
// what was there already: the audit traces every road near each place, so a city's own faults near a
// bridge end show up too.
//   on a bridge   the bridges' own meshes (deck, girder, piers, slopes, barriers), or anything within the
//                 deck's width + NEAR m of its centreline (a missing surface there is the bridge's)
//   at a join     within JOIN m of where a bridge meets a city: the city's geometry round the join, where
//                 the bridge's corridor was cut through it
//   elsewhere     the cities' own, further off
//   node scripts/bridge-audit.mjs [dir]      (default test-results/audit-bridges) → summary.md, and a table here
import fs from 'node:fs';

const dir = process.argv[2] ?? 'test-results/audit-bridges';
const NEAR = 12;
const JOIN = 80;
const { issues } = JSON.parse(fs.readFileSync(`${dir}/issues.json`, 'utf8'));
const bridges = JSON.parse(fs.readFileSync(`${dir}/bridges.json`, 'utf8'));

/** Distance from (x, z) to a polyline, and the half width there. */
function toLine(pts, halfs, x, z) {
  let best = { d: Infinity, hw: 0 };
  for (let i = 0; i + 1 < pts.length; i++) {
    const [ax, , az] = pts[i];
    const [bx, , bz] = pts[i + 1];
    const dx = bx - ax;
    const dz = bz - az;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
    const d = Math.hypot(ax + dx * t - x, az + dz * t - z);
    if (d < best.d) best = { d, hw: halfs[Math.min(i, halfs.length - 1)] ?? 15 };
  }
  return best;
}

const rows = [];
for (const i of issues) {
  const [x, , z] = i.position;
  let where = 'elsewhere';
  let which = -1;
  bridges.forEach((b, n) => {
    const line = [b.ends[0], ...b.nodes, b.ends[1]].filter(Boolean);
    const halfs = [b.halfWidths[0], ...b.halfWidths, b.halfWidths[b.halfWidths.length - 1]];
    const { d, hw } = toLine(line, halfs, x, z);
    const join = Math.min(...b.ends.map((e) => Math.hypot(e[0] - x, e[2] - z)));
    if (i.group.includes('bridges') || d <= hw + NEAR) { where = 'on a bridge'; which = n; }
    else if (where !== 'on a bridge' && join <= JOIN) { where = 'at a join'; which = n; }
  });
  rows.push({ ...i, where, bridge: which + 1 });
}

const count = (list, key) => {
  const m = new Map();
  for (const r of list) m.set(key(r), (m.get(key(r)) ?? 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1]);
};
const serious = (r) => r.severity !== 'low' && !r.type.startsWith('duplicate') && r.type !== 'triangles wound against their normals';
let md = `# Bridge audit (${dir})\n\n${issues.length} issues found near the bridges.\n\n| | all | high/medium, not mesh-only |\n|---|--:|--:|\n`;
for (const w of ['on a bridge', 'at a join', 'elsewhere']) {
  const list = rows.filter((r) => r.where === w);
  md += `| ${w} | ${list.length} | ${list.filter(serious).length} |\n`;
}
for (const w of ['on a bridge', 'at a join']) {
  const list = rows.filter((r) => r.where === w && serious(r));
  md += `\n## ${w}: ${list.length} (high/medium)\n\nBy bridge: ${count(list, (r) => r.bridge).map(([b, n]) => `#${b} ${n}`).join(', ') || '–'}\n\n| type | kind | count |\n|---|---|--:|\n`;
  for (const [t, n] of count(list, (r) => `${r.type} | ${r.kind}`).slice(0, 15)) md += `| ${t} | ${n} |\n`;
  md += '\n| # | bridge | type | severity | mesh | group | position |\n|--:|--:|---|---|---|---|---|\n';
  for (const r of list.sort((a, b) => (a.severity === 'high' ? 0 : 1) - (b.severity === 'high' ? 0 : 1) || b.hits - a.hits).slice(0, 25)) {
    md += `| ${r.id} | ${r.bridge} | ${r.type} | ${r.severity} | ${r.mesh} | ${r.group} | ${r.position.map((v) => v.toFixed(0)).join(', ')} |\n`;
  }
}
fs.writeFileSync(`${dir}/summary.md`, md);
console.log(md);
