// Dev page for looking at car designs: showroom.html?car=vesperNyx&view=front|side|rear|top
import * as THREE from 'three';
import { buildCar, DESIGNS } from './carModel';
import { neonStudioEnvironment, PostFX } from './postfx';

const params = new URLSearchParams(location.search);
const name = (params.get('car') ?? 'vesperNyx') as keyof typeof DESIGNS;
const view = params.get('view') ?? 'front';
const paint = Number(params.get('paint') ?? 0x2a48d8);
const underglow = params.has('glow') ? Number(params.get('glow')) : undefined;

const canvas = document.getElementById('game') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = true;

const scene = new THREE.Scene();
scene.background = new THREE.Color(params.has('light') ? 0x9aa0aa : 0x07070d);
scene.environment = neonStudioEnvironment(renderer);

const floor = new THREE.Mesh(
  new THREE.CircleGeometry(30, 64).rotateX(-Math.PI / 2),
  new THREE.MeshStandardMaterial({ color: params.has('light') ? 0x6a6e76 : 0x101018, roughness: 0.18, metalness: 0.4 }),
);
floor.receiveShadow = true;
scene.add(floor);
const key = new THREE.SpotLight(0xffffff, 180, 40, 0.8, 0.5);
key.position.set(4, 9, 5);
key.castShadow = true;
const fill = new THREE.DirectionalLight(0xb0c0ff, 1.2);
fill.position.set(-6, 4, -3);
scene.add(key, fill, new THREE.HemisphereLight(0x8090ff, 0x100010, 0.8));
scene.environmentIntensity = 1.6;

const car = buildCar(DESIGNS[name], { paint, underglow, lightLevel: 1 });
for (const w of car.wheels) w.steer.position.copy(w.center);
scene.add(car.root);
if (params.has('debug')) {
  // Color-code body regions: paint red, glass cyan, trim green
  const body = car.root.children[0] as THREE.Mesh;
  body.material = [0xd02020, 0x20c0d0, 0x20a040].map((c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.6 }));
}

const camera = new THREE.PerspectiveCamera(35, window.innerWidth / window.innerHeight, 0.1, 100);
const views: Record<string, [number, number, number]> = {
  front: [6.5, 1.6, 4.5],
  side: [0.2, 1.2, 8.5],
  rear: [-6.5, 1.8, -4.2],
  top: [0.01, 11, 0],
};
camera.position.set(...(views[view] ?? views.front));
camera.lookAt(0, 0.55, 0);

const fx = new PostFX(renderer, scene, camera);
fx.setSize(window.innerWidth, window.innerHeight);
let frames = 0;
renderer.setAnimationLoop(() => {
  fx.render();
  if (++frames === 3) (window as Window & { __ready?: boolean }).__ready = true;
});
