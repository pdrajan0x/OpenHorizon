// After scripts/road-blocks.mjs: loads the world headless, and at every obstruction spot in each map's blocks.json
// casts rays along the road at bumper height through the physics; says how many are clear now.
//   node scripts/road-blocks-check.mjs
import { createServer } from 'vite';
import { launch } from './browser.mjs';
import fs from 'node:fs';
const src = fs.readFileSync('src/layout.ts', 'utf8');
const fixed = Object.fromEntries([...src.matchAll(/\[(\w+)\]: \[(-?\d+), (-?\d+)\]/g)].filter((m) => Math.abs(+m[2]) > 100 || Math.abs(+m[3]) > 100).map((m) => [m[1], [+m[2], +m[3]]]));
const ids = { lordcity: 'LC', chicago: 'CHI', 'ugase-city': 'UG' };
const server = await createServer({ logLevel: 'error', server: { port: 5346 } });
await server.listen();
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 320, height: 180 } });
try {
  await page.goto(server.resolvedUrls.local[0] + '?debug&audit&traffic=0', { timeout: 300_000, waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => (window.__game?.simTime ?? 0) > 1 && window.__audit, null, { timeout: 300_000 });
  for (const [id, k] of Object.entries(ids)) {
    const blocks = JSON.parse(fs.readFileSync(`public/mods/maps/${id}/blocks.json`));
    const dy = JSON.parse(fs.readFileSync(`public/mods/maps/${id}/island.json`)).dy ?? 0;
    let clear = 0;
    for (const [x, y, z, , dx, dz] of blocks) {
      const w = [x + fixed[k][0], y + dy, z + fixed[k][1]];
      await page.evaluate(([x, z]) => window.__audit.goTo(x, z), [w[0], w[2]]);
      const t = await page.evaluate(() => window.__game.simTime);
      await page.waitForFunction((t) => window.__game.simTime > t + 1.5, t, { timeout: 120_000 });
      const hit = await page.evaluate(([x, y, z, dx, dz]) => {
        const { RAPIER, world } = window.__debug;
        let worst = null;
        for (const h of [0.8, 1.5]) for (const dir of [1, -1]) {
          const ray = new RAPIER.Ray({ x: x - dir * dx * 12, y: y + h, z: z - dir * dz * 12 }, { x: dir * dx, y: 0, z: dir * dz });
          const r = world.castRay(ray, 24, true, RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC);
          if (r && (worst === null || r.timeOfImpact < worst)) worst = r.timeOfImpact;
        }
        return worst;
      }, [...w, dx, dz]);
      if (hit === null) clear++;
    }
    console.log(`${id}: ${clear} of ${blocks.length} spots clear along the road at bumper height`);
  }
} finally { await browser.close(); await server.close(); }
