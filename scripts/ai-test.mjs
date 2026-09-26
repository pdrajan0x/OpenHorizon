// Headless rival AI test. Prints numbers rather than a single pass/fail.
// Races: starts each race event and runs it until every rival finishes or 150 s of sim time pass, then
// reports each rival's time, self-inflicted wrecks and stuck respawns. The player is one of:
//   idle      sits on the grid (rivals ease off as they pull away: minimum catch-up power)
//   pressure  sits on the grid, but rivals are told they're 250 m behind (maximum catch-up power)
//   pilot     driven by the rival AI at full power with boost, a stand-in for a good human
// Takedowns: in Road Rage the player is teleported beside or behind a rival at speed and shoves it;
// a hard shove must score a takedown and a gentle nudge must not wreck the rival.
// Usage: node scripts/ai-test.mjs [races|rage|all]   PLAYER=idle,pilot  RACES=race-0,race-2  RAGE=rage-3  TRAFFIC=0  VERBOSE=1
// Event ids come from the map (makeEvents in src/events.ts); the defaults are the current map's.
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

const PART = process.argv[2] ?? 'all';
const MODES = (process.env.PLAYER ?? 'idle').split(',');
const RACES = (process.env.RACES ?? 'race-0,race-2,race-4,race-5,race-8').split(',');
const RAGE = process.env.RAGE ?? 'rage-3';
const TRAFFIC = process.env.TRAFFIC !== '0';
const VERBOSE = process.env.VERBOSE === '1';
const RACE_LIMIT = 150; // sim seconds
const TRIALS = Number(process.env.TRIALS ?? 2); // per takedown scenario

const server = await createServer({ logLevel: 'error', server: { port: Number(process.env.PORT ?? 5301), strictPort: true, hmr: false, watch: null } }); // other edits mustn't reload mid-run
await server.listen();
const url = server.resolvedUrls.local[0];
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium',
  args: ['--use-angle=gl-egl', '--ignore-gpu-blocklist'],
  env: { ...process.env, __NV_PRIME_RENDER_OFFLOAD: '1' },
});
const page = await browser.newPage({ viewport: { width: 800, height: 450 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && !m.text().startsWith('Failed to load resource') && errors.push(m.text()));

const state = () => page.evaluate(() => ({ ...window.__game }));
const wall0 = Date.now();

async function hold(keys, seconds) {
  const t0 = (await state()).simTime;
  for (const k of keys) await page.keyboard.down(k);
  let s;
  do {
    await page.waitForTimeout(100);
    s = await state();
  } while (s.simTime < t0 + seconds);
  for (const k of keys) await page.keyboard.up(k);
  return s;
}

/** Wait (sim seconds) until `until(state)` holds; returns the last state. */
async function waitSim(seconds, until = () => false, poll = 200) {
  const t0 = (await state()).simTime;
  let s;
  do {
    await page.waitForTimeout(poll);
    s = await state();
  } while (!until(s) && s.simTime < t0 + seconds);
  return s;
}

async function load(spawn) {
  await page.goto(`${url}?debug&spawn=${spawn}${TRAFFIC ? '' : '&traffic=0'}`);
  await page.waitForFunction(() => (window.__game?.simTime ?? 0) > 2, null, { timeout: 120_000 });
  // Per-physics-step log of rival wrecks, finishes and takedowns, by wrapping RivalPack.postStep
  await page.evaluate(async () => {
    const d = window.__debug;
    const { nearestNode, nodePosition } = await import('/src/route.ts');
    const pack = d.rivals;
    const log = (window.__ai = { wrecks: [], takedowns: [], finished: {}, go: null, field: null });
    // What a collider is, for wreck diagnostics
    const kind = (c) => {
      const b = c.parent();
      if (b && b.isDynamic()) return c.handle === d.player().collider.handle ? 'player' : pack.rivals.some((r) => r.car.collider.handle === c.handle) ? 'rival' : 'traffic';
      if (c.shapeType() === d.RAPIER.ShapeType.Cylinder) return 'pole';
      const h = c.halfExtents();
      return h && h.y > 1 ? 'building' : 'curb';
    };
    const orig = pack.postStep.bind(pack);
    pack.postStep = (time, player, ahead) => {
      const before = pack.rivals.map((r) => ({ wrecked: r.wrecked, speed: r.speedBefore, v: r.car.body.linvel() }));
      const hits = pack.rivals.map((r) => {
        const out = new Set();
        d.world.contactPairsWith(r.car.collider, (c) => {
          d.world.contactPair(r.car.collider, c, (m) => m.numContacts() > 0 && out.add(kind(c)));
        });
        return [...out];
      });
      const took = orig(time, player, ahead);
      pack.rivals.forEach((r, k) => {
        if (log.finished[r.id] === undefined && log.field && log.go !== null) {
          const q = r.car.body.translation();
          if (log.field.remaining(q.x, q.z) < 14) log.finished[r.id] = time - log.go;
        }
        if (!before[k].wrecked && r.wrecked) {
          const q = r.car.body.translation();
          const n = nearestNode(q.x, q.z);
          const c = nodePosition(n);
          log.wrecks.push({
            t: log.go === null ? null : time - log.go, id: r.id, name: r.name,
            shoved: r.shovedByPlayer(time), speed: before[k].speed, dv: r.car.impact(), upY: r.car.up.y,
            hit: hits[k], node: `${n.i},${n.j}`, dx: q.x - c.x, dz: q.z - c.z,
            heading: Math.atan2(r.car.forward.z, r.car.forward.x), shift: r.shift,
          });
        }
      });
      for (const r of took) log.takedowns.push({ t: time, id: r.id, name: r.name });
      return took;
    };
  });
}

async function startEvent(id) {
  await hold(['KeyW', 'KeyS'], 1.2);
  const s = await waitSim(8, (st) => st.event === `${id}:live`);
  if (s.event !== `${id}:live`) throw new Error(`${id} did not go live (event='${s.event}')`);
  return page.evaluate(() => {
    const log = window.__ai;
    log.go = window.__debug.simTime();
    log.field = window.__debug.events.running.field;
    return log.go;
  });
}

/** Drive the player with the rival AI along the GPS route (full power, boost): a stand-in for a human. */
async function startPilot(id) {
  await page.evaluate(async (id) => {
    const d = window.__debug;
    const { Rival } = await import('/src/rivals.ts');
    const { EVENTS } = await import('/src/events.ts');
    const { routePolyline } = await import('/src/route.ts');
    const car = d.player();
    const def = EVENTS.find((e) => e.id === id);
    const field = d.events.running.field;
    const pilot = new Rival(d.world, d.scene, car.tuning, 'YOU', 99);
    pilot.car.dispose(d.world, d.scene);
    pilot.car = car;
    const nodes = field.route(def.at, () => 0, 1);
    const p = car.body.translation();
    const f = car.forward;
    const at = new d.THREE.Vector3(p.x, 0, p.z);
    pilot.setPath([at.clone().addScaledVector(f, -5), at, ...routePolyline(nodes).slice(1)], 5);
    const orig = car.fixedUpdate.bind(car);
    car.fixedUpdate = (c, dt) => {
      const live = d.events.running?.phase === 'live' && !window.__game.crashed;
      if (!live) return orig(c, dt);
      const q = car.body.translation();
      pilot.drive(dt, [...d.traffic.nearby(q.x, q.z, 400), ...d.rivals.agents()]);
      orig(pilot.controls, dt);
    };
    window.__pilot = pilot;
  }, id);
}

// --- Races ---
async function race(id, mode) {
  await load(id);
  if (mode === 'pressure') await page.evaluate(() => { window.__debug.events.lead = () => -250; });
  await startEvent(id);
  if (mode === 'pilot') await startPilot(id);
  const length = await page.evaluate(() => {
    const d = window.__debug;
    const p = d.player().body.translation();
    return window.__ai.field.remaining(p.x, p.z);
  });
  let playerTime = null;
  let atPlayerFinish = null;
  const t0 = (await state()).simTime;
  for (;;) {
    await page.waitForTimeout(400);
    const s = await state();
    const info = await page.evaluate(() => {
      const d = window.__debug;
      const log = window.__ai;
      return {
        done: d.rivals.rivals.every((r) => log.finished[r.id] !== undefined),
        remaining: d.rivals.rivals.map((r) => { const q = r.car.body.translation(); return log.field.remaining(q.x, q.z); }),
        speeds: d.rivals.rivals.map((r) => r.car.speed),
        t: d.simTime() - log.go,
      };
    });
    if (mode === 'pilot' && playerTime === null && s.event !== `${id}:live`) {
      // The player crossed the line: the event ends and rivals coast, so record where everyone was
      playerTime = info.t;
      atPlayerFinish = info.remaining;
      break;
    }
    if (info.done || s.simTime > t0 + RACE_LIMIT) break;
  }
  const r = await page.evaluate(() => {
    const d = window.__debug;
    const log = window.__ai;
    return {
      rivals: d.rivals.rivals.map((r) => ({
        name: r.name, car: r.car.tuning.name, time: log.finished[r.id] ?? null, stuck: r.stuckRespawns,
        self: log.wrecks.filter((w) => w.id === r.id && !w.shoved).length,
        byPlayer: log.wrecks.filter((w) => w.id === r.id && w.shoved).length,
      })),
      wrecks: log.wrecks,
      takedowns: log.takedowns.length,
    };
  });
  return { id, mode, length, playerTime, atPlayerFinish, ...r };
}

function printRace(res) {
  const f = (t) => (t === null ? '  DNF ' : `${t.toFixed(1).padStart(5)}s`);
  const head = `${res.id.padEnd(9)} ${res.mode.padEnd(8)} ${String(Math.round(res.length)).padStart(5)} m`;
  const times = res.rivals.map((r) => `${r.name} ${f(r.time)}`).join('  ');
  const self = res.rivals.map((r) => r.self).join('/');
  const stuck = res.rivals.map((r) => r.stuck).join('/');
  const all = res.rivals.every((r) => r.time !== null);
  console.log(`${head} | ${times} | self-wrecks ${self} | stuck ${stuck} | all finished: ${all ? 'yes' : 'NO'}`);
  if (res.playerTime !== null) {
    const place = 1 + res.rivals.filter((r) => r.time !== null && r.time <= res.playerTime).length;
    const gaps = res.rivals.map((r, k) => (r.time !== null && r.time <= res.playerTime
      ? `${r.name} ahead by ${(res.playerTime - r.time).toFixed(1)}s`
      : `${r.name} ${Math.round(res.atPlayerFinish[k])} m back`));
    console.log(`          player (AI pilot) finished ${res.playerTime.toFixed(1)}s, place ${place}/5 — ${gaps.join(', ')}`);
  }
  if (res.takedowns) console.log(`          takedowns credited to the idle player: ${res.takedowns}`);
  if (VERBOSE || res.wrecks.length) {
    for (const w of res.wrecks) {
      console.log(`          wreck ${w.name} t=${w.t?.toFixed(1)} ${w.shoved ? '(player)' : '(self)'} speed=${w.speed.toFixed(1)} dv=${w.dv.toFixed(1)} upY=${w.upY.toFixed(2)} hit=[${w.hit}] near ${w.node} (${w.dx.toFixed(1)}, ${w.dz.toFixed(1)}) shift=${w.shift.toFixed(1)}`);
    }
  }
}

// --- Road Rage takedowns ---
const SCENARIOS = [
  { name: 'gentle side nudge 1.5 m/s', kind: 'side', push: 1.5, expect: false },
  { name: 'light rear tap +3 m/s', kind: 'rear', push: 3, expect: false },
  { name: 'side shove 6 m/s', kind: 'side', push: 6, expect: true },
  { name: 'side slam 10 m/s', kind: 'side', push: 10, expect: true },
  { name: 'rear ram +16 m/s', kind: 'rear', push: 16, expect: true },
];

/** Pick a healthy rival cruising on a straight with room ahead; returns its index or -1. */
function pickRival() {
  return page.evaluate(() => {
    const d = window.__debug;
    const rs = d.rivals.rivals;
    for (let k = 0; k < rs.length; k++) {
      const r = rs[k];
      if (r.wrecked || r.car.speed < 12 || r.car.up.y < 0.95) continue;
      // Distance to the next corner on its path
      let corner = Infinity;
      for (let i = 1; i < r.path.length - 1; i++) {
        if (r.cum[i] < r.s) continue;
        const a = r.path[i].clone().sub(r.path[i - 1]).normalize();
        const b = r.path[i + 1].clone().sub(r.path[i]).normalize();
        if (a.dot(b) < 0.9) { corner = r.cum[i] - r.s; break; }
      }
      if (corner > 35 && r.pathLength - r.s > 35) return k;
    }
    return -1;
  });
}

async function shove(k, sc) {
  return page.evaluate(({ k, sc }) => {
    const d = window.__debug;
    const r = d.rivals.rivals[k];
    const car = d.player();
    const q = r.car.body.translation();
    const f = r.car.forward;
    const v = r.car.body.linvel();
    const right = { x: -f.z, z: f.x };
    const heading = Math.atan2(f.z, f.x);
    // Side: 2.4 m to its left (the centerline side), pushing it toward the curb and buildings
    const pos = sc.kind === 'side'
      ? new d.THREE.Vector3(q.x - right.x * 2.4, 0.35, q.z - right.z * 2.4)
      : new d.THREE.Vector3(q.x - f.x * 6, 0.35, q.z - f.z * 6);
    car.reset(pos, -heading);
    const push = sc.kind === 'side' ? { x: right.x * sc.push, z: right.z * sc.push } : { x: f.x * sc.push, z: f.z * sc.push };
    car.body.setLinvel({ x: v.x + push.x, y: 0, z: v.z + push.z }, true);
    return { t: d.simTime(), name: r.name, speed: r.car.speed };
  }, { k, sc });
}

async function rage() {
  await load(RAGE);
  await startEvent(RAGE);
  await waitSim(3);
  const results = [];
  for (const sc of SCENARIOS) {
    for (let trial = 0; trial < TRIALS; trial++) {
      // Wait for a suitable rival and for the player to be out of any crash cam
      let k = -1;
      const tWait = (await state()).simTime;
      while ((await state()).simTime < tWait + 25) {
        const s = await state();
        if (!s.crashed) k = await pickRival();
        if (k >= 0) break;
        await page.waitForTimeout(250);
      }
      if (k < 0) {
        results.push({ sc, ok: false, detail: 'no suitable rival found' });
        continue;
      }
      const before = (await state()).takedowns;
      const logBefore = await page.evaluate(() => window.__ai.wrecks.length);
      const info = await shove(k, sc);
      const after = await waitSim(2.2, (s) => s.takedowns > before);
      // Let a takedown/crash play out before the next shove
      const w = await page.evaluate((n) => window.__ai.wrecks.slice(n), logBefore);
      const mine = w.filter((x) => x.name === info.name);
      const took = after.takedowns - before;
      const ok = sc.expect ? took > 0 : took === 0 && mine.length === 0;
      results.push({ sc, ok, took, wrecked: mine.length, speed: info.speed, detail: mine.map((x) => `dv=${x.dv.toFixed(1)} upY=${x.upY.toFixed(2)} hit=[${x.hit}]`).join(' ') });
      await waitSim(3.5, (s) => !s.crashed && s.simTime > after.simTime + 2.6);
      if (!(await state()).event.startsWith(`${RAGE}:live`)) {
        // The event ended (won or timed out): restart it for the remaining scenarios
        await load(RAGE);
        await startEvent(RAGE);
        await waitSim(3);
      }
    }
  }
  // Catchability: how fast rivals run with the player far away vs close by (player top speed ~88 m/s)
  const speeds = await page.evaluate(() => window.__debug.rivals.rivals.map((r) => ({ name: r.name, max: r.maxSpeed })));
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.sc.name.padEnd(26)} takedowns +${r.took ?? '-'} rival wrecked ${r.wrecked ?? '-'} (rival at ${(r.speed ?? 0).toFixed(0)} m/s) ${r.detail ?? ''}`);
  }
  console.log(`rival speed caps now: ${speeds.map((s) => `${s.name} ${s.max}`).join(', ')}`);
  return results;
}

let failed = false;
try {
  if (PART === 'races' || PART === 'all') {
    console.log(`== Races (traffic ${TRAFFIC ? 'on' : 'off'}) ==`);
    const all = [];
    for (const mode of MODES) {
      for (const id of RACES) {
        const res = await race(id, mode);
        printRace(res);
        all.push(res);
      }
    }
    for (const mode of MODES) {
      const rs = all.filter((r) => r.mode === mode);
      const n = rs.reduce((s, r) => s + r.rivals.length, 0);
      const self = rs.reduce((s, r) => s + r.rivals.reduce((a, x) => a + x.self, 0), 0);
      const stuck = rs.reduce((s, r) => s + r.rivals.reduce((a, x) => a + x.stuck, 0), 0);
      const dnf = rs.reduce((s, r) => s + r.rivals.filter((x) => x.time === null).length, 0);
      console.log(`${mode}: ${self} self-wrecks over ${n} rival-races (${(self / Math.max(1, n)).toFixed(2)} each), ${stuck} stuck respawns, ${mode === 'pilot' ? 'unfinished at player finish' : 'DNF'} ${dnf}`);
    }
  }
  if (PART === 'rage' || PART === 'all') {
    console.log(`== Road Rage takedowns (traffic ${TRAFFIC ? 'on' : 'off'}) ==`);
    const rs = await rage();
    failed ||= rs.some((r) => !r.ok);
  }
} catch (e) {
  errors.push(String(e?.stack ?? e));
} finally {
  await browser.close();
  await server.close();
}
for (const e of errors) console.log(`ERROR ${e}`);
console.log(`wall time ${((Date.now() - wall0) / 1000).toFixed(0)} s`);
process.exit(failed || errors.length ? 1 : 0);
