import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { ROAD_HALF_WIDTH, type Track } from './track';

const SKY = 0x9cc8e8;
const GROUND_SIZE = 4000;
const GROUND_VISUAL_Y = -0.05; // grass mesh sits below the road so they never z-fight; physics ground is y = 0
const TREE_COUNT = 260;
const TREE_AREA = 700; // trees scatter within ±TREE_AREA
const TREE_ROAD_CLEARANCE = 14;
const RAMP_CLEARANCE = 45;
const CONE_HALF_HEIGHT = 0.36;
const CONE_RADIUS = 0.28;

// Freeroam jumps in the infield: x, z, yaw (rises toward (cos yaw, 0, -sin yaw)), length, width, height
const RAMPS: [number, number, number, number, number, number][] = [
  [-60, -110, 0, 14, 6, 2.6],
  [70, -95, Math.PI, 14, 6, 2.6],
  [0, -150, -Math.PI / 2, 20, 8, 4],
];

interface Cone {
  body: RAPIER.RigidBody;
  mesh: THREE.Mesh;
}

export class Environment {
  readonly sun: THREE.DirectionalLight;
  private readonly cones: Cone[] = [];

  constructor(scene: THREE.Scene, world: RAPIER.World, track: Track) {
    const rng = mulberry32(1337);

    scene.background = new THREE.Color(SKY);
    scene.fog = new THREE.Fog(SKY, 250, 1200);
    scene.add(new THREE.HemisphereLight(0xcfe8ff, 0x4a5a3a, 1.1));

    this.sun = new THREE.DirectionalLight(0xfff3dd, 2.4);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    Object.assign(this.sun.shadow.camera, { left: -40, right: 40, top: 40, bottom: -40, near: 1, far: 220 });
    this.sun.shadow.bias = -0.0005;
    scene.add(this.sun, this.sun.target);

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(GROUND_SIZE, GROUND_SIZE).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ map: grassTexture(GROUND_SIZE / 6), roughness: 1 }),
    );
    ground.position.y = GROUND_VISUAL_Y;
    ground.receiveShadow = true;
    scene.add(ground);
    world.createCollider(RAPIER.ColliderDesc.cuboid(GROUND_SIZE / 2, 1, GROUND_SIZE / 2).setTranslation(0, -1, 0));

    const rampMat = new THREE.MeshStandardMaterial({ color: 0xd9a441, roughness: 0.8 });
    for (const [x, z, yaw, length, width, height] of RAMPS) addRamp(scene, world, rampMat, x, z, yaw, length, width, height);

    this.addTrees(scene, world, track, rng);
    this.addCones(scene, world, track);
  }

  /** Keep the shadow-casting area centered on the car. */
  followSun(target: THREE.Vector3): void {
    this.sun.position.set(target.x + 40, target.y + 80, target.z + 25);
    this.sun.target.position.copy(target);
  }

  syncCones(): void {
    for (const { body, mesh } of this.cones) {
      if (body.isSleeping()) continue;
      const p = body.translation();
      const r = body.rotation();
      mesh.position.set(p.x, p.y, p.z);
      mesh.quaternion.set(r.x, r.y, r.z, r.w);
    }
  }

  private addTrees(scene: THREE.Scene, world: RAPIER.World, track: Track, rng: () => number): void {
    const trunkGeo = new THREE.CylinderGeometry(0.25, 0.35, 3, 6).translate(0, 1.5, 0);
    const leafGeo = new THREE.ConeGeometry(2.2, 6, 7).translate(0, 5.5, 0);
    const trunks = new THREE.InstancedMesh(trunkGeo, new THREE.MeshStandardMaterial({ color: 0x5b4030 }), TREE_COUNT);
    const leaves = new THREE.InstancedMesh(leafGeo, new THREE.MeshStandardMaterial({ color: 0x2f6b34, flatShading: true }), TREE_COUNT);
    trunks.castShadow = leaves.castShadow = true;

    const m = new THREE.Matrix4();
    let placed = 0;
    for (let tries = 0; placed < TREE_COUNT && tries < TREE_COUNT * 20; tries++) {
      const x = (rng() * 2 - 1) * TREE_AREA;
      const z = (rng() * 2 - 1) * TREE_AREA;
      if (track.nearest(x, z).lateral < ROAD_HALF_WIDTH + TREE_ROAD_CLEARANCE) continue;
      if (RAMPS.some(([rx, rz]) => Math.hypot(rx - x, rz - z) < RAMP_CLEARANCE)) continue;
      const s = 0.7 + rng() * 0.8;
      m.compose(new THREE.Vector3(x, 0, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rng() * 6.28), new THREE.Vector3(s, s, s));
      trunks.setMatrixAt(placed, m);
      leaves.setMatrixAt(placed, m);
      world.createCollider(RAPIER.ColliderDesc.cylinder(1.5 * s, 0.35 * s).setTranslation(x, 1.5 * s, z));
      placed++;
    }
    trunks.count = leaves.count = placed;
    scene.add(trunks, leaves);
  }

  /** Knock-over cones along the inside edge of the sharpest corners. */
  private addCones(scene: THREE.Scene, world: RAPIER.World, track: Track): void {
    const geo = new THREE.ConeGeometry(CONE_RADIUS, CONE_HALF_HEIGHT * 2, 12);
    const mat = new THREE.MeshStandardMaterial({ color: 0xff6a13, roughness: 0.6 });
    const side = new THREE.Vector3();
    const n = track.samples.length;
    for (const { index, inside } of track.apexes()) {
      for (const offset of [-5, 0, 5]) {
        const i = (index + offset + n) % n;
        const p = track.samples[i];
        track.sideAt(i, side).multiplyScalar(inside * (ROAD_HALF_WIDTH + 0.6));
        const body = world.createRigidBody(
          RAPIER.RigidBodyDesc.dynamic().setTranslation(p.x + side.x, CONE_HALF_HEIGHT + 0.01, p.z + side.z).setSleeping(true),
        );
        world.createCollider(RAPIER.ColliderDesc.cone(CONE_HALF_HEIGHT, CONE_RADIUS).setDensity(70), body);
        const mesh = new THREE.Mesh(geo, mat);
        mesh.castShadow = true;
        scene.add(mesh);
        this.cones.push({ body, mesh });
      }
    }
    // Sleeping cones never sync, so place their meshes once
    for (const { body, mesh } of this.cones) {
      const p = body.translation();
      mesh.position.set(p.x, p.y, p.z);
    }
  }
}

/** A wedge that rises from ground level to `height` along its local +X. */
function addRamp(
  scene: THREE.Scene, world: RAPIER.World, material: THREE.Material,
  x: number, z: number, yaw: number, length: number, width: number, height: number,
): void {
  const hl = length / 2;
  const hw = width / 2;
  const v = [
    [-hl, 0, -hw], [-hl, 0, hw], [hl, 0, -hw], [hl, 0, hw], [hl, height, -hw], [hl, height, hw],
  ];
  const faces = [[0, 1, 5], [0, 5, 4], [2, 4, 5], [2, 5, 3], [0, 4, 2], [1, 3, 5]]; // slope, back, sides
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(faces.flat().flatMap((i) => v[i]), 3));
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, material);
  mesh.position.set(x, 0, z);
  mesh.rotation.y = yaw;
  mesh.castShadow = mesh.receiveShadow = true;
  scene.add(mesh);

  const hull = RAPIER.ColliderDesc.convexHull(new Float32Array(v.flat()));
  if (!hull) throw new Error('ramp hull failed');
  world.createCollider(hull.setTranslation(x, 0, z).setRotation(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw)));
}

function grassTexture(repeat: number): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#5d8a3a';
  g.fillRect(0, 0, size, size);
  // Speckle detail matters: without ground texture there's no sense of speed
  for (let i = 0; i < 2500; i++) {
    const light = Math.random() < 0.5;
    g.fillStyle = light ? 'rgba(140,180,90,0.5)' : 'rgba(40,70,30,0.5)';
    g.fillRect(Math.random() * size, Math.random() * size, 2, 2);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat, repeat);
  tex.anisotropy = 8;
  return tex;
}

function mulberry32(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
