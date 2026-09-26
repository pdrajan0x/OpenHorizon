// Dev probe: load a game URL headless on the NVIDIA GPU, wait, evaluate an expression, screenshot.
// Usage: node scripts/probe.mjs '<path?query>' '<js expression>' [seconds] [out.png]
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

const [path, expr, seconds = '4', out] = process.argv.slice(2);
const server = await createServer({ logLevel: 'error', server: { port: 5311 } });
await server.listen();
const browser = await chromium.launch({
  executablePath: '/usr/bin/chromium',
  args: ['--use-angle=gl-egl', '--ignore-gpu-blocklist'],
  env: { ...process.env, __NV_PRIME_RENDER_OFFLOAD: '1' },
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log('PAGEERROR', String(e)));
page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && console.log(m.type().toUpperCase(), m.text().slice(0, 300)));
try {
  await page.goto(server.resolvedUrls.local[0] + path.replace(/^\//, ''));
  await page.waitForFunction((s) => (window.__game?.simTime ?? 0) > Number(s), seconds, { timeout: 300_000 });
  // KEYS="KeyW+KeyS:1.2,:20" holds key combos for that many sim seconds, in order ("" = none)
  for (const step of (process.env.KEYS ?? '').split(',').filter(Boolean)) {
    const [combo, secs] = step.split(':');
    const keys = combo ? combo.split('+') : [];
    const t0 = await page.evaluate(() => window.__game.simTime);
    for (const k of keys) await page.keyboard.down(k);
    await page.waitForFunction((t) => window.__game.simTime > t, t0 + Number(secs), { timeout: 300_000 });
    for (const k of keys) await page.keyboard.up(k);
  }
  console.log(JSON.stringify(await page.evaluate(expr), null, 1));
  if (out) await page.screenshot({ path: out });
} finally {
  await browser.close();
  await server.close();
}
