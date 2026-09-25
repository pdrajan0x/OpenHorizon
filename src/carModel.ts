// Procedural car bodies: a rounded-box cross-section swept along the car, shaped by a side profile
// (nose → hood → windshield → roof → rear glass → deck → tail) and a plan-view taper. The underside
// arches over each wheel, which cuts the wheel wells. Frame: +X forward, +Y up, +Z right, y = 0 at the ground.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { radialTexture } from './neon';

export interface CarDesign {
  name: string;
  length: number;
  width: number;
  wheelRadius: number;
  wheelWidth: number;
  wheelbase: number;
  axleShift: number; // + moves both axles toward the nose
  clearance: number;
  noseHeight: number;
  hoodHeight: number; // at the base of the windshield
  roofHeight: number;
  deckHeight: number; // rear deck / engine cover
  tailHeight: number;
  // Positions along the car as t in [-0.5 tail, 0.5 nose]
  windshield: [number, number]; // base, top
  backlight: [number, number]; // top (roof end), base (deck start)
  noseTaper: number; // width fraction at the nose
  tailTaper: number;
  tumblehome: number; // greenhouse narrowing toward the roof, 0..0.5
  boxiness: number; // cross-section superellipse exponent: 2 round .. 7 boxy
  fender: number; // how far the fenders rise above the hood/deck line over each wheel
  rim: 'chrome' | 'black' | 'bronze';
  caliper: number;
  wing?: boolean;
  roofSign?: boolean; // taxi light
}

export interface CarVisual extends CarShape {
  root: THREE.Group;
  /** Front-left, front-right, rear-left, rear-right. `center` is the wheel center at design ride height. */
  wheels: { steer: THREE.Group; spin: THREE.Group; center: THREE.Vector3 }[];
  /** Driver's-eye point for the cockpit camera. */
  eye: THREE.Vector3;
  setBraking(on: boolean): void;
}

export interface CarLook {
  paint: number;
  underglow?: number;
  /** Hero cars get brighter light bars; traffic stays dimmer so it doesn't bloom into a blur. */
  lightLevel?: number;
}

/** Physics-relevant measurements shared by hero and traffic cars. */
export interface CarShape {
  wheelRadius: number;
  chassisCenter: THREE.Vector3;
  chassisHalf: THREE.Vector3;
}

const STATIONS = 80; // cross-sections along the car
const LOWER_POINTS = 16; // per side, underside → belt line
const GLASS_POINTS = 16; // belt → over the roof → belt
const SECTION = 2 * LOWER_POINTS + GLASS_POINTS;

const bodyCache = new Map<string, THREE.BufferGeometry>();
const paintCache = new Map<number, THREE.MeshPhysicalMaterial>();

const glass = new THREE.MeshPhysicalMaterial({ color: 0x0b1118, metalness: 0.2, roughness: 0.04, clearcoat: 1, clearcoatRoughness: 0.02 });
const trim = new THREE.MeshStandardMaterial({ color: 0x0d0e10, roughness: 0.55, metalness: 0.2 });
const tire = new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.85 });
const disc = new THREE.MeshStandardMaterial({ color: 0x55585c, metalness: 0.9, roughness: 0.35 });
const rims = {
  chrome: new THREE.MeshStandardMaterial({ color: 0xd6d9dc, metalness: 1, roughness: 0.15 }),
  black: new THREE.MeshStandardMaterial({ color: 0x1c1d20, metalness: 0.8, roughness: 0.3 }),
  bronze: new THREE.MeshStandardMaterial({ color: 0x9b7a4a, metalness: 1, roughness: 0.25 }),
};

export function buildCar(design: CarDesign, look: CarLook): CarVisual {
  const d = design;
  const root = new THREE.Group();
  const body = new THREE.Mesh(bodyGeometry(d), [paintMaterial(look.paint), glass, trim]);
  body.castShadow = true;
  root.add(body);

  const L = d.length;
  const R = d.wheelRadius;
  const frontX = d.wheelbase / 2 + d.axleShift;
  const rearX = -d.wheelbase / 2 + d.axleShift;
  const trackZ = d.width / 2 - d.wheelWidth / 2 - 0.02;

  // Dark liners hide the see-through tunnel the wheel arches leave under the body
  for (const x of [frontX, rearX]) {
    const t = x / L;
    const top = Math.min(2 * R + 0.05, Math.min(topAt(d, t - (R * 1.05) / L), topAt(d, t), topAt(d, t + (R * 1.05) / L)) - 0.06);
    const liner = new THREE.Mesh(new THREE.BoxGeometry(2.1 * R, top - d.clearance, d.width - 2 * d.wheelWidth - 0.1), trim);
    liner.position.set(x, (top + d.clearance) / 2, 0);
    root.add(liner);
  }

  // Light bars: bright enough to bloom
  const level = look.lightLevel ?? 1;
  const head = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xdff6ff).multiplyScalar(2.2 * level) });
  const tail = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xff1030).multiplyScalar(2.2 * level) });
  const noseY = (bottomAt(d, 0.5) + topAt(d, 0.5)) / 2;
  const tailY = (bottomAt(d, -0.5) + topAt(d, -0.5)) / 2 + 0.04;
  const noseW = halfWidthAt(d, 0.5) * 2;
  const tailW = halfWidthAt(d, -0.5) * 2;
  const bar = (w: number, h: number, mat: THREE.Material, x: number, y: number, z = 0) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(0.05, h, w), mat);
    m.position.set(x, y, z);
    root.add(m);
  };
  bar(noseW * 0.82, 0.035, head, L / 2 + 0.005, noseY + 0.05);
  for (const s of [-1, 1]) bar(noseW * 0.16, 0.09, head, L / 2 + 0.006, noseY - 0.02, s * noseW * 0.34);
  bar(tailW * 0.9, 0.05, tail, -L / 2 - 0.005, tailY);

  if (d.wing) {
    const deckX = -L * 0.43;
    const deckY = topAt(d, -0.43);
    for (const s of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.26, 0.04), trim);
      post.position.set(deckX, deckY + 0.13, s * d.width * 0.3);
      root.add(post);
    }
    const foil = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.035, d.width * 0.92), trim);
    foil.position.set(deckX - 0.04, deckY + 0.27, 0);
    foil.rotation.z = 0.08;
    foil.castShadow = true;
    root.add(foil);
  }
  if (d.roofSign) {
    const sign = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.14, 0.6), new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffd23a).multiplyScalar(2) }));
    sign.position.set(-0.1, d.roofHeight + 0.07, 0);
    root.add(sign);
  }
  // Mirrors at the base of the A-pillars
  for (const s of [-1, 1]) {
    const mirror = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.07, 0.14), trim);
    const t = d.windshield[0] - 0.03;
    mirror.position.set(t * L, beltAt(d, t) + 0.07, s * (halfWidthAt(d, t) * (1 - d.tumblehome * 0.15) + 0.04));
    root.add(mirror);
  }

  if (look.underglow !== undefined) root.add(underglow(L, d.width, look.underglow));
  root.add(blobShadow(L, d.width));

  const wheels = [
    new THREE.Vector3(frontX, R, -trackZ),
    new THREE.Vector3(frontX, R, trackZ),
    new THREE.Vector3(rearX, R, -trackZ),
    new THREE.Vector3(rearX, R, trackZ),
  ].map((center) => {
    const steer = new THREE.Group();
    steer.position.copy(center);
    const spin = new THREE.Group();
    const wheel = wheelMesh(d);
    if (center.z < 0) wheel.rotation.y = Math.PI; // outer face points away from the car
    spin.add(wheel);
    steer.add(spin);
    // Calipers ride with the steering but don't spin
    const caliper = new THREE.Mesh(
      new THREE.BoxGeometry(0.16, 0.1, 0.07),
      new THREE.MeshStandardMaterial({ color: d.caliper, roughness: 0.4, metalness: 0.3 }),
    );
    caliper.position.set(-R * 0.35, R * 0.35, Math.sign(center.z) * d.wheelWidth * 0.12);
    steer.add(caliper);
    root.add(steer);
    return { steer, spin, center };
  });

  const bodyBottom = d.clearance + 0.08;
  const chassisTop = Math.max(d.hoodHeight, d.deckHeight);
  return {
    root,
    wheels,
    wheelRadius: R,
    chassisCenter: new THREE.Vector3(0, (bodyBottom + chassisTop) / 2, 0),
    chassisHalf: new THREE.Vector3(L * 0.47, (chassisTop - bodyBottom) / 2, d.width * 0.46),
    eye: new THREE.Vector3(d.windshield[1] * L - 0.25, d.roofHeight - 0.14, -0.3),
    setBraking(on: boolean) {
      tail.color.setHex(0xff1030).multiplyScalar((on ? 6 : 2.2) * level);
    },
  };
}

const trafficLit = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.35, metalness: 0.45 });
const trafficGlow = new THREE.MeshBasicMaterial({ vertexColors: true });
const trafficCache = new Map<string, { lit: THREE.BufferGeometry; glow: THREE.BufferGeometry; shape: CarShape }>();

/**
 * Traffic version of a car: every part baked into one lit mesh (colors from vertex colors) and one
 * light-bar mesh, plus the blob shadow. Three draw calls instead of about thirty; wheels don't turn.
 */
export function buildTrafficCar(design: CarDesign, paint: number): { root: THREE.Group; shape: CarShape } {
  const key = `${design.name}:${paint}`;
  let baked = trafficCache.get(key);
  if (!baked) {
    const car = buildCar(design, { paint, lightLevel: 0.6 });
    for (const w of car.wheels) w.steer.position.copy(w.center);
    car.root.updateMatrixWorld(true);
    const lit: THREE.BufferGeometry[] = [];
    const glow: THREE.BufferGeometry[] = [];
    car.root.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh) || obj.material === shadowMaterial) return;
      let geo = (obj.geometry as THREE.BufferGeometry).clone().applyMatrix4(obj.matrixWorld);
      if (geo.index) geo = geo.toNonIndexed();
      geo.deleteAttribute('uv');
      // Box and cylinder geometries carry per-face groups even with a single material
      const multi = Array.isArray(obj.material);
      const materials: THREE.Material[] = multi ? obj.material : [obj.material];
      const ranges = multi && geo.groups.length ? geo.groups : [{ start: 0, count: geo.attributes.position.count, materialIndex: 0 }];
      const colors = new Float32Array(geo.attributes.position.count * 3);
      let emissive = false;
      for (const range of ranges) {
        const m = materials[range.materialIndex ?? 0] as THREE.MeshStandardMaterial | THREE.MeshBasicMaterial;
        emissive = m instanceof THREE.MeshBasicMaterial;
        for (let v = range.start; v < range.start + range.count; v++) colors.set([m.color.r, m.color.g, m.color.b], v * 3);
      }
      geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      geo.clearGroups();
      (emissive ? glow : lit).push(geo);
    });
    baked = { lit: mergeGeometries(lit), glow: mergeGeometries(glow), shape: car };
    trafficCache.set(key, baked);
  }
  const root = new THREE.Group();
  root.add(new THREE.Mesh(baked.lit, trafficLit), new THREE.Mesh(baked.glow, trafficGlow), blobShadow(design.length, design.width));
  return { root, shape: baked.shape };
}

// --- Profile functions (t in [-0.5, 0.5], tail → nose) ---

function topAt(d: CarDesign, t: number): number {
  const keys: [number, number][] = [
    [-0.5, d.tailHeight],
    [d.backlight[1], d.deckHeight],
    [d.backlight[0], d.roofHeight],
    [d.windshield[1], d.roofHeight],
    [d.windshield[0], d.hoodHeight],
    [0.5, d.noseHeight],
  ];
  for (let k = 0; k < keys.length - 1; k++) {
    const [t0, y0] = keys[k];
    const [t1, y1] = keys[k + 1];
    if (t <= t1) return THREE.MathUtils.lerp(y0, y1, smooth(t0, t1, t));
  }
  return d.noseHeight;
}

function bottomAt(d: CarDesign, t: number): number {
  const x = t * d.length;
  const R = d.wheelRadius;
  let y = d.clearance + 0.06 * smooth(0.4, 0.5, Math.abs(t)); // overhangs lift at the ends
  for (const axle of [d.wheelbase / 2 + d.axleShift, -d.wheelbase / 2 + d.axleShift]) {
    const archR = R * 1.12;
    const dx = x - axle;
    if (Math.abs(dx) < archR) y = Math.max(y, R + Math.sqrt(archR * archR - dx * dx) + 0.02);
  }
  return Math.min(y, topAt(d, t) - 0.1);
}

/** Belt line (bottom of the side glass): deck height at the rear of the cabin, hood height at the windshield. */
function beltAt(d: CarDesign, t: number): number {
  const y = THREE.MathUtils.lerp(d.deckHeight, d.hoodHeight, smooth(d.backlight[1], d.windshield[0], t));
  return Math.min(y, topAt(d, t));
}

function fenderAt(d: CarDesign, t: number): number {
  const x = t * d.length;
  let rise = 0;
  for (const axle of [d.wheelbase / 2 + d.axleShift, -d.wheelbase / 2 + d.axleShift]) {
    rise = Math.max(rise, 1 - smooth(0, d.wheelRadius * 1.8, Math.abs(x - axle)));
  }
  return d.fender * rise;
}

function halfWidthAt(d: CarDesign, t: number): number {
  const nose = THREE.MathUtils.lerp(d.noseTaper, 1, smooth(0.5, 0.3, t));
  const tail = THREE.MathUtils.lerp(d.tailTaper, 1, smooth(-0.5, -0.35, t));
  return (d.width / 2) * Math.min(nose, tail);
}

function bodyGeometry(d: CarDesign): THREE.BufferGeometry {
  const cached = bodyCache.get(d.name);
  if (cached) return cached;

  // Each cross-section is three bands with fixed vertex counts: right lower body (underside → belt),
  // greenhouse (belt → over the roof → belt) and left lower body. The belt lands exactly on a vertex
  // ring, so glass edges are clean lines. Outside the cabin the greenhouse band collapses to nothing.
  const e = 2 / d.boxiness;
  const positions: number[] = [];
  const meta: { t: number; v: number; y: number }[] = [];
  for (let i = 0; i <= STATIONS; i++) {
    const t = -0.5 + i / STATIONS;
    const yt = topAt(d, t);
    const yb = bottomAt(d, t);
    const w = halfWidthAt(d, t);
    const beltY = beltAt(d, t);
    const vBelt = THREE.MathUtils.clamp((2 * (beltY - yb)) / (yt - yb) - 1, -0.2, 1);
    const phiBelt = Math.sign(vBelt) * Math.asin(Math.abs(vBelt) ** (1 / e));
    const ring: number[] = [];
    for (let k = 0; k < LOWER_POINTS; k++) ring.push(THREE.MathUtils.lerp(-Math.PI / 2, phiBelt, k / LOWER_POINTS));
    for (let k = 0; k < GLASS_POINTS; k++) ring.push(THREE.MathUtils.lerp(phiBelt, Math.PI - phiBelt, k / GLASS_POINTS));
    for (let k = 0; k < LOWER_POINTS; k++) ring.push(THREE.MathUtils.lerp(Math.PI - phiBelt, (3 * Math.PI) / 2, k / LOWER_POINTS));
    for (const phi of ring) {
      const u = Math.sign(Math.cos(phi)) * Math.abs(Math.cos(phi)) ** e;
      const v = Math.sign(Math.sin(phi)) * Math.abs(Math.sin(phi)) ** e;
      // Fenders: lift the outer top edge over the wheels, so the hood and deck sit between them
      const lift = fenderAt(d, t) * Math.abs(u) ** 4 * Math.max(0, v);
      const y = yb + ((v + 1) / 2) * (yt - yb) + lift;
      const z = u * w * (1 - d.tumblehome * smooth(beltY, d.roofHeight, y));
      positions.push(t * d.length, y, z);
      meta.push({ t, v, y });
    }
  }
  // End caps: a center vertex at each end
  const tailCenter = positions.length / 3;
  positions.push(-d.length / 2, (bottomAt(d, -0.5) + topAt(d, -0.5)) / 2, 0);
  const noseCenter = tailCenter + 1;
  positions.push(d.length / 2, (bottomAt(d, 0.5) + topAt(d, 0.5)) / 2, 0);

  // Faces sorted into material groups: 0 paint, 1 glass, 2 trim
  const groups: number[][] = [[], [], []];
  const roofFrom = LOWER_POINTS + Math.round(GLASS_POINTS * 0.28);
  const roofTo = LOWER_POINTS + Math.round(GLASS_POINTS * 0.72);
  const classify = (i: number, j: number, a: number, c: number) => {
    const t = -0.5 + (i + 0.5) / STATIONS;
    const v = (meta[a].v + meta[c].v) / 2;
    const y = (meta[a].y + meta[c].y) / 2;
    if (v < -0.85 || y < d.clearance + 0.05) return 2;
    if (j >= LOWER_POINTS && j < LOWER_POINTS + GLASS_POINTS) {
      const roofPanel = j >= roofFrom && j < roofTo && t > d.backlight[0] + 0.015 && t < d.windshield[1] - 0.015;
      return roofPanel ? 0 : 1;
    }
    return 0;
  };
  const idx = (i: number, j: number) => i * SECTION + (j % SECTION);
  for (let i = 0; i < STATIONS; i++) {
    for (let j = 0; j < SECTION; j++) {
      const a = idx(i, j);
      const b = idx(i + 1, j);
      const c = idx(i + 1, j + 1);
      const dd = idx(i, j + 1);
      groups[classify(i, j, a, c)].push(a, b, dd, b, c, dd);
    }
  }
  for (let j = 0; j < SECTION; j++) {
    groups[0].push(tailCenter, idx(0, j + 1), idx(0, j));
    groups[0].push(noseCenter, idx(STATIONS, j), idx(STATIONS, j + 1));
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  const index: number[] = [];
  groups.forEach((g, material) => {
    geo.addGroup(index.length, g.length, material);
    index.push(...g);
  });
  geo.setIndex(index);
  geo.computeVertexNormals();
  bodyCache.set(d.name, geo);
  return geo;
}

function wheelMesh(d: CarDesign): THREE.Group {
  const R = d.wheelRadius;
  const w = d.wheelWidth;
  const g = new THREE.Group();
  const profile = [
    new THREE.Vector2(R * 0.7, -w / 2),
    new THREE.Vector2(R - 0.035, -w / 2),
    new THREE.Vector2(R, -w / 2 + 0.04),
    new THREE.Vector2(R, w / 2 - 0.04),
    new THREE.Vector2(R - 0.035, w / 2),
    new THREE.Vector2(R * 0.7, w / 2),
  ];
  const tireMesh = new THREE.Mesh(new THREE.LatheGeometry(profile, 28).rotateX(Math.PI / 2), tire);
  tireMesh.castShadow = true;
  g.add(tireMesh);

  const rimMat = rims[d.rim];
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(R * 0.7, R * 0.7, w * 0.9, 24, 1, true).rotateX(Math.PI / 2), rimMat);
  g.add(barrel);
  const brake = new THREE.Mesh(new THREE.CylinderGeometry(R * 0.56, R * 0.56, 0.03, 24).rotateX(Math.PI / 2), disc);
  brake.position.z = w * 0.05;
  g.add(brake);
  // Twin five-spoke face on the outer (+Z) side
  const face = w * 0.42;
  for (let k = 0; k < 10; k++) {
    const angle = (k / 10) * Math.PI * 2 + (k % 2 ? 0.12 : -0.12);
    const spoke = new THREE.Mesh(new THREE.BoxGeometry(R * 0.6, 0.035, 0.035), rimMat);
    spoke.position.set(Math.cos(angle) * R * 0.34, Math.sin(angle) * R * 0.34, face);
    spoke.rotation.z = angle;
    g.add(spoke);
  }
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(R * 0.14, R * 0.14, 0.06, 12).rotateX(Math.PI / 2), rimMat);
  hub.position.z = face;
  g.add(hub);
  return g;
}

function underglow(length: number, width: number, color: number): THREE.Mesh {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const g = canvas.getContext('2d')!;
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.55, 'rgba(255,255,255,0.45)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(length * 1.05, width * 1.6).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({
      map: new THREE.CanvasTexture(canvas), color: new THREE.Color(color).multiplyScalar(1.6),
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    }),
  );
  mesh.position.y = 0.03;
  return mesh;
}

const shadowMaterial = new THREE.MeshBasicMaterial({ color: 0x000000, map: radialTexture(), transparent: true, opacity: 0.8, depthWrite: false });

/** Soft dark contact patch under the car; the night scene has no shadow maps. */
function blobShadow(length: number, width: number): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(length * 1.2, width * 1.5).rotateX(-Math.PI / 2), shadowMaterial);
  mesh.position.y = 0.02;
  mesh.renderOrder = 1;
  return mesh;
}

function paintMaterial(color: number): THREE.MeshPhysicalMaterial {
  let m = paintCache.get(color);
  if (!m) {
    m = new THREE.MeshPhysicalMaterial({ color, metalness: 0.55, roughness: 0.32, clearcoat: 1, clearcoatRoughness: 0.04 });
    paintCache.set(color, m);
  }
  return m;
}

function smooth(edge0: number, edge1: number, x: number): number {
  const t = THREE.MathUtils.clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

// --- Designs: fictional marques, recognizable archetypes ---

export const DESIGNS = {
  vesperNyx: {
    name: 'Vesper Nyx', length: 4.55, width: 2.05, wheelRadius: 0.36, wheelWidth: 0.33, wheelbase: 2.75, axleShift: -0.06,
    clearance: 0.11, noseHeight: 0.48, hoodHeight: 0.76, roofHeight: 1.12, deckHeight: 0.9, tailHeight: 0.84,
    windshield: [0.2, -0.02], backlight: [-0.12, -0.3], noseTaper: 0.78, tailTaper: 0.9, tumblehome: 0.34, boxiness: 3.2, fender: 0.1,
    rim: 'black', caliper: 0xffc400, wing: true,
  },
  solaceArc: {
    name: 'Solace Arc', length: 4.75, width: 1.98, wheelRadius: 0.35, wheelWidth: 0.3, wheelbase: 2.85, axleShift: 0.05,
    clearance: 0.13, noseHeight: 0.55, hoodHeight: 0.84, roofHeight: 1.24, deckHeight: 0.92, tailHeight: 0.9,
    windshield: [0.1, -0.06], backlight: [-0.2, -0.38], noseTaper: 0.74, tailTaper: 0.82, tumblehome: 0.3, boxiness: 2.8, fender: 0.07,
    rim: 'chrome', caliper: 0xd81b3a,
  },
  ironcladBrute: {
    name: 'Ironclad Brute', length: 4.85, width: 2.0, wheelRadius: 0.37, wheelWidth: 0.34, wheelbase: 2.9, axleShift: 0,
    clearance: 0.15, noseHeight: 0.74, hoodHeight: 0.95, roofHeight: 1.33, deckHeight: 0.98, tailHeight: 0.95,
    windshield: [0.1, -0.06], backlight: [-0.2, -0.32], noseTaper: 0.9, tailTaper: 0.92, tumblehome: 0.2, boxiness: 5, fender: 0.05,
    rim: 'bronze', caliper: 0x1f2a36,
  },
  // Traffic
  sedan: {
    name: 'Mobi Sedan', length: 4.7, width: 1.85, wheelRadius: 0.33, wheelWidth: 0.24, wheelbase: 2.8, axleShift: 0,
    clearance: 0.16, noseHeight: 0.7, hoodHeight: 0.92, roofHeight: 1.45, deckHeight: 0.98, tailHeight: 0.95,
    windshield: [0.18, 0.02], backlight: [-0.18, -0.33], noseTaper: 0.85, tailTaper: 0.88, tumblehome: 0.22, boxiness: 4, fender: 0.02,
    rim: 'chrome', caliper: 0x3a3a3a,
  },
  taxi: {
    name: 'Mobi Cab', length: 4.7, width: 1.85, wheelRadius: 0.33, wheelWidth: 0.24, wheelbase: 2.8, axleShift: 0,
    clearance: 0.16, noseHeight: 0.7, hoodHeight: 0.92, roofHeight: 1.45, deckHeight: 0.98, tailHeight: 0.95,
    windshield: [0.18, 0.02], backlight: [-0.18, -0.33], noseTaper: 0.85, tailTaper: 0.88, tumblehome: 0.22, boxiness: 4, fender: 0.02,
    rim: 'black', caliper: 0x3a3a3a, roofSign: true,
  },
  suv: {
    name: 'Hauler SUV', length: 4.85, width: 1.96, wheelRadius: 0.38, wheelWidth: 0.27, wheelbase: 2.9, axleShift: 0,
    clearance: 0.22, noseHeight: 0.95, hoodHeight: 1.12, roofHeight: 1.75, deckHeight: 1.2, tailHeight: 1.15,
    windshield: [0.2, 0.06], backlight: [-0.4, -0.47], noseTaper: 0.9, tailTaper: 0.94, tumblehome: 0.15, boxiness: 5.5, fender: 0.03,
    rim: 'black', caliper: 0x3a3a3a,
  },
  van: {
    name: 'Kestrel Van', length: 5.1, width: 2.0, wheelRadius: 0.36, wheelWidth: 0.26, wheelbase: 3.2, axleShift: 0.1,
    clearance: 0.2, noseHeight: 1.0, hoodHeight: 1.18, roofHeight: 2.05, deckHeight: 1.9, tailHeight: 1.85,
    windshield: [0.36, 0.26], backlight: [-0.46, -0.49], noseTaper: 0.92, tailTaper: 0.97, tumblehome: 0.08, boxiness: 7, fender: 0.0,
    rim: 'chrome', caliper: 0x3a3a3a,
  },
  hatch: {
    name: 'Pico Hatch', length: 4.0, width: 1.78, wheelRadius: 0.31, wheelWidth: 0.22, wheelbase: 2.5, axleShift: 0.05,
    clearance: 0.15, noseHeight: 0.68, hoodHeight: 0.88, roofHeight: 1.42, deckHeight: 1.1, tailHeight: 1.0,
    windshield: [0.2, 0.04], backlight: [-0.36, -0.45], noseTaper: 0.86, tailTaper: 0.93, tumblehome: 0.2, boxiness: 3.6, fender: 0.03,
    rim: 'chrome', caliper: 0x3a3a3a,
  },
} satisfies Record<string, CarDesign>;
