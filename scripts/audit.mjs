// Runs the geometry and visibility audit (src/audit.ts) across the world, headless: the car is taken to
// every place in the plan, the city streams in around it, and the audit traces the roads there. Writes
// the issues as JSON and a Markdown report, and screenshots of the worst ones with the debug markers on.
//
//   node scripts/audit.mjs                  every bridge end, plus one place per GRID m of road in every city
//   GRID=400 node scripts/audit.mjs         denser (slower)
//   PLACES="x,z;x,z" node scripts/audit.mjs just these points
//   CITIES="chicago miami" node scripts/audit.mjs
//   BRIDGES=1 node scripts/audit.mjs        only the bridges: both joins and every ALONG m (250) along each
//   OUT=test-results/audit-bridges …        write somewhere else (default test-results/audit)
//   BUILD=1 …                               audit a production build (a snapshot: edits during the run don't reload it)
//   REDO=1 node scripts/audit.mjs           no new scan: the last run's findings again, new screenshots and report
// Output: test-results/audit/issues.json, report.md, shot-<n>.png
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { report, worst as pickWorst } from './audit-report.mjs';
import { launch } from './browser.mjs';
import { createServer, preview } from 'vite';

const GRID = Number(process.env.GRID ?? 900);
const SHOTS = Number(process.env.SHOTS ?? 12);
const OUT = process.env.OUT ?? 'test-results/audit';
const ALONG = Number(process.env.ALONG ?? 250);
fs.mkdirSync(OUT, { recursive: true });

let server;
if (process.env.BUILD) {
  execFileSync('npx', ['vite', 'build', '--outDir', '.build/audit', '--emptyOutDir', '--logLevel', 'error'], { env: { ...process.env, LINK_MODS: '1' }, stdio: 'inherit' });
  fs.symlinkSync(`${process.cwd()}/public/mods`, '.build/audit/mods');
  server = await preview({ logLevel: 'error', preview: { port: 5330 }, build: { outDir: '.build/audit' } });
} else {
  server = await createServer({ logLevel: 'error', server: { port: 5330 } });
  await server.listen();
}
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log('PAGEERROR', String(e)));
const t0 = Date.now();
try {
  await page.goto(server.resolvedUrls.local[0] + '?debug&audit&traffic=0', { timeout: 300_000, waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => (window.__game?.simTime ?? 0) > 1 && window.__audit, null, { timeout: 300_000 });

  // The plan: explicit places, or every bridge end plus a grid over each city's roads
  const places = process.env.REDO ? [] : await page.evaluate(({ GRID, only, cities, bridgesOnly, ALONG }) => {
    const d = window.__debug;
    if (only) return only.split(';').map((p) => { const [x, z] = p.split(',').map(Number); return { x, z, why: 'asked' }; });
    const map = d.map;
    const out = [];
    for (const [n, b] of (map.bridges?.bridges ?? []).entries()) {
      // Both joins (where it meets each city's road), and every ALONG m between when only bridges are asked for
      const ends = b.ends ?? [b.nodes[0], b.nodes[b.nodes.length - 1]];
      for (const p of ends) out.push({ x: p.x, z: p.z, why: 'bridge end' });
      if (!bridgesOnly) continue;
      const every = Math.max(1, Math.round(ALONG / (b.length / (b.nodes.length + 1))));
      for (let i = every; i < b.nodes.length - every / 2; i += every) out.push({ x: b.nodes[i].x, z: b.nodes[i].z, why: `bridge ${n + 1}` });
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
    if (bridgesOnly) return out.filter((p) => p.why.startsWith('bridge'));
    return cities ? out.filter((p) => p.why !== 'bridge end') : out;
  }, { GRID, only: process.env.PLACES, cities: process.env.CITIES, bridgesOnly: !!process.env.BRIDGES, ALONG });
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

  if (process.env.REDO) {
    const last = JSON.parse(fs.readFileSync(`${OUT}/issues.json`));
    await page.evaluate((last) => {
      const a = window.__audit.audit;
      a.issues.push(...last.issues.map((i) => ({ ...i, shot: undefined })));
      a.stats = last.stats;
      a.draw();
    }, last);
  }
  const { issues, stats } = await page.evaluate(() => ({ issues: window.__audit.audit.issues, stats: window.__audit.audit.stats }));
  fs.writeFileSync(`${OUT}/issues.json`, JSON.stringify({ stats, issues }, null, 1));

  // Screenshots of the worst: the car at the issue, the drone camera over it, markers on
  const worst = pickWorst(issues, SHOTS);
  await page.evaluate(() => { window.__audit.audit.show(true); window.__debug.cam.mode = 'drone'; });
  for (const [n, i] of worst.entries()) {
    await page.evaluate(({ x, z }) => window.__audit.goTo(x, z), { x: i.position[0], z: i.position[2] });
    const s0 = await page.evaluate(() => window.__game.simTime);
    await page.waitForFunction((t) => window.__game.simTime > t + 2, s0, { timeout: 120_000 });
    await page.screenshot({ path: `${OUT}/shot-${n + 1}.png` });
    i.shot = `shot-${n + 1}.png`;
  }

  // The report, and the findings again with their screenshots
  fs.writeFileSync(`${OUT}/issues.json`, JSON.stringify({ stats, issues }, null, 1));
  fs.writeFileSync(`${OUT}/report.md`, report({ stats, issues }, worst));
  console.log(`audit done in ${((Date.now() - t0) / 60000).toFixed(1)} min: ${issues.length} issues → ${OUT}/report.md`);
} finally {
  await browser.close();
  await server.close?.();
  await server.httpServer?.close?.();
}
