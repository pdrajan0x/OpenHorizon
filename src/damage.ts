// Crash damage for any car model: dents and crumples the body around an impact, cracks glass and
// knocks small parts askew. It works on any Object3D hierarchy (procedural cars, baked traffic, glTF
// imports). Cars share geometry, so a mesh's geometry is cloned on its first hit and the shared
// original is swapped back in on repair(). WreckSmoke is one particle draw call for every smoking wreck.
// Frame for the helpers: +X forward, +Y up, +Z right, which is also the wheel axle direction.
import type RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { radialTexture } from './effects';
import { mulberry32 } from './random';

// Dent shape
const RADIUS_BASE = 0.5; // m, dent radius at strength 0
const RADIUS_PER_STRENGTH = 0.9;
const DEPTH = 0.36; // m, push at the impact point for a strength-1 hit
const MAX_DISPLACEMENT = 0.4; // m; no vertex ever ends up further than this from its factory position
const CRUMPLE = 0.4; // smooth noise on the push, so a dent is uneven instead of looking pressed in
const CRUMPLE_WAVELENGTHS = [0.75, 0.5]; // m
const FOLD = 0.5; // out-of-plane buckling of panels along the push, as a fraction of the push
const CREASE_SPACING = 0.36; // m between fold creases along the push
const MIN_MOVE = 1e-4; // m; smaller moves don't count as touching a vertex

// Wheels: tires are never dented, and the body is kept out of them
const WHEEL_NAME = /wheel|tyre|tire/i;
const WHEEL_CLEARANCE = 0.04; // m of air the body keeps around a tire
const WHEEL_FREEZE = 0.02; // m; vertices this far inside a wheel zone are the tire itself (baked meshes)

// Glass and loose parts
const GLASS_NAME = /glass|window|windscreen|windshield/i;
const GLASS_CRACK_MOVE = 0.03; // m a glass vertex must move before its pane cracks
const CRACK_PER_HIT = 1.4; // crack gained per unit strength
const CRACKED_ROUGHNESS = 0.55;
const CRACKED_CLEARCOAT_ROUGHNESS = 0.4;
const CRACKED_OPACITY = 0.9;
const CRACK_TINT = new THREE.Color(0x8c969e); // crazed safety glass goes milky
const CRACK_TINT_MIX = 0.3;
const LOOSE_RADIUS = 0.2; // m; parts this small get knocked askew as a whole
const LOOSE_TILT = 0.45; // rad at the center of a strength-1 hit
const LOOSE_MAX_TILT = 0.8;

const AMOUNT_PER_HIT = 0.55; // share of the remaining health a strength-1 hit takes
const WELD_TOLERANCE = 1e-6; // relative to a geometry's size: split vertices closer than this are one point
const STRENGTH_MIN_DV = 4; // m/s of velocity change that starts to dent
const STRENGTH_FULL_DV = 30; // m/s for a strength-1 hit

/** A tire as a cylinder along the car's +Z axis, in the root's frame. */
export interface WheelZone {
  center: THREE.Vector3;
  radius: number;
  halfWidth: number;
}

export interface CarDamageOptions {
  /** Wheel objects (e.g. `visual.wheels.map((w) => w.steer)`). Never deformed; the body is kept out of them. */
  wheels?: THREE.Object3D[];
  /** Tires baked into merged meshes (traffic): vertices inside stay put and the rest are kept out. */
  wheelZones?: WheelZone[];
  /** Extra objects to leave alone (their whole subtree). */
  exclude?: (o: THREE.Object3D) => boolean;
  /** Overrides glass detection for a material slot. */
  isGlass?: (material: THREE.Material, mesh: THREE.Mesh) => boolean;
}

/** Welding, adjacency and rest data for one source geometry, shared by every car that uses it. */
interface Topology {
  rest: Float32Array;
  restNormals: Float32Array | null;
  /** Vertex → material slot, for multi-material geometries (255 = none). */
  materialOf: Uint8Array | null;
  corners: Uint32Array; // triangle corner → vertex (a copy of the index, or 0..n-1 for non-indexed meshes)
  groupOf: Uint32Array; // vertex → welded point (split vertices at seams and hard edges share one)
  groupFaceStart: Uint32Array;
  groupFaces: Uint32Array;
  groupVertStart: Uint32Array;
  groupVerts: Uint32Array;
  restGroupNormals: Float32Array;
  // Scratch, valid where the mark equals the current stamp
  stamp: number;
  movedMark: Uint32Array;
  dirtyMark: Uint32Array;
  faceMark: Uint32Array;
  faceNormals: Float32Array;
  dirty: Uint32Array;
}

interface Part {
  mesh: THREE.Mesh;
  source: THREE.BufferGeometry;
  sourceMaterial: THREE.Material | THREE.Material[];
  slots: THREE.Material[];
  glassSlots: Uint8Array; // per material slot, 1 = glass
  small: boolean;
  // Set on the first hit
  geometry: THREE.BufferGeometry | null;
  topology: Topology | null;
  frozen: Uint8Array | null;
  materials: THREE.Material[] | null; // per-car clones of cracked glass
  crack: number;
  tilt: number;
  restPosition: THREE.Vector3 | null;
  restQuaternion: THREE.Quaternion | null;
}

/** One impact, precomputed for the vertex loop. */
interface Field {
  px: number; py: number; pz: number;
  dx: number; dy: number; dz: number;
  r: number;
  r2: number;
  depth: number;
  waves: Float64Array; // crumple waves: kx, ky, kz, phase
  foldPhase: number;
  zones: Float64Array; // per wheel: center xyz, axle xyz, keep-out radius, keep-out half width
  upX: number; upY: number; upZ: number;
}

const topologies = new WeakMap<THREE.BufferGeometry, Topology>();
let instances = 0;

/**
 * Deformable damage for one car. Construct it once per car (cheap; nothing is cloned until a hit),
 * call hit() or hitLocal() on impacts and repair() for a fresh car.
 */
export class CarDamage {
  private readonly parts: Part[] = [];
  private readonly zones: WheelZone[] = [];
  private readonly rng: () => number;
  private readonly field: Field;
  private readonly smokeLocal = new THREE.Vector3();
  private smokeStrength = 0;
  private damage = 0;
  private moved = new Uint32Array(0);
  private readonly span = new Int32Array(3);
  private readonly matrix = new Float64Array(16);
  private readonly matrixInverse = new Float64Array(16);
  private readonly inverse = new THREE.Matrix4();
  private readonly v = new THREE.Vector3();
  private readonly w = new THREE.Vector3();
  private readonly q = new THREE.Quaternion();

  constructor(readonly root: THREE.Object3D, options: CarDamageOptions = {}) {
    this.rng = mulberry32(0x5eed + 7919 * instances++);
    root.updateWorldMatrix(true, true);
    const wheelRoots = new Set(options.wheels ?? []);
    const excluded = (o: THREE.Object3D) => {
      for (let p: THREE.Object3D | null = o; p && p !== root; p = p.parent) {
        if (wheelRoots.has(p) || WHEEL_NAME.test(p.name) || options.exclude?.(p)) return true;
      }
      return false;
    };
    const isGlass = options.isGlass ?? defaultIsGlass;
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || (o as THREE.InstancedMesh).isInstancedMesh || (o as THREE.SkinnedMesh).isSkinnedMesh) return;
      const geometry = mesh.geometry as THREE.BufferGeometry;
      if (!geometry?.attributes.position || excluded(o)) return;
      const slots = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      // Shadow blobs, underglow and decals don't write depth; they aren't bodywork
      if (slots.every((m) => !m.depthWrite)) return;
      if (!geometry.boundingSphere) geometry.computeBoundingSphere();
      const scale = mesh.matrixWorld.getMaxScaleOnAxis() / Math.max(1e-9, root.matrixWorld.getMaxScaleOnAxis());
      this.parts.push({
        mesh, source: geometry, sourceMaterial: mesh.material, slots,
        glassSlots: Uint8Array.from(slots, (m) => (isGlass(m, mesh) ? 1 : 0)),
        small: geometry.boundingSphere!.radius * scale < LOOSE_RADIUS,
        geometry: null, topology: null, frozen: null, materials: null, crack: 0, tilt: 0, restPosition: null, restQuaternion: null,
      });
    });

    // Wheel zones: given ones, plus the bounds of each wheel object (named ones must sit on the ground,
    // which rules out steering wheels)
    this.zones.push(...(options.wheelZones ?? []));
    const wheelObjects = options.wheels ?? topmostNamed(root, WHEEL_NAME);
    for (const wheel of wheelObjects) {
      const box = boundsInRoot(wheel, root);
      if (box.isEmpty()) continue;
      const size = box.getSize(this.v);
      const center = box.getCenter(new THREE.Vector3());
      if (!options.wheels && center.y > 0.75 * size.y) continue;
      this.zones.push({ center, radius: Math.max(size.x, size.y) / 2, halfWidth: size.z / 2 });
    }

    const maxWaves = CRUMPLE_WAVELENGTHS.length;
    this.field = {
      px: 0, py: 0, pz: 0, dx: 0, dy: 0, dz: 0, r: 0, r2: 0, depth: 0,
      waves: new Float64Array(maxWaves * 4), foldPhase: 0, zones: new Float64Array(this.zones.length * 8), upX: 0, upY: 1, upZ: 0,
    };
  }

  /** Accumulated damage, 0 (factory fresh) to 1 (totaled). */
  get amount(): number {
    return this.damage;
  }

  /**
   * Dent the car at `worldPoint`, pushing along `worldDirection` (into the car). `strength` 0..1 sets
   * the dent's radius and depth. Returns how many vertices moved.
   */
  hit(worldPoint: THREE.Vector3, worldDirection: THREE.Vector3, strength: number): number {
    const s = THREE.MathUtils.clamp(strength, 0, 1);
    const len = worldDirection.length();
    if (!(s > 0) || !(len > 1e-6) || !Number.isFinite(worldPoint.x + worldPoint.y + worldPoint.z)) return 0;
    this.root.updateWorldMatrix(true, true);
    const F = this.field;
    F.px = worldPoint.x;
    F.py = worldPoint.y;
    F.pz = worldPoint.z;
    F.dx = worldDirection.x / len;
    F.dy = worldDirection.y / len;
    F.dz = worldDirection.z / len;
    F.r = RADIUS_BASE + RADIUS_PER_STRENGTH * s;
    F.r2 = F.r * F.r;
    F.depth = DEPTH * s;
    // Each hit gets its own crumple pattern: plane waves in random directions
    CRUMPLE_WAVELENGTHS.forEach((wavelength, i) => {
      const dir = this.v.randomDirection();
      const k = (2 * Math.PI) / wavelength;
      F.waves.set([dir.x * k, dir.y * k, dir.z * k, this.rng() * 2 * Math.PI], i * 4);
    });
    F.foldPhase = this.rng() * 2 * Math.PI;

    const rootMatrix = this.root.matrixWorld;
    const rootScale = rootMatrix.getMaxScaleOnAxis();
    const up = this.v.set(0, 1, 0).transformDirection(rootMatrix);
    F.upX = up.x;
    F.upY = up.y;
    F.upZ = up.z;
    this.zones.forEach((zone, i) => {
      const c = this.v.copy(zone.center).applyMatrix4(rootMatrix);
      const axle = this.w.set(0, 0, 1).transformDirection(rootMatrix);
      F.zones.set([c.x, c.y, c.z, axle.x, axle.y, axle.z,
        (zone.radius + WHEEL_CLEARANCE) * rootScale, (zone.halfWidth + WHEEL_CLEARANCE) * rootScale], i * 8);
    });

    let moved = 0;
    for (const part of this.parts) moved += this.dent(part, s);

    this.damage = 1 - (1 - this.damage) * (1 - AMOUNT_PER_HIT * s);
    if (s >= this.smokeStrength) {
      // Smoke rises from inside the dent
      this.smokeStrength = s;
      const inward = Math.min(0.3, F.depth);
      this.smokeLocal.set(F.px + F.dx * inward, F.py + F.dy * inward, F.pz + F.dz * inward);
      this.root.worldToLocal(this.smokeLocal);
    }
    return moved;
  }

  /**
   * hit() with the point and direction in the car root's own frame. Use this from physics code: it
   * doesn't care that the mesh transform lags the rigid body until the next syncVisuals().
   */
  hitLocal(localPoint: THREE.Vector3, localDirection: THREE.Vector3, strength: number): number {
    this.root.updateWorldMatrix(true, false);
    const m = this.root.matrixWorld;
    const point = new THREE.Vector3().copy(localPoint).applyMatrix4(m);
    const direction = new THREE.Vector3().copy(localDirection).transformDirection(m);
    return this.hit(point, direction, strength);
  }

  /** Back to factory condition: shared geometry and materials restored, clones freed. */
  repair(): void {
    for (const part of this.parts) {
      const mesh = part.mesh;
      if (part.geometry) {
        mesh.geometry = part.source;
        releaseClone(part.geometry, part.source);
        part.geometry = null;
        part.frozen = null;
      }
      if (part.materials) {
        mesh.material = part.sourceMaterial;
        part.materials.forEach((m, i) => m !== part.slots[i] && m.dispose());
        part.materials = null;
        part.crack = 0;
      }
      if (part.restPosition && part.restQuaternion) {
        mesh.position.copy(part.restPosition);
        mesh.quaternion.copy(part.restQuaternion);
        mesh.updateMatrix();
        part.tilt = 0;
      }
    }
    this.damage = 0;
    this.smokeStrength = 0;
  }

  /** World-space point wreck smoke rises from, or null while this car isn't smoking. */
  smokeOrigin(target: THREE.Vector3): THREE.Vector3 | null {
    if (this.damage < SMOKE_FROM || !this.root.visible) return null;
    return target.copy(this.smokeLocal).applyMatrix4(this.root.matrixWorld);
  }

  /** Dent one mesh. Returns how many of its vertices moved. */
  private dent(part: Part, s: number): number {
    const F = this.field;
    const mesh = part.mesh;
    const world = mesh.matrixWorld;
    const sphere = part.source.boundingSphere!;
    const center = this.w.copy(sphere.center).applyMatrix4(world);
    const reach = F.r + sphere.radius * world.getMaxScaleOnAxis() + MAX_DISPLACEMENT;
    const cdx = center.x - F.px;
    const cdy = center.y - F.py;
    const cdz = center.z - F.pz;
    const centerD2 = cdx * cdx + cdy * cdy + cdz * cdz;
    if (centerD2 > reach * reach || Math.abs(world.determinant()) < 1e-12) return 0;

    const topo = this.damaged(part);
    const geometry = part.geometry!;
    const position = geometry.attributes.position as THREE.BufferAttribute;
    const count = position.count;
    const m = this.matrix;
    const n = this.matrixInverse;
    m.set(world.elements);
    n.set(this.inverse.copy(world).invert().elements);
    if (this.moved.length < count) this.moved = new Uint32Array(count);
    const movedCount = dentVertices(
      position.array as Float32Array, topo.rest, count, m, n, F, topo.groupOf, topo.restGroupNormals,
      part.frozen ?? EMPTY, (part.slots.length > 1 && topo.materialOf) || EMPTY, part.glassSlots, this.moved, this.span,
    );
    if (movedCount > 0) {
      markRange(position, this.span[0], this.span[1]);
      const normal = geometry.attributes.normal as THREE.BufferAttribute | undefined;
      if (normal && topo.restNormals) {
        if (renormal(topo, this.moved, movedCount, position.array as Float32Array, normal.array as Float32Array, this.span)) {
          markRange(normal, this.span[0], this.span[1]);
        }
      }
      geometry.boundingBox = null;
    }
    if (this.span[2]) this.crack(part, s);
    if (part.small && centerD2 < F.r2) this.knock(part, s, 1 - centerD2 / F.r2);
    return movedCount;
  }

  /** First hit on a mesh: give this car its own copy of the geometry. */
  private damaged(part: Part): Topology {
    if (part.geometry && part.topology) return part.topology;
    const topo = topologyOf(part.source);
    const clone = new THREE.BufferGeometry();
    const src = part.source;
    clone.name = src.name;
    clone.setIndex(src.index);
    for (const name of Object.keys(src.attributes)) clone.setAttribute(name, src.attributes[name]);
    // Only positions and normals change; the index, UVs, colors and the rest stay shared
    clone.setAttribute('position', new THREE.BufferAttribute(topo.rest.slice(), 3));
    if (topo.restNormals) clone.setAttribute('normal', new THREE.BufferAttribute(topo.restNormals.slice(), 3));
    clone.morphAttributes = src.morphAttributes;
    clone.morphTargetsRelative = src.morphTargetsRelative;
    for (const g of src.groups) clone.addGroup(g.start, g.count, g.materialIndex);
    clone.setDrawRange(src.drawRange.start, src.drawRange.count);
    clone.userData = src.userData;
    // Dents stay within MAX_DISPLACEMENT of the factory shape, so a grown sphere stays valid for culling
    const scale = part.mesh.matrixWorld.getMaxScaleOnAxis() || 1;
    clone.boundingSphere = src.boundingSphere!.clone();
    clone.boundingSphere.radius += MAX_DISPLACEMENT / scale;
    part.mesh.geometry = clone;
    part.geometry = clone;
    part.topology = topo;
    part.frozen = this.zones.length ? this.frozenMask(part, topo.rest) : null;
    return topo;
  }

  /** Vertices of a baked mesh that sit inside a wheel zone: the tire itself, never dented. */
  private frozenMask(part: Part, rest: Float32Array): Uint8Array | null {
    const toRoot = this.inverse.copy(this.root.matrixWorld).invert().multiply(part.mesh.matrixWorld).elements;
    let mask: Uint8Array | null = null;
    for (let i = 0, k = 0; k < rest.length; i++, k += 3) {
      const x = toRoot[0] * rest[k] + toRoot[4] * rest[k + 1] + toRoot[8] * rest[k + 2] + toRoot[12];
      const y = toRoot[1] * rest[k] + toRoot[5] * rest[k + 1] + toRoot[9] * rest[k + 2] + toRoot[13];
      const z = toRoot[2] * rest[k] + toRoot[6] * rest[k + 1] + toRoot[10] * rest[k + 2] + toRoot[14];
      for (const zone of this.zones) {
        const r = zone.radius + WHEEL_FREEZE;
        if (Math.abs(z - zone.center.z) < zone.halfWidth + WHEEL_FREEZE && (x - zone.center.x) ** 2 + (y - zone.center.y) ** 2 < r * r) {
          mask ??= new Uint8Array(rest.length / 3);
          mask[i] = 1;
          break;
        }
      }
    }
    return mask;
  }

  /** Glass that moved gets crazed: rougher, milkier, less see-through. Per-car material clones. */
  private crack(part: Part, s: number): void {
    part.crack = Math.min(1, part.crack + CRACK_PER_HIT * s);
    if (!part.materials) {
      part.materials = part.slots.map((m, i) => (part.glassSlots[i] ? m.clone() : m));
      part.mesh.material = Array.isArray(part.sourceMaterial) ? part.materials : part.materials[0];
    }
    const c = part.crack;
    part.materials.forEach((material, i) => {
      if (!part.glassSlots[i]) return;
      const src = part.slots[i] as THREE.MeshPhysicalMaterial;
      const m = material as THREE.MeshPhysicalMaterial;
      if (m.roughness !== undefined) m.roughness = THREE.MathUtils.lerp(src.roughness, Math.max(src.roughness, CRACKED_ROUGHNESS), c);
      if (m.isMeshPhysicalMaterial) {
        m.clearcoatRoughness = THREE.MathUtils.lerp(src.clearcoatRoughness, Math.max(src.clearcoatRoughness, CRACKED_CLEARCOAT_ROUGHNESS), c);
      }
      if (m.transparent) m.opacity = THREE.MathUtils.lerp(src.opacity, Math.max(src.opacity, CRACKED_OPACITY), c);
      if (m.color) m.color.copy(src.color).lerp(CRACK_TINT, CRACK_TINT_MIX * c);
    });
  }

  /** Small parts (mirrors, spoiler stays, trim bits) get knocked askew about their own center. */
  private knock(part: Part, s: number, falloff: number): void {
    const mesh = part.mesh;
    const angle = Math.min(LOOSE_MAX_TILT - part.tilt, LOOSE_TILT * s * falloff * falloff * (0.6 + 0.8 * this.rng()));
    if (angle < 0.01) return;
    part.restPosition ??= mesh.position.clone();
    part.restQuaternion ??= mesh.quaternion.clone();
    part.tilt += angle;
    const F = this.field;
    // Swing about an axis across the push, in the parent's frame
    const axis = this.v.set(F.dx, F.dy, F.dz).cross(this.w.randomDirection()).normalize();
    if (mesh.parent) axis.transformDirection(this.inverse.copy(mesh.parent.matrixWorld).invert());
    const turn = this.q.setFromAxisAngle(axis, angle);
    const pivot = this.w.copy(part.source.boundingSphere!.center).applyMatrix4(mesh.matrix);
    mesh.position.sub(pivot).applyQuaternion(turn).add(pivot);
    mesh.quaternion.premultiply(turn);
    mesh.updateMatrix();
    mesh.updateWorldMatrix(false, true);
  }
}

// --- Wreck smoke ---

const SMOKE_MAX = 384;
const SMOKE_FROM = 0.35; // damage amount where a wreck starts smoking
const SMOKE_RATE = 26; // particles per second at full damage
const SMOKE_RATE_MIN = 0.2; // share of that rate at SMOKE_FROM
const SMOKE_LIFE = 2.4; // s
const SMOKE_RISE = 1.2; // m/s
const SMOKE_BUOYANCY = 0.6; // m/s² of extra rise
const SMOKE_SPREAD = 0.35; // m/s sideways
const SMOKE_DRAG = 0.8; // 1/s
const SMOKE_SIZE_START = 0.45; // m
const SMOKE_SIZE_END = 2.6;
const SMOKE_ALPHA = 0.4;
const SMOKE_STEAM = 0.62; // gray level of light damage's steam...
const SMOKE_SOOT = 0.14; // ...and a totaled car's smoke
const SMOKE_JITTER = 0.2; // m around the emitter

/**
 * Smoke and steam rising from damaged cars. One shared pool of camera-facing sprites in world space
 * (so a moving wreck leaves a trail), one draw call however many cars smoke.
 */
export class WreckSmoke {
  readonly points: THREE.Points;
  private readonly pos = new Float32Array(SMOKE_MAX * 3);
  private readonly vel = new Float32Array(SMOKE_MAX * 3);
  private readonly rgba = new Float32Array(SMOKE_MAX * 4);
  private readonly size = new Float32Array(SMOKE_MAX);
  private readonly age = new Float32Array(SMOKE_MAX).fill(SMOKE_LIFE);
  private readonly shade = new Float32Array(SMOKE_MAX);
  private readonly carry = new WeakMap<CarDamage, number>();
  private readonly origin = new THREE.Vector3();
  private next = 0;

  constructor(scene: THREE.Object3D) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('color', new THREE.BufferAttribute(this.rgba, 4).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    const material = new THREE.PointsMaterial({ size: 1, map: radialTexture(), vertexColors: true, transparent: true, depthWrite: false });
    // Per-particle size: sprites grow as the smoke spreads
    material.onBeforeCompile = (shader) => {
      shader.vertexShader = `attribute float aSize;\n${shader.vertexShader.replace('gl_PointSize = size;', 'gl_PointSize = size * aSize;')}`;
    };
    this.points = new THREE.Points(geo, material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 2;
    scene.add(this.points);
  }

  /** Emit from every smoking car and advance the particles. Call once per frame. */
  update(dt: number, cars: Iterable<CarDamage>): void {
    for (const car of cars) {
      const at = car.smokeOrigin(this.origin);
      if (!at) {
        this.carry.delete(car);
        continue;
      }
      const heavy = (car.amount - SMOKE_FROM) / (1 - SMOKE_FROM);
      let due = (this.carry.get(car) ?? Math.random()) + dt * SMOKE_RATE * THREE.MathUtils.lerp(SMOKE_RATE_MIN, 1, heavy);
      for (; due >= 1; due--) this.emit(at, THREE.MathUtils.lerp(SMOKE_STEAM, SMOKE_SOOT, heavy));
      this.carry.set(car, due);
    }

    const drag = Math.exp(-SMOKE_DRAG * dt);
    for (let i = 0; i < SMOKE_MAX; i++) {
      const k = i * 3;
      const t = (this.age[i] += dt) / SMOKE_LIFE;
      if (t >= 1) {
        this.size[i] = 0;
        this.rgba[i * 4 + 3] = 0;
        continue;
      }
      this.vel[k] *= drag;
      this.vel[k + 1] += SMOKE_BUOYANCY * dt;
      this.vel[k + 2] *= drag;
      this.pos[k] += this.vel[k] * dt;
      this.pos[k + 1] += this.vel[k + 1] * dt;
      this.pos[k + 2] += this.vel[k + 2] * dt;
      this.size[i] = THREE.MathUtils.lerp(SMOKE_SIZE_START, SMOKE_SIZE_END, Math.sqrt(t));
      const g = this.shade[i];
      this.rgba.set([g, g, g * 1.04, SMOKE_ALPHA * Math.min(1, t / 0.1) * (1 - t) ** 1.5], i * 4);
    }
    const attrs = this.points.geometry.attributes;
    attrs.position.needsUpdate = true;
    attrs.color.needsUpdate = true;
    attrs.aSize.needsUpdate = true;
  }

  dispose(): void {
    this.points.removeFromParent();
    this.points.geometry.dispose();
    const material = this.points.material as THREE.PointsMaterial;
    material.map?.dispose();
    material.dispose();
  }

  private emit(at: THREE.Vector3, shade: number): void {
    const i = this.next;
    this.next = (this.next + 1) % SMOKE_MAX;
    const k = i * 3;
    this.pos[k] = at.x + (Math.random() - 0.5) * 2 * SMOKE_JITTER;
    this.pos[k + 1] = at.y + Math.random() * SMOKE_JITTER;
    this.pos[k + 2] = at.z + (Math.random() - 0.5) * 2 * SMOKE_JITTER;
    this.vel[k] = (Math.random() - 0.5) * 2 * SMOKE_SPREAD;
    this.vel[k + 1] = SMOKE_RISE * (0.7 + 0.6 * Math.random());
    this.vel[k + 2] = (Math.random() - 0.5) * 2 * SMOKE_SPREAD;
    this.age[i] = 0;
    this.shade[i] = shade * (0.85 + 0.3 * Math.random());
  }
}

// --- Impact helpers for physics code. Points and directions are in the car's own frame, for hitLocal() ---

/** Dent strength for a velocity change (m/s) over one physics step. */
export function impactStrength(dv: number): number {
  return THREE.MathUtils.clamp((dv - STRENGTH_MIN_DV) / (STRENGTH_FULL_DV - STRENGTH_MIN_DV), 0, 1);
}

/**
 * Where the chassis collider is touching something right after world.step(), from Rapier's contact
 * manifolds: the impulse-weighted mean of the solver contact points, and the direction the contacts
 * push the car. Both in the body's frame. Returns false if there are no contacts that pushed.
 */
export function contactImpact(
  world: RAPIER.World,
  collider: RAPIER.Collider,
  localPoint: THREE.Vector3,
  localDirection: THREE.Vector3,
  ignore?: (other: RAPIER.Collider) => boolean,
): boolean {
  const point = new THREE.Vector3();
  const push = new THREE.Vector3();
  const normal = new THREE.Vector3();
  let total = 0;
  world.contactPairsWith(collider, (other) => {
    if (ignore?.(other)) return;
    world.contactPair(collider, other, (manifold, flipped) => {
      const n = manifold.normal();
      // The manifold normal points from its first shape to its second; the car is pushed away from `other`
      normal.set(n.x, n.y, n.z).multiplyScalar(flipped ? 1 : -1);
      for (let i = 0; i < manifold.numSolverContacts(); i++) {
        const p = manifold.solverContactPoint(i);
        const impulse = i < manifold.numContacts() ? manifold.contactImpulse(i) : 0;
        const weight = Math.max(impulse, 1e-3);
        if (!p) continue;
        point.x += p.x * weight;
        point.y += p.y * weight;
        point.z += p.z * weight;
        push.addScaledVector(normal, weight);
        total += weight;
      }
    });
  });
  if (total <= 0 || push.lengthSq() < 1e-12) return false;
  const body = collider.parent();
  if (!body) return false;
  const t = body.translation();
  const r = body.rotation();
  const inverse = new THREE.Quaternion(r.x, r.y, r.z, r.w).invert();
  localPoint.copy(point.divideScalar(total)).sub(new THREE.Vector3(t.x, t.y, t.z)).applyQuaternion(inverse);
  localDirection.copy(push).normalize().applyQuaternion(inverse);
  return true;
}

/**
 * Fallback impact estimate from a world-space velocity change: whatever was hit pushed the car along
 * Δv, so it struck the chassis box (`center`, `half`, car frame) where a ray from the center against
 * Δv comes out. Rotation is the body's, e.g. `body.rotation()`.
 */
export function impactFromVelocity(
  dv: THREE.Vector3,
  rotation: { x: number; y: number; z: number; w: number },
  center: THREE.Vector3,
  half: THREE.Vector3,
  localPoint: THREE.Vector3,
  localDirection: THREE.Vector3,
): boolean {
  if (dv.lengthSq() < 1e-8) return false;
  const inverse = new THREE.Quaternion(rotation.x, rotation.y, rotation.z, rotation.w).invert();
  localDirection.copy(dv).applyQuaternion(inverse).normalize();
  const d = localDirection;
  const t = Math.min(
    Math.abs(d.x) > 1e-6 ? half.x / Math.abs(d.x) : Infinity,
    Math.abs(d.y) > 1e-6 ? half.y / Math.abs(d.y) : Infinity,
    Math.abs(d.z) > 1e-6 ? half.z / Math.abs(d.z) : Infinity,
  );
  localPoint.copy(center).addScaledVector(d, -t);
  return true;
}


// --- Hot loops: standalone, typed arrays and numbers only, so V8 keeps them optimized ---

const EMPTY = new Uint8Array(0);

/**
 * Dent every vertex of one mesh that lies inside the impact sphere. `m` and `n` are the mesh's world
 * matrix and its inverse. Writes moved vertex indices to `moved` and [first, last, glass cracked] to
 * `span`; returns how many moved.
 */
function dentVertices(
  pos: Float32Array, rest: Float32Array, count: number, m: Float64Array, n: Float64Array, F: Field,
  groupOf: Uint32Array, groupNormals: Float32Array, frozen: Uint8Array, materialOf: Uint8Array, glass: Uint8Array,
  moved: Uint32Array, span: Int32Array,
): number {
  const { px, py, pz, dx, dy, dz, r, r2, depth, foldPhase, upX, upY, upZ, waves, zones } = F;
  const k0x = waves[0], k0y = waves[1], k0z = waves[2], a0 = waves[3];
  const k1x = waves[4], k1y = waves[5], k1z = waves[6], a1 = waves[7];
  const m0 = m[0], m1 = m[1], m2 = m[2], m4 = m[4], m5 = m[5], m6 = m[6], m8 = m[8], m9 = m[9], m10 = m[10], m12 = m[12], m13 = m[13], m14 = m[14];
  const n0 = n[0], n1 = n[1], n2 = n[2], n4 = n[4], n5 = n[5], n6 = n[6], n8 = n[8], n9 = n[9], n10 = n[10], n12 = n[12], n13 = n[13], n14 = n[14];
  // The impact sphere seen in mesh space is an ellipsoid; this is its bounding box, a cheap first cull
  const lcx = n0 * px + n4 * py + n8 * pz + n12;
  const lcy = n1 * px + n5 * py + n9 * pz + n13;
  const lcz = n2 * px + n6 * py + n10 * pz + n14;
  const ex = r * Math.sqrt(n0 * n0 + n4 * n4 + n8 * n8);
  const ey = r * Math.sqrt(n1 * n1 + n5 * n5 + n9 * n9);
  const ez = r * Math.sqrt(n2 * n2 + n6 * n6 + n10 * n10);
  const zoneEnd = zones.length;
  const hasFrozen = frozen.length > 0;
  const hasSlots = materialOf.length > 0;
  let anyGlass = false;
  for (let j = 0; j < glass.length; j++) if (glass[j]) anyGlass = true;
  const foldK = Math.PI / CREASE_SPACING;
  const max2 = MAX_DISPLACEMENT * MAX_DISPLACEMENT;
  const crack2 = GLASS_CRACK_MOVE * GLASS_CRACK_MOVE;
  let cracked = 0;
  let movedCount = 0;
  let lo = count;
  let hi = -1;

  for (let i = 0, k = 0; i < count; i++, k += 3) {
    const x = pos[k];
    const y = pos[k + 1];
    const z = pos[k + 2];
    if (Math.abs(x - lcx) > ex || Math.abs(y - lcy) > ey || Math.abs(z - lcz) > ez) continue;
    if (hasFrozen && frozen[i] !== 0) continue;
    const wx = m0 * x + m4 * y + m8 * z + m12;
    const wy = m1 * x + m5 * y + m9 * z + m13;
    const wz = m2 * x + m6 * y + m10 * z + m14;
    const ox = wx - px;
    const oy = wy - py;
    const oz = wz - pz;
    const d2 = ox * ox + oy * oy + oz * oz;
    if (d2 >= r2) continue;
    const q = 1 - d2 / r2;
    const f = depth * q * q;

    // Push along the impact, varied by smooth noise so the dent is uneven
    const noise = fastSin(k0x * wx + k0y * wy + k0z * wz + a0) * fastSin(k1x * wx + k1y * wy + k1z * wz + a1);
    const push = f * (1 + CRUMPLE * noise);
    // Buckling: panels running along the push fold out of their plane in sharp creases, the way a hood
    // concertinas; panels facing the push just cave in. It follows the welded rest normal, so split
    // vertices at hard edges and seams move together and the mesh never tears.
    const g = groupOf[i] * 3;
    const gx = groupNormals[g];
    const gy = groupNormals[g + 1];
    const gz = groupNormals[g + 2];
    let nx = m0 * gx + m4 * gy + m8 * gz;
    let ny = m1 * gx + m5 * gy + m9 * gz;
    let nz = m2 * gx + m6 * gy + m10 * gz;
    const nd = nx * dx + ny * dy + nz * dz;
    nx -= nd * dx;
    ny -= nd * dy;
    nz -= nd * dz;
    const nl = Math.sqrt(nx * nx + ny * ny + nz * nz + nd * nd) + 1e-9;
    const along = ox * dx + oy * dy + oz * dz;
    const fold = (f * FOLD * (1 - 2 * Math.abs(fastSin(along * foldK + foldPhase)))) / nl;
    let tx = wx + dx * push + nx * fold;
    let ty = wy + dy * push + ny * fold;
    let tz = wz + dz * push + nz * fold;

    // Never further than MAX_DISPLACEMENT from the factory shape
    const rx = rest[k];
    const ry = rest[k + 1];
    const rz = rest[k + 2];
    const bx = m0 * rx + m4 * ry + m8 * rz + m12;
    const by = m1 * rx + m5 * ry + m9 * rz + m13;
    const bz = m2 * rx + m6 * ry + m10 * rz + m14;
    let ux = tx - bx;
    let uy = ty - by;
    let uz = tz - bz;
    const u2 = ux * ux + uy * uy + uz * uz;
    if (u2 > max2) {
      const c = MAX_DISPLACEMENT / Math.sqrt(u2);
      tx = bx + ux * c;
      ty = by + uy * c;
      tz = bz + uz * c;
    }

    // Keep the body out of the tires: anything pushed into a wheel slides out around it
    for (let b = 0; b < zoneEnd; b += 8) {
      const qx = tx - zones[b];
      const qy = ty - zones[b + 1];
      const qz = tz - zones[b + 2];
      const a = qx * zones[b + 3] + qy * zones[b + 4] + qz * zones[b + 5];
      if (Math.abs(a) > zones[b + 7]) continue;
      let sx = qx - a * zones[b + 3];
      let sy = qy - a * zones[b + 4];
      let sz = qz - a * zones[b + 5];
      let sl = Math.sqrt(sx * sx + sy * sy + sz * sz);
      const radius = zones[b + 6];
      if (sl >= radius) continue;
      if (sl < 1e-6) {
        sx = upX;
        sy = upY;
        sz = upZ;
        sl = 1;
      }
      const c = radius / sl;
      tx = zones[b] + a * zones[b + 3] + sx * c;
      ty = zones[b + 1] + a * zones[b + 4] + sy * c;
      tz = zones[b + 2] + a * zones[b + 5] + sz * c;
    }

    const vx = tx - wx;
    const vy = ty - wy;
    const vz = tz - wz;
    if (vx * vx + vy * vy + vz * vz < MIN_MOVE * MIN_MOVE) continue;
    pos[k] = n0 * tx + n4 * ty + n8 * tz + n12;
    pos[k + 1] = n1 * tx + n5 * ty + n9 * tz + n13;
    pos[k + 2] = n2 * tx + n6 * ty + n10 * tz + n14;
    moved[movedCount++] = i;
    if (i < lo) lo = i;
    hi = i;
    if (anyGlass && cracked === 0 && glass[hasSlots ? materialOf[i] : 0] === 1) {
      ux = tx - bx;
      uy = ty - by;
      uz = tz - bz;
      if (ux * ux + uy * uy + uz * uz > crack2) cracked = 1;
    }
  }
  span[0] = lo;
  span[1] = hi;
  span[2] = cracked;
  return movedCount;
}

/**
 * New normals around the moved vertices. Each welded point's face-averaged normal is recomputed, and
 * the authored vertex normals are turned by the same rotation it went through since the factory
 * shape. That keeps hard edges hard and UV seams invisible, and non-indexed meshes stay smooth.
 * Writes the touched vertex range to `span`; false if none.
 */
function renormal(topo: Topology, moved: Uint32Array, movedCount: number, pos: Float32Array, normals: Float32Array, span: Int32Array): boolean {
  const stamp = ++topo.stamp;
  const { groupOf, groupFaceStart, groupFaces, groupVertStart, groupVerts, corners, movedMark, dirtyMark, faceMark, dirty, faceNormals } = topo;
  const restNormals = topo.restNormals!;
  const r0 = topo.restGroupNormals;
  // Every point on a face touching a moved point needs a new normal
  let dirtyCount = 0;
  for (let j = 0; j < movedCount; j++) {
    const g = groupOf[moved[j]];
    if (movedMark[g] === stamp) continue;
    movedMark[g] = stamp;
    for (let e = groupFaceStart[g], end = groupFaceStart[g + 1]; e < end; e++) {
      const o = groupFaces[e] * 3;
      for (let c = o; c < o + 3; c++) {
        const g2 = groupOf[corners[c]];
        if (dirtyMark[g2] === stamp) continue;
        dirtyMark[g2] = stamp;
        dirty[dirtyCount++] = g2;
      }
    }
  }

  let lo = 0x7fffffff;
  let hi = -1;
  for (let j = 0; j < dirtyCount; j++) {
    const g = dirty[j];
    let bx = 0;
    let by = 0;
    let bz = 0;
    for (let e = groupFaceStart[g], end = groupFaceStart[g + 1]; e < end; e++) {
      const f = groupFaces[e];
      const o = f * 3;
      if (faceMark[f] !== stamp) {
        faceMark[f] = stamp;
        faceNormal(pos, corners[o], corners[o + 1], corners[o + 2], faceNormals, o);
      }
      bx += faceNormals[o];
      by += faceNormals[o + 1];
      bz += faceNormals[o + 2];
    }
    const bl = Math.sqrt(bx * bx + by * by + bz * bz);
    const ax = r0[g * 3];
    const ay = r0[g * 3 + 1];
    const az = r0[g * 3 + 2];
    const valid = bl > 1e-12 && ax * ax + ay * ay + az * az > 0.5;
    if (valid) {
      bx /= bl;
      by /= bl;
      bz /= bl;
    }
    // Rotation taking the rest normal a to the new normal b (Rodrigues, with v = a × b)
    const c = ax * bx + ay * by + az * bz;
    const vx = ay * bz - az * by;
    const vy = az * bx - ax * bz;
    const vz = ax * by - ay * bx;
    const flip = 1 / (1 + c);
    for (let e = groupVertStart[g], end = groupVertStart[g + 1]; e < end; e++) {
      const vtx = groupVerts[e];
      const k = vtx * 3;
      const x = restNormals[k];
      const y = restNormals[k + 1];
      const z = restNormals[k + 2];
      let ox = x;
      let oy = y;
      let oz = z;
      if (valid && c > -0.95) {
        const dot = (vx * x + vy * y + vz * z) * flip;
        ox = x * c + (vy * z - vz * y) + vx * dot;
        oy = y * c + (vz * x - vx * z) + vy * dot;
        oz = z * c + (vx * y - vy * x) + vz * dot;
      } else if (valid) {
        ox = bx;
        oy = by;
        oz = bz;
      }
      const ol = Math.sqrt(ox * ox + oy * oy + oz * oz);
      if (ol > 1e-12) {
        normals[k] = ox / ol;
        normals[k + 1] = oy / ol;
        normals[k + 2] = oz / ol;
      }
      if (vtx < lo) lo = vtx;
      if (vtx > hi) hi = vtx;
    }
  }
  span[0] = lo;
  span[1] = hi;
  return hi >= 0;
}

// --- Geometry plumbing ---

function defaultIsGlass(material: THREE.Material, mesh: THREE.Mesh): boolean {
  if (GLASS_NAME.test(material.name) || GLASS_NAME.test(mesh.name)) return true;
  const m = material as THREE.MeshPhysicalMaterial;
  if (m.transmission > 0) return true;
  if (material.transparent && material.opacity < 1 && material.blending === THREE.NormalBlending) return true;
  // Unnamed procedural glass: a smooth, non-metallic lit surface
  return (m.isMeshStandardMaterial === true) && m.roughness <= 0.06 && m.metalness <= 0.3 && !m.map;
}

/** Objects matching `pattern` with no matching ancestor below `root`. */
function topmostNamed(root: THREE.Object3D, pattern: RegExp): THREE.Object3D[] {
  const found: THREE.Object3D[] = [];
  const walk = (o: THREE.Object3D) => {
    if (o !== root && pattern.test(o.name)) {
      found.push(o);
      return;
    }
    for (const child of o.children) walk(child);
  };
  walk(root);
  return found;
}

/** Bounds of an object's meshes in the root's frame. */
function boundsInRoot(object: THREE.Object3D, root: THREE.Object3D): THREE.Box3 {
  const toRoot = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const m = new THREE.Matrix4();
  const box = new THREE.Box3();
  const part = new THREE.Box3();
  object.updateWorldMatrix(true, true);
  object.traverse((o) => {
    const geometry = (o as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
    if (!(o as THREE.Mesh).isMesh || !geometry?.attributes.position) return;
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    box.union(part.copy(geometry.boundingBox!).applyMatrix4(m.multiplyMatrices(toRoot, o.matrixWorld)));
  });
  return box;
}

/** A float copy of a (possibly interleaved or quantized) attribute. */
function floatArray(attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute): Float32Array {
  if (attribute instanceof THREE.BufferAttribute && attribute.array instanceof Float32Array && attribute.itemSize === 3) {
    return attribute.array.slice(0, attribute.count * 3);
  }
  const out = new Float32Array(attribute.count * 3);
  for (let i = 0; i < attribute.count; i++) {
    out[i * 3] = attribute.getX(i);
    out[i * 3 + 1] = attribute.getY(i);
    out[i * 3 + 2] = attribute.getZ(i);
  }
  return out;
}

/** sin(x) to within about 0.001 and several times cheaper than Math.sin, which is plenty for noise. */
function fastSin(x: number): number {
  const t = x - 2 * Math.PI * Math.round(x / (2 * Math.PI));
  const y = t * (4 / Math.PI - (4 / (Math.PI * Math.PI)) * Math.abs(t));
  return y * (0.775 + 0.225 * Math.abs(y));
}

/** Area-weighted normal of triangle (a, b, c) into out[o..o+2]. */
function faceNormal(pos: Float32Array, a: number, b: number, c: number, out: Float32Array, o: number): void {
  const ax = pos[a * 3];
  const ay = pos[a * 3 + 1];
  const az = pos[a * 3 + 2];
  const e1x = pos[b * 3] - ax;
  const e1y = pos[b * 3 + 1] - ay;
  const e1z = pos[b * 3 + 2] - az;
  const e2x = pos[c * 3] - ax;
  const e2y = pos[c * 3 + 1] - ay;
  const e2z = pos[c * 3 + 2] - az;
  out[o] = e1y * e2z - e1z * e2y;
  out[o + 1] = e1z * e2x - e1x * e2z;
  out[o + 2] = e1x * e2y - e1y * e2x;
}

/** Built once per source geometry, on the first hit to any car using it. */
function topologyOf(geometry: THREE.BufferGeometry): Topology {
  const cached = topologies.get(geometry);
  if (cached) return cached;
  const position = geometry.attributes.position;
  const count = position.count;
  const rest = floatArray(position);
  const normalAttr = geometry.attributes.normal;
  const restNormals = normalAttr ? floatArray(normalAttr) : null;
  const index = geometry.index ? geometry.index.array : null;
  const faceCount = Math.floor((index ? index.length : count) / 3);
  const corners = new Uint32Array(faceCount * 3);
  for (let c = 0; c < corners.length; c++) corners[c] = index ? index[c] : c;

  // Weld split vertices (UV seams, hard edges, non-indexed meshes) by quantized position
  if (!geometry.boundingSphere) geometry.computeBoundingSphere();
  const quantum = 1 / Math.max(1e-9, (geometry.boundingSphere!.radius || 1) * WELD_TOLERANCE);
  const size = 1 << Math.ceil(Math.log2(Math.max(2, count * 2)));
  const mask = size - 1;
  const table = new Int32Array(size).fill(-1);
  const quantized = new Int32Array(count * 3);
  const groupOf = new Uint32Array(count);
  let groups = 0;
  for (let i = 0; i < count; i++) {
    const qx = Math.round(rest[i * 3] * quantum) | 0;
    const qy = Math.round(rest[i * 3 + 1] * quantum) | 0;
    const qz = Math.round(rest[i * 3 + 2] * quantum) | 0;
    quantized[i * 3] = qx;
    quantized[i * 3 + 1] = qy;
    quantized[i * 3 + 2] = qz;
    let h = (Math.imul(qx, 73856093) ^ Math.imul(qy, 19349663) ^ Math.imul(qz, 83492791)) & mask;
    for (;;) {
      const t = table[h];
      if (t < 0) {
        table[h] = i;
        groupOf[i] = groups++;
        break;
      }
      if (quantized[t * 3] === qx && quantized[t * 3 + 1] === qy && quantized[t * 3 + 2] === qz) {
        groupOf[i] = groupOf[t];
        break;
      }
      h = (h + 1) & mask;
    }
  }

  // Compressed adjacency: welded point → faces, and → vertices
  const groupFaceStart = new Uint32Array(groups + 1);
  for (let c = 0; c < faceCount * 3; c++) groupFaceStart[groupOf[corners[c]] + 1]++;
  for (let g = 0; g < groups; g++) groupFaceStart[g + 1] += groupFaceStart[g];
  const groupFaces = new Uint32Array(faceCount * 3);
  const fill = groupFaceStart.slice(0, groups);
  for (let c = 0; c < faceCount * 3; c++) groupFaces[fill[groupOf[corners[c]]]++] = (c / 3) | 0;
  const groupVertStart = new Uint32Array(groups + 1);
  for (let i = 0; i < count; i++) groupVertStart[groupOf[i] + 1]++;
  for (let g = 0; g < groups; g++) groupVertStart[g + 1] += groupVertStart[g];
  const groupVerts = new Uint32Array(count);
  fill.set(groupVertStart.subarray(0, groups));
  for (let i = 0; i < count; i++) groupVerts[fill[groupOf[i]]++] = i;

  // Rest normal of each welded point, from the factory faces
  const faceNormals = new Float32Array(faceCount * 3);
  for (let o = 0; o < faceCount * 3; o += 3) faceNormal(rest, corners[o], corners[o + 1], corners[o + 2], faceNormals, o);
  const restGroupNormals = new Float32Array(groups * 3);
  for (let c = 0; c < faceCount * 3; c++) {
    const g = groupOf[corners[c]] * 3;
    const o = c - (c % 3);
    restGroupNormals[g] += faceNormals[o];
    restGroupNormals[g + 1] += faceNormals[o + 1];
    restGroupNormals[g + 2] += faceNormals[o + 2];
  }
  for (let g = 0; g < groups * 3; g += 3) {
    const l = Math.hypot(restGroupNormals[g], restGroupNormals[g + 1], restGroupNormals[g + 2]);
    if (l > 1e-12) {
      restGroupNormals[g] /= l;
      restGroupNormals[g + 1] /= l;
      restGroupNormals[g + 2] /= l;
    }
  }

  let materialOf: Uint8Array | null = null;
  if (geometry.groups.length) {
    materialOf = new Uint8Array(count).fill(255);
    const end = index ? index.length : count;
    for (const g of geometry.groups) {
      for (let j = g.start; j < Math.min(g.start + g.count, end); j++) materialOf[index ? index[j] : j] = g.materialIndex ?? 0;
    }
  }

  const topo: Topology = {
    rest, restNormals, materialOf, corners, groupOf, groupFaceStart, groupFaces, groupVertStart, groupVerts, restGroupNormals,
    stamp: 0,
    movedMark: new Uint32Array(groups),
    dirtyMark: new Uint32Array(groups),
    faceMark: new Uint32Array(faceCount),
    faceNormals,
    dirty: new Uint32Array(groups),
  };
  topologies.set(geometry, topo);
  return topo;
}

/** Upload only vertices lo..hi of a 3-component attribute on the next render. */
function markRange(attribute: THREE.BufferAttribute, lo: number, hi: number): void {
  attribute.addUpdateRange(lo * 3, (hi - lo + 1) * 3);
  attribute.needsUpdate = true;
}

/** Free a damaged clone's own buffers without touching the ones it shares with the original. */
function releaseClone(clone: THREE.BufferGeometry, source: THREE.BufferGeometry): void {
  clone.setIndex(null);
  for (const name of Object.keys(clone.attributes)) {
    if (clone.attributes[name] === source.attributes[name]) clone.deleteAttribute(name);
  }
  clone.morphAttributes = {};
  clone.dispose();
}
