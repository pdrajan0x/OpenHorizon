// Rival racers: full physics cars driven by an AI along a route through the grid. They steer toward
// a look-ahead point, brake for corners, dodge traffic, catch up when behind, and crash like the
// player does. A rival that crashes shortly after the player shoved it is a takedown.
import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { Car } from './car';
import type { Controls } from './input';
import { mulberry32 } from './random';
import type { RoadGraph } from './map';
import type { Agent } from './traffic';
import { RIVAL_GARAGE, type CarTuning } from './tuning';

const LOOK_BASE = 7; // m
const LOOK_PER_SPEED = 0.45; // extra look-ahead per m/s
const STEER_GAIN = 2.4;
const CORNER_SPEED = 16; // m/s through a right-angle turn
const PLAN_DECEL = 10; // m/s² the AI assumes when braking for a corner
const CORNER_SCAN = 160; // m ahead to look for corners
const WRECK_DV = 10;
const WRECK_MIN_SPEED = 8;
const WRECK_SECONDS = 2.5;
const STUCK_SECONDS = 2.5;
const FLIP_UP = 0.3;
const CONTACT_MEMORY = 1.5; // s a shove from the player still counts toward a takedown
const AVOID_LOOK = 38;
const AVOID_CORRIDOR = 2.2;
const SHIFT_MIN = -6; // lateral room left of the route line (it runs half a lane right of the centerline)
const SHIFT_MAX = 2.5;
const SHIFT_RATE = 5; // m/s
export const FINISH_RADIUS = 14;
const RESPAWN_SPEED = 14;

const LOOKS: Pick<CarTuning, 'paint' | 'underglow'>[] = [
  { paint: 0xe8e8ee, underglow: 0xff2030 },
  { paint: 0xf2b705, underglow: 0xff2030 },
  { paint: 0x0d0d10, underglow: 0xff2030 },
  { paint: 0x1a7a4c, underglow: 0xff2030 },
  { paint: 0xff5a1f, underglow: 0xff2030 },
];
const NAMES = ['KAZE', 'VANTA', 'NOVA', 'RIOT', 'HEX'];

export class Rival {
  readonly car: Car;
  readonly controls: Controls = { throttle: 0, brake: 0, steer: 0, handbrake: false, boost: false };
  path: THREE.Vector3[] = [];
  private cum: number[] = [];
  s = 0; // progress along the path, m
  finished = false;
  wrecked = false;
  remaining = Infinity;
  maxSpeed = Infinity; // m/s cap on the AI's target speed
  mayBoost = true;
  stuckRespawns = 0; // telemetry for scripts/ai-test.mjs
  private wreckedAt = 0;
  private lastContact = -Infinity;
  private stuck = 0;
  private shift = 0;
  private shiftTarget = 0;
  private clearFor = 0;
  private speedBefore = 0;
  private readonly tmp = new THREE.Vector3();
  private readonly tangent = new THREE.Vector3();

  constructor(world: RAPIER.World, scene: THREE.Scene, tuning: CarTuning, readonly name: string, readonly id: number) {
    this.car = new Car(world, scene, tuning, new THREE.Vector3(0, -50, 0), 0);
  }

  setPath(points: THREE.Vector3[], s = 0): void {
    this.path = points;
    this.cum = [0];
    for (let i = 1; i < points.length; i++) this.cum.push(this.cum[i - 1] + points[i].distanceTo(points[i - 1]));
    this.s = s;
    this.shift = this.shiftTarget = 0;
  }

  get pathLength(): number {
    return this.cum[this.cum.length - 1] ?? 0;
  }

  /** Put the car on its path at distance `s`, pointing along it. */
  placeAt(s: number, speed: number): void {
    this.s = THREE.MathUtils.clamp(s, 0, this.pathLength);
    const p = this.pointAt(this.s, this.tmp);
    const heading = Math.atan2(this.tangent.z, this.tangent.x);
    this.car.reset(new THREE.Vector3(p.x, p.y + 0.5, p.z), -heading);
    this.car.damage.repair();
    this.car.body.setLinvel({ x: this.tangent.x * speed, y: 0, z: this.tangent.z * speed }, true);
    this.wrecked = false;
    this.stuck = 0;
  }

  /** Point on the path at distance s; also sets this.tangent. */
  pointAt(s: number, target: THREE.Vector3): THREE.Vector3 {
    const { path, cum } = this;
    let i = 1;
    while (i < path.length - 1 && cum[i] < s) i++;
    const a = path[i - 1];
    const b = path[i];
    const t = THREE.MathUtils.clamp((s - cum[i - 1]) / Math.max(1e-6, cum[i] - cum[i - 1]), 0, 1);
    this.tangent.subVectors(b, a).normalize();
    return target.lerpVectors(a, b, t);
  }

  /** Decide controls for this physics step. */
  drive(dt: number, others: Agent[]): void {
    const c = this.controls;
    const car = this.car;
    if (this.wrecked || this.finished) {
      c.throttle = 0;
      c.steer = 0;
      c.boost = false;
      c.brake = this.finished ? 1 : 0;
      return;
    }
    const p = car.body.translation();

    // Progress: project onto the path near where we were
    this.s = this.project(p.x, p.z);

    // Traffic avoidance: shift sideways within the road when something slower is in our corridor
    this.pointAt(this.s, this.tmp);
    const tx = this.tangent.x;
    const tz = this.tangent.z;
    let blockedAt = Infinity;
    const lateral: number[] = [];
    for (const o of others) {
      const dx = o.x - p.x;
      const dz = o.z - p.z;
      const along = dx * tx + dz * tz;
      if (along < 2 || along > AVOID_LOOK) continue;
      const closing = car.forwardSpeed - (o.vx * tx + o.vz * tz);
      if (closing < 3) continue;
      const side = -dx * tz + dz * tx;
      lateral.push(side);
      if (Math.abs(side - this.shift) < AVOID_CORRIDOR) blockedAt = Math.min(blockedAt, along);
    }
    if (blockedAt < Infinity) {
      let best = this.shiftTarget;
      let bestRoom = -Infinity;
      for (const cand of [this.shift - 3.5, this.shift + 3.5, this.shift - 7, 0, SHIFT_MIN + 1, SHIFT_MAX]) {
        const s = THREE.MathUtils.clamp(cand, SHIFT_MIN, SHIFT_MAX);
        const room = Math.min(...lateral.map((l) => Math.abs(l - s)), 10) - Math.abs(s - this.shift) * 0.1;
        if (room > bestRoom) {
          bestRoom = room;
          best = s;
        }
      }
      this.shiftTarget = best;
      this.clearFor = 0;
    } else {
      this.clearFor += dt;
      if (this.clearFor > 1) this.shiftTarget = 0;
    }
    this.shift += THREE.MathUtils.clamp(this.shiftTarget - this.shift, -SHIFT_RATE * dt, SHIFT_RATE * dt);

    // Steer at a look-ahead point, shifted sideways
    const look = LOOK_BASE + LOOK_PER_SPEED * car.speed;
    const target = this.pointAt(this.s + look, this.tmp);
    target.x += -this.tangent.z * this.shift;
    target.z += this.tangent.x * this.shift;
    const dx = target.x - p.x;
    const dz = target.z - p.z;
    const f = car.forward;
    const along = dx * f.x + dz * f.z;
    const side = -dx * f.z + dz * f.x;
    c.steer = THREE.MathUtils.clamp(Math.atan2(side, Math.max(0.1, along)) * STEER_GAIN, -1, 1);

    // Speed: fastest speed from which we can still brake down to each upcoming corner's speed
    let allowed = Infinity;
    let straight = Infinity;
    const { path, cum } = this;
    for (let k = 1; k < path.length - 1; k++) {
      const dist = cum[k] - this.s;
      if (dist < -2) continue;
      if (dist > CORNER_SCAN) break;
      const a = this.tmp.subVectors(path[k], path[k - 1]).normalize();
      const bx = path[k + 1].x - path[k].x;
      const bz = path[k + 1].z - path[k].z;
      const bl = Math.hypot(bx, bz) || 1;
      const turn = Math.acos(THREE.MathUtils.clamp((a.x * bx + a.z * bz) / bl, -1, 1));
      if (turn < 0.2) continue;
      straight = Math.min(straight, Math.max(0, dist));
      const vc = CORNER_SPEED * (1 + 1.5 * (1 - turn / (Math.PI / 2)));
      allowed = Math.min(allowed, Math.sqrt(vc * vc + 2 * PLAN_DECEL * Math.max(0, dist - 4)));
    }
    allowed = Math.min(allowed, this.maxSpeed);
    const v = car.forwardSpeed;
    if (v > allowed + 1.5) {
      c.throttle = 0;
      c.brake = THREE.MathUtils.clamp((v - allowed) / 6, 0.3, 1);
    } else {
      c.brake = 0;
      c.throttle = v < allowed ? 1 : 0.3;
    }
    c.boost = this.mayBoost && straight > 110 && v > 22 && Math.abs(c.steer) < 0.25;
    car.drift.award(0.22 * dt); // rivals earn boost steadily rather than by drifting

    this.stuck = car.speed < 2 ? this.stuck + dt : 0;
  }

  /**
   * After world.step(): crash, flip and stuck checks. 'wrecked' on the step it crashes, 'respawn' when
   * a wreck has lain long enough or the car is stuck.
   */
  afterStep(time: number, player: Car, world: RAPIER.World): 'wrecked' | 'respawn' | null {
    const car = this.car;
    world.contactPair(player.collider, car.collider, (manifold) => {
      if (manifold.numContacts() > 0) this.lastContact = time;
    });
    if (this.wrecked) return time - this.wreckedAt > WRECK_SECONDS ? 'respawn' : null;
    if (this.finished) return null;
    const dv = car.impact();
    if (dv > 3) car.applyDamage(world, dv);
    if ((dv > WRECK_DV && this.speedBefore > WRECK_MIN_SPEED) || car.up.y < FLIP_UP) {
      this.wrecked = true;
      this.wreckedAt = time;
      return 'wrecked';
    }
    if (this.stuck <= STUCK_SECONDS) return null;
    this.stuckRespawns++;
    return 'respawn';
  }

  /** True if the player touched this car recently enough for a crash to count as their takedown. */
  shovedByPlayer(time: number): boolean {
    return time - this.lastContact < CONTACT_MEMORY;
  }

  /** Before world.step(): run the car with this step's controls. */
  physics(dt: number): void {
    this.car.fixedUpdate(this.controls, dt);
    this.speedBefore = this.car.speed;
    this.car.markVelocity();
  }

  touchingPlayer(time: number): boolean {
    return time - this.lastContact < 0.05;
  }

  /** Last node of the path (roaming rivals get a new route from here). */
  atEnd(): boolean {
    return this.s > this.pathLength - 12;
  }

  private project(x: number, z: number): number {
    const { path, cum } = this;
    let i = 1;
    while (i < path.length - 1 && cum[i] < this.s) i++;
    let best = this.s;
    let bestD = Infinity;
    for (let k = Math.max(1, i - 1); k <= Math.min(path.length - 1, i + 2); k++) {
      const a = path[k - 1];
      const b = path[k];
      const abx = b.x - a.x;
      const abz = b.z - a.z;
      const len2 = abx * abx + abz * abz || 1;
      const t = THREE.MathUtils.clamp(((x - a.x) * abx + (z - a.z) * abz) / len2, 0, 1);
      const px = a.x + abx * t;
      const pz = a.z + abz * t;
      const d = (x - px) ** 2 + (z - pz) ** 2;
      if (d < bestD) {
        bestD = d;
        best = cum[k - 1] + Math.sqrt(len2) * t;
      }
    }
    return best;
  }
}

/** The rivals in the current event. */
export class RivalPack {
  readonly rivals: Rival[] = [];
  mode: 'race' | 'roam' = 'race';
  private readonly rng = mulberry32(99);

  constructor(private readonly world: RAPIER.World, private readonly scene: THREE.Scene, private readonly roads: RoadGraph) {}

  /**
   * Spawn rivals racing along `route` (road node indices). They line up behind its first node in grid
   * slots `back` meters behind it and `lane` meters right of the road's centerline.
   */
  startRace(route: number[], slots: { lane: number; back: number }[]): void {
    this.clear();
    const start = this.roads.nodes[route[0]];
    const dir = new THREE.Vector3().subVectors(this.roads.nodes[route[1]], start).setY(0).normalize();
    const right = new THREE.Vector3(-dir.z, 0, dir.x);
    const path = this.roads.polyline(route);
    slots.forEach((slot, k) => {
      const rival = this.make(k);
      const at = start.clone().addScaledVector(dir, -slot.back).addScaledVector(right, slot.lane);
      rival.setPath([at.clone().addScaledVector(dir, -5), at, ...path.slice(1)]);
      rival.placeAt(5, 0);
    });
  }

  /** Spawn rivals scattered on routes leaving node `from` (Road Rage), each heading somewhere far. */
  startRoam(count: number, from: number): void {
    this.clear();
    for (let k = 0; k < count; k++) {
      const rival = this.make(k);
      this.newRoamRoute(rival, from, 25 + k * 18);
    }
  }

  /**
   * Give a roaming rival a fresh route from node `from` to somewhere far, not doubling back through
   * node `avoid`. With `s` it is placed that far along the route; without, it just drives onto it.
   */
  newRoamRoute(rival: Rival, from: number, s: number | null, speed = RESPAWN_SPEED, avoid?: number): void {
    const nodes = this.roads.nodes;
    let route: number[] = [];
    for (let attempt = 0; attempt < 8 && route.length < 2; attempt++) {
      const dest = Math.floor(this.rng() * nodes.length);
      if (nodes[dest].distanceTo(nodes[from]) < 400) continue;
      route = this.roads.route(from, dest, avoid);
    }
    if (route.length < 2) route = [from, this.roads.adjacent[from][0]?.other ?? from];
    rival.setPath(this.roads.polyline(route));
    if (s !== null) rival.placeAt(s, speed);
  }

  clear(): void {
    for (const r of this.rivals) r.car.dispose(this.world, this.scene);
    this.rivals.length = 0;
  }

  /**
   * Before world.step(). `lead` is how far each rival is ahead of the player (m, negative = behind);
   * it drives the catch-up: rivals ease off when far ahead and push when behind.
   */
  fixedUpdate(dt: number, traffic: Agent[], lead: (r: Rival) => number, frozen: boolean): void {
    const all = [...traffic, ...this.agents()];
    for (const r of this.rivals) {
      if (frozen) {
        r.controls.throttle = 0;
        r.controls.brake = 1;
        r.controls.steer = 0;
        r.controls.boost = false;
      } else {
        const d = lead(r);
        if (this.mode === 'race') {
          r.car.powerScale = THREE.MathUtils.clamp(1 - d / 500, 0.8, 1.35);
        } else {
          // Road Rage targets cruise when well ahead so the player can close in, and flee when caught
          r.maxSpeed = d > 70 ? 24 : d > 30 ? 32 : 45;
          r.mayBoost = d < 30;
        }
        r.drive(dt, all.filter((a) => a.id !== 1000 + r.id));
      }
      r.physics(dt);
    }
  }

  /**
   * After world.step(): returns the rivals the player took down this step. Wrecks respawn on their
   * route (races) or on a new route ahead of the player (roaming); `ahead` is the node to use.
   */
  postStep(time: number, player: Car, ahead: () => number): Rival[] {
    const takedowns: Rival[] = [];
    for (const r of this.rivals) {
      const result = r.afterStep(time, player, this.world);
      if (result === 'wrecked' && r.shovedByPlayer(time)) takedowns.push(r);
      if (result === 'respawn') {
        if (this.mode === 'race') r.placeAt(r.s - 4, RESPAWN_SPEED);
        else this.newRoamRoute(r, ahead(), 20 + this.rng() * 30);
      } else if (this.mode === 'roam' && r.atEnd() && !r.wrecked) {
        const end = r.path[r.path.length - 1];
        const before = r.path[r.path.length - 2];
        this.newRoamRoute(r, this.roads.nearestNode(end.x, end.z), null, 0, this.roads.nearestNode(before.x, before.z));
      }
    }
    return takedowns;
  }

  syncVisuals(): void {
    for (const r of this.rivals) r.car.syncVisuals();
  }

  agents(): Agent[] {
    return this.rivals.map((r) => {
      const p = r.car.body.translation();
      const v = r.car.body.linvel();
      return { id: 1000 + r.id, x: p.x, z: p.z, vx: v.x, vz: v.z, wrecked: r.wrecked };
    });
  }

  private make(k: number): Rival {
    const base = RIVAL_GARAGE[k % RIVAL_GARAGE.length];
    const tuning: CarTuning = { ...base, ...LOOKS[k % LOOKS.length] };
    const rival = new Rival(this.world, this.scene, tuning, NAMES[k % NAMES.length], k);
    this.rivals.push(rival);
    return rival;
  }
}
