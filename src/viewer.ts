// Dev page for converted mod cars: viewer.html?car=quadra&view=front|side|rear|top&paint=0xd02a38
import * as THREE from 'three';
import { loadModCar, modCarVisual } from './modcar';
import { neonStudioEnvironment, PostFX } from './postfx';

const params = new URLSearchParams(location.search);
const name = params.get('car') ?? 'quadra';
const view = params.get('view') ?? 'front';
const paint = Number(params.get('paint') ?? 0xd02a38);

const canvas = document.getElementById('game') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.toneMapping = THREE.ACESFilmicToneMapping;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x07070d);
scene.environment = neonStudioEnvironment(renderer);
scene.environmentIntensity = 1.4;
const floor = new THREE.Mesh(
  new THREE.CircleGeometry(30, 64).rotateX(-Math.PI / 2),
  new THREE.MeshStandardMaterial({ color: 0x101018, roughness: 0.2, metalness: 0.4 }),
);
scene.add(floor);
const key = new THREE.SpotLight(0xffffff, 180, 40, 0.8, 0.5);
key.position.set(4, 9, 5);
scene.add(key, new THREE.HemisphereLight(0x8090ff, 0x100010, 0.8));

const camera = new THREE.PerspectiveCamera(35, window.innerWidth / window.innerHeight, 0.1, 100);
const views: Record<string, [number, number, number]> = {
  front: [6.5, 1.6, 4.5],
  side: [0.2, 1.2, 8.5],
  rear: [-6.5, 1.8, -4.2],
  top: [0.01, 11, 0],
  cockpit: [0, 0, 0],
};
camera.position.set(...(views[view] ?? views.front));
camera.lookAt(0, 0.55, 0);
const fx = new PostFX(renderer, scene, camera);
fx.setSize(window.innerWidth, window.innerHeight);

const car = modCarVisual(await loadModCar(`/mods/cars/${name}.glb`), { paint });
scene.add(car.root);
if (params.has('brake')) car.setBraking(true);
if (view === 'cockpit') {
  camera.position.copy(car.eye);
  camera.lookAt(car.eye.x + 10, car.eye.y - 0.5, car.eye.z);
}
(window as Window & { __info?: unknown }).__info = {
  wheelRadius: car.wheelRadius,
  wheels: car.wheels.map((w) => w.center.toArray().map((v) => +v.toFixed(3))),
  chassisCenter: car.chassisCenter.toArray().map((v) => +v.toFixed(3)),
  chassisHalf: car.chassisHalf.toArray().map((v) => +v.toFixed(3)),
};
let frames = 0;
renderer.setAnimationLoop(() => {
  fx.render();
  if (++frames === 3) (window as Window & { __ready?: boolean }).__ready = true;
});
