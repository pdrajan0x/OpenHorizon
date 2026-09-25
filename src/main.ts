import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import './style.css';
import { CarAudio } from './audio';
import { ChaseCamera } from './camera';
import { Car } from './car';
import { SkidMarks } from './effects';
import { Environment } from './environment';
import { Hud } from './hud';
import { Input } from './input';
import { LapTimer } from './laps';
import { Track } from './track';
import { VESPER_GT } from './tuning';

const FIXED_DT = 1 / 60;
const MAX_STEPS_PER_FRAME = 4;
const REAR_WHEELS = [2, 3];
const UPSIDE_DOWN_RESET_SECONDS = 2;

// Read by scripts/smoke.mjs
declare global {
  interface Window {
    __game?: Record<string, number | boolean>;
  }
}

async function main(): Promise<void> {
  await RAPIER.init();

  const canvas = document.getElementById('game') as HTMLCanvasElement;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;

  const scene = new THREE.Scene();
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = FIXED_DT;

  const track = new Track(scene);
  const env = new Environment(scene, world, track);
  const spawn = track.spawnAt(0);
  const car = new Car(world, scene, VESPER_GT, spawn.position, spawn.yaw);
  const cam = new ChaseCamera();
  const skids = new SkidMarks(scene);
  const input = new Input();
  const hud = new Hud();
  const laps = new LapTimer(track.samples.length);
  const audio = new CarAudio();

  const resize = () => {
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    cam.camera.aspect = window.innerWidth / window.innerHeight;
    cam.camera.updateProjectionMatrix();
  };
  window.addEventListener('resize', resize);
  resize();

  let trackIndex = 0;
  let offroad = false;
  let simTime = 0;
  let accumulator = 0;
  let upsideDown = 0;
  let last = performance.now();
  const fps = { frames: 0, since: last, text: '' };
  const contact = new THREE.Vector3();
  const carPos = new THREE.Vector3();

  const resetToRoad = () => {
    const s = track.spawnAt(trackIndex);
    car.reset(s.position, s.yaw);
    skids.breakAll();
    cam.snap();
  };

  const frame = (now: number) => {
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;

    const { controls, actions } = input.update(dt);
    if (actions.reset) resetToRoad();
    if (actions.camera) cam.toggle();
    if (actions.fps) hud.toggleFps();
    if (actions.help) hud.toggleHelp();
    if (!laps.running && controls.throttle > 0) laps.start();

    accumulator += dt;
    let steps = 0;
    while (accumulator >= FIXED_DT && steps < MAX_STEPS_PER_FRAME) {
      const p = car.body.translation();
      const near = track.nearest(p.x, p.z);
      trackIndex = near.index;
      offroad = track.isOffroad(near.lateral);

      car.fixedUpdate(controls, FIXED_DT, offroad);
      world.step();

      for (const [id, wheel] of REAR_WHEELS.entries()) {
        skids.update(id, car.skidAmount > 0.3 ? car.contactPoint(wheel, contact) : null);
      }
      laps.update(FIXED_DT, trackIndex);
      simTime += FIXED_DT;
      accumulator -= FIXED_DT;
      steps++;
    }
    if (steps === MAX_STEPS_PER_FRAME) accumulator = 0; // running slow: drop time rather than spiral

    // Recover when stuck on the roof or off the world
    const p = car.body.translation();
    upsideDown = car.up.y < 0.3 && car.speed < 3 ? upsideDown + dt : 0;
    if (upsideDown > UPSIDE_DOWN_RESET_SECONDS || p.y < -20) {
      resetToRoad();
      upsideDown = 0;
    }

    car.syncVisuals();
    env.syncCones();
    env.followSun(carPos.set(p.x, p.y, p.z));
    cam.update(dt, car);

    fps.frames++;
    if (now - fps.since > 500) {
      const perSecond = (fps.frames * 1000) / (now - fps.since);
      fps.text = `${perSecond.toFixed(0)} fps · ${(1000 / perSecond).toFixed(1)} ms`;
      fps.frames = 0;
      fps.since = now;
    }
    hud.update(dt, car, laps, offroad, fps.text);
    audio.update(car.speed, controls.throttle, car.skidAmount, car.drift.boosting);
    renderer.render(scene, cam.camera);

    window.__game = {
      simTime,
      x: p.x,
      y: p.y,
      z: p.z,
      speedKmh: car.speed * 3.6,
      forwardSpeed: car.forwardSpeed,
      heading: car.heading,
      slip: car.slip,
      upY: car.up.y,
      wheelsInContact: car.wheelsInContact,
      drifting: car.drift.drifting,
      meter: car.drift.meter,
      boosting: car.drift.boosting,
      offroad,
      trackIndex,
    };
    requestAnimationFrame(frame);
  };

  document.getElementById('loading')!.classList.add('hidden');
  requestAnimationFrame(frame);
}

main();
