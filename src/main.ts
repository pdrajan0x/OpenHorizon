import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import './style.css';
import { Atmosphere } from './atmosphere';
import { CarAudio } from './audio';
import { ChaseCamera, type Clearance } from './camera';
import { Car } from './car';
import { City, LANES, LOT_CENTER, ROAD, roadPose, streetAt } from './city';
import { SkidMarks } from './effects';
import { Hud } from './hud';
import { Input } from './input';
import { Minimap } from './minimap';
import { PostFX } from './postfx';
import { Traffic } from './traffic';
import { GARAGE } from './tuning';

const FIXED_DT = 1 / 60;
const MAX_STEPS_PER_FRAME = 4;
const REAR_WHEELS = [2, 3];
const UPSIDE_DOWN_RESET_SECONDS = 2;
const TRAFFIC_CARS = 36;

// Read by scripts/smoke.mjs and scripts/bench.mjs
declare global {
  interface Window {
    __game?: Record<string, number | boolean | string>;
  }
}

async function main(): Promise<void> {
  await RAPIER.init();
  // Test hooks: ?traffic=0 for an empty city, ?spawn=lot to start in the open lot
  const params = new URLSearchParams(location.search);

  const canvas = document.getElementById('game') as HTMLCanvasElement;
  const renderer = new THREE.WebGLRenderer({ canvas, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;

  const scene = new THREE.Scene();
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = FIXED_DT;

  const city = new City(scene, world);
  const atmosphere = new Atmosphere(scene);
  atmosphere.captureEnvironment(renderer, scene, new THREE.Vector3(0, 25, 0));

  const spawn = params.get('spawn') === 'lot'
    ? { position: LOT_CENTER.clone().add(new THREE.Vector3(-40, 0.3, 0)), yaw: 0 }
    : { position: new THREE.Vector3(streetAt(3) + ROAD / 2 + 12, 0.3, streetAt(5) + LANES[1]), yaw: 0 };
  let carIndex = 0;
  let player = new Car(world, scene, GARAGE[carIndex], spawn.position, spawn.yaw, true);
  const traffic = new Traffic(world, scene, params.get('traffic') === '0' ? 0 : TRAFFIC_CARS);
  const cam = new ChaseCamera();
  // Dim fill light riding with the camera, so the player car's rear isn't a black silhouette
  cam.camera.add(new THREE.PointLight(0xa8b8ff, 30, 16, 1.5));
  scene.add(cam.camera);
  const fx = new PostFX(renderer, scene, cam.camera);
  const skids = new SkidMarks(scene);
  const input = new Input();
  const hud = new Hud();
  const minimap = new Minimap(document.getElementById('minimap') as HTMLCanvasElement, city.blocks);
  const audio = new CarAudio();
  hud.showCar(player);

  const resize = () => {
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    fx.setSize(window.innerWidth, window.innerHeight);
    cam.camera.aspect = window.innerWidth / window.innerHeight;
    cam.camera.updateProjectionMatrix();
  };
  window.addEventListener('resize', resize);
  resize();

  // Only building-sized boxes block the camera; poles and cars don't
  const ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
  const dir = new THREE.Vector3();
  const blocksView = (c: RAPIER.Collider) => c.shapeType() === RAPIER.ShapeType.Cuboid && (c.halfExtents()?.y ?? 0) > 1;
  const clearance: Clearance = (from, to) => {
    const length = dir.subVectors(to, from).length();
    ray.origin = from;
    ray.dir = dir.divideScalar(length);
    const hit = world.castRay(ray, length, true, RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC, undefined, undefined, undefined, blocksView);
    return hit ? hit.timeOfImpact : Infinity;
  };

  const resetPlayer = () => {
    const p = player.body.translation();
    const pose = roadPose(p.x, p.z, player.heading);
    player.reset(pose.position, pose.yaw);
    skids.breakAll();
    cam.snap();
  };

  const switchCar = (index: number) => {
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
    if (actions.car !== null && actions.car !== carIndex) switchCar(actions.car);
    if (actions.reset) resetPlayer();
    if (actions.camera) cam.toggle();
    if (actions.fps) hud.toggleFps();
    if (actions.help) hud.toggleHelp();

    accumulator += dt;
    let steps = 0;
    while (accumulator >= FIXED_DT && steps < MAX_STEPS_PER_FRAME) {
      const p = player.body.translation();
      playerPos.set(p.x, p.y, p.z);
      player.fixedUpdate(controls, FIXED_DT);
      traffic.fixedUpdate(FIXED_DT, simTime, playerPos);
      world.step();
      traffic.postStep(simTime);
      for (const [id, wheel] of REAR_WHEELS.entries()) {
        skids.update(id, player.skidAmount > 0.3 ? player.contactPoint(wheel, contact) : null);
      }
      simTime += FIXED_DT;
      accumulator -= FIXED_DT;
      steps++;
    }
    if (steps === MAX_STEPS_PER_FRAME) accumulator = 0; // running slow: drop time rather than spiral

    const p = player.body.translation();
    playerPos.set(p.x, p.y, p.z);
    upsideDown = player.up.y < 0.3 && player.speed < 3 ? upsideDown + dt : 0;
    if (upsideDown > UPSIDE_DOWN_RESET_SECONDS || p.y < -20) {
      resetPlayer();
      upsideDown = 0;
    }

    city.update(simTime);
    traffic.update(simTime, playerPos);
    player.syncVisuals();
    cam.update(dt, player, clearance);
    atmosphere.update(simTime, cam.camera.position);

    fps.frames++;
    if (now - fps.since > 500) {
      const perSecond = (fps.frames * 1000) / (now - fps.since);
      fps.text = `${perSecond.toFixed(0)} fps · ${(1000 / perSecond).toFixed(1)} ms`;
      fps.frames = 0;
      fps.since = now;
    }
    hud.update(dt, player, fps.text);
    if (frameCount++ % 2 === 0) minimap.draw(p.x, p.z, player.heading, traffic.positions());
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
    };
    requestAnimationFrame(frame);
  };

  document.getElementById('loading')!.classList.add('hidden');
  requestAnimationFrame(frame);
}

main();
