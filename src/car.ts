import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { CarDamage, contactImpact, impactFromVelocity, impactStrength } from './damage';
import type { CarVisual } from './modcar';
import { DriftBoost } from './drift';
import type { Controls } from './input';
import type { CarTuning } from './tuning';

const FORWARD = new THREE.Vector3(1, 0, 0);
const RIGHT = new THREE.Vector3(0, 0, 1);
const UP = new THREE.Vector3(0, 1, 0);
const GRAVITY = 9.81;

// Rapier rotates a steered wheel about +Y, which turns +X toward -Z (left); our steer input is +right
const STEER_SIGN = -1;

const WORN_POWER = 0.55; // share of engine force a car with no health left has lost
const WORN_TOP_SPEED = 0.35; // share of top speed lost
const WORN_PULL = 0.05; // rad/s of steering drift at full wear

const AIR_LEVELING = 2500; // N·m per radian of tilt while airborne
// Steering lock falls off with speed as limit = maxSteer / (1 + (v / STEER_FALLOFF)^STEER_FALLOFF_POWER):
// full lock for parking, a calm few degrees on the highway (the tires couldn't use more anyway)
const STEER_FALLOFF = 20; // m/s
const STEER_FALLOFF_POWER = 1.3;
// Stability assist (off while drifting or on the handbrake): yaw beyond what the steering asks for is
// damped, so a twitch at speed doesn't become a spin
const STABILITY = 2.6; // 1/s: how hard excess yaw is pulled back (times the car's yaw inertia)
const STABILITY_MARGIN = 0.12; // rad/s of yaw beyond the asked-for rate before it steps in
const AIR_DAMPING = 800;

// Wheel order: front-left, front-right, rear-left, rear-right
const isFront = (i: number) => i < 2;

/**
 * A driven car: Rapier raycast vehicle plus arcade assists. The rigid body's origin is at ground
 * level under the car, matching the model; the chassis collider sits above it.
 */
export class Car {
  readonly body: RAPIER.RigidBody;
  readonly collider: RAPIER.Collider;
  readonly vehicle: RAPIER.DynamicRayCastVehicleController;
  readonly mesh: THREE.Group;
  readonly visual: CarVisual;
  readonly drift = new DriftBoost();
  readonly damage: CarDamage;

  // Telemetry for camera, HUD, audio
  speed = 0;
  forwardSpeed = 0;
  slip = 0; // radians between heading and travel direction; + means sliding to the right
  heading = 0;
  wheelsInContact = 0;
  braking = false;
  skidAmount = 0; // 0..1, drives skid marks and tire audio
  powerScale = 1; // engine force multiplier (rival catch-up)
  /** 1 = factory fresh, 0 = totaled. Crashes and hard hits wear it down; a worn car is slower and pulls to one side. */
  health = 1;
  /** Totaled: the engine is dead and the car only rolls. Only a new car (repair()) brings it back. */
  destroyed = false;
  readonly forward = new THREE.Vector3();
  readonly up = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();

  private steerAngle = 0;
  private readonly wheelbase: number;
  private readonly yawInertia: number;
  private pull = 0; // steering bias a bent chassis gives, -1..1 (set by the first real hit)
  private prevSlip = 0;
  private prevHandbrake = false;
  private readonly mounts: THREE.Vector3[];
  private readonly right = new THREE.Vector3();
  private readonly q = new THREE.Quaternion();
  private readonly tmp = new THREE.Vector3();
  private readonly before = new THREE.Vector3();

  constructor(world: RAPIER.World, scene: THREE.Scene, readonly tuning: CarTuning, position: THREE.Vector3, yaw: number, headlights = false) {
    const t = tuning;
    this.visual = t.makeVisual(t);
    this.mesh = this.visual.root;
    this.damage = new CarDamage(this.mesh, { wheels: this.visual.wheels.map((w) => w.steer) });

    this.body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(position.x, position.y, position.z)
        .setRotation(new THREE.Quaternion().setFromAxisAngle(UP, yaw))
        .setAngularDamping(0.6)
        .setCcdEnabled(true),
    );

    // Box inertia, with roll doubled so hard cornering doesn't tip the car over
    const c = this.visual.chassisCenter;
    const h = this.visual.chassisHalf;
    const inertia = {
      x: (t.mass / 12) * ((2 * h.y) ** 2 + (2 * h.z) ** 2) * 2,
      y: (t.mass / 12) * ((2 * h.x) ** 2 + (2 * h.z) ** 2),
      z: (t.mass / 12) * ((2 * h.x) ** 2 + (2 * h.y) ** 2),
    };
    const wheels = this.visual.wheels;
    const comX = (wheels[0].center.x + wheels[2].center.x) / 2;
    this.wheelbase = Math.max(2, Math.abs(wheels[0].center.x - wheels[2].center.x));
    this.yawInertia = inertia.y;
    this.collider = world.createCollider(
      RAPIER.ColliderDesc.cuboid(h.x, h.y, h.z)
        .setTranslation(c.x, c.y, c.z)
        .setMassProperties(t.mass, { x: comX - c.x, y: t.centerOfMassHeight - c.y, z: 0 }, inertia, { x: 0, y: 0, z: 0, w: 1 })
        .setFriction(0.4)
        .setRestitution(0.1),
      this.body,
    );

    // Mount each suspension so the wheel settles at the model's wheel position under static load
    const sag = GRAVITY / (4 * t.suspensionStiffness);
    this.vehicle = world.createVehicleController(this.body);
    this.mounts = wheels.map((w) => w.center.clone().setY(w.center.y + t.suspensionRest - sag));
    this.mounts.forEach((mount, i) => {
      // Rapier rolls wheels along contactNormal × axle, so a +Z axle drives toward +X
      this.vehicle.addWheel(mount, { x: 0, y: -1, z: 0 }, { x: 0, y: 0, z: 1 }, t.suspensionRest, this.visual.wheelRadius);
      this.vehicle.setWheelSuspensionStiffness(i, t.suspensionStiffness);
      this.vehicle.setWheelSuspensionCompression(i, t.suspensionCompression);
      this.vehicle.setWheelSuspensionRelaxation(i, t.suspensionRelaxation);
      this.vehicle.setWheelMaxSuspensionTravel(i, t.suspensionTravel);
      this.vehicle.setWheelMaxSuspensionForce(i, t.mass * 40);
    });

    if (headlights) {
      const lamp = new THREE.SpotLight(0xdbe8ff, 350, 80, 0.5, 0.5, 1.3);
      const nose = this.visual.chassisCenter.x + this.visual.chassisHalf.x;
      lamp.position.set(nose - 0.3, 0.7, 0);
      lamp.target.position.set(nose + 20, 0, 0);
      this.mesh.add(lamp, lamp.target);
    }
    scene.add(this.mesh);
    this.readState();
  }

  fixedUpdate(c: Controls, dt: number): void {
    const t = this.tuning;
    this.readState();
    this.slip = this.speed > 3 ? Math.atan2(this.velocity.dot(this.right), Math.abs(this.forwardSpeed)) : 0;

    this.drift.update(dt, { speed: this.speed, slip: this.slip, steer: c.steer, handbrake: c.handbrake, boostHeld: c.boost });
    const drifting = this.drift.drifting;

    // Less steering lock at speed. While drifting, the front wheels auto-align with the direction of travel
    // and the player steers relative to that, so steering into a slide doesn't overdrive it into a spin.
    const lock = Math.max(t.highSpeedSteer * 0.45, t.maxSteer / (1 + (Math.abs(this.forwardSpeed) / STEER_FALLOFF) ** STEER_FALLOFF_POWER));
    const targetSteer = drifting
      ? THREE.MathUtils.clamp(this.slip + c.steer * t.driftSteer, -t.driftLock, t.driftLock)
      : c.steer * lock;
    const maxDelta = t.steerRate * (drifting ? 2 : 1) * dt;
    this.steerAngle += THREE.MathUtils.clamp(targetSteer - this.steerAngle, -maxDelta, maxDelta);

    // A bent car pulls to one side and loses power; a totaled one has none
    const worn = 1 - this.health;
    this.steerAngle += this.pull * worn * WORN_PULL * dt * Math.min(1, this.speed / 10);
    const power = this.destroyed ? 0 : 1 - worn * WORN_POWER;
    const fwd = this.forwardSpeed;
    const wantsReverse = c.brake > 0.1 && c.throttle < 0.1 && fwd < 1.0;
    const wantsBrakeReverse = c.throttle > 0.1 && c.brake < 0.1 && fwd < -0.5;
    let drive = 0;
    let brake = 0;
    if (wantsReverse) {
      drive = fwd > -t.reverseTopSpeed ? -t.reverseForce * c.brake * power : 0;
    } else if (wantsBrakeReverse) {
      brake = t.brakeForce * c.throttle;
    } else if (c.brake > 0.1) {
      brake = t.brakeForce * c.brake;
    } else if (c.throttle > 0) {
      drive = t.engineForce * this.powerScale * power * c.throttle * fade(fwd, t.topSpeed * (1 - worn * WORN_TOP_SPEED));
    }
    if (this.drift.boosting && !this.destroyed) drive += t.boostForce * fade(fwd, t.boostTopSpeed);
    if (drive === 0 && brake === 0) brake = t.coastBrake;
    this.braking = (c.brake > 0.1 && !wantsReverse) || wantsBrakeReverse;

    const drivenWheels = (t.driveFront ? 2 : 0) + (t.driveRear ? 2 : 0);
    for (let i = 0; i < 4; i++) {
      const front = isFront(i);
      const rearLocked = !front && c.handbrake;
      const driven = front ? t.driveFront : t.driveRear;
      this.vehicle.setWheelSteering(i, front ? STEER_SIGN * this.steerAngle : 0);
      this.vehicle.setWheelEngineForce(i, driven && !rearLocked ? drive / drivenWheels : 0);
      // Front brake bias (60% front, 40% rear) gives stable bite; rear locked for handbrake
      const axleBrake = front ? brake * 0.30 : brake * 0.20;
      const wheelBrake = rearLocked ? Math.max(axleBrake, t.handbrakeForce / 2) : axleBrake;
      this.vehicle.setWheelBrake(i, wheelBrake * dt);

      let grip = front ? t.gripFront : t.gripRear;
      let side = 1;
      if (rearLocked) {
        grip = t.handbrakeGripRear;
        side = t.driftSideStiffness;
      } else if (!front && drifting) {
        grip = t.driftGripRear;
        side = t.driftSideStiffness;
      }
      this.vehicle.setWheelFrictionSlip(i, grip);
      this.vehicle.setWheelSideFrictionStiffness(i, side);
    }

    this.vehicle.updateVehicle(dt, RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC);
    this.wheelsInContact = 0;
    for (let i = 0; i < 4; i++) if (this.vehicle.wheelIsInContact(i)) this.wheelsInContact++;
    const grounded = this.wheelsInContact >= 2;

    // Handbrake kick: immediate yaw torque impulse on tap to break the rear loose cleanly into the turn
    const handbrakeTap = c.handbrake && !this.prevHandbrake;
    this.prevHandbrake = c.handbrake;
    if (handbrakeTap && Math.abs(c.steer) > 0.1 && this.speed > 4.5 && grounded) {
      const kickYaw = -Math.sign(c.steer) * (t.mass * 22) * Math.abs(c.steer);
      this.body.applyTorqueImpulse(this.tmp.copy(this.up).multiplyScalar(kickYaw * dt), true);
    }

    // Aero drag opposes travel; downforce adds grip at speed
    if (this.speed > 0.1) {
      this.body.applyImpulse(this.tmp.copy(this.velocity).multiplyScalar((-t.drag * this.speed * dt)), true);
    }
    if (grounded) {
      this.body.applyImpulse(this.tmp.copy(this.up).multiplyScalar(-t.downforce * this.speed ** 2 * dt), true);
    }

    if (!drifting && !c.handbrake && grounded && this.speed > 8) this.stabilize(dt);

    const slipRate = (this.slip - this.prevSlip) / dt;
    this.prevSlip = this.slip;
    if (drifting && grounded && this.speed > 4) {
      // Drift angle controller: steering picks a target slip angle (into the corner = wider, counter-steer =
      // narrower) and a damped yaw torque holds the car there, so drifts neither spin out nor snap straight.
      // Torque about +up turns the nose left, which increases slip.
      const side = Math.abs(this.slip) > 0.08 ? Math.sign(this.slip) : -Math.sign(c.steer);
      const into = -side * c.steer;
      const targetSlip = side * Math.max(0, t.driftAngle + into * t.driftAngleRange);
      const yaw = THREE.MathUtils.clamp(
        t.driftYawStiffness * (targetSlip - this.slip) - t.driftYawDamping * slipRate,
        -t.driftMaxTorque,
        t.driftMaxTorque,
      );
      this.body.applyTorqueImpulse(this.tmp.copy(this.up).multiplyScalar(yaw * dt), true);

      // Keep momentum through the slide so drifting isn't a pure speed penalty
      if (c.throttle > 0) {
        this.tmp.set(this.velocity.x, 0, this.velocity.z).normalize();
        this.body.applyImpulse(this.tmp.multiplyScalar(t.driftSustain * t.mass * c.throttle * dt), true);
      }
    }

    if (this.wheelsInContact === 0) {
      // Air control: gently level the car so jumps land on the wheels
      const w = this.body.angvel();
      this.tmp.copy(this.up).cross(UP).multiplyScalar(AIR_LEVELING);
      this.tmp.x -= w.x * AIR_DAMPING;
      this.tmp.z -= w.z * AIR_DAMPING;
      this.body.applyTorqueImpulse(this.tmp.multiplyScalar(dt), true);
    }

    const sliding = drifting ? Math.min(1, Math.abs(this.slip) / 0.6) : 0;
    const locking = (c.handbrake || this.braking) && this.speed > 5 ? 0.6 : 0;
    this.skidAmount = grounded ? Math.max(sliding, locking) : 0;
  }

  /**
   * Stability assist: the yaw rate the steering asks for (a bicycle model, capped at what the tires can
   * hold), and a damping torque on any yaw beyond it. Only excess is taken away; it never steers for you.
   */
  private stabilize(dt: number): void {
    const t = this.tuning;
    const v = this.forwardSpeed;
    // Turning right is negative yaw about +up
    let wanted = (-v * Math.tan(this.steerAngle)) / this.wheelbase;
    const grip = (Math.max(t.gripFront, t.gripRear) * GRAVITY * 1.15) / Math.max(1, Math.abs(v));
    wanted = THREE.MathUtils.clamp(wanted, -grip, grip);
    const yaw = this.body.angvel();
    const r = yaw.x * this.up.x + yaw.y * this.up.y + yaw.z * this.up.z;
    let excess = 0;
    if (Math.sign(r) === Math.sign(wanted) || Math.abs(wanted) < 0.02) {
      if (Math.abs(r) > Math.abs(wanted) + STABILITY_MARGIN) excess = r - Math.sign(r) * (Math.abs(wanted) + STABILITY_MARGIN);
    } else if (Math.abs(r) > STABILITY_MARGIN) {
      excess = r - Math.sign(r) * STABILITY_MARGIN; // turning against the steering: a slide the other way
    }
    if (excess === 0) return;
    const torque = THREE.MathUtils.clamp(-excess * STABILITY * this.yawInertia, -t.mass * 30, t.mass * 30);
    this.body.applyTorqueImpulse(this.tmp.copy(this.up).multiplyScalar(torque * dt), true);
  }

  /** Call right before world.step(), after fixedUpdate has applied this step's driving impulses. */
  markVelocity(): void {
    const v = this.body.linvel();
    this.before.set(v.x, v.y, v.z);
  }

  /** Horizontal velocity change over the last world.step(). Collisions show up as spikes. */
  impact(): number {
    const v = this.body.linvel();
    return Math.hypot(v.x - this.before.x, v.z - this.before.z);
  }

  /** The horizontal velocity change over the last world.step() as a vector (see impact()). */
  impactVector(out: THREE.Vector3): THREE.Vector3 {
    const v = this.body.linvel();
    return out.set(v.x - this.before.x, 0, v.z - this.before.z);
  }

  /**
   * Dent the body after a hit: call after world.step() with this step's impact(). The contact
   * manifolds give the point; failing that, the direction of the velocity change does.
   */
  applyDamage(world: RAPIER.World, dv: number): void {
    const strength = impactStrength(dv);
    if (strength <= 0) return;
    const v = this.body.linvel();
    const point = new THREE.Vector3();
    const dir = new THREE.Vector3();
    const found = contactImpact(world, this.collider, point, dir)
      || impactFromVelocity(new THREE.Vector3(v.x - this.before.x, 0, v.z - this.before.z), this.body.rotation(), this.visual.chassisCenter, this.visual.chassisHalf, point, dir);
    if (found) this.damage.hitLocal(point, dir, strength);
  }

  /** World-space contact point of a wheel, or null when it's in the air. */
  contactPoint(i: number, target: THREE.Vector3): THREE.Vector3 | null {
    if (!this.vehicle.wheelIsInContact(i)) return null;
    const p = this.vehicle.wheelContactPoint(i);
    return p ? target.set(p.x, p.y, p.z) : null;
  }

  /**
   * Wear from a hit: `amount` 0..1 of the car's health. Returns true when this hit totals it. The body
   * dents separately (applyDamage); this is what the hits add up to.
   */
  wear(amount: number): boolean {
    if (this.destroyed || amount <= 0) return false;
    if (this.pull === 0) this.pull = Math.random() < 0.5 ? -1 : 1;
    this.health = Math.max(0, this.health - amount);
    if (this.health > 0) return false;
    this.destroyed = true;
    this.drift.reset();
    this.damage.totaled();
    return true;
  }

  /** A fresh car: undented, full health. */
  repair(): void {
    this.health = 1;
    this.destroyed = false;
    this.pull = 0;
    this.damage.repair();
  }

  /** Back on the wheels where the car is, e.g. after a rollover: keeps position and heading. */
  rightUp(): void {
    const p = this.body.translation();
    this.body.setTranslation({ x: p.x, y: p.y + 1.2, z: p.z }, true);
    this.body.setRotation(new THREE.Quaternion().setFromAxisAngle(UP, -this.heading), true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.readState();
  }

  reset(position: THREE.Vector3, yaw: number): void {
    this.body.setTranslation(position, true);
    this.body.setRotation(new THREE.Quaternion().setFromAxisAngle(UP, yaw), true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.steerAngle = 0;
    this.prevHandbrake = false;
    this.drift.reset();
    this.readState();
  }

  syncVisuals(): void {
    const p = this.body.translation();
    const r = this.body.rotation();
    this.mesh.position.set(p.x, p.y, p.z);
    this.mesh.quaternion.set(r.x, r.y, r.z, r.w);
    this.visual.wheels.forEach((w, i) => {
      const mount = this.mounts[i];
      const length = this.vehicle.wheelSuspensionLength(i) ?? this.tuning.suspensionRest;
      w.steer.position.set(mount.x, mount.y - length, mount.z);
      w.steer.rotation.y = this.vehicle.wheelSteering(i) ?? 0;
      w.spin.rotation.z = -(this.vehicle.wheelRotation(i) ?? 0);
    });
    this.visual.setBraking(this.braking);
  }

  dispose(world: RAPIER.World, scene: THREE.Scene): void {
    world.removeVehicleController(this.vehicle);
    world.removeRigidBody(this.body);
    scene.remove(this.mesh);
  }

  private readState(): void {
    const r = this.body.rotation();
    this.q.set(r.x, r.y, r.z, r.w);
    this.forward.copy(FORWARD).applyQuaternion(this.q);
    this.right.copy(RIGHT).applyQuaternion(this.q);
    this.up.copy(UP).applyQuaternion(this.q);
    const v = this.body.linvel();
    this.velocity.set(v.x, v.y, v.z);
    this.speed = this.velocity.length();
    this.forwardSpeed = this.velocity.dot(this.forward);
    this.heading = Math.atan2(this.forward.z, this.forward.x);
  }
}

/** Drive force multiplier that fades to zero as forward speed approaches the limit. */
function fade(forwardSpeed: number, limit: number): number {
  return Math.max(0, 1 - (Math.max(0, forwardSpeed) / limit) ** 2);
}
