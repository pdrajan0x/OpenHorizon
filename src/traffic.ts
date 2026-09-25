// Ambient traffic: cars follow lanes on the street grid, stop for red lights and for whatever is
// ahead of them, and turn right at some intersections. They are dynamic bodies steered by velocity,
// so a hard hit knocks them out of their lane and plain physics takes over ("wrecked").
// Only a population around the player exists; cars spawn and despawn with distance.
import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { BLOCKS, isLotSegment, LANES, ROAD, signalAt, streetAt } from './city';
import { buildTrafficCar, DESIGNS, type CarShape } from './carModel';
import { mulberry32, pick } from './random';

const CRUISE = 13; // m/s, about 47 km/h
const ACCEL = 3;
const BRAKE = 7;
const STOP_DECEL = 3.5; // planned deceleration toward a red light
const STOP_BACK = 1.5; // stop line distance before the intersection box
const FOLLOW_GAP = 7.5; // center-to-center distance when queued
const LOOK_AHEAD = 32;
const CORRIDOR = 2.3; // half-width of the lane corridor checked for a leader
const SPAWN_MIN = 90;
const SPAWN_MAX = 260;
const SPAWN_SPACING = 14;
const DESPAWN = 320;
const WRECK_DESPAWN = 70;
const WRECK_SPEED_JUMP = 4; // m/s of unexpected velocity change that knocks a car out of its lane
const WRECK_DRIFT = 3; // meters off its path
const RIGHT_TURN_CHANCE = 0.35;
const POSITION_GAIN = 4;
const YAW_GAIN = 8;
const MASS = 1400;
const DESIGN_POOL = [DESIGNS.sedan, DESIGNS.sedan, DESIGNS.taxi, DESIGNS.suv, DESIGNS.hatch, DESIGNS.hatch, DESIGNS.van];
const PAINTS = [0x1c1e24, 0x8a8f99, 0xc9ccd2, 0x2b3a55, 0x5a1f24, 0x1f4a3a, 0x3a3a40, 0xe0e0e0];
const TAXI_YELLOW = 0xf2b705;

type Axis = 0 | 1;
/** A direction of travel along one street, in one lane. `street` is the index of the street driven along. */
interface Leg {
  axis: Axis;
  dir: 1 | -1;
  street: number;
  lane: 0 | 1;
}
interface Path {
  points: THREE.Vector3[];
  cum: number[];
  length: number;
  /** Set on approach paths: the signal controlling the stop line at the end. */
  signal: { ix: number; iz: number; axis: Axis } | null;
}

class TrafficCar {
  active = false;
  wrecked = false;
  wreckedAt = 0;
  leg: Leg = { axis: 0, dir: 1, street: 0, lane: 0 };
  next = 0; // index of the cross street ahead
  path: Path = makePath([new THREE.Vector3(), new THREE.Vector3(1, 0, 0)], null);
  queued: Path | null = null; // approach that follows the current crossing
  s = 0;
  speed = 0;
  readonly position = new THREE.Vector3();
  readonly forward = new THREE.Vector3(1, 0, 0);
  readonly commanded = new THREE.Vector3();

  constructor(readonly body: RAPIER.RigidBody, readonly root: THREE.Group, readonly shape: CarShape, readonly cruise: number) {}
}

export class Traffic {
  private readonly cars: TrafficCar[] = [];
  private readonly rng = mulberry32(451);
  private readonly target = new THREE.Vector3();
  private readonly tangent = new THREE.Vector3();
  private filled = false;

  constructor(world: RAPIER.World, scene: THREE.Scene, count: number) {
    for (let k = 0; k < count; k++) {
      const design = pick(this.rng, DESIGN_POOL);
      const paint = design === DESIGNS.taxi ? TAXI_YELLOW : pick(this.rng, PAINTS);
      const { root, shape } = buildTrafficCar(design, paint);
      root.visible = false;
      scene.add(root);
      const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setEnabled(false).setCcdEnabled(true));
      const c = shape.chassisCenter;
      const h = shape.chassisHalf;
      const inertia = {
        x: (MASS / 12) * ((2 * h.y) ** 2 + (2 * h.z) ** 2),
        y: (MASS / 12) * ((2 * h.x) ** 2 + (2 * h.z) ** 2),
        z: (MASS / 12) * ((2 * h.x) ** 2 + (2 * h.y) ** 2),
      };
      world.createCollider(
        RAPIER.ColliderDesc.cuboid(h.x, h.y, h.z)
          .setTranslation(c.x, c.y, c.z)
          .setMassProperties(MASS, { x: 0, y: 0.5 - c.y, z: 0 }, inertia, { x: 0, y: 0, z: 0, w: 1 })
          .setFriction(0.3),
        body,
      );
      this.cars.push(new TrafficCar(body, root, shape, CRUISE * (0.85 + this.rng() * 0.25)));
    }
  }

  /** Plan speeds and steer every lane-following car. Call before world.step(). */
  fixedUpdate(dt: number, time: number, player: THREE.Vector3): void {
    for (const car of this.cars) {
      if (!car.active || car.wrecked) continue;
      const p = car.body.translation();
      car.position.set(p.x, 0, p.z);

      let desired = car.cruise;
      const sig = car.path.signal;
      if (sig) {
        const remaining = car.path.length - car.s;
        const light = signalAt(sig.ix, sig.iz, sig.axis, time);
        if (light === 'red' || (light === 'yellow' && remaining > 12)) {
          desired = Math.min(desired, Math.sqrt(2 * STOP_DECEL * Math.max(0, remaining - 0.3)));
        }
      } else if (this.isTurning(car)) {
        desired *= 0.55;
      }
      const gap = this.gapAhead(car, player);
      if (gap < LOOK_AHEAD) desired = Math.min(desired, Math.max(0, (gap - FOLLOW_GAP) * 1.2));
      car.speed += THREE.MathUtils.clamp(desired - car.speed, -BRAKE * dt, ACCEL * dt);

      this.advance(car, car.speed * dt);
      pointOn(car.path, car.s, this.target, this.tangent);
      car.forward.copy(this.tangent);
      car.commanded.set(
        this.tangent.x * car.speed + (this.target.x - p.x) * POSITION_GAIN,
        0,
        this.tangent.z * car.speed + (this.target.z - p.z) * POSITION_GAIN,
      );
      const v = car.body.linvel();
      car.body.setLinvel({ x: car.commanded.x, y: v.y, z: car.commanded.z }, true);
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
      pointOn(car.path, car.s, this.target, this.tangent);
      const jump = Math.hypot(v.x - car.commanded.x, v.z - car.commanded.z);
      const off = Math.hypot(p.x - this.target.x, p.z - this.target.z);
      if (jump > WRECK_SPEED_JUMP || off > WRECK_DRIFT) this.wreck(car, time);
    }
  }

  /** Despawn far cars, spawn new ones around the player, and move meshes to their bodies. */
  update(time: number, player: THREE.Vector3): void {
    for (const car of this.cars) {
      if (!car.active) continue;
      const p = car.body.translation();
      const dist = Math.hypot(p.x - player.x, p.z - player.z);
      if (dist > DESPAWN || (car.wrecked && dist > WRECK_DESPAWN && time - car.wreckedAt > 4) || p.y < -10) {
        car.active = false;
        car.body.setEnabled(false);
        car.root.visible = false;
      }
    }
    let budget = this.filled ? 3 : Infinity;
    for (const car of this.cars) {
      if (car.active || budget <= 0) continue;
      if (this.spawn(car, player, this.filled ? SPAWN_MIN : 25)) budget--;
    }
    this.filled = true;

    for (const car of this.cars) {
      if (!car.active) continue;
      const p = car.body.translation();
      const r = car.body.rotation();
      car.root.position.set(p.x, p.y, p.z);
      car.root.quaternion.set(r.x, r.y, r.z, r.w);
    }
  }

  positions(): THREE.Vector3[] {
    return this.cars.filter((c) => c.active).map((c) => {
      const p = c.body.translation();
      return new THREE.Vector3(p.x, p.y, p.z);
    });
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

  private spawn(car: TrafficCar, player: THREE.Vector3, minDist: number): boolean {
    for (let attempt = 0; attempt < 25; attempt++) {
      const leg: Leg = {
        axis: this.rng() < 0.5 ? 0 : 1,
        dir: this.rng() < 0.5 ? 1 : -1,
        street: Math.floor(this.rng() * (BLOCKS + 1)),
        lane: this.rng() < 0.5 ? 0 : 1,
      };
      const seg = Math.floor(this.rng() * BLOCKS);
      if (isLotSegment(leg.axis, leg.street, seg, seg + 1)) continue;
      const along = THREE.MathUtils.lerp(streetAt(seg) + ROAD / 2 + 8, streetAt(seg + 1) - ROAD / 2 - 8, this.rng());
      const p = lanePoint(leg, along);
      const dist = Math.hypot(p.x - player.x, p.z - player.z);
      if (dist < minDist || dist > SPAWN_MAX) continue;
      if (this.cars.some((o) => o.active && o.position.distanceTo(p) < SPAWN_SPACING)) continue;

      car.leg = leg;
      car.next = leg.dir > 0 ? seg + 1 : seg;
      car.path = approach(leg, along, car.next);
      car.queued = null;
      car.s = 0;
      car.speed = car.cruise * 0.8;
      car.active = true;
      car.wrecked = false;
      car.position.copy(p);
      const f = forwardOf(leg);
      car.forward.copy(f);
      car.commanded.copy(f).multiplyScalar(car.speed);
      const body = car.body;
      body.setEnabled(true);
      body.setTranslation({ x: p.x, y: 0.05, z: p.z }, true);
      body.setRotation(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(-f.z, f.x)), true);
      body.setLinvel({ x: car.commanded.x, y: 0, z: car.commanded.z }, true);
      body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      body.setEnabledRotations(false, true, false, true);
      body.setLinearDamping(0);
      body.setAngularDamping(0);
      car.root.visible = true;
      return true;
    }
    return false;
  }

  private wreck(car: TrafficCar, time: number): void {
    car.wrecked = true;
    car.wreckedAt = time;
    car.body.setEnabledRotations(true, true, true, true);
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

  private isTurning(car: TrafficCar): boolean {
    return car.path.points.length > 2;
  }

  /** Move along the route, stitching approach → crossing → approach as each path runs out. */
  private advance(car: TrafficCar, ds: number): void {
    car.s += ds;
    while (car.s > car.path.length) {
      car.s -= car.path.length;
      if (car.path.signal) {
        const next = crossing(car.leg, car.next, this.rng);
        car.path = next.path;
        car.leg = next.leg;
        car.next = next.next;
        car.queued = next.then;
      } else {
        car.path = car.queued ?? car.path;
        car.queued = null;
      }
    }
  }
}

// --- Route geometry ---

function forwardOf(leg: Leg): THREE.Vector3 {
  return leg.axis === 0 ? new THREE.Vector3(leg.dir, 0, 0) : new THREE.Vector3(0, 0, leg.dir);
}

/** Point on a leg's lane at coordinate `along` of its travel axis. Lanes sit right of the centerline. */
function lanePoint(leg: Leg, along: number): THREE.Vector3 {
  const offset = leg.dir * LANES[leg.lane];
  return leg.axis === 0
    ? new THREE.Vector3(along, 0, streetAt(leg.street) + offset)
    : new THREE.Vector3(streetAt(leg.street) - offset, 0, along);
}

/** Straight run from `from` to the stop line before cross street `next`. */
function approach(leg: Leg, from: number, next: number): Path {
  const stop = streetAt(next) - leg.dir * (ROAD / 2 + STOP_BACK);
  const [ix, iz] = leg.axis === 0 ? [next, leg.street] : [leg.street, next];
  return makePath([lanePoint(leg, from), lanePoint(leg, stop)], { ix, iz, axis: leg.axis });
}

/**
 * Through the intersection with cross street `next`: straight on, or a right turn. Left turns only
 * happen where nothing else is open (city corners, the lot edge), so paths never cross oncoming traffic.
 */
function crossing(leg: Leg, next: number, rng: () => number): { path: Path; leg: Leg; next: number; then: Path } {
  const start = lanePoint(leg, streetAt(next) - leg.dir * (ROAD / 2 + STOP_BACK));
  const straightNext = next + leg.dir;
  const canStraight = straightNext >= 0 && straightNext <= BLOCKS && !isLotSegment(leg.axis, leg.street, next, straightNext);
  // Right of travel: heading +x turns onto +z; heading +z turns onto -x
  const rightDir = (leg.axis === 0 ? leg.dir : -leg.dir) as 1 | -1;
  const other = (1 - leg.axis) as Axis;
  const canRight = leg.street + rightDir >= 0 && leg.street + rightDir <= BLOCKS && !isLotSegment(other, next, leg.street, leg.street + rightDir);
  const turnRight = canRight && (!canStraight || (leg.lane === 1 && rng() < RIGHT_TURN_CHANCE));

  if (!turnRight && canStraight) {
    const exitAt = streetAt(next) + leg.dir * (ROAD / 2);
    const path = makePath([start, lanePoint(leg, exitAt)], null);
    return { path, leg, next: straightNext, then: approach(leg, exitAt, straightNext) };
  }
  const turnDir = (turnRight ? rightDir : -rightDir) as 1 | -1;
  const newLeg: Leg = { axis: (1 - leg.axis) as Axis, dir: turnDir, street: next, lane: turnRight ? 1 : 0 };
  const exitAt = streetAt(leg.street) + turnDir * (ROAD / 2);
  const end = lanePoint(newLeg, exitAt);
  const k = start.distanceTo(end) * 0.4;
  const p1 = start.clone().addScaledVector(forwardOf(leg), k);
  const p2 = end.clone().addScaledVector(forwardOf(newLeg), -k);
  const curve = new THREE.CubicBezierCurve3(start, p1, p2, end);
  const newNext = leg.street + turnDir;
  return { path: makePath(curve.getPoints(14), null), leg: newLeg, next: newNext, then: approach(newLeg, exitAt, newNext) };
}

function makePath(points: THREE.Vector3[], signal: Path['signal']): Path {
  const cum = [0];
  for (let i = 1; i < points.length; i++) cum.push(cum[i - 1] + points[i].distanceTo(points[i - 1]));
  return { points, cum, length: cum[cum.length - 1], signal };
}

function pointOn(path: Path, s: number, point: THREE.Vector3, tangent: THREE.Vector3): void {
  const { points, cum } = path;
  let i = 1;
  while (i < points.length - 1 && cum[i] < s) i++;
  const a = points[i - 1];
  const b = points[i];
  const t = THREE.MathUtils.clamp((s - cum[i - 1]) / Math.max(1e-6, cum[i] - cum[i - 1]), 0, 1);
  point.lerpVectors(a, b, t);
  tangent.subVectors(b, a).normalize();
}

function wrapAngle(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}
