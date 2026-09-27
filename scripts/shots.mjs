// Screenshots at places on the roads, headless:
//   node scripts/shots.mjs <out-prefix> "x,z[,heading];x,z"   the car on the road there (heading in radians)
//   node scripts/shots.mjs <out-prefix> start                where the game starts you
//   node scripts/shots.mjs <out-prefix> bridges:<n>          both joins of the first n bridges: the car on
//                                                            the bridge, driving into the city
// CAM=drone for the drone camera instead of the chase camera; QUERY="&map=<id>" for one map on its own.
// Writes <out-prefix>-<k>.png.
import { launch } from './browser.mjs';
import { createServer } from 'vite';

const [out, list] = process.argv.slice(2);
const cam = process.env.CAM ?? 'chase';
const server = await createServer({ logLevel: 'error', server: { port: 5331 } });
await server.listen();
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log('PAGEERROR', String(e)));
try {
  await page.goto(server.resolvedUrls.local[0] + '?debug&audit&traffic=0' + (process.env.QUERY ?? ''), { timeout: 300_000, waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => (window.__game?.simTime ?? 0) > 1 && window.__audit, null, { timeout: 300_000 });
  const places = list.startsWith('bridges:')
    ? await page.evaluate((n) => {
      const out = [];
      for (const b of (window.__debug.map.bridges?.bridges ?? []).slice(0, n)) {
        for (const nodes of [b.nodes, [...b.nodes].reverse()]) {
          // 60 m out on the bridge, facing the join
          let s = 0;
          let k = 1;
          for (; k < nodes.length - 1 && s < 60; k++) s += Math.hypot(nodes[k].x - nodes[k - 1].x, nodes[k].z - nodes[k - 1].z);
          const p = nodes[k];
          out.push({ x: p.x, z: p.z, heading: Math.atan2(nodes[0].z - p.z, nodes[0].x - p.x) });
        }
      }
      return out;
    }, Number(list.slice(8)))
    : list === 'start' ? [null] // where the game starts you, as it is
    : list.split(';').map((p) => { const [x, z, heading] = p.split(',').map(Number); return { x, z, heading }; });
  for (const [n, p] of places.entries()) {
    if (p) await page.evaluate(({ x, z, heading }) => window.__audit.goTo(x, z, Number.isFinite(heading) ? heading : undefined), p);
    await page.evaluate((cam) => { window.__debug.cam.mode = cam; }, cam);
    const s0 = await page.evaluate(() => window.__game.simTime);
    await page.waitForFunction((t) => window.__game.simTime > t + 3, s0, { timeout: 120_000 });
    await page.screenshot({ path: `${out}-${n + 1}.png` });
    console.log(`${out}-${n + 1}.png${p ? ` (${p.x.toFixed(0)}, ${p.z.toFixed(0)})` : ''}`);
  }
} finally {
  await browser.close();
  await server.close();
}
