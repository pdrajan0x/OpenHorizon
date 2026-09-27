// Runs the geometry and visibility audit (src/audit.ts) across the world, headless: the car is taken to
// every place in the plan, the city streams in around it, and the audit traces the roads there. Writes
// the issues as JSON and a Markdown report, and screenshots of the worst ones with the debug markers on.
//
//   node scripts/audit.mjs                  every bridge end, plus one place per GRID m of road in every city
//   GRID=400 node scripts/audit.mjs         denser (slower)
//   PLACES="x,z;x,z" node scripts/audit.mjs just these points
//   CITIES="chicago miami" node scripts/audit.mjs
// Output: test-results/audit/issues.json, report.md, shot-<n>.png
import fs from 'node:fs';
import { launch } from './browser.mjs';
import { createServer } from 'vite';

const GRID = Number(process.env.GRID ?? 900);
const SHOTS = Number(process.env.SHOTS ?? 12);
const OUT = 'test-results/audit';
fs.mkdirSync(OUT, { recursive: true });

const server = await createServer({ logLevel: 'error', server: { port: 5330 } });
await server.listen();
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log('PAGEERROR', String(e)));
const t0 = Date.now();
try {
  await page.goto(server.resolvedUrls.local[0] + '?debug&audit&traffic=0', { timeout: 300_000, waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => (window.__game?.simTime ?? 0) > 1 && window.__audit, null, { timeout: 300_000 });

  // The plan: explicit places, or every bridge end plus a grid over each city's roads
  const places = await page.evaluate(({ GRID, only, cities }) => {
    const d = window.__debug;
    if (only) return only.split(';').map((p) => { const [x, z] = p.split(',').map(Number); return { x, z, why: 'asked' }; });
    const map = d.map;
    const out = [];
    for (const b of map.bridges?.bridges ?? []) {
      for (const p of [b.nodes[0], b.nodes[b.nodes.length - 1]]) out.push({ x: p.x, z: p.z, why: 'bridge end' });
    }
    map.maps.forEach((m, i) => {
      const id = map.info[i].id;
      if (cities && !cities.split(' ').includes(id)) return;
      const cells = new Map();
      for (const [x, , z] of m.roadData.nodes) {
        const k = `${Math.floor(x / GRID)},${Math.floor(z / GRID)}`;
        const cx = (Math.floor(x / GRID) + 0.5) * GRID;
        const cz = (Math.floor(z / GRID) + 0.5) * GRID;
        const dist = Math.hypot(x - cx, z - cz);
        const have = cells.get(k);
        if (!have || dist < have.dist) cells.set(k, { x, z, dist });
      }
      for (const c of cells.values()) out.push({ x: c.x, z: c.z, why: map.info[i].name });
    });
    return cities ? out.filter((p) => p.why !== 'bridge end') : out;
  }, { GRID, only: process.env.PLACES, cities: process.env.CITIES });
  console.log(`${places.length} places to audit`);

  for (const [k, p] of places.entries()) {
    await page.evaluate(({ x, z }) => window.__audit.goTo(x, z), p);
    // Let the streaming settle: a few frames after the cells around have loaded
    const s0 = await page.evaluate(() => window.__game.simTime);
    await page.waitForFunction((t) => window.__game.simTime > t + 1.5, s0, { timeout: 120_000 });
    const found = await page.evaluate(() => window.__audit.run());
    const total = await page.evaluate(() => window.__audit.audit.issues.length);
    console.log(`[${k + 1}/${places.length}] ${p.why} (${p.x.toFixed(0)}, ${p.z.toFixed(0)}): +${found} (total ${total}) ${((Date.now() - t0) / 60000).toFixed(1)} min`);
  }

  const { issues, stats } = await page.evaluate(() => ({ issues: window.__audit.audit.issues, stats: window.__audit.audit.stats }));
  fs.writeFileSync(`${OUT}/issues.json`, JSON.stringify({ stats, issues }, null, 1));

  // Screenshots of the worst: the car at the issue, the drone camera over it, markers on
  const order = { high: 0, medium: 1, low: 2 };
  const worst = [...issues].sort((a, b) => order[a.severity] - order[b.severity] || b.hits - a.hits).slice(0, SHOTS);
  await page.evaluate(() => { window.__audit.audit.show(true); window.__debug.cam.mode = 'drone'; });
  for (const [n, i] of worst.entries()) {
    await page.evaluate(({ x, z }) => window.__audit.goTo(x, z), { x: i.position[0], z: i.position[2] });
    const s0 = await page.evaluate(() => window.__game.simTime);
    await page.waitForFunction((t) => window.__game.simTime > t + 2, s0, { timeout: 120_000 });
    await page.screenshot({ path: `${OUT}/shot-${n + 1}.png` });
    i.shot = `shot-${n + 1}.png`;
  }

  // The report
  const kinds = { A: 'visual rendering problem', B: 'geometry hole / gap', C: 'collision problem', D: 'backface / normal / material problem', E: 'missing piece of environment' };
  const by = (f) => Object.entries(issues.reduce((m, i) => ((m[f(i)] = (m[f(i)] ?? 0) + 1), m), {})).sort((a, b) => b[1] - a[1]);
  let md = `# Geometry and visibility audit\n\n${stats.places} places, ${stats.points} sample points, ${stats.rays} rays; ${stats.meshesChecked} meshes (${(stats.trianglesChecked / 1e6).toFixed(1)} M triangles) checked. ${issues.length} issues.\n\n`;
  md += '| Kind | Issues |\n|---|---|\n' + Object.entries(kinds).map(([k, v]) => `| ${k}: ${v} | ${issues.filter((i) => i.kind === k).length} |`).join('\n') + '\n\n';
  md += '| Type | Issues |\n|---|---|\n' + by((i) => `${i.kind} ${i.type}`).map(([t, n]) => `| ${t} | ${n} |`).join('\n') + '\n\n';
  md += '| Where | Issues |\n|---|---|\n' + by((i) => i.group.split(' › ').find((s) => s.startsWith('map:')) ?? i.group.split(' › ')[1] ?? i.group).map(([t, n]) => `| ${t} | ${n} |`).join('\n') + '\n\n';
  md += '## Worst issues\n\n';
  for (const i of worst) {
    md += `### #${i.id} ${i.kind} ${i.severity}: ${i.type}\n\n- Mesh: ${i.mesh}\n- Group: ${i.group}\n- Position: (${i.position.join(', ')}), about ${i.size.toFixed(1)} m across, ${i.hits} rays\n- Why: ${i.why}\n${i.shot ? `\n![](${i.shot})\n` : ''}\n`;
  }
  fs.writeFileSync(`${OUT}/report.md`, md);
  console.log(`audit done in ${((Date.now() - t0) / 60000).toFixed(1)} min: ${issues.length} issues → ${OUT}/report.md`);
} finally {
  await browser.close();
  await server.close();
}
