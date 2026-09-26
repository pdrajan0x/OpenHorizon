import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import './style.css';
import { Atmosphere } from './atmosphere';
import { CarAudio } from './audio';
import { ChaseCamera, type Clearance } from './camera';
import { Car } from './car';
import { SkidMarks, Sparks } from './effects';
import { Events, makeEvents } from './events';
import { Hud } from './hud';
import { Input, type Controls } from './input';
import { Minimap } from './minimap';
import { PostFX } from './postfx';
import { RivalPack, type Rival } from './rivals';
import { GameMap } from './map';
import { Stunts } from './stunts';
import { Traffic } from './traffic';
import { ensureHero, loadGarage, loadTrafficModels } from './garage';
import { GARAGE } from './tuning';

const FIXED_DT = 1 / 60;
const MAX_STEPS_PER_FRAME = 4;
const REAR_WHEELS = [2, 3];
const UPSIDE_DOWN_RESET_SECONDS = 2;
const TRAFFIC_CARS = 24;
const DENT_DV = 3; // m/s of velocity change in one step that leaves a mark on the body
const CRASH_SECONDS = 2.6; // real seconds of crash cam before driving on
const CRASH_SLOW_SECONDS = 1.6;
const CRASH_TIME_SCALE = 0.3;
const TAKEDOWN_SLOW_SECONDS = 0.7;
const TAKEDOWN_TIME_SCALE = 0.4;
const HELD: Controls = { throttle: 0, brake: 1, steer: 0, handbrake: false, boost: false };
const LIMP: Controls = { throttle: 0, brake: 0, steer: 0, handbrake: false, boost: false };

// Read by scripts/smoke.mjs and scripts/bench.mjs
declare global {
  interface Window {
    __game?: Record<string, number | boolean | string>;
    __debug?: Record<string, unknown>; // live game objects for test scripts, with ?debug
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
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;

  const scene = new THREE.Scene();
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = FIXED_DT;

  // The city: a GTA V map mod (?map=<id> picks another converted map)
  const map = await GameMap.load(params.get('map') ?? 'chicago', world);
  scene.add(map.root);
  const atmosphere = new Atmosphere(scene);

  // ?spawn=<event id> starts inside that event's start ring
  const spawnParam = params.get('spawn') ?? '';
  const eventDefs = makeEvents(map.roads, map.spawn);
  const spawnEvent = eventDefs.find((e) => e.id === spawnParam);
  const spawnAt = spawnEvent ? map.roads.nodes[spawnEvent.at] : map.spawn;
  const spawn = map.roads.roadPose(spawnAt.x, spawnAt.z, 0);
  await map.prime(spawn.position);
  atmosphere.captureEnvironment(renderer, scene, spawn.position.clone().setY(spawn.position.y + 25));
  let carIndex = 0;
  let player = new Car(world, scene, GARAGE[carIndex], spawn.position, spawn.yaw, true);
  const trafficCount = params.get('traffic') === '0' ? 0 : TRAFFIC_CARS;
  const traffic = new Traffic(world, scene, map.roads, trafficCount ? await loadTrafficModels() : [], trafficCount);
  const cam = new ChaseCamera();
  // Dim fill light riding with the camera, so the player car's rear isn't a black silhouette
  cam.camera.add(new THREE.PointLight(0xa8b8ff, 30, 16, 1.5));
  scene.add(cam.camera);
  const fx = new PostFX(renderer, scene, cam.camera);
  const skids = new SkidMarks(scene);
  const sparks = new Sparks(scene);
  const stunts = new Stunts((x, z, fx, fz) => map.roads.laneOffset(x, z, fx, fz));
  const rivals = new RivalPack(world, scene, map.roads);
  const input = new Input();
  const hud = new Hud();
  const minimap = new Minimap(document.getElementById('minimap') as HTMLCanvasElement, map.roads);
  const audio = new CarAudio();
  const events = new Events(scene, hud, audio, map.roads, eventDefs);
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

  let switching = false;
  const switchCar = async (index: number) => {
    if (switching || index >= GARAGE.length) return;
    switching = true;
    await ensureHero(index);
    switching = false;
    if (events.running || crash) return;
    const p = player.body.translation();
    const v = player.body.linvel();
    const old = player;
    player = new Car(world, scene, GARAGE[index], new THREE.Vector3(p.x, p.y + 0.1, p.z), -old.heading, true);
    player.body.setLinvel(v, true);
    old.dispose(world, scene);
    carIndex = index;
    skids.breakAll();
    hud.showCar(player);
  };

  // Crash: slow-motion orbit of the wreck, then back on the road still rolling
  let crash: { t: number; speed: number; heading: number } | null = null;
  let takedownSlow = 0;
  const startCrash = (speed: number) => {
    crash = { t: 0, speed, heading: player.heading };
    player.drift.crashed();
    const p = player.body.translation();
    sparks.burst(new THREE.Vector3(p.x, p.y + 0.6, p.z).addScaledVector(player.forward, 2), player.forward.clone().negate(), 90, 10);
    audio.crash(Math.min(1, speed / 40));
    hud.banner('CRASH', '', 'crash', 1.8);
  };
  const endCrash = () => {
    const c = crash!;
    const p = player.body.translation();
    // Back on the road a little behind the wreck, facing the way we were going unless that's a wall
    const respawnPose = (heading: number, shift: number) => {
      const pose = map.roads.roadPose(p.x, p.z, heading);
      const fwd = new THREE.Vector3(Math.cos(pose.yaw), 0, -Math.sin(pose.yaw));
      pose.position.addScaledVector(fwd, shift);
      const eye = pose.position.clone().setY(pose.position.y + 0.5);
      return { ...pose, fwd, clear: clearance(eye, eye.clone().addScaledVector(fwd, 40)) };
    };
    let pose = respawnPose(c.heading, -8);
    if (pose.clear < 40) pose = respawnPose(c.heading + Math.PI, 8); // dead end: turn around, away from the wall
    place(pose.position, pose.yaw);
    player.damage.repair(); // Burnout hands you a fresh car after a crash
    const v = Math.max(12, c.speed * 0.5);
    player.body.setLinvel({ x: pose.fwd.x * v, y: 0, z: pose.fwd.z * v }, true);
    crash = null;
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

    const { controls, actions } = input.update(dt);
    if (actions.car !== null && actions.car !== carIndex && !events.running && !crash) void switchCar(actions.car);
    if (actions.reset && !crash) resetPlayer();
    if (actions.camera) cam.toggle();
    if (actions.fps) hud.toggleFps();
    if (actions.help) hud.toggleHelp();

    const frozen = events.update(dt, { player, controls, quit: actions.quit, stunts, rivals, traffic, place });
    const drive = crash ? LIMP : frozen ? HELD : controls;
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
      if (hit > DENT_DV) player.applyDamage(world, hit);
      if (!crash && !frozen) {
        const shielded = rivals.rivals.some((r) => r.touchingPlayer(simTime));
        if (stunts.step(player, simTime, speedBefore, h, shielded)) startCrash(speedBefore);
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
    upsideDown = player.up.y < 0.3 && player.speed < 3 && !crash ? upsideDown + dt : 0;
    const fellThrough = p.y < map.roads.nodes[map.roads.nearestNode(p.x, p.z)].y - 20;
    if (upsideDown > UPSIDE_DOWN_RESET_SECONDS || fellThrough) {
      resetPlayer();
      upsideDown = 0;
    }
    if (!crash) {
      stunts.nearMisses(player, [...traffic.nearby(p.x, p.z, 20), ...rivals.agents()], simTime);
    }
    for (const n of stunts.notes) if (n.kind !== 'crash') hud.note(n.text, n.kind);
    stunts.notes.length = 0;

    map.update(cam.camera.position, [playerPos, ...rivals.rivals.map((r) => {
      const q = r.car.body.translation();
      return new THREE.Vector3(q.x, q.y, q.z);
    })]);
    traffic.update(simTime, playerPos);
    player.syncVisuals();
    rivals.syncVisuals();
    sparks.update(dt * timeScale);
    if (crash) {
      cam.crash(crash.t, player, clearance);
      crash.t += dt;
      if (crash.t > CRASH_SECONDS) endCrash();
    } else {
      cam.update(dt, player, clearance);
    }
    atmosphere.update(simTime, cam.camera.position);

    fps.frames++;
    if (now - fps.since > 500) {
      const perSecond = (fps.frames * 1000) / (now - fps.since);
      fps.text = `${perSecond.toFixed(0)} fps · ${(1000 / perSecond).toFixed(1)} ms`;
      fps.frames = 0;
      fps.since = now;
    }
    hud.update(dt, player, fps.text);
    hud.setProgress(`EVENTS ${events.completed}/${events.defs.length}`);
    if (frameCount++ % 2 === 0) {
      minimap.draw(p.x, p.z, player.heading, traffic.positions(), {
        events: events.mapMarkers(),
        rivals: rivals.rivals.map((r) => {
          const q = r.car.body.translation();
          return new THREE.Vector3(q.x, q.y, q.z);
        }),
        route: events.gps(),
        destination: events.destination(),
      });
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
      event: events.running ? `${events.running.def.id}:${events.running.phase}` : '',
      takedowns: events.running?.takedowns ?? 0,
      rivals: rivals.rivals.length,
      rivalsWrecked: rivals.rivals.filter((r) => r.wrecked).length,
      rivalAvgSpeed: rivals.rivals.reduce((sum, r) => sum + r.car.speed, 0) / Math.max(1, rivals.rivals.length),
      rivalProgress: rivals.rivals.reduce((sum, r) => sum + r.s, 0) / Math.max(1, rivals.rivals.length),
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
