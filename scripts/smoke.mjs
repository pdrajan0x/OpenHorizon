// Headless smoke test: boots the game in Chromium (software WebGL), drives it with the keyboard,
// and checks the car settles, accelerates forward, steers the right way, and that drifting fills boost.
// Usage: npm run smoke   (CHROMIUM=/path/to/chrome to override the browser, SHOTS_DIR for screenshots)
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

const shots = process.env.SHOTS_DIR ?? 'test-results';
mkdirSync(shots, { recursive: true });

const server = await createServer({ logLevel: 'error', server: { port: 5199 } });
await server.listen();
const url = server.resolvedUrls.local[0];

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && !m.text().startsWith('Failed to load resource') && errors.push(m.text()));
page.on('response', (r) => r.status() >= 400 && errors.push(`HTTP ${r.status()} ${r.url()}`));

const results = [];
const check = (name, ok, detail) => results.push({ name, ok, detail });
const state = () => page.evaluate(() => ({ ...window.__game }));
const angleDiff = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));

// Hold keys for `seconds` of simulated time (headless rendering is slow, so wall time is meaningless)
async function hold(keys, seconds, sample) {
  const t0 = (await state()).simTime;
  for (const k of keys) await page.keyboard.down(k);
  let s;
  do {
    await page.waitForTimeout(100);
    s = await state();
    sample?.(s);
  } while (s.simTime < t0 + seconds);
  for (const k of keys) await page.keyboard.up(k);
  return s;
}

try {
  await page.goto(url);
  await page.waitForFunction(() => (window.__game?.simTime ?? 0) > 1.5, null, { timeout: 90_000 });
  const settled = await state();
  check('car settles on four wheels', settled.wheelsInContact === 4 && settled.upY > 0.95,
    `wheels=${settled.wheelsInContact} upY=${settled.upY.toFixed(3)}`);
  await page.screenshot({ path: `${shots}/start.png` });

  const fast = await hold(['KeyW'], 4);
  check('W accelerates forward', fast.forwardSpeed > 12, `forwardSpeed=${fast.forwardSpeed.toFixed(1)} m/s (${fast.speedKmh.toFixed(0)} km/h)`);
  await page.screenshot({ path: `${shots}/accelerating.png` });

  const turned = await hold(['KeyW', 'KeyD'], 1);
  const dh = angleDiff(turned.heading, fast.heading);
  check('D steers right', dh > 0.1, `heading change=${dh.toFixed(2)} rad (+ is right)`);

  // Kick into a drift with the handbrake, then hold it with throttle and steering into the corner
  let sawDrift = false;
  let maxSlip = 0;
  let driftTime = 0;
  let lastT = turned.simTime;
  const track = (s) => {
    if (s.drifting) driftTime += s.simTime - lastT;
    lastT = s.simTime;
    sawDrift ||= s.drifting;
    maxSlip = Math.max(maxSlip, Math.abs(s.slip));
  };
  const meterBefore = turned.meter;
  await hold(['KeyW', 'KeyD', 'Space'], 0.6, track);
  const drifted = await hold(['KeyW', 'KeyD'], 3, track);
  await page.screenshot({ path: `${shots}/drifting.png` });
  check('handbrake + steer starts a drift', sawDrift, `drifting for ${driftTime.toFixed(1)} of 3.6 s`);
  check('held drift stays under spin-out angle', maxSlip < 1.1, `max slip=${maxSlip.toFixed(2)} rad (${(maxSlip * 57.3).toFixed(0)}°)`);
  check('a sustained drift banks a full boost segment', drifted.meter >= 1, `meter ${meterBefore.toFixed(2)} → ${drifted.meter.toFixed(2)}`);
  check('car stays upright through the drift', drifted.upY > 0.8, `upY=${drifted.upY.toFixed(2)}`);

  let sawBoost = false;
  const boosted = await hold(['KeyW', 'ShiftLeft'], 1, (s) => { sawBoost ||= s.boosting; });
  check('Shift spends a banked segment', sawBoost && boosted.meter < drifted.meter,
    `boosting=${sawBoost} meter ${drifted.meter.toFixed(2)} → ${boosted.meter.toFixed(2)}`);

  await page.keyboard.press('KeyR');
  await page.waitForTimeout(300);
  const reset = await hold([], 1);
  check('R resets onto the road, upright', !reset.offroad && reset.upY > 0.95, `offroad=${reset.offroad} upY=${reset.upY.toFixed(3)}`);
} catch (e) {
  errors.push(String(e));
} finally {
  await browser.close();
  await server.close();
}

for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name} — ${r.detail}`);
for (const e of errors) console.log(`ERROR ${e}`);
console.log(`screenshots: ${shots}/`);
process.exit(results.every((r) => r.ok) && errors.length === 0 ? 0 : 1);
