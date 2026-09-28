// Every garage car in the game, headless: switched to in turn (number keys, then the pause menu), seen from
// its front three-quarters. node scripts/garage-shots.mjs [out-dir]  → <out-dir>/car-<n>.png
import fs from 'node:fs';
import { createServer } from 'vite';
import { launch } from './browser.mjs';

const out = process.argv[2] ?? 'test-results/garage';
fs.mkdirSync(out, { recursive: true });
const server = await createServer({ logLevel: 'error', server: { port: 5351 } });
await server.listen();
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log('PAGEERROR', String(e)));
const settle = async (s) => { const t = await page.evaluate(() => window.__game.simTime); await page.waitForFunction((t) => window.__game.simTime > t, t + s, { timeout: 120_000 }); };
try {
  await page.goto(server.resolvedUrls.local[0] + '?debug&traffic=0', { timeout: 300_000, waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => (window.__game?.simTime ?? 0) > 2, null, { timeout: 300_000 });
  await page.addStyleTag({ content: '#hud, #help { display: none !important; }' });
  for (let n = 0; n < Number(process.env.COUNT ?? 18); n++) {
    if (n < 9) await page.keyboard.press(`Digit${n + 1}`);
    else {
      // The pause menu: Switch car, then down from the current car to this one
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(300);
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
    }
    await page.waitForTimeout(2500);
    await settle(1.5);
    const car = await page.evaluate(() => {
      const g = window.__game;
      const h = g.heading;
      const f = [Math.cos(h), Math.sin(h)];
      const r = [-f[1], f[0]];
      window.__debug.cam.view = { from: { x: g.x + f[0] * 5.5 + r[0] * 3.2, y: g.y + 1.4, z: g.z + f[1] * 5.5 + r[1] * 3.2 }, to: { x: g.x, y: g.y + 0.4, z: g.z }, fov: 50 };
      return g.car;
    });
    await page.waitForTimeout(700);
    await page.screenshot({ path: `${out}/car-${n + 1}.png` });
    await page.evaluate(() => { window.__debug.cam.view = null; });
    console.log(`${out}/car-${n + 1}.png ${car}`);
  }
  // Then ride the last one: full throttle, steering left for 4 s; is it upright, leaning, fast?
  if (process.env.RIDE) {
    await page.evaluate(() => { window.__debug.cam.mode = 'chase'; });
    await page.keyboard.down('KeyW');
    await settle(2);
    await page.keyboard.down('KeyA');
    await settle(1.5);
    await page.screenshot({ path: `${out}/ride-turn.png` });
    const s = await page.evaluate(() => ({ kmh: window.__game.speedKmh, upY: window.__game.upY, lean: window.__debug.player().visual.lean?.rotation.x }));
    await page.keyboard.up('KeyA');
    await page.keyboard.up('KeyW');
    console.log('ride:', JSON.stringify(s));
  }
} finally {
  await browser.close();
  await server.close();
}
