// Measures every converted city from its data, to compare them: how big (land, roads), how built up
// (the share of ground under buildings, how tall they are, triangles and objects per km²), how good it
// looks up close (texture sizes, untextured materials), and what the geometry audit found there.
//   node scripts/city-report.mjs            → test-results/cities/metrics.json + report.md
//   node scripts/city-report.mjs --shots    also an aerial and a street screenshot of each downtown
import fs from 'node:fs';

const OUT = 'test-results/cities';
const MAPS = 'public/mods/maps';
fs.mkdirSync(OUT, { recursive: true });

const index = JSON.parse(fs.readFileSync(`${MAPS}/index.json`));
const mods = JSON.parse(fs.readFileSync('assets/mods.json'));
const audit = fs.existsSync('test-results/audit/issues.json') ? JSON.parse(fs.readFileSync('test-results/audit/issues.json')).issues : [];
const meshAudit = fs.existsSync('test-results/mesh-audit/summary.json') ? JSON.parse(fs.readFileSync('test-results/mesh-audit/summary.json')) : null;

const polygonArea = (pts) => {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
  return Math.abs(a) / 2;
};

function textures(id) {
  const dir = `${MAPS}/${id}/tex`;
  const sizes = [];
  if (!fs.existsSync(dir)) return { count: 0 };
  const head = Buffer.alloc(16);
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.gtx')) continue;
    const fd = fs.openSync(`${dir}/${f}`, 'r');
    fs.readSync(fd, head, 0, 16, 0);
    fs.closeSync(fd);
    if (head.toString('latin1', 0, 4) === 'GTX1') sizes.push(Math.max(head.readUInt16LE(8), head.readUInt16LE(10)));
  }
  sizes.sort((a, b) => a - b);
  return {
    count: sizes.length,
    median: sizes[Math.floor(sizes.length / 2)] ?? 0,
    atLeast1k: sizes.filter((s) => s >= 1024).length / (sizes.length || 1),
    atMost256: sizes.filter((s) => s <= 256).length / (sizes.length || 1),
  };
}

/** Built-up ground from the height grid: each cell's top against the lowest ground within 140 m. */
function buildings(tops) {
  const h = new Int16Array(Uint8Array.from(Buffer.from(tops.h, 'base64')).buffer);
  const { nx, nz, cell } = tops;
  const at = (i, j) => (i < 0 || j < 0 || i >= nx || j >= nz ? -32768 : h[i * nz + j]);
  // Ground: a running minimum over 7 × 7 cells (separable: rows, then columns)
  const R = 3;
  const rowMin = new Float32Array(nx * nz).fill(Infinity);
  for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) {
    let m = Infinity;
    for (let d = -R; d <= R; d++) { const v = at(i, j + d); if (v !== -32768 && v < m) m = v; }
    rowMin[i * nz + j] = m;
  }
  let land = 0, built = 0, tall = 0, sky = 0, max = 0;
  const heights = [];
  for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) {
    const v = at(i, j);
    if (v === -32768) continue;
    let ground = Infinity;
    for (let d = -R; d <= R; d++) { const g = i + d >= 0 && i + d < nx ? rowMin[(i + d) * nz + j] : Infinity; if (g < ground) ground = g; }
    land++;
    const above = v - ground;
    if (above > 6) { built++; heights.push(above); }
    if (above > 40) tall++;
    if (above > 100) sky++;
    if (above > max && above < 700) max = above;
  }
  heights.sort((a, b) => a - b);
  const km2 = (n) => (n * cell * cell) / 1e6;
  return {
    builtShare: built / (land || 1), builtKm2: km2(built), tallKm2: km2(tall), skyCells: sky,
    medianHeight: heights[Math.floor(heights.length / 2)] ?? 0, p95Height: heights[Math.floor(heights.length * 0.95)] ?? 0, maxHeight: max,
  };
}

/** The densest built-up spot: most cells above 20 m within 300 m. */
function downtown(tops, roads) {
  const h = new Int16Array(Uint8Array.from(Buffer.from(tops.h, 'base64')).buffer);
  const { nx, nz, cell, x0, z0 } = tops;
  const W = Math.round(150 / cell);
  let best = { score: -1, i: 0, j: 0 };
  // Coarse scan (every 4th cell) is plenty for a camera position
  for (let i = W; i < nx - W; i += 4) for (let j = W; j < nz - W; j += 4) {
    let score = 0;
    let low = Infinity;
    for (let a = -W; a <= W; a += 2) for (let b = -W; b <= W; b += 2) { const v = h[(i + a) * nz + j + b]; if (v !== -32768 && v < low) low = v; }
    for (let a = -W; a <= W; a += 2) for (let b = -W; b <= W; b += 2) { const v = h[(i + a) * nz + j + b]; if (v !== -32768 && v - low > 20) score++; }
    if (score > best.score) best = { score, i, j };
  }
  const x = x0 + (best.i + 0.5) * cell, z = z0 + (best.j + 0.5) * cell;
  // On the road nearest to it
  let node = roads.nodes[0], d = Infinity;
  for (const n of roads.nodes) { const e = Math.hypot(n[0] - x, n[2] - z); if (e < d) { d = e; node = n; } }
  return { x: node[0], z: node[2] };
}

const cityOf = (i) => { const m = i.group.split(' › ').find((s) => s.startsWith('map:')); return m ? m.slice(4) : null; };

const rows = [];
for (const info of index) {
  const id = info.id;
  const dir = `${MAPS}/${id}`;
  const manifest = JSON.parse(fs.readFileSync(`${dir}/manifest.json`));
  const island = JSON.parse(fs.readFileSync(`${dir}/island.json`));
  const roads = JSON.parse(fs.readFileSync(`${dir}/roads.json`));
  const landM2 = island.loops.reduce((s, l) => s + (l.outer ? 1 : -1) * polygonArea(l.points.map((p) => [p[0], p[1]])), 0);
  const roadKm = roads.links.reduce((s, [a, b]) => s + Math.hypot(roads.nodes[a][0] - roads.nodes[b][0], roads.nodes[a][2] - roads.nodes[b][2]), 0) / 1000;
  const roadBox = info.roadBox; // the driven part of the map
  const roadBoxKm2 = ((roadBox[2] - roadBox[0]) * (roadBox[3] - roadBox[1])) / 1e6;
  const tris = manifest.stats?.triangles ?? 0;
  const mats = manifest.materials ?? [];
  const untextured = mats.filter((m) => !m.diffuse).length / (mats.length || 1);
  const here = audit.filter((i) => cityOf(i) === id);
  const leaks = here.filter((i) => i.severity === 'high' && i.type !== 'triangles wound against their normals' && !i.type.startsWith('duplicate')).length;
  const mesh = meshAudit?.maps?.[id] ?? meshAudit?.[id] ?? null;
  const mod = mods.find((m) => m.id === `map-${id}` || (m.category === 'map' && m.id.includes(id)));
  rows.push({
    id, name: info.name, area: info.area, source: mod ? `${mod.title} (${mod.author ?? '?'})` : (id.startsWith('carla') ? 'CARLA simulator (CC BY)' : '?'),
    landKm2: landM2 / 1e6, roadKm, roadBoxKm2, roadKmPerKm2: roadKm / Math.max(0.1, landM2 / 1e6),
    trisM: tris / 1e6, trisPerKm2M: tris / 1e6 / Math.max(0.1, landM2 / 1e6), entities: manifest.stats?.entities ?? 0,
    entitiesPerKm2: (manifest.stats?.entities ?? 0) / Math.max(0.1, landM2 / 1e6),
    ...buildings(island.tops), tex: textures(id), untextured,
    auditLeaksHigh: leaks, auditLeaksPerRoadKm: leaks / Math.max(1, roadKm),
    meshDupShare: mesh?.duplicates?.same && mesh?.triangles ? mesh.duplicates.same / mesh.triangles : null,
    downtown: downtown(island.tops, roads),
  });
}
fs.writeFileSync(`${OUT}/metrics.json`, JSON.stringify(rows, null, 1));

const f = (v, d = 1) => (v == null ? '–' : v.toFixed(d));
let md = '# Cities compared\n\n| City | Land km² | Roads km | Road km/km² | Built % | Tall (>40 m) km² | Median / p95 / max height m | M tris | M tris / km² land | Objects / km² | Textures (median px, ≥1K %, ≤256 %) | Untextured % | Audit leaks (high) per road km |\n|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|\n';
for (const r of [...rows].sort((a, b) => b.landKm2 - a.landKm2)) {
  md += `| ${r.name} | ${f(r.landKm2)} | ${f(r.roadKm, 0)} | ${f(r.roadKmPerKm2)} | ${f(r.builtShare * 100, 0)} | ${f(r.tallKm2, 2)} | ${f(r.medianHeight, 0)} / ${f(r.p95Height, 0)} / ${f(r.maxHeight, 0)} | ${f(r.trisM)} | ${f(r.trisPerKm2M, 2)} | ${f(r.entitiesPerKm2, 0)} | ${r.tex.count} (${r.tex.median}, ${f(r.tex.atLeast1k * 100, 0)}, ${f(r.tex.atMost256 * 100, 0)}) | ${f(r.untextured * 100, 0)} | ${f(r.auditLeaksPerRoadKm, 2)} |\n`;
}
fs.writeFileSync(`${OUT}/report.md`, md);
console.log(md);

if (process.argv.includes('--shots')) {
  const { launch } = await import('./browser.mjs');
  const { createServer } = await import('vite');
  const server = await createServer({ logLevel: 'error', server: { port: 5337 } });
  await server.listen();
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', (e) => console.log('PAGEERROR', String(e)));
  try {
    await page.goto(server.resolvedUrls.local[0] + '?debug&audit&traffic=0', { timeout: 300_000, waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => (window.__game?.simTime ?? 0) > 1 && window.__audit, null, { timeout: 300_000 });
    await page.keyboard.press('KeyH');
    for (const r of rows) {
      const at = await page.evaluate(({ id, x, z }) => {
        const m = window.__debug.map;
        const k = m.info.findIndex((i) => i.id === id);
        const o = m.outlines[k].offset;
        return { x: x + o.x, z: z + o.z };
      }, { id: r.id, ...r.downtown });
      for (const cam of ['drone', 'chase']) {
        await page.evaluate(({ x, z }) => window.__audit.goTo(x, z), at);
        await page.evaluate((cam) => { window.__debug.cam.mode = cam; }, cam);
        const t = await page.evaluate(() => window.__game.simTime);
        await page.waitForFunction((t) => window.__game.simTime > t + 3, t, { timeout: 180_000 });
        await page.screenshot({ path: `${OUT}/${r.id}-${cam}.png` });
      }
      console.log('shots', r.id);
    }
  } finally {
    await browser.close();
    await server.close();
  }
}
