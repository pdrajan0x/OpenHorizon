// The audit's report (test-results/audit/report.md) from its findings (issues.json): what kind of
// problem, where, which meshes, and the worst ones with their screenshots. scripts/audit.mjs writes it
// at the end of a run; run this on its own to redo it:   node scripts/audit-report.mjs [dir]
import fs from 'node:fs';

export const KINDS = {
  A: 'visual rendering problem',
  B: 'geometry hole / gap',
  C: 'collision problem',
  D: 'backface / normal / material problem',
  E: 'missing piece of environment',
};

/** The city an issue is in, from its group path ("islands › map:chicago › cell 12"). */
export function cityOf(i) {
  const parts = i.group.split(' › ');
  const map = parts.find((s) => s.startsWith('map:'));
  if (map) return map.slice(4);
  return parts[1] ?? (i.group === '(none)' ? '(nothing drawn)' : i.group);
}

export function report({ stats, issues }, shots = []) {
  const count = (list, f) => Object.entries(list.reduce((m, i) => ((m[f(i)] = (m[f(i)] ?? 0) + 1), m), {})).sort((a, b) => b[1] - a[1]);
  let md = '# Geometry and visibility audit\n\n';
  md += `${stats.places} places, ${stats.points} sample points on the roads, ${stats.rays} rays; ${stats.meshesChecked} meshes (${(stats.trianglesChecked / 1e6).toFixed(1)} M triangles) checked. **${issues.length} issues.**\n\n`;

  md += '## By kind\n\n| Kind | High | Medium | Low | Total |\n|---|---:|---:|---:|---:|\n';
  for (const [k, name] of Object.entries(KINDS)) {
    const of = issues.filter((i) => i.kind === k);
    const sev = (s) => of.filter((i) => i.severity === s).length;
    md += `| ${k}: ${name} | ${sev('high')} | ${sev('medium')} | ${sev('low')} | ${of.length} |\n`;
  }

  md += '\n## By type\n\n| Kind | Type | Issues | Rays / triangles | Most affected meshes |\n|---|---|---:|---:|---|\n';
  for (const [type, n] of count(issues, (i) => `${i.kind}\t${i.type}`)) {
    const [kind, name] = type.split('\t');
    const of = issues.filter((i) => i.kind === kind && i.type === name);
    const hits = of.reduce((s, i) => s + i.hits, 0);
    const meshes = count(of, (i) => `${i.mesh} (${cityOf(i)})`).slice(0, 3).map(([m, c]) => `${m} ×${c}`).join('; ');
    md += `| ${kind} | ${name} | ${n} | ${hits} | ${meshes} |\n`;
  }

  md += '\n## By city\n\n| City | A | B | C | D | E | High severity |\n|---|---:|---:|---:|---:|---:|---:|\n';
  for (const [city] of count(issues, cityOf)) {
    const of = issues.filter((i) => cityOf(i) === city);
    md += `| ${city} | ${Object.keys(KINDS).map((k) => of.filter((i) => i.kind === k).length).join(' | ')} | ${of.filter((i) => i.severity === 'high').length} |\n`;
  }

  md += '\n## Worst issues\n\n';
  for (const i of shots) {
    md += `### #${i.id} ${i.kind} ${i.severity}: ${i.type}\n\n- City: ${cityOf(i)}\n- Mesh: ${i.mesh}\n- Group: ${i.group}\n- Position: (${i.position.join(', ')}), about ${i.size.toFixed(1)} m across, ${i.hits} rays\n- Why: ${i.why}\n${i.shot ? `\n![](${i.shot})\n` : ''}\n`;
  }
  return md;
}

/** The issues worth a screenshot: the most-hit high-severity one of each type and city first. */
export function worst(issues, n) {
  const order = { high: 0, medium: 1, low: 2 };
  const sorted = [...issues].sort((a, b) => order[a.severity] - order[b.severity] || b.hits - a.hits);
  const picked = [];
  const seen = new Set();
  for (const i of sorted) {
    const k = `${i.type}|${cityOf(i)}`;
    if (seen.has(k) || i.severity === 'low') continue;
    seen.add(k);
    picked.push(i);
  }
  for (const i of sorted) if (!picked.includes(i)) picked.push(i);
  return picked.slice(0, n);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2] ?? 'test-results/audit';
  const data = JSON.parse(fs.readFileSync(`${dir}/issues.json`));
  const shots = data.issues.filter((i) => i.shot).sort((a, b) => Number(a.shot.match(/\d+/)[0]) - Number(b.shot.match(/\d+/)[0]));
  fs.writeFileSync(`${dir}/report.md`, report(data, shots));
  console.log(`${dir}/report.md`);
}
