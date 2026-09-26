import { chromium } from 'playwright-core';

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium',
  args: ['--use-angle=gl-egl', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
  env: { ...process.env, __NV_PRIME_RENDER_OFFLOAD: '1' },
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && !m.text().startsWith('Failed to load resource') && errors.push(m.text()));

const results = [];
const check = (name, ok, detail) => results.push({ name, ok, detail });
const state = () => page.evaluate(() => ({ ...window.__game }));
const angleDiff = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));

async function hold(keys, seconds, sample) {
  const t0 = (await state()).simTime;
  for (const k of keys) await page.keyboard.down(k);
  let s;
  do {
    await page.waitForTimeout(60);
    s = await state();
    sample?.(s);
  } while (s.simTime < t0 + seconds);
  for (const k of keys) await page.keyboard.up(k);
  return s;
}

try {
  console.log('Connecting to http://localhost:5173?traffic=0...');
  await page.goto('http://localhost:5173?traffic=0');
  await page.waitForFunction(() => (window.__game?.simTime ?? 0) > 1.2, null, { timeout: 30_000 });

  const initial = await state();
  check('1. Car settles on four wheels', initial.wheelsInContact === 4 && initial.upY > 0.95,
    `wheels=${initial.wheelsInContact} upY=${initial.upY.toFixed(3)}`);

  // Test Camera mode switching with 'KeyV'
  const cam0 = (await state()).camMode;
  await page.keyboard.press('KeyV');
  await page.waitForTimeout(150);
  const cam1 = (await state()).camMode;

  await page.keyboard.press('KeyV');
  await page.waitForTimeout(150);
  const cam2 = (await state()).camMode;

  await page.keyboard.press('KeyV');
  await page.waitForTimeout(150);
  const cam3 = (await state()).camMode;

  await page.keyboard.press('KeyV');
  await page.waitForTimeout(150);
  const cam4 = (await state()).camMode;

  await page.keyboard.press('KeyV');
  await page.waitForTimeout(150);
  const cam5 = (await state()).camMode;

  check('2. V key cycles through all 5 camera modes',
    cam0 === 'chase' && cam1 === 'chase_far' && cam2 === 'hood' && cam3 === 'cockpit' && cam4 === 'drone' && cam5 === 'chase',
    `modes: ${cam0} -> ${cam1} -> ${cam2} -> ${cam3} -> ${cam4} -> ${cam5}`);

  // Test Forward Acceleration
  const fast = await hold(['KeyW'], 2.5);
  check('3. W accelerates forward briskly', fast.forwardSpeed > 14,
    `forwardSpeed=${fast.forwardSpeed.toFixed(1)} m/s (${fast.speedKmh.toFixed(0)} km/h)`);

  // Test Steering Response
  const turned = await hold(['KeyW', 'KeyD'], 1);
  const dh = angleDiff(turned.heading, fast.heading);
  check('4. Steering turns the car crisply', dh > 0.12, `heading change=${dh.toFixed(2)} rad`);

  // Test Drift Initiation on Handbrake + Steer & Boost Banking
  await page.keyboard.press('KeyR');
  await page.waitForTimeout(300);
  await hold(['KeyW'], 1.5);
  const driftStart = await state();

  let sawDrift = false;
  let maxSlip = 0;
  let driftTime = 0;
  let lastT = driftStart.simTime;
  const track = (s) => {
    if (s.drifting) driftTime += s.simTime - lastT;
    lastT = s.simTime;
    sawDrift ||= s.drifting;
    maxSlip = Math.max(maxSlip, Math.abs(s.slip));
  };
  const meterBefore = driftStart.meter;
  await hold(['KeyW', 'KeyA', 'Space'], 0.4, track);
  const drifted = await hold(['KeyW', 'KeyA'], 1.8, track);
  check('5. Handbrake + steer initiates drift instantly', sawDrift && driftTime > 0.8,
    `drifting for ${driftTime.toFixed(1)} of 2.2 s, max slip=${maxSlip.toFixed(2)} rad (${(maxSlip * 57.3).toFixed(0)}°)`);
  check('6. Sustained drift banks boost segments', drifted.meter >= 1.0,
    `boost meter ${meterBefore.toFixed(2)} -> ${drifted.meter.toFixed(2)}`);

  // Test Boost Spending with Shift
  let sawBoost = false;
  const boosted = await hold(['KeyW', 'ShiftLeft'], 0.8, (s) => { sawBoost ||= s.boosting; });
  check('7. Shift spends banked boost segment', sawBoost && boosted.meter < drifted.meter,
    `boosting=${sawBoost}, meter ${drifted.meter.toFixed(2)} -> ${boosted.meter.toFixed(2)}`);

  // Test Braking Bite
  await page.keyboard.press('KeyR');
  await page.waitForTimeout(300);
  await hold(['KeyW'], 2.0);
  const atSpeed = await state();
  const braked = await hold(['KeyS'], 1.2);
  check('8. S brakes hard from speed', braked.forwardSpeed < 4 && braked.forwardSpeed < atSpeed.forwardSpeed * 0.3,
    `speed before=${atSpeed.forwardSpeed.toFixed(1)} m/s, after 1.2s brake=${braked.forwardSpeed.toFixed(1)} m/s`);

  // Test Reverse Transition
  const reversed = await hold(['KeyS'], 2.0);
  check('9. S smoothly engages reverse gear from stop', reversed.forwardSpeed < -2.5,
    `reverse speed=${reversed.forwardSpeed.toFixed(1)} m/s (${(reversed.forwardSpeed * 3.6).toFixed(0)} km/h)`);

  // Test Reverse Braking to Forward
  const forwardAgain = await hold(['KeyW'], 1.5);
  check('10. W brakes reverse and accelerates forward', forwardAgain.forwardSpeed > 3,
    `forward speed=${forwardAgain.forwardSpeed.toFixed(1)} m/s`);

} catch (e) {
  errors.push(String(e));
} finally {
  await browser.close();
}

console.log('\n=== PHYSICS & CAMERA VERIFICATION RESULTS ===');
for (const r of results) console.log(`${r.ok ? '✓ PASS' : '✗ FAIL'}  ${r.name} — ${r.detail}`);
if (errors.length > 0) {
  console.log('\nERRORS:');
  for (const e of errors) console.log(`  ${e}`);
}
process.exit(results.every((r) => r.ok) && errors.length === 0 ? 0 : 1);
