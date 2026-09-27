// Screenshots of every bridge, headless: for judging them, and for finding what's wrong where they meet
// the cities.
//   node scripts/bridge-shots.mjs <out-dir> [bridges, e.g. 1,4]
// Writes <out-dir>/world-map.png and, per bridge n (in build order):
//   n-aerial   from above: the curve in plan
//   n-side     from the sea, level with the deck: the profile, the piers
//   n-a-chase  the car on the bridge, driving off it into city A (and n-b-chase into B)
//   n-a-low    beside the join, a few metres up: the ramp, the embankment, the city's edge
//   n-a-under  from the water under the deck near the shore: supports, the embankment's end
// BUILD=1 shoots a production build instead of the dev server: a snapshot that doesn't reload when source
// files change during the run.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createServer, preview } from 'vite';
import { launch } from './browser.mjs';

const [out = 'test-results/bridges', only] = process.argv.slice(2);
const pick = only ? new Set(only.split(',').map(Number)) : null;
fs.mkdirSync(out, { recursive: true });

let server;
if (process.env.BUILD) {
  execFileSync('npx', ['vite', 'build', '--outDir', '.build/shots', '--emptyOutDir', '--logLevel', 'error'], { env: { ...process.env, LINK_MODS: '1' }, stdio: 'inherit' });
  fs.symlinkSync(`${process.cwd()}/public/mods`, '.build/shots/mods');
  server = await preview({ logLevel: 'error', preview: { port: 5341 }, build: { outDir: '.build/shots' } });
} else {
  server = await createServer({ logLevel: 'error', server: { port: 5341 } });
  await server.listen();
}
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log('PAGEERROR', String(e)));
const settle = async (seconds = 3) => {
  const t = await page.evaluate(() => window.__game.simTime);
  await page.waitForFunction((t) => window.__game.simTime > t, t + seconds, { timeout: 180_000 });
};
const view = (v) => page.evaluate((v) => { window.__debug.cam.view = v; }, v);
const shot = async (name) => {
  await page.screenshot({ path: `${out}/${name}.png` });
  console.log(`${out}/${name}.png`);
};

try {
  console.log(`loading ${server.resolvedUrls.local[0]}`);
  await page.goto(server.resolvedUrls.local[0] + '?debug&audit&traffic=0', { timeout: 300_000, waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => (window.__game?.simTime ?? 0) > 1 && window.__audit, null, { timeout: 300_000 });
  console.log('world loaded');
  await page.keyboard.press('KeyM');
  await page.waitForTimeout(1500); // the world stops while the map is open: wall-clock time, not game time
  await shot('world-map');
  await page.keyboard.press('KeyM');
  await page.addStyleTag({ content: '#hud { display: none !important; }' }); // the rest without the HUD

  // Land or sea at a point, from the islands' outlines (even-odd over each island's loops)
  await page.evaluate(() => {
    const loops = window.__debug.map.outlines.map(({ offset, loops }) => loops.map((l) => l.points.map(([x, z]) => [x + offset.x, z + offset.z])));
    window.__onLand = (x, z) => loops.some((island) => {
      let inside = false;
      for (const pts of island) {
        for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
          const [xi, zi] = pts[i];
          const [xj, zj] = pts[j];
          if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
        }
      }
      return inside;
    });
  });
  const bridges = await page.evaluate(() => (window.__debug.map.bridges?.bridges ?? []).map((b) => {
    const pts = b.nodes.map((p) => [p.x, p.y, p.z]);
    // The gateways: the bridge's own record of them, else a node's spacing beyond the first and last node
    const beyond = (p, q) => [p[0] + (p[0] - q[0]), p[1], p[2] + (p[2] - q[2])];
    const ends = b.ends ? b.ends.map((p) => [p.x, p.y, p.z]) : [beyond(pts[0], pts[1]), beyond(pts[pts.length - 1], pts[pts.length - 2])];
    return { pts, ends, length: b.length };
  }));
  console.log(`${bridges.length} bridges`);

  for (const [k, b] of bridges.entries()) {
    const n = k + 1;
    if (pick && !pick.has(n)) continue;
    const { pts, ends } = b;
    const mid = pts[Math.floor(pts.length / 2)];
    // The car on the deck in the middle, so the world streams in around it
    await page.evaluate(([x, z]) => window.__audit.goTo(x, z), [mid[0], mid[2]]);
    let [x0, z0, x1, z1] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const p of [...pts, ...ends]) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); z0 = Math.min(z0, p[2]); z1 = Math.max(z1, p[2]); }
    const span = Math.max(x1 - x0, z1 - z0, 300);
    const cx = (x0 + x1) / 2;
    const cz = (z0 + z1) / 2;
    // Across the chord, from whichever side is open water
    const [ax, , az] = ends[0];
    const [bx, , bz] = ends[1];
    const len = Math.hypot(bx - ax, bz - az);
    const [nx, nz] = [-(bz - az) / len, (bx - ax) / len];
    const d = Math.min(900, Math.max(260, len * 0.38));
    const wet = await page.evaluate(([p, q]) => [!window.__onLand(p[0], p[1]), !window.__onLand(q[0], q[1])], [[cx + nx * d, cz + nz * d], [cx - nx * d, cz - nz * d]]);
    const side = wet[0] || !wet[1] ? 1 : -1;
    // From above, obliquely (straight down, the sea only mirrors the sun)
    await view({ from: { x: cx + side * nx * span * 0.55, y: span * 0.42, z: cz + side * nz * span * 0.55 }, to: { x: cx, y: 0, z: cz }, fov: 55 });
    await settle();
    await shot(`${n}-aerial`);
    await view({ from: { x: cx + side * nx * d, y: wet[side > 0 ? 0 : 1] ? 16 : 60, z: cz + side * nz * d }, to: { x: cx, y: 14, z: cz }, fov: 55 });
    await settle();
    await shot(`${n}-side`);

    for (const [e, tag] of [[0, 'a'], [1, 'b']]) {
      const end = ends[e];
      const run = e === 0 ? pts : [...pts].reverse();
      // Out along the bridge from this end
      const at = (m) => {
        let s = Math.hypot(run[0][0] - end[0], run[0][2] - end[2]);
        for (let i = 1; i < run.length; i++) {
          const step = Math.hypot(run[i][0] - run[i - 1][0], run[i][2] - run[i - 1][2]);
          if (s + step >= m) return run[i];
          s += step;
        }
        return run[run.length - 1];
      };
      const out60 = at(60);
      // Chase: driving off the bridge into the city
      await view(null);
      await page.evaluate(([x, z, h]) => window.__audit.goTo(x, z, h), [out60[0], out60[2], Math.atan2(end[2] - out60[2], end[0] - out60[0])]);
      await page.evaluate(() => { window.__debug.cam.mode = 'chase'; });
      await settle();
      await shot(`${n}-${tag}-chase`);
      // Beside the join, looking at it
      const o = at(90);
      const [ux, uz] = [(o[0] - end[0]), (o[2] - end[2])];
      const ul = Math.hypot(ux, uz) || 1;
      const [sx, sz] = [-uz / ul, ux / ul];
      await view({ from: { x: end[0] + (ux / ul) * 110 + sx * 70, y: end[1] + 12, z: end[2] + (uz / ul) * 110 + sz * 70 }, to: { x: end[0] + (ux / ul) * 20, y: end[1] + 2, z: end[2] + (uz / ul) * 20 }, fov: 60 });
      await settle(2);
      await shot(`${n}-${tag}-low`);
      // From the water beside the deck, further out, looking back at the shore under it
      const w = at(320);
      await view({ from: { x: w[0] + sx * 45, y: 2.5, z: w[2] + sz * 45 }, to: { x: end[0] + (ux / ul) * 120, y: 4, z: end[2] + (uz / ul) * 120 }, fov: 65 });
      await settle(2);
      await shot(`${n}-${tag}-under`);
    }
    await view(null);
  }
} finally {
  await browser.close();
  await server.close?.();
  await server.httpServer?.close?.();
}
