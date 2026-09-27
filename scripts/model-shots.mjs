// Screenshots of .glb models on their own, headless: for judging a model (a kit piece, a converted prop)
// before it goes into the game.
//   node scripts/model-shots.mjs <out-dir> <model.glb> [more.glb …]
// Writes <out-dir>/<name>-front.png and <name>-side.png: each model framed whole, lit by a sun and sky,
// on a grey ground, with its size in metres in the corner.
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'vite';
import { launch } from './browser.mjs';

const [out, ...models] = process.argv.slice(2);
if (!out || !models.length) {
  console.error('usage: node scripts/model-shots.mjs <out-dir> <model.glb> [more.glb …]');
  process.exit(1);
}
fs.mkdirSync(out, { recursive: true });
const stage = '.build/model-shots';
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
for (const m of models) fs.copyFileSync(m, `${stage}/${path.basename(m)}`);
fs.writeFileSync(`${stage}/index.html`, `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;background:#9fb3c2;overflow:hidden}#size{position:fixed;left:12px;top:10px;font:15px sans-serif;color:#102030}</style>
<div id="size"></div>
<script type="module">
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9fb3c2);
scene.add(new THREE.HemisphereLight(0xdfefff, 0x6b5f50, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
scene.add(sun);
const camera = new THREE.PerspectiveCamera(40, innerWidth / innerHeight, 0.1, 10000);
window.show = async (file, view) => {
  for (const o of [...scene.children]) if (o.userData.model) scene.remove(o);
  const g = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync(file);
  g.scene.userData.model = true;
  g.scene.traverse((o) => { if (o.isMesh) { o.castShadow = o.receiveShadow = true; } });
  scene.add(g.scene);
  const box = new THREE.Box3().setFromObject(g.scene);
  const size = box.getSize(new THREE.Vector3());
  const c = box.getCenter(new THREE.Vector3());
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x77736c }));
  ground.scale.setScalar(Math.max(size.x, size.z) * 4);
  ground.position.set(c.x, box.min.y - 0.02, c.z);
  ground.receiveShadow = true;
  ground.userData.model = true;
  scene.add(ground);
  const r = size.length() / 2;
  sun.position.set(c.x + r, c.y + r * 1.5, c.z + r * 0.6);
  sun.target.position.copy(c);
  scene.add(sun.target);
  Object.assign(sun.shadow.camera, { left: -r, right: r, top: r, bottom: -r, near: 0.1, far: r * 6 });
  sun.shadow.camera.updateProjectionMatrix();
  const d = r / Math.tan((camera.fov * Math.PI) / 360) * 1.05;
  const dir = view === 'front' ? new THREE.Vector3(0.85, 0.35, 0.45) : new THREE.Vector3(-0.2, 0.25, 1);
  camera.position.copy(c).addScaledVector(dir.normalize(), d);
  camera.near = d / 100;
  camera.far = d * 10;
  camera.updateProjectionMatrix();
  camera.lookAt(c);
  renderer.render(scene, camera);
  document.getElementById('size').textContent = file + ': ' + size.x.toFixed(1) + ' × ' + size.y.toFixed(1) + ' × ' + size.z.toFixed(1) + ' m (x × y up × z)';
};
window.ready = true;
</script>`);
const server = await createServer({ logLevel: 'error', server: { port: 5342 } });
await server.listen();
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log('PAGEERROR', String(e)));
try {
  await page.goto(server.resolvedUrls.local[0] + stage + '/index.html');
  await page.waitForFunction(() => window.ready, null, { timeout: 60_000 });
  for (const m of models) {
    const name = path.basename(m, '.glb');
    for (const view of ['front', 'side']) {
      await page.evaluate(([f, v]) => window.show(f, v), [path.basename(m), view]);
      await page.screenshot({ path: `${out}/${name}-${view}.png` });
    }
    console.log(`${out}/${name}-front.png, -side.png`);
  }
} finally {
  await browser.close();
  await server.close();
}
