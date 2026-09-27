import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import './style.css';
import { Atmosphere, type TimeOfDay } from './atmosphere';
import { CarAudio } from './audio';
import { Audit } from './audit';
import { ChaseCamera, type Clearance } from './camera';
import { Car } from './car';
import { SkidMarks, Sparks } from './effects';
import { Events, makeEvents } from './events';
import { Hud } from './hud';
import { Input, type Controls } from './input';
import { Minimap } from './minimap';
import { PostFX } from './postfx';
import { RivalPack, type Rival } from './rivals';
import { Islands } from './islands';
import { RaceField } from './map';
import { Ocean, SEA_LEVEL } from './ocean';
import { WorldMap } from './worldmap';
import { Stunts } from './stunts';
import { Traffic } from './traffic';
import { WreckSmoke } from './damage';
import { ensureHero, loadGarage, loadTrafficModels } from './garage';
import { GARAGE } from './tuning';

const FIXED_DT = 1 / 60;
const MAX_STEPS_PER_FRAME = 4;
const REAR_WHEELS = [2, 3];
const UPSIDE_DOWN_RESET_SECONDS = 2;
const TRAFFIC_CARS = 24;
const DENT_DV = 3; // m/s of velocity change in one step that leaves a mark on the body
const GPS_REFRESH = 0.4; // s between re-routes to the waypoint
const WAYPOINT_ARRIVED = 30; // m of driving left when the waypoint counts as reached
const CRASH_SECONDS = 2.2; // real seconds of crash cam before driving on from where the car stopped
const CRASH_SLOW_SECONDS = 1.6;
const CRASH_TIME_SCALE = 0.3;
// Wear: a crash costs this much of the car's health, plus more the faster it was going; plain dents a
// little. Around five hard crashes total a car.
const CRASH_WEAR = 0.1;
const CRASH_WEAR_PER_MS = 0.004; // per m/s of speed going into the crash
const DENT_WEAR_PER_MS = 0.003; // per m/s of velocity change above DENT_DV
const WRECK_SECONDS = 2.5; // wreck cam before the "new car" prompt
const TAKEDOWN_SLOW_SECONDS = 0.7;
const TAKEDOWN_TIME_SCALE = 0.4;
const HELD: Controls = { throttle: 0, brake: 1, steer: 0, handbrake: false, boost: false };
const LIMP: Controls = { throttle: 0, brake: 0, steer: 0, handbrake: false, boost: false };

// Read by scripts/smoke.mjs and scripts/bench.mjs
declare global {
  interface Window {
    __game?: Record<string, number | boolean | string>;
    __debug?: Record<string, unknown>; // live game objects for test scripts, with ?debug
    __audit?: { audit: Audit; run: () => number; goTo: (x: number, z: number) => Promise<void> }; // ?debug&audit
  }
}

async function main(): Promise<void> {
  await RAPIER.init();
  await loadGarage(0);
  // Test hook: ?traffic=0 for an empty city
  const params = new URLSearchParams(location.search);

  const canvas = document.getElementById('game') as HTMLCanvasElement;
  const renderer = new THREE.WebGLRenderer({ canvas, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  renderer.toneMapping = THREE.ACESFilmicToneMapping; // the atmosphere picks the tone mapping for its time of day

  const scene = new THREE.Scene();
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = FIXED_DT;

  // The world: cities from GTA V map mods as islands in one sea (?map=<id> loads a single map on its own)
  const map = await Islands.load(world, scene, params.get('map') ?? undefined);
  scene.add(map.root);
  // ?time=day|sunset|night picks the sky photograph; ?rain adds rain
  const time = (['day', 'sunset', 'night'].includes(params.get('time') ?? '') ? params.get('time') : 'day') as TimeOfDay;
  const [atmosphere, ocean] = await Promise.all([Atmosphere.load(renderer, scene, time, params.has('rain')), Ocean.load(scene)]);
  map.setNight(atmosphere.look.night);

  // ?spawn=<event id> starts inside that event's start ring; ?at=x,z on the road nearest a map point
  const spawnParam = params.get('spawn') ?? '';
  const eventDefs = makeEvents(map.roads, map.spawn);
  const spawnEvent = eventDefs.find((e) => e.id === spawnParam);
  const [atX, atZ] = (params.get('at') ?? '').split(',').map(Number);
  const spawnAt = spawnEvent ? map.roads.nodes[spawnEvent.at] : Number.isFinite(atZ) ? { x: atX, z: atZ } : map.spawn;
  const spawn = map.roads.roadPose(spawnAt.x, spawnAt.z, 0);
  await map.prime(spawn.position);
  let carIndex = 0;
  let player = new Car(world, scene, GARAGE[carIndex], spawn.position, spawn.yaw, true);
  const trafficCount = params.get('traffic') === '0' ? 0 : TRAFFIC_CARS;
  const traffic = new Traffic(world, scene, map.roads, trafficCount ? await loadTrafficModels() : [], trafficCount);
  const cam = new ChaseCamera();
  // Dim fill light riding with the camera, so the player car's rear isn't a black silhouette
  // (not by day: in sunlight it only paints a spotlight on the road ahead)
  if (atmosphere.time !== 'day') cam.camera.add(new THREE.PointLight(0xa8b8ff, 30, 16, 1.5));
  scene.add(cam.camera);
  atmosphere.castShadows(renderer, cam.camera);
  const fx = new PostFX(renderer, scene, cam.camera, atmosphere.look.bloom);
  const skids = new SkidMarks(scene);
  const smoke = new WreckSmoke(scene);
  const sparks = new Sparks(scene);
  const stunts = new Stunts((x, z, fx, fz) => map.roads.laneOffset(x, z, fx, fz));
  const rivals = new RivalPack(world, scene, map.roads);
  const input = new Input();
  const hud = new Hud();
  const minimap = new Minimap(document.getElementById('minimap') as HTMLCanvasElement, map.roads);
  const audio = new CarAudio();
  const events = new Events(scene, hud, audio, map.roads, eventDefs);
  // M: the full map; the world pauses while it's open
  const hudElement = document.getElementById('hud')!;
  // GPS waypoint set on the big map: the shortest drive there, refreshed as you go. An event's own
  // route takes over while it runs.
  let waypoint: { field: RaceField; at: THREE.Vector3; gps: THREE.Vector3[]; timer: number } | null = null;
  const routeWaypoint = () => {
    if (!waypoint) return;
    const p = player.body.translation();
    waypoint.gps = [new THREE.Vector3(p.x, 0, p.z), ...waypoint.field.route(waypoint.field.nextNode(p.x, p.z)).map((n) => map.roads.nodes[n].clone())];
    waypoint.timer = GPS_REFRESH;
  };
  const worldMap = new WorldMap(map, (open) => hudElement.classList.toggle('hidden', open), (at) => {
    if (!at) waypoint = null;
    else {
      const node = map.roads.nearestNode(at.x, at.y);
      waypoint = { field: new RaceField(map.roads, node), at: map.roads.nodes[node].clone(), gps: [], timer: 0 };
      routeWaypoint();
    }
    worldMap.refresh(mapExtras());
  }, (at) => void teleport(at));
  const mapExtras = () => ({
    events: events.mapMarkers(),
    rivals: rivals.rivals.map((r) => {
      const q = r.car.body.translation();
      return new THREE.Vector3(q.x, q.y, q.z);
    }),
    route: events.gps() ?? waypoint?.gps ?? null,
    destination: events.destination() ?? waypoint?.at ?? null,
  });
  audio.setEngine(player.tuning.engineSound ?? 'lambo-v12');
  hud.showCar(player);

  if (params.has('debug')) {
    window.__debug = {
      THREE, RAPIER, world, scene, map, traffic, rivals, events, stunts, cam, renderer, fx,
      player: () => player,
      simTime: () => simTime,
    };
  }

  const resize = () => {
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    fx.setSize(window.innerWidth, window.innerHeight);
    cam.camera.aspect = window.innerWidth / window.innerHeight;
    cam.camera.updateProjectionMatrix();
  };
  window.addEventListener('resize', resize);
  resize();

  // The city's static geometry blocks the camera; cars don't
  const ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
  const dir = new THREE.Vector3();
  const blocksView = (c: RAPIER.Collider) => c.shapeType() === RAPIER.ShapeType.TriMesh;
  const clearance: Clearance = (from, to) => {
    const length = dir.subVectors(to, from).length();
    ray.origin = from;
    ray.dir = dir.divideScalar(length);
    const hit = world.castRay(ray, length, true, RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC, undefined, undefined, undefined, blocksView);
    return hit ? hit.timeOfImpact : Infinity;
  };

  const place = (position: THREE.Vector3, yaw: number) => {
    player.reset(position, yaw);
    skids.breakAll();
    cam.snap();
  };

  const resetPlayer = () => {
    const p = player.body.translation();
    const pose = map.roads.roadPose(p.x, p.z, player.heading);
    place(pose.position, pose.yaw);
  };
  // Spawning from the map (Shift+click, or T at the GPS pin): the road nearest the point, with that city
  // streamed in first so the car lands on solid ground. Not during an event or a crash
  let teleporting = false;
  const teleport = async (at: THREE.Vector2) => {
    if (teleporting) return;
    if (events.running || crash) {
      hud.note(events.running ? 'LEAVE THE EVENT TO SPAWN ELSEWHERE' : 'WAIT FOR THE CRASH TO END', 'info');
      return;
    }
    teleporting = true;
    const pose = map.roads.roadPose(at.x, at.y, player.heading);
    await map.prime(pose.position);
    teleporting = false;
    if (worldMap.open) worldMap.toggle();
    if (wreck) {
      player.repair();
      wreck = null;
    }
    place(pose.position, pose.yaw);
    hud.banner('SPAWNED', map.islandAt(pose.position).info.name, 'info', 1.2);
  };

  // ?debug&audit: the geometry and visibility audit (src/audit.ts); F9 shows its markers and issue list
  if (params.has('debug') && params.has('audit')) {
    const audit = new Audit(scene, map.root, world, () => map.roads.nodes, (p) => void teleport(new THREE.Vector2(p.x, p.z)));
    window.__audit = {
      audit,
      run: () => audit.run(new THREE.Vector3().copy(player.body.translation() as THREE.Vector3Like)),
      goTo: async (x: number, z: number) => { await teleport(new THREE.Vector2(x, z)); },
    };
  }

  // After a wreck: a new car on the nearest road
  const newCar = () => {
    player.repair();
    resetPlayer();
    wreck = null;
    hud.banner('NEW CAR', player.tuning.name, 'info', 1.2);
  };

  let switching = false;
  const switchCar = async (index: number) => {
    if (switching || index >= GARAGE.length) return;
    switching = true;
    await ensureHero(index);
    switching = false;
    if (events.running || crash || wreck) return;
    const p = player.body.translation();
    const v = player.body.linvel();
    const old = player;
    player = new Car(world, scene, GARAGE[index], new THREE.Vector3(p.x, p.y + 0.1, p.z), -old.heading, true);
    player.body.setLinvel(v, true);
    old.dispose(world, scene);
    carIndex = index;
    skids.breakAll();
    hud.showCar(player);
    audio.setEngine(player.tuning.engineSound ?? 'lambo-v12');
  };

  // Crash: slow-motion orbit of the crash, then you drive on from where the car ended up, dented and a
  // little slower. Crashes add up: enough of them total the car (a wreck), and only then is there a new one.
  let crash: { t: number } | null = null;
  let wreck: { t: number; prompted: boolean } | null = null;
  let takedownSlow = 0;
  const startWreck = (sunk = false) => {
    if (wreck) return;
    if (!player.destroyed) player.wear(1);
    wreck = { t: 0, prompted: false };
    crash = null;
    hud.banner(sunk ? 'SUNK' : 'WRECKED', player.tuning.name, 'crash', WRECK_SECONDS);
  };
  const startCrash = (speed: number) => {
    player.drift.crashed();
    const p = player.body.translation();
    sparks.burst(new THREE.Vector3(p.x, p.y + 0.6, p.z).addScaledVector(player.forward, 2), player.forward.clone().negate(), 90, 10);
    audio.crash(Math.min(1, speed / 40));
    if (player.wear(CRASH_WEAR + CRASH_WEAR_PER_MS * speed)) {
      startWreck();
      return;
    }
    crash = { t: 0 };
    hud.banner('CRASH', `CAR ${Math.round(player.health * 100)}%`, 'crash', 1.8);
  };
  const endCrash = () => {
    crash = null;
    cam.snap();
  };
  const onTakedown = (r: Rival) => {
    stunts.takedown(player);
    events.onTakedown();
    takedownSlow = TAKEDOWN_SLOW_SECONDS;
    const q = r.car.body.translation();
    sparks.burst(new THREE.Vector3(q.x, q.y + 0.6, q.z), r.car.velocity, 70, 12);
    audio.crash(0.8);
    hud.banner('TAKEDOWN!', r.name, 'takedown', 1.3);
  };
  const aheadOfPlayer = () => {
    const p = player.body.translation();
    return map.roads.nearestNode(p.x + player.forward.x * 90, p.z + player.forward.z * 90);
  };

  // Test hook: where the closest healthy rival is, relative to the player's heading
  const nearestRival = () => {
    const p = player.body.translation();
    let best = { rivalDist: Infinity, rivalBearing: 0 };
    for (const r of rivals.rivals) {
      if (r.wrecked) continue;
      const q = r.car.body.translation();
      const d = Math.hypot(q.x - p.x, q.z - p.z);
      if (d < best.rivalDist) {
        const a = Math.atan2(q.z - p.z, q.x - p.x) - player.heading;
        best = { rivalDist: d, rivalBearing: Math.atan2(Math.sin(a), Math.cos(a)) };
      }
    }
    return best;
  };

  let simTime = 0;
  let accumulator = 0;
  let upsideDown = 0;
  let frameCount = 0;
  let last = performance.now();
  const fps = { frames: 0, since: last, text: '' };
  const contact = new THREE.Vector3();
  const playerPos = new THREE.Vector3();

  const frame = (now: number) => {
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    if (worldMap.open) {
      audio.update(0, 0, 0, false);
      requestAnimationFrame(frame);
      return;
    }

    const { controls, actions } = input.update(dt);
    if (actions.car !== null && actions.car !== carIndex && !events.running && !crash && !wreck) void switchCar(actions.car);
    if (actions.reset && !crash) {
      if (wreck) {
        if (wreck.prompted) newCar();
      } else resetPlayer();
    }
    if (actions.camera) {
      const mode = cam.toggle();
      const labels: Record<string, string> = {
        chase: 'CAMERA: CLOSE CHASE',
        chase_far: 'CAMERA: FAR CHASE',
        hood: 'CAMERA: HOOD / BUMPER',
        cockpit: 'CAMERA: COCKPIT / INTERIOR',
        drone: 'CAMERA: DRONE / AERIAL',
      };
      hud.note(labels[mode] ?? `CAMERA: ${mode.toUpperCase()}`, 'stunt');
    }
    if (actions.fps) hud.toggleFps();
    if (actions.help) hud.toggleHelp();

    // Events start with a fresh car
    const eventPlace = (position: THREE.Vector3, yaw: number) => {
      player.repair();
      wreck = null;
      place(position, yaw);
    };
    const frozen = events.update(dt, { player, controls, quit: actions.quit, stunts, rivals, traffic, place: eventPlace });
    const drive = crash || wreck ? LIMP : frozen ? HELD : controls;
    const timeScale = crash && crash.t < CRASH_SLOW_SECONDS ? CRASH_TIME_SCALE : takedownSlow > 0 ? TAKEDOWN_TIME_SCALE : 1;
    takedownSlow -= dt;

    accumulator += dt;
    let steps = 0;
    while (accumulator >= FIXED_DT && steps < MAX_STEPS_PER_FRAME) {
      // Slow motion shrinks each physics step instead of skipping steps, so it stays smooth
      const h = FIXED_DT * timeScale;
      world.timestep = h;
      const p = player.body.translation();
      playerPos.set(p.x, p.y, p.z);
      player.fixedUpdate(drive, h);
      const speedBefore = player.speed;
      player.markVelocity();
      traffic.fixedUpdate(h, simTime, playerPos);
      if (rivals.rivals.length > 0) {
        rivals.fixedUpdate(h, traffic.nearby(p.x, p.z, 400), (r) => events.lead(r, player), frozen);
      }
      world.step();
      traffic.postStep(simTime);
      for (const r of rivals.postStep(simTime, player, aheadOfPlayer)) onTakedown(r);
      const hit = player.impact();
      if (hit > DENT_DV) {
        player.applyDamage(world, hit);
        audio.bump(Math.min(1, (hit - DENT_DV) / 8));
        if (!wreck && player.wear(DENT_WEAR_PER_MS * (hit - DENT_DV))) startWreck();
      }
      if (!crash && !wreck && !frozen) {
        const shielded = rivals.rivals.some((r) => r.touchingPlayer(simTime));
        if (stunts.step(player, simTime, speedBefore, h, shielded)) startCrash(speedBefore);
        // Off the edge of an island: into the sea, and that car is gone
        else if (player.body.translation().y < SEA_LEVEL - 1.5) startWreck(true);
      }
      for (const [id, wheel] of REAR_WHEELS.entries()) {
        skids.update(id, player.skidAmount > 0.3 ? player.contactPoint(wheel, contact) : null);
      }
      simTime += h;
      accumulator -= FIXED_DT;
      steps++;
    }
    if (steps === MAX_STEPS_PER_FRAME) accumulator = 0; // running slow: drop time rather than spiral

    const p = player.body.translation();
    playerPos.set(p.x, p.y, p.z);
    upsideDown = player.up.y < 0.3 && player.speed < 3 && !crash && !wreck ? upsideDown + dt : 0;
    const nearestNode = map.roads.nearestNode(p.x, p.z);
    const roadY = map.roads.nodes[nearestNode].y;
    // Through a hole in the city's collision: nothing to stand on, so back to the road
    const fellThrough = !wreck && p.y > SEA_LEVEL - 1 && (p.y < roadY - 25 || p.y < -50);
    if (fellThrough) resetPlayer();
    // On its roof: back on its wheels where it is (a crash doesn't move you anywhere)
    if (upsideDown > UPSIDE_DOWN_RESET_SECONDS) {
      player.rightUp();
      upsideDown = 0;
    }
    if (wreck) {
      wreck.t += dt;
      if (!wreck.prompted && wreck.t > WRECK_SECONDS) {
        wreck.prompted = true;
        hud.banner('WRECKED', 'Press R for a new car', 'crash', Infinity);
      }
    }
    if (!crash) {
      stunts.nearMisses(player, [...traffic.nearby(p.x, p.z, 20), ...rivals.agents()], simTime);
    }
    for (const n of stunts.notes) if (n.kind !== 'crash') hud.note(n.text, n.kind);
    stunts.notes.length = 0;

    const lookahead = playerPos.clone().addScaledVector(player.velocity, 2.5);
    map.update(cam.camera.position, [playerPos, lookahead, ...rivals.rivals.map((r) => {
      const q = r.car.body.translation();
      return new THREE.Vector3(q.x, q.y, q.z);
    })]);
    traffic.update(simTime, playerPos);
    player.syncVisuals();
    rivals.syncVisuals();
    sparks.update(dt * timeScale);
    smoke.update(dt * timeScale, [player.damage, ...rivals.rivals.map((r) => r.car.damage)]);
    if (wreck && wreck.t < WRECK_SECONDS) {
      cam.crash(wreck.t, player, clearance);
    } else if (crash) {
      cam.crash(crash.t, player, clearance);
      crash.t += dt;
      if (crash.t > CRASH_SECONDS) endCrash();
    } else {
      cam.update(dt, player, clearance);
    }
    atmosphere.update(simTime, cam.camera.position);
    ocean.update(simTime, cam.camera.position);
    map.cull(cam.camera.position);

    fps.frames++;
    if (now - fps.since > 500) {
      const perSecond = (fps.frames * 1000) / (now - fps.since);
      fps.text = `${perSecond.toFixed(0)} fps · ${(1000 / perSecond).toFixed(1)} ms`;
      fps.frames = 0;
      fps.since = now;
    }
    hud.update(dt, player, fps.text);
    hud.setProgress(`EVENTS ${events.completed}/${events.defs.length}`);
    if (waypoint && (waypoint.timer -= dt) <= 0) {
      if (waypoint.field.remaining(p.x, p.z) < WAYPOINT_ARRIVED) {
        waypoint = null;
        worldMap.clearWaypoint();
        hud.banner('ARRIVED', 'GPS waypoint reached', 'info', 2);
      } else routeWaypoint();
    }
    if (frameCount++ % 2 === 0) {
      const extras = mapExtras();
      minimap.draw(p.x, p.z, player.heading, traffic.positions(), extras);
      worldMap.setState(p.x, p.z, player.heading, extras);
    }
    audio.update(player.speed, controls.throttle, player.skidAmount, player.drift.boosting);
    fx.render();

    const t = traffic.stats();
    window.__game = {
      simTime,
      x: p.x,
      y: p.y,
      z: p.z,
      car: player.tuning.name,
      speedKmh: player.speed * 3.6,
      forwardSpeed: player.forwardSpeed,
      heading: player.heading,
      slip: player.slip,
      upY: player.up.y,
      wheelsInContact: player.wheelsInContact,
      drifting: player.drift.drifting,
      meter: player.drift.meter,
      boosting: player.drift.boosting,
      trafficActive: t.active,
      trafficMoving: t.moving,
      trafficWrecked: t.wrecked,
      trafficAvgSpeed: t.avgSpeed,
      crashed: crash !== null,
      wrecked: wreck !== null,
      health: player.health,
      event: events.running ? `${events.running.def.id}:${events.running.phase}` : '',
      takedowns: events.running?.takedowns ?? 0,
      rivals: rivals.rivals.length,
      rivalsWrecked: rivals.rivals.filter((r) => r.wrecked).length,
      rivalAvgSpeed: rivals.rivals.reduce((sum, r) => sum + r.car.speed, 0) / Math.max(1, rivals.rivals.length),
      rivalProgress: rivals.rivals.reduce((sum, r) => sum + r.s, 0) / Math.max(1, rivals.rivals.length),
      camMode: cam.mode,
      stuntScore: stunts.score,
      ...nearestRival(),
      eventsDone: events.completed,
    };
    requestAnimationFrame(frame);
  };

  document.getElementById('loading')!.classList.add('hidden');
  requestAnimationFrame(frame);
  // Fetch the other cars' full models in the background so switching is instant
  for (let i = 1; i < GARAGE.length; i++) await ensureHero(i);
}

main();
