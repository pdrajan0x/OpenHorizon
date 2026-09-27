// Live reflections for the player's car: a cube camera at the car renders the city around it, one face
// every EVERY frames (a full refresh about every third of a second), and the car's paint, glass and chrome reflect that
// instead of the sky alone, so the buildings, the road and the other cars slide over the body as it
// drives. The car itself is hidden while a face renders; the sun's shadow map isn't redrawn for it.
import * as THREE from 'three';

const SIZE = 128; // px per cube face: a car's curved panels blur what they reflect anyway
const NEAR = 0.3;
const FAR = 220; // m: the nearby city is what shows in a car's panels
const EVERY = 3; // frames per face

export class CarReflections {
  readonly texture: THREE.CubeTexture;
  private readonly target: THREE.WebGLCubeRenderTarget;
  private readonly cube: THREE.CubeCamera;
  private face = 0;
  private frame = 0;

  constructor() {
    this.target = new THREE.WebGLCubeRenderTarget(SIZE, { type: THREE.HalfFloatType, generateMipmaps: false });
    this.cube = new THREE.CubeCamera(NEAR, FAR, this.target);
    this.texture = this.target.texture;
  }

  /** Render the next face from `at` (the car's roof), with `hide` (the car) out of the picture. */
  update(renderer: THREE.WebGLRenderer, scene: THREE.Scene, at: THREE.Vector3, hide: THREE.Object3D): void {
    if (this.frame++ % EVERY !== 0) return;
    const cube = this.cube;
    if (this.face === 0) {
      cube.position.copy(at);
      cube.updateMatrixWorld(true);
    }
    if (cube.coordinateSystem !== renderer.coordinateSystem) {
      cube.coordinateSystem = renderer.coordinateSystem;
      cube.updateCoordinateSystem();
    }
    const camera = cube.children[this.face] as THREE.PerspectiveCamera;
    const previous = renderer.getRenderTarget();
    const shadows = renderer.shadowMap.autoUpdate;
    const wasVisible = hide.visible;
    renderer.shadowMap.autoUpdate = false;
    hide.visible = false;
    renderer.setRenderTarget(this.target, this.face);
    renderer.render(scene, camera);
    renderer.setRenderTarget(previous);
    hide.visible = wasVisible;
    renderer.shadowMap.autoUpdate = shadows;
    this.face = (this.face + 1) % 6;
    // A whole new cube: have the materials' blurred (rough) reflections rebuilt from it
    if (this.face === 0) this.texture.needsPMREMUpdate = true;
  }

  /** Point a car's reflective materials at the live cube. */
  apply(root: THREE.Object3D): void {
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        const std = m as THREE.MeshStandardMaterial;
        if (!std.isMeshStandardMaterial) continue;
        std.envMap = this.texture;
        std.envMapIntensity = std.transparent ? 1.5 : (std as THREE.MeshPhysicalMaterial).clearcoat ? 1.1 : 0.9;
        std.needsUpdate = true;
      }
    });
  }
}

/** A soft dark patch under a car where the body shades the road (the sun's shadow alone is too faint). */
export function contactShadow(length: number, width: number): THREE.Mesh {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(64, 64, 8, 64, 64, 64);
  grad.addColorStop(0, 'rgba(0,0,0,0.75)');
  grad.addColorStop(0.55, 'rgba(0,0,0,0.45)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const texture = new THREE.CanvasTexture(c);
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(length * 1.25, width * 1.45).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({
      map: texture, transparent: true, depthWrite: false, opacity: 0.85,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
    }),
  );
  mesh.renderOrder = 1;
  mesh.name = 'contact-shadow';
  return mesh;
}
