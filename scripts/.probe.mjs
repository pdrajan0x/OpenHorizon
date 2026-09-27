import { launch } from './browser.mjs';
import { createServer } from 'vite';
const server = await createServer({ logLevel: 'error', server: { port: 5333 } });
await server.listen();
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log('PAGEERROR', String(e)));
try {
  await page.goto(server.resolvedUrls.local[0] + '?debug&audit&traffic=0', { timeout: 300_000, waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => (window.__game?.simTime ?? 0) > 1 && window.__audit, null, { timeout: 300_000 });
  await page.evaluate(() => window.__audit.goTo(8949, 12438, 1.2));
  const s0 = await page.evaluate(() => window.__game.simTime);
  await page.waitForFunction((t) => window.__game.simTime > t + 3, s0, { timeout: 120_000 });
  console.log(await page.evaluate(() => {
    const THREE = window.__debug.THREE;
    const a = window.__audit.audit;
    const meshes = a.targets(); a.ensureBvh(meshes);
    const cam = window.__debug.cam.camera ?? window.__debug.cam.cam ?? null;
    const from = new THREE.Vector3().copy(window.__debug.player().body.translation()); from.y += 3;
    const found = new Map();
    for (let az = 0; az < 360; az += 1.5) for (const el of [0.5, 1.5, 3, 5, 8]) {
      const r = az * Math.PI / 180, e = el * Math.PI / 180;
      const dir = new THREE.Vector3(Math.cos(r) * Math.cos(e), Math.sin(e), Math.sin(r) * Math.cos(e));
      const h = a.castRender(meshes, from, dir, 6000);
      if (!h || h.distance < 250) continue;
      const names = []; for (let p = h.object; p; p = p.parent) if (p.name) names.push(p.name);
      const k = names.slice(0, 3).join(' < ');
      const f = found.get(k) ?? { n: 0, minY: 1e9, maxY: -1e9, d: 0, at: null };
      f.n++; f.minY = Math.min(f.minY, h.point.y); f.maxY = Math.max(f.maxY, h.point.y); f.d = h.distance; f.at = h.point.toArray().map((v) => v.toFixed(0)).join(',');
      found.set(k, f);
    }
    return `from ${from.toArray().map((v) => v.toFixed(0))}\n` + [...found.entries()].sort((x, y) => y[1].n - x[1].n).slice(0, 25).map(([k, f]) => `${f.n} ${k} y ${f.minY.toFixed(0)}..${f.maxY.toFixed(0)} d ${f.d.toFixed(0)} at ${f.at}`).join('\n');
  }));
} finally { await browser.close(); await server.close(); }
