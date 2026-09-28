// Drives the car at places, headless: from REACH m before each point, full throttle along the road for a few
// seconds, and says whether it got past the point (for checking that a road is clear).
//   node scripts/drive-through.mjs "x,z,dirX,dirZ;…"   (world frame)   SHOTS=<prefix>: a screenshot after each
import { createServer } from 'vite';
import { launch } from './browser.mjs';

const REACH = 40;
const list = process.argv[2].split(';').map((p) => p.split(',').map(Number));
const server = await createServer({ logLevel: 'error', server: { port: 5345 } });
await server.listen();
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
try {
  await page.goto(server.resolvedUrls.local[0] + '?debug&audit&traffic=0', { timeout: 300_000, waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => (window.__game?.simTime ?? 0) > 1 && window.__audit, null, { timeout: 300_000 });
  for (const [x, z, dx, dz] of list) {
    await page.evaluate(([x, z, h]) => window.__audit.goTo(x, z, h), [x - dx * REACH, z - dz * REACH, Math.atan2(dz, dx)]);
    const t = await page.evaluate(() => window.__game.simTime);
    await page.waitForFunction((t) => window.__game.simTime > t + 2, t, { timeout: 120_000 });
    await page.keyboard.down('KeyW');
    const t2 = await page.evaluate(() => window.__game.simTime);
    await page.waitForFunction((t) => window.__game.simTime > t + 5, t2, { timeout: 120_000 });
    await page.keyboard.up('KeyW');
    const p = await page.evaluate(() => { const b = window.__debug.player().body.translation(); return [b.x, b.z]; });
    const along = (p[0] - x) * dx + (p[1] - z) * dz;
    if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}-${list.indexOf(list.find((q) => q[0] === x && q[1] === z)) + 1}.png` });
    console.log(`(${x.toFixed(0)}, ${z.toFixed(0)}): ${along > 5 ? 'got through' : 'STOPPED'} (${along.toFixed(0)} m past it)`);
  }
} finally {
  await browser.close();
  await server.close();
}
