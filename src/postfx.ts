import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

// Only HDR-bright surfaces cross the threshold: at night light bars, neon and lit windows; by day,
// when sunlit concrete is already bright, only the sun's glints and lamps
export interface Bloom {
  strength: number;
  radius: number;
  threshold: number;
}
const NIGHT_BLOOM: Bloom = { strength: 0.85, radius: 0.4, threshold: 0.9 };

/** Scene render → bloom (half resolution internally) → tone mapping + sRGB output. */
export class PostFX {
  private readonly composer: EffectComposer;

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, bloom: Bloom = NIGHT_BLOOM) {
    this.composer = new EffectComposer(renderer);
    this.composer.addPass(new RenderPass(scene, camera));
    this.composer.addPass(new UnrealBloomPass(new THREE.Vector2(256, 256), bloom.strength, bloom.radius, bloom.threshold));
    this.composer.addPass(new OutputPass());
  }

  setSize(width: number, height: number): void {
    this.composer.setSize(width, height);
  }

  render(): void {
    this.composer.render();
  }
}

/** A dark studio lined with neon strips, for reflections when there's no city to capture. */
export function neonStudioEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x05050a);
  const strip = (color: number, intensity: number, w: number, h: number, pos: [number, number, number], rotY = 0) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(intensity), side: THREE.DoubleSide }));
    m.position.set(...pos);
    m.rotation.y = rotY;
    scene.add(m);
  };
  strip(0xffffff, 3, 14, 1.2, [0, 6, 0]); // overhead softbox
  scene.children.at(-1)!.rotation.x = Math.PI / 2;
  strip(0xff2bd6, 2.5, 10, 0.5, [0, 2.5, -8]);
  strip(0x00e5ff, 2.5, 10, 0.5, [0, 2.5, 8]);
  strip(0x7a5cff, 1.8, 0.5, 6, [-9, 3, 0], Math.PI / 2);
  strip(0xffb347, 1.2, 0.5, 6, [9, 3, 0], Math.PI / 2);
  const env = new THREE.PMREMGenerator(renderer).fromScene(scene, 0.02).texture;
  return env;
}
