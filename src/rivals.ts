// Rival racers: full physics cars driven by an AI along a route through the city. The AI scans the
// collision mesh ahead to see how much road there is (curbs, walls, poles and tree trunks), lays a
// smooth racing line inside it, brakes for that line's bends, dodges traffic within the road, catches
// up when behind, and crashes like the player does. A rival that crashes shortly after the player
// shoved it is a takedown.
import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { Car } from './car';
import type { Controls } from './input';
import { mulberry32 } from './random';
import type { RoadGraph } from './map';
import type { Agent } from './traffic';
import { RIVAL_GARAGE, type CarTuning } from './tuning';

// Steering: pure pursuit of a point on the racing line this far ahead
const LOOK_BASE = 5; // m
const LOOK_PER_SPEED = 0.3; // extra look-ahead per m/s
const STEER_GAIN = 1.25; // times the geometric steering angle (the tires slip a little)
// Speed: the fastest speed from which the car can still brake down to every bend ahead
const PLAN_DECEL = 10; // m/s² the AI assumes when braking for a bend
const LATERAL_GRIP = 16; // m/s² of cornering the AI plans for
const FAST = 95; // m/s: treat as straight
const BOOST_BURN = 1.6; // s a boost keeps pushing once started (a segment burns 1.3 s)
const BOOST_GAIN = 15; // m/s a burn can add
const BOOST_DECEL = 0.4; // share of the usual braking left while boost pushes against it
// The racing line: the route sampled every SAMPLE m. At each sample the AI scans sideways for the
// road's edges (a step in the ground is a curb; a ray at body height finds walls, poles and trunks),
// then the line is smoothed toward least curvature within that room.
const SAMPLE = 4;
const SCAN_AHEAD = 300; // m of road kept scanned (collision streams in 340 m around each rival)
const SCAN_WIDTH = 9; // m either side of the route
const SCAN_STEP = 0.5;
const SCANS_PER_STEP = 2;
const CURB = 0.08; // m
const BODY_HEIGHT = 0.6; // m above the road
const EDGE_MARGIN = 0.6; // m between the car's side and the road's edge
const MAX_OFFSET = 7; // m the line may stray from the route
const UNSCANNED = 0.5; // m of room either side where the collision mesh never showed up
const SMOOTH_STRIDES = [4, 2, 1, 1]; // samples between neighbours in each smoothing pass
const LANE_PULL = 0.004; // per pass: how strongly the line drifts back to its lane where it runs straight
const LANE_WIDTH = 3.4;
const WRONG_WAY_COST = 1.6; // routes avoid driving one-way roads (and divided roads' far sides) backwards
// Traffic: anything we'd reach within AVOID_TIME is dodged within the road, or followed if there's no gap
const AVOID_TIME = 2.5; // s
const AVOID_RANGE = 160; // m
const AVOID_CORRIDOR = 2.5; // m between car centers that counts as in the way
const CAR_LENGTH = 4.5;
const FOLLOW_GAP = 9; // m
const SHIFT_RATE = 6; // m/s
const SHIFT_LIMIT = 8;
// Crashes
const WRECK_DV = 10;
const WRECK_MIN_SPEED = 8;
const WRECK_SECONDS = 2.5;
const STUCK_SECONDS = 2.5;
const FLIP_UP = 0.3;
const CONTACT_MEMORY = 1.5; // s a shove from the player still counts toward a takedown
// Burnout-style shoves: a hard hit from the player is a takedown on the spot; a firm one knocks the
// rival out of control (it spins off and usually finds a wall or traffic); a tap does nothing
const SHUNT_DV = 4.5; // m/s the player's hit changes the rival's velocity by
const SPIN_DV = 2.5;
const SPIN_SECONDS = 1.3;
const SPIN_YAW = 0.9; // rad/s of yaw kick per m/s of hit
// The car's drift assist holds a slide once it starts; steering past full lock this way winds it down
const DRIFT_UNWIND = 1.6;
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

let ray: RAPIER.Ray | null = null;

/** Distance along a ray to the city's static geometry (cars don't count), or `max`. */
function castStatic(world: RAPIER.World, x: number, y: number, z: number, dx: number, dy: number, dz: number, max: number): number {
  ray ??= new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
  ray.origin.x = x;
  ray.origin.y = y;
  ray.origin.z = z;
  ray.dir.x = dx;
  ray.dir.y = dy;
  ray.dir.z = dz;
  const hit = world.castRay(ray, max, true, RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC);
  return hit ? hit.timeOfImpact : max;
}

/** Height of the ground within `depth` m below (x, top, z), or null. */
function groundAt(world: RAPIER.World, x: number, top: number, z: number, depth: number): number | null {
  const d = castStatic(world, x, top, z, 0, -1, 0, depth);
  return d < depth ? top - d : null;
}

/**
 * Points along a node route in the right-hand lane. Two-way roads' lanes sit half a lane right of the
 * centerline; one-way roads (the map draws divided roads as a one-way road per side) are driven
 * down their middle.
 */
export function laneLine(roads: RoadGraph, route: number[]): THREE.Vector3[] {
  const twoWay = (a: number, b: number) => {
    const link = roads.adjacent[a]?.find((e) => e.other === b)?.link;
    return !!link && link.lanesAB > 0 && link.lanesBA > 0;
  };
  const pts: THREE.Vector3[] = [];
  for (let k = 0; k < route.length; k++) {
    const p = roads.nodes[route[k]].clone();
    const prev = route[Math.max(0, k - 1)];
    const next = route[Math.min(route.length - 1, k + 1)];
    const dir = new THREE.Vector3().subVectors(roads.nodes[next], roads.nodes[prev]).setY(0);
    const sides = [k > 0 ? twoWay(prev, route[k]) : null, k < route.length - 1 ? twoWay(route[k], next) : null].filter((w) => w !== null);
    const offset = (sides.filter(Boolean).length / Math.max(1, sides.length)) * LANE_WIDTH * 0.5;
    if (dir.lengthSq() > 1e-6) {
      dir.normalize();
      p.x += -dir.z * offset;
      p.z += dir.x * offset;
    }
    pts.push(p);
  }
  return pts;
}

/** Shortest route between nodes (A*) that avoids driving roads the wrong way where it reasonably can. */
export function racingRoute(roads: RoadGraph, from: number, to: number, avoid?: number): number[] {
  const open = new Map<number, number>([[from, 0]]);
  const g = new Map<number, number>([[from, 0]]);
  const came = new Map<number, number>();
  const h = (n: number) => roads.nodes[n].distanceTo(roads.nodes[to]);
  while (open.size > 0) {
    let cur = -1;
    let best = Infinity;
    for (const [n, f] of open) if (f < best) { best = f; cur = n; }
    if (cur === to) break;
    open.delete(cur);
    for (const { link, other } of roads.adjacent[cur]) {
      if (other === avoid && cur === from) continue;
      const lanes = link.a === cur ? link.lanesAB : link.lanesBA;
      const cost = g.get(cur)! + link.length * (lanes > 0 ? 1 : WRONG_WAY_COST);
      if (cost < (g.get(other) ?? Infinity)) {
        g.set(other, cost);
        came.set(other, cur);
        open.set(other, cost + h(other));
      }
    }
  }
  if (!came.has(to) && from !== to) return [];
  const path = [to];
  while (path[0] !== from) path.unshift(came.get(path[0])!);
  return path;
}

interface Threat {
  along: number; // m ahead
  k: number; // sample there
  lat: number; // where it will be across the road when we get there (m right of the route)
  t: number; // s until we get there
  speed: number; // its speed along our route
}

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
  private shift = 0; // m the car moves off its racing line to pass traffic
  private shiftTarget = 0;
  private clearFor = 0;
  private speedBefore = 0;
  private spinning = 0; // s left out of control after a shove
  private lastRespawn = -Infinity; // s along the path
  // The racing line, per sample: route point (b), unit vector to its right (r), room across the road
  // for the car's center (lo..hi, m right of the route) and the line's offset within it, corner speed
  private bx = new Float32Array(0);
  private by = new Float32Array(0);
  private bz = new Float32Array(0);
  private rx = new Float32Array(0);
  private rz = new Float32Array(0);
  private lo = new Float32Array(0);
  private hi = new Float32Array(0);
  private off = new Float32Array(0);
  private limit = new Float32Array(0);
  private scanned = 0; // samples below this have been scanned
  private readonly threats: Threat[] = [];
  private readonly tmp = new THREE.Vector3();
  private readonly tangent = new THREE.Vector3();
  private readonly wheelbase: number;
  private readonly rearAxle: number; // m ahead of the body origin (negative: behind)

  constructor(private readonly world: RAPIER.World, scene: THREE.Scene, tuning: CarTuning, readonly name: string, readonly id: number) {
    this.car = new Car(world, scene, tuning, new THREE.Vector3(0, -50, 0), 0);
    const w = this.car.visual.wheels;
    this.rearAxle = (w[2].center.x + w[3].center.x) / 2;
    this.wheelbase = Math.max(1.5, (w[0].center.x + w[1].center.x) / 2 - this.rearAxle);
  }

  setPath(points: THREE.Vector3[], s = 0): void {
    this.path = points;
    this.cum = [0];
    for (let i = 1; i < points.length; i++) this.cum.push(this.cum[i - 1] + points[i].distanceTo(points[i - 1]));
    this.s = s;
    this.shift = this.shiftTarget = 0;
    const n = Math.floor(this.pathLength / SAMPLE) + 1;
    this.bx = new Float32Array(n);
    this.by = new Float32Array(n);
    this.bz = new Float32Array(n);
    this.rx = new Float32Array(n);
    this.rz = new Float32Array(n);
    this.lo = new Float32Array(n).fill(-UNSCANNED);
    this.hi = new Float32Array(n).fill(UNSCANNED);
    this.off = new Float32Array(n);
    this.limit = new Float32Array(n);
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    for (let k = 0; k < n; k++) {
      const d = k * SAMPLE;
      this.pointAt(d, this.tmp);
      this.bx[k] = this.tmp.x;
      this.by[k] = this.tmp.y;
      this.bz[k] = this.tmp.z;
      // Across the road: square to the route averaged over a few meters, so a corner's sample points
      // along the corner's bisector (toward its inside curb)
      this.pointAt(d - 2, a);
      this.pointAt(d + 2, b);
      const tx = b.x - a.x;
      const tz = b.z - a.z;
      const len = Math.hypot(tx, tz) || 1;
      this.rx[k] = -tz / len;
      this.rz[k] = tx / len;
    }
    for (let k = 0; k < n; k++) this.limit[k] = this.cornerSpeed(k);
    this.scanned = Math.max(0, Math.floor(s / SAMPLE) - 2);
    this.lastRespawn = -Infinity;
  }

  get pathLength(): number {
    return this.cum[this.cum.length - 1] ?? 0;
  }

  /** Put the car on its racing line at distance `s`, pointing along it. */
  placeAt(s: number, speed: number): void {
    this.s = THREE.MathUtils.clamp(s, 0, this.pathLength);
    this.scanned = Math.max(this.scanned, Math.floor(this.s / SAMPLE) - 2);
    this.scan(24);
    const k = this.sampleAt(this.s);
    this.linePoint(k, this.tmp);
    const heading = this.lineHeading(k);
    this.car.reset(new THREE.Vector3(this.tmp.x, this.by[k] + 0.5, this.tmp.z), -heading);
    this.car.damage.repair();
    this.spinning = 0;
    const v = Math.min(speed, this.limit[k]);
    this.car.body.setLinvel({ x: Math.cos(heading) * v, y: 0, z: Math.sin(heading) * v }, true);
    this.wrecked = false;
    this.stuck = 0;
    this.shift = this.shiftTarget = 0;
  }

  /** Back on the road after a wreck: the first clear spot on the racing line near `s`, never the same one twice. */
  respawn(s: number, speed: number): void {
    if (Math.abs(s - this.lastRespawn) < 10) s = this.lastRespawn + 20; // it wrecked right away last time
    const candidates = [0, -6, 6, -12, 12, 20].map((d) => THREE.MathUtils.clamp(s + d, 0, this.pathLength));
    const at = candidates.find((c) => this.clearAt(c)) ?? candidates[0];
    this.lastRespawn = at;
    this.placeAt(at, speed);
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

  /** Scan up to `budget` more samples of road ahead and re-smooth the racing line. */
  scan(budget: number): void {
    const n = this.bx.length;
    while (budget-- > 0 && this.scanned < n && this.scanned * SAMPLE < this.s + SCAN_AHEAD) {
      // Collision streams in around each car; give up waiting on samples we're about to reach
      if (!this.scanSample(this.scanned, this.scanned * SAMPLE < this.s + 60)) break;
      this.scanned++;
    }
    this.smooth(Math.max(0, Math.floor(this.s / SAMPLE)));
  }

  /** Decide controls for this physics step. */
  drive(dt: number, others: Agent[]): void {
    const c = this.controls;
    const car = this.car;
    if (this.spinning > 0) {
      this.spinning -= dt;
      c.throttle = 0;
      c.steer = 0;
      c.brake = 0;
      c.boost = false;
      return;
    }
    if (this.wrecked) {
      c.throttle = 0;
      c.steer = 0;
      c.boost = false;
      c.brake = 0;
      return;
    }
    const p = car.body.translation();
    this.s = this.project(p.x, p.z);
    this.scan(SCANS_PER_STEP);
    const v = car.forwardSpeed;
    this.pointAt(this.s, this.tmp);
    const tx = this.tangent.x;
    const tz = this.tangent.z;

    // Traffic: dodge within the road, or follow if there's no way past
    const follow = this.avoid(dt, others, p.x, p.z, tx, tz, v);

    // Steer: pure pursuit of the racing line (plus any dodge) a speed-dependent distance ahead
    const look = LOOK_BASE + LOOK_PER_SPEED * Math.max(0, v);
    const target = this.targetAt(this.s + look, this.tmp);
    const f = car.forward;
    const ax = p.x + f.x * this.rearAxle;
    const az = p.z + f.z * this.rearAxle;
    const dx = target.x - ax;
    const dz = target.z - az;
    const along = dx * f.x + dz * f.z;
    const side = -dx * f.z + dz * f.x;
    const t = car.tuning;
    const lock = THREE.MathUtils.lerp(t.maxSteer, t.highSpeedSteer, Math.min(1, Math.abs(v) / t.topSpeed));
    const angle = along > 0 ? Math.atan((2 * this.wheelbase * side) / (dx * dx + dz * dz)) : Math.sign(side) * lock;
    c.steer = THREE.MathUtils.clamp((angle / lock) * STEER_GAIN, -1, 1);
    if (car.drift.drifting) {
      // Knocked into a slide: steer the drift assist toward zero slip so it lets go
      c.steer = Math.sign(car.slip) * DRIFT_UNWIND;
    }

    // Speed: fastest speed from which we can still brake down to each upcoming corner's speed. A boost
    // burns on for a while whatever the pedals do, so boost only where a whole burn still leaves room
    // to brake, and brake early while one is burning.
    let allowed = Math.min(follow, this.maxSpeed);
    let boostRoom = Infinity;
    const decel = car.drift.boosting ? PLAN_DECEL * BOOST_DECEL : PLAN_DECEL;
    const burn = Math.max(0, v) * BOOST_BURN + 10;
    const horizon = ((v + BOOST_GAIN) ** 2) / (2 * PLAN_DECEL) + burn + 40;
    for (let k = Math.max(0, Math.floor(this.s / SAMPLE)); k < this.limit.length; k++) {
      const dist = k * SAMPLE - this.s;
      if (dist > horizon) break;
      const vc2 = this.limit[k] ** 2;
      allowed = Math.min(allowed, Math.sqrt(vc2 + 2 * decel * Math.max(0, dist - 4)));
      boostRoom = Math.min(boostRoom, Math.sqrt(vc2 + 2 * PLAN_DECEL * Math.max(0, dist - burn)));
    }
    // Pointing well off the line (after a knock): gather it up before pushing on
    const off = Math.abs(Math.atan2(side, Math.max(0.1, along)));
    if (off > 0.6) allowed = Math.min(allowed, 12);
    if (this.finished) allowed = 0;
    if (v > allowed + 1.5) {
      c.throttle = 0;
      c.brake = THREE.MathUtils.clamp((v - allowed) / 6, 0.3, 1);
    } else {
      c.brake = 0;
      c.throttle = v < allowed ? 1 : 0.3;
    }
    if (car.drift.drifting) c.throttle = Math.min(c.throttle, 0.3);
    c.boost = this.mayBoost && !this.finished && boostRoom > Math.min(v + BOOST_GAIN, this.maxSpeed) && v > 22
      && Math.abs(c.steer) < 0.25 && follow === Infinity;
    car.drift.award(0.22 * dt); // rivals earn boost steadily rather than by drifting

    this.stuck = car.speed < 2 && !this.finished ? this.stuck + dt : 0;
  }

  /**
   * After world.step(): crash, flip and stuck checks. 'wrecked' on the step it crashes, 'respawn' when
   * a wreck has lain long enough or the car is stuck.
   */
  afterStep(time: number, player: Car, world: RAPIER.World): 'wrecked' | 'respawn' | null {
    const car = this.car;
    let touched = false;
    world.contactPair(player.collider, car.collider, (manifold) => {
      if (manifold.numContacts() > 0) touched = true;
    });
    if (touched) this.lastContact = time;
    if (this.wrecked) return time - this.wreckedAt > WRECK_SECONDS ? 'respawn' : null;
    if (this.finished) return null;
    const dv = car.impact();
    if (dv > 3) car.applyDamage(world, dv);
    let shunted = false;
    if (touched && dv > SPIN_DV && this.speedBefore > WRECK_MIN_SPEED) {
      shunted = dv > SHUNT_DV;
      // Knocked sideways: yaw away from the hit, and no driving until it's over
      const hit = car.impactVector(this.tmp);
      const right = -hit.x * car.forward.z + hit.z * car.forward.x;
      const w = car.body.angvel();
      car.body.setAngvel({ x: w.x, y: w.y - Math.sign(right) * SPIN_YAW * dv, z: w.z }, true);
      this.spinning = SPIN_SECONDS;
    }
    if (shunted || (dv > WRECK_DV && this.speedBefore > WRECK_MIN_SPEED) || car.up.y < FLIP_UP) {
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

  /**
   * Pick a sideways shift off the racing line that clears whatever we're closing on, and return the
   * speed to follow at if nothing does (Infinity when the way is clear).
   */
  private avoid(dt: number, others: Agent[], x: number, z: number, tx: number, tz: number, v: number): number {
    const threats = this.threats;
    threats.length = 0;
    for (const o of others) {
      const dx = o.x - x;
      const dz = o.z - z;
      if (dx * dx + dz * dz > AVOID_RANGE * AVOID_RANGE) continue;
      const along = dx * tx + dz * tz;
      if (along < 0) continue;
      const speed = o.vx * tx + o.vz * tz;
      const closing = v - speed;
      if (closing < 1) continue;
      const t = Math.max(0, along - CAR_LENGTH) / closing;
      if (t > AVOID_TIME) continue;
      const k = this.sampleAt(this.s + along);
      const lat = (o.x - this.bx[k]) * this.rx[k] + (o.z - this.bz[k]) * this.rz[k];
      const drift = (o.vx * this.rx[k] + o.vz * this.rz[k]) * Math.min(t, 1.5);
      threats.push({ along, k, lat: lat + drift, t, speed });
    }
    if (threats.length === 0) {
      this.clearFor += dt;
      if (this.clearFor > 0.8) this.shiftTarget = 0;
    } else {
      this.clearFor = 0;
      // Candidates: stay, back to the line, or just either side of each threat
      let best = this.shift;
      let bestScore = -Infinity;
      const consider = (cand: number) => {
        const shift = THREE.MathUtils.clamp(cand, -SHIFT_LIMIT, SHIFT_LIMIT);
        const hit = this.conflict(shift);
        const score = Math.min(hit, 200) - Math.abs(shift - this.shift) * 1.5 - Math.abs(shift) * 0.3;
        if (score > bestScore) {
          bestScore = score;
          best = shift;
        }
      };
      consider(this.shift);
      consider(0);
      for (const th of threats) {
        const line = this.off[th.k];
        consider(th.lat - AVOID_CORRIDOR - 0.5 - line);
        consider(th.lat + AVOID_CORRIDOR + 0.5 - line);
      }
      this.shiftTarget = best;
    }
    this.shift += THREE.MathUtils.clamp(this.shiftTarget - this.shift, -SHIFT_RATE * dt, SHIFT_RATE * dt);
    // Nothing clears it: follow the first car in the way
    let follow = Infinity;
    for (const th of threats) {
      if (!this.blocks(th, this.shiftTarget)) continue;
      follow = Math.min(follow, Math.max(0, th.speed) + Math.sqrt(2 * PLAN_DECEL * Math.max(0, th.along - FOLLOW_GAP)));
    }
    return follow;
  }

  /** How far ahead the first threat we'd still hit with this shift is (Infinity if none). */
  private conflict(shift: number): number {
    let first = Infinity;
    for (const th of this.threats) if (th.along < first && this.blocks(th, shift)) first = th.along;
    return first;
  }

  /** Whether a threat is in the way if we aim for `shift`, given how fast we can move across. */
  private blocks(th: Threat, shift: number): boolean {
    const reach = SHIFT_RATE * th.t;
    const lateral = this.off[th.k] + this.shift + THREE.MathUtils.clamp(shift - this.shift, -reach, reach);
    const at = THREE.MathUtils.clamp(lateral, this.lo[th.k], this.hi[th.k]);
    return Math.abs(th.lat - at) < AVOID_CORRIDOR;
  }

  /** Scan one sample's road width; false if its collision hasn't streamed in yet (unless `force`). */
  private scanSample(k: number, force: boolean): boolean {
    const world = this.world;
    const x = this.bx[k];
    const z = this.bz[k];
    const g0 = groundAt(world, x, this.by[k] + 2, z, 6);
    if (g0 === null) {
      if (!force) return false;
      this.lo[k] = -UNSCANNED;
      this.hi[k] = UNSCANNED;
      this.off[k] = 0;
      return true;
    }
    this.by[k] = g0;
    const room = [0, 0];
    for (const side of [-1, 1]) {
      const dx = this.rx[k] * side;
      const dz = this.rz[k] * side;
      let edge = castStatic(world, x, g0 + BODY_HEIGHT, z, dx, 0, dz, SCAN_WIDTH);
      let prev = g0;
      const flat = (o: number) => {
        const h = groundAt(world, x + dx * o, prev + 1, z + dz * o, 2);
        return h !== null && Math.abs(h - prev) <= CURB ? h : null;
      };
      for (let o = SCAN_STEP; o <= edge; o += SCAN_STEP) {
        const h = flat(o);
        if (h === null) {
          // Found the curb: narrow down where it is
          let a = o - SCAN_STEP;
          let b = o;
          for (let i = 0; i < 2; i++) {
            const m = (a + b) / 2;
            if (flat(m) === null) b = m;
            else a = m;
          }
          edge = a;
          break;
        }
        prev = h;
      }
      room[side < 0 ? 0 : 1] = edge;
    }
    const half = this.car.visual.chassisHalf.z + EDGE_MARGIN;
    let lo = Math.max(-MAX_OFFSET, -room[0] + half);
    let hi = Math.min(MAX_OFFSET, room[1] - half);
    if (lo > hi) lo = hi = (lo + hi) / 2;
    this.lo[k] = lo;
    this.hi[k] = hi;
    this.off[k] = THREE.MathUtils.clamp(this.off[k], lo, hi);
    return true;
  }

  /**
   * Smooth the scanned racing line ahead of sample k0 toward least curvature, inside each sample's
   * room, then update corner speeds from it.
   */
  private smooth(k0: number): void {
    const { bx, bz, rx, rz, off, lo, hi } = this;
    const end = Math.min(this.scanned, bx.length) - 2;
    const lx = (j: number) => bx[j] + rx[j] * off[j];
    const lz = (j: number) => bz[j] + rz[j] * off[j];
    // Coarse to fine: bending over long stretches settles in a few passes instead of hundreds
    for (const st of SMOOTH_STRIDES) {
      for (let k = Math.max(2 * st, k0 + 1); k < end + 2 - 2 * st; k++) {
        // Where this point would sit for the least bending given its neighbours, along its cross-line
        const px = (-lx(k - 2 * st) + 4 * lx(k - st) + 4 * lx(k + st) - lx(k + 2 * st)) / 6;
        const pz = (-lz(k - 2 * st) + 4 * lz(k - st) + 4 * lz(k + st) - lz(k + 2 * st)) / 6;
        const t = (px - bx[k]) * rx[k] + (pz - bz[k]) * rz[k];
        const lane = THREE.MathUtils.clamp(0, lo[k], hi[k]);
        off[k] = THREE.MathUtils.clamp(t + (lane - t) * LANE_PULL, lo[k], hi[k]);
      }
    }
    for (let k = Math.max(0, k0 - 2); k < Math.min(end + 2, bx.length); k++) this.limit[k] = this.cornerSpeed(k);
  }

  /** Corner speed at sample k from the racing line's curvature over 8 m either side. */
  private cornerSpeed(k: number): number {
    const n = this.bx.length;
    const a = Math.max(0, k - 2);
    const c = Math.min(n - 1, k + 2);
    if (a === k || c === k) return FAST;
    const ax = this.bx[a] + this.rx[a] * this.off[a];
    const az = this.bz[a] + this.rz[a] * this.off[a];
    const bx = this.bx[k] + this.rx[k] * this.off[k];
    const bz = this.bz[k] + this.rz[k] * this.off[k];
    const cx = this.bx[c] + this.rx[c] * this.off[c];
    const cz = this.bz[c] + this.rz[c] * this.off[c];
    const l1 = Math.hypot(bx - ax, bz - az);
    const l2 = Math.hypot(cx - bx, cz - bz);
    if (l1 < 0.5 || l2 < 0.5) return FAST;
    const cross = (bx - ax) * (cz - bz) - (bz - az) * (cx - bx);
    const dot = (bx - ax) * (cx - bx) + (bz - az) * (cz - bz);
    const turn = Math.abs(Math.atan2(cross, dot));
    const curvature = turn / ((l1 + l2) / 2);
    return Math.min(FAST, Math.sqrt(LATERAL_GRIP / Math.max(curvature, 1e-4)));
  }

  private sampleAt(s: number): number {
    return THREE.MathUtils.clamp(Math.round(s / SAMPLE), 0, this.bx.length - 1);
  }

  private linePoint(k: number, out: THREE.Vector3): THREE.Vector3 {
    return out.set(this.bx[k] + this.rx[k] * this.off[k], this.by[k], this.bz[k] + this.rz[k] * this.off[k]);
  }

  /** Heading (radians, atan2(z, x)) of the racing line at sample k. */
  private lineHeading(k: number): number {
    const n = this.bx.length;
    const a = Math.max(0, k - 1);
    const b = Math.min(n - 1, k + 1);
    if (a === b) return Math.atan2(this.tangent.z, this.tangent.x);
    const dx = this.bx[b] + this.rx[b] * this.off[b] - (this.bx[a] + this.rx[a] * this.off[a]);
    const dz = this.bz[b] + this.rz[b] * this.off[b] - (this.bz[a] + this.rz[a] * this.off[a]);
    return Math.atan2(dz, dx);
  }

  /** The point to steer for at distance s: on the racing line, shifted for traffic but kept on the road. */
  private targetAt(s: number, out: THREE.Vector3): THREE.Vector3 {
    const n = this.bx.length;
    const f = THREE.MathUtils.clamp(s / SAMPLE, 0, n - 1);
    const k = Math.min(n - 2, Math.floor(f));
    if (k < 0) return this.linePoint(0, out);
    const u = f - k;
    const mix = (arr: Float32Array) => arr[k] + (arr[k + 1] - arr[k]) * u;
    const lateral = THREE.MathUtils.clamp(mix(this.off) + this.shift, mix(this.lo), mix(this.hi));
    return out.set(mix(this.bx) + mix(this.rx) * lateral, mix(this.by), mix(this.bz) + mix(this.rz) * lateral);
  }

  /** Whether the car would fit at distance s on its racing line without touching the city or a car. */
  private clearAt(s: number): boolean {
    this.scan(24);
    const k = this.sampleAt(s);
    const p = this.linePoint(k, this.tmp);
    const heading = this.lineHeading(k);
    const c = this.car.visual.chassisCenter;
    const h = this.car.visual.chassisHalf;
    const cos = Math.cos(heading);
    const sin = Math.sin(heading);
    // Chassis box, lifted a little clear of the road, turned to the line's heading (yaw = -heading)
    const center = { x: p.x + c.x * cos - c.z * sin, y: this.by[k] + 0.5 + c.y + 0.15, z: p.z + c.x * sin + c.z * cos };
    const rotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -heading);
    let blocked = false;
    this.world.intersectionsWithShape(center, rotation, new RAPIER.Cuboid(h.x + 0.3, h.y * 0.8, h.z + 0.3), () => {
      blocked = true;
      return false;
    }, undefined, undefined, this.car.collider);
    return !blocked;
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
  private player: Agent | null = null; // as of the last step, so rivals can steer around it

  constructor(private readonly world: RAPIER.World, private readonly scene: THREE.Scene, private readonly roads: RoadGraph) {}

  /**
   * Spawn rivals racing along `route` (road node indices). They line up behind its first node in grid
   * slots `back` meters behind it and `lane` meters right of the road's centerline. They take the same
   * first road but then their own way, one that keeps off roads' wrong sides where it reasonably can.
   */
  startRace(route: number[], slots: { lane: number; back: number }[]): void {
    this.clear();
    const start = this.roads.nodes[route[0]];
    const dir = new THREE.Vector3().subVectors(this.roads.nodes[route[1]], start).setY(0).normalize();
    const right = new THREE.Vector3(-dir.z, 0, dir.x);
    const own = route.length > 2 ? racingRoute(this.roads, route[1], route[route.length - 1], route[0]) : [];
    const path = laneLine(this.roads, own.length > 1 ? [route[0], ...own] : route);
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
      route = racingRoute(this.roads, from, dest, avoid);
    }
    if (route.length < 2) route = [from, this.roads.adjacent[from][0]?.other ?? from];
    rival.setPath(laneLine(this.roads, route));
    if (s !== null) rival.respawn(s, speed);
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
    if (this.player) all.push(this.player);
    for (const r of this.rivals) {
      if (frozen) {
        r.scan(SCANS_PER_STEP);
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
    const p = player.body.translation();
    const v = player.body.linvel();
    this.player = { id: -1, x: p.x, z: p.z, vx: v.x, vz: v.z, wrecked: false };
    const takedowns: Rival[] = [];
    for (const r of this.rivals) {
      const result = r.afterStep(time, player, this.world);
      if (result === 'wrecked' && r.shovedByPlayer(time)) takedowns.push(r);
      if (result === 'respawn') {
        if (this.mode === 'race') r.respawn(r.s - 4, RESPAWN_SPEED);
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
