// Ambient traffic on the map's road network: cars drive the path graph in right-hand lanes, pick a
// turn at each junction, slow for corners and queue behind whatever is ahead. They are dynamic bodies
// steered by velocity, so a hard hit knocks them out of their lane and plain physics takes over
// ("wrecked"). Only a population around the player exists; cars spawn and despawn with distance.
// The cars are mod models drawn with GPU instancing: one draw call per model part for all cars.
import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { MeshoptSimplifier } from 'meshoptimizer';
import { CAR_GROUP, type RoadGraph, type RoadLink } from './map';
import { modCarVisual, type Template } from './modcar';
import { mulberry32, pick } from './random';

const CRUISE = 13; // m/s, about 47 km/h
const CORNER_SPEED = 6;
const ACCEL = 3;
const BRAKE = 7;
const FOLLOW_GAP = 8; // center-to-center distance when queued
const LOOK_AHEAD = 32;
const JUNCTION_APPROACH = 22; // m before a junction where cars start checking it
const JUNCTION_BOX = 7; // m around the junction node that counts as occupied
const JUNCTION_STOP = 11; // m short of the node where a yielding car waits
const CORRIDOR = 2.3; // half-width of the lane corridor checked for a leader
const SPAWN_MIN = 90;
const SPAWN_MAX = 280;
const SPAWN_SPACING = 16;
const DESPAWN = 320;
const WRECK_DESPAWN = 70;
const WRECK_SPEED_JUMP = 4; // m/s of unexpected velocity change that knocks a car out of its lane
const WRECK_DRIFT = 3.5; // meters off its path
const POSITION_GAIN = 4;
const HEIGHT_GAIN = 8;
// Driving cars touch only other cars: the city's collision mesh has seams and curbs that would jolt
// them out of lane. They ride the road height from the path nodes instead. Wrecks collide with everything.
const DRIVING_GROUPS = (CAR_GROUP << 16) | CAR_GROUP;
const WRECK_GROUPS = (CAR_GROUP << 16) | 0xffff;
const YAW_GAIN = 8;
const MASS = 1500;
const LANE_WIDTH = 3.4;
const PAINTS = [0x1c1e24, 0x8a8f99, 0xc9ccd2, 0x2b3a55, 0x5a1f24, 0x1f4a3a, 0x3a3a40, 0xe0e0e0, 0x6b5a3a];
const TAXI_PAINT = 0xf2b705;
const INTERIOR = /interior|dash|cloth|badges/; // shaders traffic never shows well enough to pay for
const SIMPLIFY_RATIO = 0.25;
// Shared by every traffic model: paint takes each car's color per instance, the rest vertex colors
const FLEET_MATERIALS = {
  paint: new THREE.MeshPhysicalMaterial({ color: 0xffffff, metalness: 0.6, roughness: 0.32, clearcoat: 1, clearcoatRoughness: 0.08 }),
  glass: new THREE.MeshStandardMaterial({ color: 0x07090d, roughness: 0.08, metalness: 0.7 }),
  lights: new THREE.MeshBasicMaterial({ vertexColors: true }),
  body: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.3 }),
};
const SIMPLIFY_ERROR = 0.02; // relative to the mesh size

/** A traffic car as other systems see it: near-miss checks, rival avoidance. */
export interface Agent {
  id: number;
  x: number;
  z: number;
  vx: number;
  vz: number;
  wrecked: boolean;
}

/** One traffic model: its visual parts, instanced for every car that uses it. */
class Fleet {
  readonly parts: { mesh: THREE.InstancedMesh; local: THREE.Matrix4; paint: boolean }[] = [];
  readonly chassisCenter: THREE.Vector3;
  readonly chassisHalf: THREE.Vector3;
  readonly slots: (TrafficCar | null)[];

  constructor(scene: THREE.Scene, template: Template, readonly taxi: boolean, capacity: number) {
    const visual = modCarVisual(template, { paint: 0xffffff });
    visual.root.updateMatrixWorld(true);
    // Collapse the model into four batches (paint, glass, lights, everything else), so a traffic car
    // costs four draw calls however many materials the mod has. Textures give way to each material's
    // average color, baked into vertex colors: at traffic distance the detail doesn't read anyway.
    const groups: Record<'paint' | 'glass' | 'lights' | 'body', THREE.BufferGeometry[]> = { paint: [], glass: [], lights: [], body: [] };
    const color = new THREE.Color();
    visual.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const material = mesh.material as THREE.MeshStandardMaterial;
      const info = material.userData as { shader?: string; average?: number[]; emissive?: boolean };
      if (INTERIOR.test(info.shader ?? '')) return;
      const kind = (material as THREE.MeshPhysicalMaterial).clearcoat === 1 ? 'paint'
        : material.transparent ? 'glass'
        : info.emissive ? 'lights' : 'body';
      color.copy(material.color);
      if (material.map && info.average) color.multiply(new THREE.Color(...(info.average as [number, number, number])).convertSRGBToLinear());
      if (kind === 'lights') color.multiplyScalar(2.2);
      const g = plainGeometry(mesh.geometry).applyMatrix4(mesh.matrixWorld);
      const n = g.getAttribute('position').count;
      const colors = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) colors.set([color.r, color.g, color.b], i * 3);
      g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      g.deleteAttribute('uv');
      groups[kind].push(g);
    });
    for (const [kind, geos] of Object.entries(groups)) {
      if (geos.length === 0) continue;
      const geometry = mergeGeometries(geos, false);
      if (!geometry) continue;
      simplify(geometry);
      const inst = new THREE.InstancedMesh(geometry, FLEET_MATERIALS[kind as keyof typeof groups], capacity);
      inst.count = 0;
      inst.visible = false;
      inst.frustumCulled = false;
      const paint = kind === 'paint';
      if (paint) inst.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
      scene.add(inst);
      this.parts.push({ mesh: inst, local: new THREE.Matrix4(), paint });
    }
    this.chassisCenter = visual.chassisCenter;
    this.chassisHalf = visual.chassisHalf;
    this.slots = new Array(capacity).fill(null);
  }
}

class TrafficCar {
  active = false;
  wrecked = false;
  wreckedAt = 0;
  link!: RoadLink;
  forwardOnLink = true; // driving a→b
  lane = 0;
  s = 0; // meters along the link
  next = -1; // node after the end of this link
  speed = 0;
  paint = new THREE.Color();
  readonly position = new THREE.Vector3();
  readonly forward = new THREE.Vector3(1, 0, 0);
  readonly commanded = new THREE.Vector3();

  constructor(readonly body: RAPIER.RigidBody, readonly fleet: Fleet, readonly slot: number, readonly cruise: number) {}
}

export class Traffic {
  private readonly cars: TrafficCar[] = [];
  private readonly rng = mulberry32(451);
  private readonly target = new THREE.Vector3();
  private readonly tangent = new THREE.Vector3();
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly one = new THREE.Vector3(1, 1, 1);
  private filled = false;

  constructor(world: RAPIER.World, scene: THREE.Scene, private readonly roads: RoadGraph, models: { template: Template; taxi: boolean }[], count: number) {
    if (models.length === 0 || count === 0) return;
    const per = Math.ceil(count / models.length);
    const fleets = models.map((m) => new Fleet(scene, m.template, m.taxi, per));
    for (let k = 0; k < count; k++) {
      const fleet = fleets[k % fleets.length];
      const slot = Math.floor(k / fleets.length);
      const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setEnabled(false).setCcdEnabled(true));
      const c = fleet.chassisCenter;
      const h = fleet.chassisHalf;
      const inertia = {
        x: (MASS / 12) * ((2 * h.y) ** 2 + (2 * h.z) ** 2),
        y: (MASS / 12) * ((2 * h.x) ** 2 + (2 * h.z) ** 2),
        z: (MASS / 12) * ((2 * h.x) ** 2 + (2 * h.y) ** 2),
      };
      // The box reaches down to the ground so the car rests on it without wheels
      const bottom = 0.05;
      const top = c.y + h.y;
      world.createCollider(
        RAPIER.ColliderDesc.cuboid(h.x, (top - bottom) / 2, h.z)
          .setCollisionGroups(DRIVING_GROUPS)
          .setTranslation(c.x, (top + bottom) / 2, c.z)
          .setMassProperties(MASS, { x: 0, y: 0.5 - (top + bottom) / 2, z: 0 }, inertia, { x: 0, y: 0, z: 0, w: 1 })
          .setFriction(0.3),
        body,
      );
      const car = new TrafficCar(body, fleet, slot, CRUISE * (0.85 + this.rng() * 0.25));
      car.paint.set(fleet.taxi ? TAXI_PAINT : pick(this.rng, PAINTS));
      fleet.slots[slot] = car;
      this.cars.push(car);
    }
  }

  /** Plan speeds and steer every lane-following car. Call before world.step(). */
  fixedUpdate(dt: number, _time: number, player: THREE.Vector3): void {
    for (const car of this.cars) {
      if (!car.active || car.wrecked) continue;
      const p = car.body.translation();
      car.position.set(p.x, p.y, p.z);

      let desired = car.cruise;
      const remaining = car.link.length - car.s;
      const turn = this.turnAngle(car);
      if (turn > 0.5 && remaining < 25) desired = Math.min(desired, CORNER_SPEED + remaining * 0.3);
      // Unsignalled junctions: wait short of the node while someone else is crossing it
      const end = this.endNode(car);
      if (remaining < JUNCTION_APPROACH && this.roads.adjacent[end].length >= 3) {
        const node = this.roads.nodes[end];
        const busy = this.cars.some((o) => o !== car && o.active && !o.wrecked
          && Math.hypot(o.position.x - node.x, o.position.z - node.z) < JUNCTION_BOX
          && o.forward.x * car.forward.x + o.forward.z * car.forward.z < 0.7);
        if (busy) desired = Math.min(desired, Math.max(0, (remaining - JUNCTION_STOP) * 1.2));
      }
      const gap = this.gapAhead(car, player);
      if (gap < LOOK_AHEAD) desired = Math.min(desired, Math.max(0, (gap - FOLLOW_GAP) * 1.2));
      car.speed += THREE.MathUtils.clamp(desired - car.speed, -BRAKE * dt, ACCEL * dt);

      this.advance(car, car.speed * dt);
      this.lanePoint(car, car.s, this.target, this.tangent);
      car.forward.copy(this.tangent);
      car.commanded.set(
        this.tangent.x * car.speed + (this.target.x - p.x) * POSITION_GAIN,
        0,
        this.tangent.z * car.speed + (this.target.z - p.z) * POSITION_GAIN,
      );
      car.body.setLinvel({ x: car.commanded.x, y: (this.target.y - p.y) * HEIGHT_GAIN, z: car.commanded.z }, true);
      const r = car.body.rotation();
      const yaw = 2 * Math.atan2(r.y, r.w);
      const targetYaw = Math.atan2(-this.tangent.z, this.tangent.x);
      car.body.setAngvel({ x: 0, y: wrapAngle(targetYaw - yaw) * YAW_GAIN, z: 0 }, true);
    }
  }

  /** After world.step(): anything knocked off its commanded motion becomes a free physics wreck. */
  postStep(time: number): void {
    for (const car of this.cars) {
      if (!car.active || car.wrecked) continue;
      const v = car.body.linvel();
      const p = car.body.translation();
      this.lanePoint(car, car.s, this.target, this.tangent);
      const jump = Math.hypot(v.x - car.commanded.x, v.z - car.commanded.z);
      const off = Math.hypot(p.x - this.target.x, p.z - this.target.z);
      if (jump > WRECK_SPEED_JUMP || off > WRECK_DRIFT) this.wreck(car, time);
    }
  }

  /** Despawn far cars, spawn new ones around the player, and move the instances to their bodies. */
  update(time: number, player: THREE.Vector3): void {
    for (const car of this.cars) {
      if (!car.active) continue;
      const p = car.body.translation();
      const dist = Math.hypot(p.x - player.x, p.z - player.z);
      const road = this.roads.nodes[car.link.a].y;
      if (dist > DESPAWN || (car.wrecked && dist > WRECK_DESPAWN && time - car.wreckedAt > 4) || p.y < road - 15) this.deactivate(car);
    }
    let budget = this.filled ? 3 : Infinity;
    for (const car of this.cars) {
      if (car.active || budget <= 0) continue;
      if (this.spawn(car, player, this.filled ? SPAWN_MIN : 30)) budget--;
    }
    this.filled = true;
    this.render();
  }

  positions(): THREE.Vector3[] {
    return this.cars.filter((c) => c.active).map((c) => {
      const p = c.body.translation();
      return new THREE.Vector3(p.x, p.y, p.z);
    });
  }

  /** Active cars within `radius` of (x, z). */
  nearby(x: number, z: number, radius: number): Agent[] {
    const out: Agent[] = [];
    this.cars.forEach((c, id) => {
      if (!c.active) return;
      const p = c.body.translation();
      if (Math.abs(p.x - x) > radius || Math.abs(p.z - z) > radius) return;
      const v = c.body.linvel();
      out.push({ id, x: p.x, z: p.z, vx: v.x, vz: v.z, wrecked: c.wrecked });
    });
    return out;
  }

  /** Despawn every car within `radius` of (x, z), to clear an event's starting grid. */
  clearAround(x: number, z: number, radius: number): void {
    for (const c of this.cars) {
      if (!c.active) continue;
      const p = c.body.translation();
      if (Math.hypot(p.x - x, p.z - z) < radius) this.deactivate(c);
    }
  }

  stats(): { active: number; moving: number; wrecked: number; avgSpeed: number } {
    const active = this.cars.filter((c) => c.active);
    const driving = active.filter((c) => !c.wrecked);
    return {
      active: active.length,
      moving: driving.filter((c) => c.speed > 1).length,
      wrecked: active.length - driving.length,
      avgSpeed: driving.reduce((s, c) => s + c.speed, 0) / Math.max(1, driving.length),
    };
  }

  private render(): void {
    const fleets = new Set(this.cars.map((c) => c.fleet));
    for (const fleet of fleets) {
      let n = 0;
      for (const car of fleet.slots) {
        if (!car?.active) continue;
        const p = car.body.translation();
        const r = car.body.rotation();
        this.m.compose(this.target.set(p.x, p.y, p.z), this.q.set(r.x, r.y, r.z, r.w), this.one);
        for (const part of fleet.parts) {
          part.mesh.setMatrixAt(n, this.tangentMatrix.multiplyMatrices(this.m, part.local));
          if (part.paint) part.mesh.setColorAt(n, car.paint);
        }
        n++;
      }
      for (const part of fleet.parts) {
        part.mesh.count = n;
        part.mesh.visible = n > 0;
        part.mesh.instanceMatrix.needsUpdate = true;
        if (part.mesh.instanceColor) part.mesh.instanceColor.needsUpdate = true;
      }
    }
  }

  private readonly tangentMatrix = new THREE.Matrix4();

  private deactivate(car: TrafficCar): void {
    car.active = false;
    car.body.setEnabled(false);
  }

  private spawn(car: TrafficCar, player: THREE.Vector3, minDist: number): boolean {
    const links = this.roads.links;
    for (let attempt = 0; attempt < 30; attempt++) {
      const link = links[Math.floor(this.rng() * links.length)];
      const forward = this.rng() < 0.5 ? link.lanesAB > 0 : link.lanesBA === 0;
      const lanes = forward ? link.lanesAB : link.lanesBA;
      if (lanes === 0 || link.length < 10) continue;
      car.link = link;
      car.forwardOnLink = forward;
      car.lane = Math.floor(this.rng() * lanes);
      car.s = link.length * (0.2 + this.rng() * 0.6);
      this.lanePoint(car, car.s, this.target, this.tangent);
      const dist = Math.hypot(this.target.x - player.x, this.target.z - player.z);
      if (dist < minDist || dist > SPAWN_MAX) continue;
      if (this.cars.some((o) => o.active && o.position.distanceTo(this.target) < SPAWN_SPACING)) continue;

      car.next = this.chooseNext(car);
      car.speed = car.cruise * 0.8;
      car.active = true;
      car.wrecked = false;
      car.position.copy(this.target);
      car.forward.copy(this.tangent);
      car.commanded.copy(this.tangent).multiplyScalar(car.speed);
      const body = car.body;
      body.setEnabled(true);
      body.setTranslation({ x: this.target.x, y: this.target.y, z: this.target.z }, true);
      body.setRotation(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(-this.tangent.z, this.tangent.x)), true);
      body.setLinvel({ x: car.commanded.x, y: 0, z: car.commanded.z }, true);
      body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      body.setEnabledRotations(false, true, false, true);
      body.setLinearDamping(0);
      body.setAngularDamping(0);
      body.setGravityScale(0, true);
      body.collider(0).setCollisionGroups(DRIVING_GROUPS);
      return true;
    }
    return false;
  }

  private wreck(car: TrafficCar, time: number): void {
    car.wrecked = true;
    car.wreckedAt = time;
    car.body.setEnabledRotations(true, true, true, true);
    car.body.setGravityScale(1, true);
    car.body.collider(0).setCollisionGroups(WRECK_GROUPS);
    car.body.setLinearDamping(0.5);
    car.body.setAngularDamping(0.8);
  }

  /** Distance to the nearest car (or the player) in this car's lane corridor ahead. */
  private gapAhead(car: TrafficCar, player: THREE.Vector3): number {
    const f = car.forward;
    let gap = Infinity;
    const check = (x: number, z: number) => {
      const dx = x - car.position.x;
      const dz = z - car.position.z;
      const ahead = dx * f.x + dz * f.z;
      if (ahead <= 0 || ahead > LOOK_AHEAD) return;
      if (Math.abs(dz * f.x - dx * f.z) < CORRIDOR) gap = Math.min(gap, ahead);
    };
    for (const o of this.cars) if (o !== car && o.active) check(o.position.x, o.position.z);
    check(player.x, player.z);
    return gap;
  }

  private startNode(car: TrafficCar): number {
    return car.forwardOnLink ? car.link.a : car.link.b;
  }

  private endNode(car: TrafficCar): number {
    return car.forwardOnLink ? car.link.b : car.link.a;
  }

  /** Pick where to go at the end of the current link: any other road with lanes our way, else turn back. */
  private chooseNext(car: TrafficCar): number {
    const end = this.endNode(car);
    const from = this.startNode(car);
    const options = this.roads.adjacent[end].filter(({ link, other }) =>
      other !== from && (link.a === end ? link.lanesAB : link.lanesBA) > 0);
    if (options.length === 0) return from;
    return options[Math.floor(this.rng() * options.length)].other;
  }

  /** How sharply the car turns at the end of this link (radians). */
  private turnAngle(car: TrafficCar): number {
    const nodes = this.roads.nodes;
    const a = nodes[this.startNode(car)];
    const b = nodes[this.endNode(car)];
    const c = nodes[car.next];
    const d1x = b.x - a.x, d1z = b.z - a.z, d2x = c.x - b.x, d2z = c.z - b.z;
    const l = Math.hypot(d1x, d1z) * Math.hypot(d2x, d2z) || 1;
    return Math.acos(THREE.MathUtils.clamp((d1x * d2x + d1z * d2z) / l, -1, 1));
  }

  /** Move along the route, stepping onto the chosen next link at each node. */
  private advance(car: TrafficCar, ds: number): void {
    car.s += ds;
    while (car.s > car.link.length) {
      car.s -= car.link.length;
      const end = this.endNode(car);
      const next = car.next;
      const link = this.roads.adjacent[end].find((e) => e.other === next)?.link;
      if (!link) return;
      car.link = link;
      car.forwardOnLink = link.a === end;
      const lanes = car.forwardOnLink ? link.lanesAB : link.lanesBA;
      car.lane = Math.min(car.lane, Math.max(0, lanes - 1));
      car.next = this.chooseNext(car);
    }
  }

  /** Point in the car's lane at distance s along its link, and the travel direction there. */
  private lanePoint(car: TrafficCar, s: number, point: THREE.Vector3, tangent: THREE.Vector3): void {
    const a = this.roads.nodes[this.startNode(car)];
    const b = this.roads.nodes[this.endNode(car)];
    const t = THREE.MathUtils.clamp(s / Math.max(1e-6, car.link.length), 0, 1);
    tangent.subVectors(b, a).setY(0).normalize();
    point.lerpVectors(a, b, t);
    const twoWay = car.link.lanesAB > 0 && car.link.lanesBA > 0;
    const lanes = car.forwardOnLink ? car.link.lanesAB : car.link.lanesBA;
    // Right of travel: heading +x has +z on its right. One-way roads spread lanes across the middle.
    const offset = twoWay ? LANE_WIDTH * (car.lane + 0.5) : LANE_WIDTH * (car.lane - (lanes - 1) / 2);
    point.x += -tangent.z * offset;
    point.z += tangent.x * offset;
  }
}

/** Reduce a merged traffic part to a fraction of its triangles (meshoptimizer; call after it's ready). */
function simplify(g: THREE.BufferGeometry): void {
  const index = g.index;
  if (!index || index.count < 600) return;
  const indices = new Uint32Array(index.array as ArrayLike<number>);
  const positions = g.getAttribute('position').array as Float32Array;
  const target = Math.floor((indices.length * SIMPLIFY_RATIO) / 3) * 3;
  // Parts are unwelded and full of UV seams: let the simplifier collapse across them and drop specks
  const [reduced] = MeshoptSimplifier.simplify(indices, positions, 3, target, SIMPLIFY_ERROR, ['Permissive', 'Prune']);
  g.setIndex(new THREE.BufferAttribute(reduced, 1));
}

/** Position/normal/uv as plain float attributes (models may use quantized ones), ready to merge. */
function plainGeometry(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const out = new THREE.BufferGeometry();
  for (const name of ['position', 'normal', 'uv']) {
    const a = g.getAttribute(name);
    if (!a) continue;
    const size = a.itemSize;
    const arr = new Float32Array(a.count * size);
    for (let i = 0; i < a.count; i++) {
      arr[i * size] = a.getX(i);
      if (size > 1) arr[i * size + 1] = a.getY(i);
      if (size > 2) arr[i * size + 2] = a.getZ(i);
    }
    out.setAttribute(name, new THREE.BufferAttribute(arr, size));
  }
  if (!out.getAttribute('uv')) out.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(out.getAttribute('position').count * 2), 2));
  if (!out.getAttribute('normal')) out.computeVertexNormals();
  if (g.index) out.setIndex(Array.from(g.index.array as ArrayLike<number>));
  return out;
}

function wrapAngle(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}
