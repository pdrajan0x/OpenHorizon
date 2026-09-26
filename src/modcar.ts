// Cars converted from GTA V mods (tools/gta5conv → public/mods/cars/*.glb). A converted car is a
// glTF scene in the game's frame with one node per part (named after GTA bones: chassis, bonnet,
// headlight_l…) and wheel_lf/rf/lr/rr nodes at the hubs. Materials carry the GTA shader in extras
// (paint slot, glass, emissive). This turns one into the CarVisual the physics and camera expect.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

/** Physics-relevant measurements of a car model. */
export interface CarShape {
  wheelRadius: number;
  chassisCenter: THREE.Vector3;
  chassisHalf: THREE.Vector3;
}

export interface CarVisual extends CarShape {
  root: THREE.Group;
  /** Front-left, front-right, rear-left, rear-right. `center` is the wheel center at ride height. */
  wheels: { steer: THREE.Group; spin: THREE.Group; center: THREE.Vector3 }[];
  /** Driver's-eye point for the cockpit camera. */
  eye: THREE.Vector3;
  setBraking(on: boolean): void;
}

export interface CarLook {
  paint: number;
  rim?: number; // wheel color
}

const WHEELS = ['wheel_lf', 'wheel_rf', 'wheel_lr', 'wheel_rr']; // Car's order: FL, FR, RL, RR
const BRAKE_PARTS = /taillight|brakelight/;
const HEAD_PARTS = /headlight/;
const RIM_COLOR = 0x1a1b1e;
const TRIM_COLOR = 0x151518;

export interface Template {
  scene: THREE.Group;
  wheelRadius: number;
  lift: number; // raises the model so the wheels sit on y = 0
  pivots: Record<string, [number, number, number]>;
}

const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
const cache = new Map<string, Promise<Template>>();

/** Load (once) and prepare a converted car. */
export function loadModCar(url: string): Promise<Template> {
  let p = cache.get(url);
  if (!p) {
    p = loader.loadAsync(url).then((gltf) => {
      const scene = gltf.scene;
      const root = scene.children[0];
      const extras = (root.userData ?? {}) as { wheels?: { position: number[]; radius: number }[]; pivots?: Template['pivots'] };
      const wheels = extras.wheels ?? [];
      const wheelRadius = wheels.length ? Math.max(...wheels.map((w) => w.radius)) : 0.35;
      const lowestHub = wheels.length ? Math.min(...wheels.map((w) => w.position[1])) : 0;
      return { scene, wheelRadius, lift: wheelRadius - lowestHub, pivots: extras.pivots ?? {} };
    });
    cache.set(url, p);
  }
  return p;
}

/** A drivable visual from a loaded template: own materials (for paint and lights), shared geometry. */
export function modCarVisual(t: Template, look: CarLook): CarVisual {
  const root = new THREE.Group();
  const model = t.scene.clone(true);
  model.position.y = t.lift;
  root.add(model);
  model.updateMatrixWorld(true);

  const paint = new THREE.MeshPhysicalMaterial({
    color: look.paint, metalness: 0.6, roughness: 0.32, clearcoat: 1, clearcoatRoughness: 0.06,
  });
  const brake: THREE.MeshStandardMaterial[] = [];
  const materials = new Map<THREE.Material, THREE.Material>();
  const rim = new THREE.MeshStandardMaterial({ color: look.rim ?? RIM_COLOR, metalness: 0.9, roughness: 0.28 });
  const swap = (m: THREE.Material, part: string): THREE.Material => {
    const x = (m.userData ?? {}) as { shader?: string; paint?: number; glass?: boolean; emissive?: boolean; average?: number[] };
    // Light textures on the tire shader are rim parts GTA tints with the wheel color
    if (x.shader === 'vehicle_tire' && x.average && (x.average[0] + x.average[1] + x.average[2]) / 3 > 0.45) return rim;
    if (x.paint !== undefined) {
      if (x.paint <= 3) return paint;
      return x.paint === 4 ? rim : new THREE.MeshStandardMaterial({ color: TRIM_COLOR, metalness: 0.7, roughness: 0.35 });
    }
    const std = m as THREE.MeshStandardMaterial;
    if (x.glass) {
      const g = std.clone();
      g.transparent = true;
      g.opacity = Math.min(g.opacity, 0.55);
      g.color.multiplyScalar(0.35);
      g.roughness = 0.05;
      g.metalness = 0.2;
      g.depthWrite = false;
      return g;
    }
    if (x.emissive) {
      // Each light part gets its own material so brake lights can brighten independently
      const e = std.clone();
      e.emissiveIntensity = HEAD_PARTS.test(part) ? 2.2 : BRAKE_PARTS.test(part) ? 0.7 : 1;
      if (BRAKE_PARTS.test(part)) brake.push(e);
      return e;
    }
    let shared = materials.get(m);
    if (!shared) {
      shared = std.clone();
      materials.set(m, shared);
    }
    return shared;
  };

  // Part name: the node itself (single-primitive meshes) or its group (multi-primitive)
  const carNode = model.children[0];
  const wheelNodes = new Map<string, THREE.Object3D>();
  model.traverse((o) => {
    if (WHEELS.includes(o.name)) wheelNodes.set(o.name, o);
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const part = mesh.parent && mesh.parent !== carNode ? mesh.parent.name : mesh.name;
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map((m) => swap(m, part)) : swap(mesh.material, part);
  });

  // Re-hang each wheel under steer → spin groups centered on its hub, as the physics sync expects
  const wheels = WHEELS.map((name) => {
    const node = wheelNodes.get(name);
    const center = new THREE.Vector3();
    const steer = new THREE.Group();
    const spin = new THREE.Group();
    steer.add(spin);
    root.add(steer);
    if (node) {
      node.getWorldPosition(center);
      spin.add(node);
      node.position.set(0, 0, 0);
    }
    steer.position.copy(center);
    return { steer, spin, center };
  });

  // Chassis box from the body (wheels are no longer under the model)
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const bottom = Math.max(box.min.y, t.wheelRadius * 0.7);
  const chassisHalf = new THREE.Vector3(size.x / 2 - 0.05, (box.max.y - 0.08 - bottom) / 2, size.z / 2 - 0.05);
  const chassisCenter = new THREE.Vector3((box.min.x + box.max.x) / 2, bottom + chassisHalf.y, (box.min.z + box.max.z) / 2);

  const seat = t.pivots.seat_dside_f;
  const eye = seat
    ? new THREE.Vector3(seat[0], seat[1] + t.lift + 0.72, seat[2])
    : new THREE.Vector3(0, box.max.y - 0.25, -0.35);

  return {
    root,
    wheels,
    eye,
    wheelRadius: t.wheelRadius,
    chassisCenter,
    chassisHalf,
    setBraking(on: boolean) {
      for (const m of brake) m.emissiveIntensity = on ? 3 : 0.7;
    },
  };
}
