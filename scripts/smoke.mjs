// Headless smoke test on the NVIDIA GPU (falls back to software WebGL elsewhere), on the mod city map.
// Part 1 drives with no traffic: settles, accelerates forward, steers the right way, drifting fills
// boost, boost spends it, R resets. Part 2 checks traffic is alive and not crashing. Part 3 starts a
// race and a Road Rage and checks the rivals; part 4 drives flat out until it crashes, and respawns.
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
  args: ['--use-angle=gl-egl', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
  env: { ...process.env, __NV_PRIME_RENDER_OFFLOAD: '1' },
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
  await page.goto(`${url}?traffic=0`);
  await page.waitForFunction(() => (window.__game?.simTime ?? 0) > 1.5, null, { timeout: 90_000 });
  const settled = await state();
  check('car settles on four wheels', settled.wheelsInContact === 4 && settled.upY > 0.95,
    `wheels=${settled.wheelsInContact} upY=${settled.upY.toFixed(3)}`);
  await page.screenshot({ path: `${shots}/start.png` });

  const fast = await hold(['KeyW'], 2.5);
  check('W accelerates forward', fast.forwardSpeed > 12, `forwardSpeed=${fast.forwardSpeed.toFixed(1)} m/s (${fast.speedKmh.toFixed(0)} km/h)`);
  await page.screenshot({ path: `${shots}/accelerating.png` });

  const turned = await hold(['KeyW', 'KeyD'], 1);
  const dh = angleDiff(turned.heading, fast.heading);
  check('D steers right', dh > 0.1, `heading change=${dh.toFixed(2)} rad (+ is right)`);

  // Kick into a drift with the handbrake, then hold it with throttle and steering into the corner
  let sawDrift = false;
  let maxSlip = 0;
  let sawAir = false;
  let driftTime = 0;
  let lastT = turned.simTime;
  const track = (s) => {
    if (s.drifting) driftTime += s.simTime - lastT;
    lastT = s.simTime;
    sawDrift ||= s.drifting;
    maxSlip = Math.max(maxSlip, Math.abs(s.slip));
    sawAir ||= s.wheelsInContact === 0;
  };
  const meterBefore = turned.meter;
  await hold(['KeyW', 'KeyD', 'Space'], 0.6, track);
  const drifted = await hold(['KeyW', 'KeyD'], 3, track);
  await page.screenshot({ path: `${shots}/drifting.png` });
  check('handbrake + steer starts a drift', sawDrift, `drifting for ${driftTime.toFixed(1)} of 3.6 s`);
  // On the city map a drift can clip a curb and launch the car; judge the angle only on clean drifts
  check('held drift stays under spin-out angle', maxSlip < 1.1 || sawAir,
    `max slip=${maxSlip.toFixed(2)} rad (${(maxSlip * 57.3).toFixed(0)}°)${sawAir ? ', car went airborne off a curb' : ''}`);
  check('a sustained drift banks a full boost segment', drifted.meter >= 1, `meter ${meterBefore.toFixed(2)} → ${drifted.meter.toFixed(2)}`);
  check('car stays upright through the drift', drifted.upY > 0.8, `upY=${drifted.upY.toFixed(2)}`);

  let sawBoost = false;
  const boosted = await hold(['KeyW', 'ShiftLeft'], 1, (s) => { sawBoost ||= s.boosting; });
  check('Shift spends a banked segment', sawBoost && boosted.meter < drifted.meter,
    `boosting=${sawBoost} meter ${drifted.meter.toFixed(2)} → ${boosted.meter.toFixed(2)}`);

  await page.keyboard.press('KeyR');
  await page.waitForTimeout(300);
  const reset = await hold([], 1);
  check('R puts the car back upright', reset.upY > 0.95 && reset.wheelsInContact === 4, `upY=${reset.upY.toFixed(3)} wheels=${reset.wheelsInContact}`);

  // Part 2: the living city
  await page.goto(url);
  await page.waitForFunction(() => (window.__game?.simTime ?? 0) > 10, null, { timeout: 90_000 });
  const city = await state();
  await page.screenshot({ path: `${shots}/city.png` });
  check('traffic populates around the player', city.trafficActive >= 18, `${city.trafficActive} cars active`);
  check('traffic is moving', city.trafficMoving >= 10 && city.trafficAvgSpeed > 4,
    `${city.trafficMoving} moving, average ${(city.trafficAvgSpeed * 3.6).toFixed(0)} km/h`);
  check('traffic does not crash on its own', city.trafficWrecked <= 1, `${city.trafficWrecked} wrecked`);

  // Part 3: a race event. Spawn in its start ring, hold throttle + brake, and watch the rivals go
  await page.goto(`${url}?debug`);
  await page.waitForFunction(() => (window.__game?.simTime ?? 0) > 0.5, null, { timeout: 90_000 });
  const defs = await page.evaluate(() => window.__debug.events.defs.map((d) => ({ id: d.id, kind: d.kind })));
  const raceId = defs.find((d) => d.kind === 'race')?.id;
  const rageId = defs.find((d) => d.kind === 'rage')?.id;
  check('the map has race and Road Rage events', !!raceId && !!rageId, defs.map((d) => d.id).join(' '));
  await page.goto(`${url}?spawn=${raceId}`);
  await page.waitForFunction(() => (window.__game?.simTime ?? 0) > 2, null, { timeout: 90_000 });
  const started = await hold(['KeyW', 'KeyS'], 1.2);
  check('holding W + S in the ring starts the event', started.event === `${raceId}:countdown`, `event=${started.event}`);
  check('the race has four rivals', started.rivals === 4, `${started.rivals} rivals`);
  const go = await hold([], 3.5);
  check('countdown hands over to the race', go.event === `${raceId}:live`, `event=${go.event}`);
  let minRivalSpeed = Infinity;
  const raced = await hold([], 20, (s) => { if (s.simTime > go.simTime + 4) minRivalSpeed = Math.min(minRivalSpeed, s.rivalAvgSpeed); });
  await page.screenshot({ path: `${shots}/race.png` });
  check('rivals race along their routes', raced.rivalProgress > 250, `average ${raced.rivalProgress.toFixed(0)} m in 20 s, slowest average ${(minRivalSpeed * 3.6).toFixed(0)} km/h`);
  check('rivals are mostly not wrecked', raced.rivalsWrecked <= 1, `${raced.rivalsWrecked} wrecked right now`);
  await page.keyboard.press('Backspace');
  const quit = await hold([], 0.5);
  check('Backspace abandons the event', quit.event === '' && quit.rivals === 0, `event='${quit.event}' rivals=${quit.rivals}`);

  // Road Rage: rivals spawn roaming ahead
  await page.goto(`${url}?spawn=${rageId}`);
  await page.waitForFunction(() => (window.__game?.simTime ?? 0) > 2, null, { timeout: 90_000 });
  await hold(['KeyW', 'KeyS'], 1.2);
  const rage = await hold([], 8);
  check('Road Rage runs with roaming rivals', rage.event === `${rageId}:live` && rage.rivals === 4 && rage.rivalAvgSpeed > 5,
    `event=${rage.event} rivals=${rage.rivals} avg ${(rage.rivalAvgSpeed * 3.6).toFixed(0)} km/h`);

  // Part 4: flat out across the lot into the buildings beyond it
  await page.goto(`${url}?traffic=0`);
  await page.waitForFunction(() => (window.__game?.simTime ?? 0) > 1.5, null, { timeout: 90_000 });
  let crashedAt = null;
  await page.keyboard.down('KeyW');
  await page.keyboard.down('ShiftLeft');
  const t0 = (await state()).simTime;
  let s;
  do {
    await page.waitForTimeout(100);
    s = await state();
    if (s.crashed) crashedAt = s;
  } while (!crashedAt && s.simTime < t0 + 25);
  await page.keyboard.up('KeyW');
  await page.keyboard.up('ShiftLeft');
  if (crashedAt) await page.screenshot({ path: `${shots}/crash.png` });
  check('a flat-out hit is a crash', crashedAt !== null, crashedAt ? `crashed at x=${crashedAt.x.toFixed(0)} z=${crashedAt.z.toFixed(0)}` : 'no crash in 25 s');
  if (crashedAt) {
    await page.waitForFunction(() => !window.__game?.crashed, null, { timeout: 60_000 });
    const after = await hold([], 0.3);
    check('after the crash cam the car drives on', after.upY > 0.9 && after.speedKmh > 20, `upY=${after.upY.toFixed(2)} ${after.speedKmh.toFixed(0)} km/h`);
  }
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
