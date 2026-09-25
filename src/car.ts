import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { DriftBoost } from './drift';
import type { Controls } from './input';
import type { CarTuning } from './tuning';

const FORWARD = new THREE.Vector3(1, 0, 0);
const RIGHT = new THREE.Vector3(0, 0, 1);
const UP = new THREE.Vector3(0, 1, 0);

// Rapier rotates a steered wheel about +Y, which turns +X toward -Z (left); our steer input is +right
const STEER_SIGN = -1;

const AIR_LEVELING = 2500; // N·m per radian of tilt while airborne
const AIR_DAMPING = 800;

// Wheel order: front-left, front-right, rear-left, rear-right
const isFront = (i: number) => i < 2;

export class Car {
  readonly body: RAPIER.RigidBody;
  readonly vehicle: RAPIER.DynamicRayCastVehicleController;
  readonly mesh = new THREE.Group();
  readonly drift = new DriftBoost();

  // Telemetry for camera, HUD, audio
  speed = 0;
  forwardSpeed = 0;
  slip = 0; // radians between heading and travel direction; + means sliding to the right
  heading = 0;
  wheelsInContact = 0;
  braking = false;
  skidAmount = 0; // 0..1, drives skid marks and tire audio
  readonly forward = new THREE.Vector3();
  readonly up = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();

  private steerAngle = 0;
  private prevSlip = 0;
  private readonly right = new THREE.Vector3();
  private readonly q = new THREE.Quaternion();
  private readonly tmp = new THREE.Vector3();
  private readonly wheelVisuals: { steer: THREE.Group; spin: THREE.Group; mount: THREE.Vector3 }[] = [];
  private readonly tailMaterial = new THREE.MeshStandardMaterial({ color: 0x550000, emissive: 0xff1a1a, emissiveIntensity: 0.8 });

  constructor(world: RAPIER.World, scene: THREE.Scene, readonly tuning: CarTuning, position: THREE.Vector3, yaw: number) {
    const t = tuning;
    this.body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(position.x, position.y, position.z)
        .setRotation(new THREE.Quaternion().setFromAxisAngle(UP, yaw))
        .setAngularDamping(0.6)
        .setCcdEnabled(true),
    );

    // Box inertia, with roll doubled so hard cornering doesn't tip the car over
    const h = t.chassisHalf;
    const inertia = {
      x: (t.mass / 12) * ((2 * h.y) ** 2 + (2 * h.z) ** 2) * 2,
      y: (t.mass / 12) * ((2 * h.x) ** 2 + (2 * h.z) ** 2),
      z: (t.mass / 12) * ((2 * h.x) ** 2 + (2 * h.y) ** 2),
    };
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(h.x, h.y, h.z)
        .setMassProperties(t.mass, { x: 0, y: t.centerOfMassY, z: 0 }, inertia, { x: 0, y: 0, z: 0, w: 1 })
        .setFriction(0.4)
        .setRestitution(0.1),
      this.body,
    );

    this.vehicle = world.createVehicleController(this.body);
    const mounts = [
      new THREE.Vector3(t.axleFront, t.mountY, -t.halfTrack),
      new THREE.Vector3(t.axleFront, t.mountY, t.halfTrack),
      new THREE.Vector3(t.axleRear, t.mountY, -t.halfTrack),
      new THREE.Vector3(t.axleRear, t.mountY, t.halfTrack),
    ];
    mounts.forEach((mount, i) => {
      // Rapier rolls wheels along contactNormal × axle, so a +Z axle drives toward +X
      this.vehicle.addWheel(mount, { x: 0, y: -1, z: 0 }, { x: 0, y: 0, z: 1 }, t.suspensionRest, t.wheelRadius);
      this.vehicle.setWheelSuspensionStiffness(i, t.suspensionStiffness);
      this.vehicle.setWheelSuspensionCompression(i, t.suspensionCompression);
      this.vehicle.setWheelSuspensionRelaxation(i, t.suspensionRelaxation);
      this.vehicle.setWheelMaxSuspensionTravel(i, t.suspensionTravel);
      this.vehicle.setWheelMaxSuspensionForce(i, t.mass * 40);
    });

    this.buildMesh(mounts);
    scene.add(this.mesh);
    this.readState();
  }

  fixedUpdate(c: Controls, dt: number, offroad: boolean): void {
    const t = this.tuning;
    this.readState();
    this.slip = this.speed > 3 ? Math.atan2(this.velocity.dot(this.right), Math.abs(this.forwardSpeed)) : 0;

    this.drift.update(dt, { speed: this.speed, slip: this.slip, steer: c.steer, handbrake: c.handbrake, boostHeld: c.boost });
    const drifting = this.drift.drifting;

    // Less steering lock at speed. While drifting, the front wheels auto-align with the direction of travel
    // and the player steers relative to that, so steering into a slide doesn't overdrive it into a spin.
    const speedT = Math.min(1, Math.abs(this.forwardSpeed) / t.topSpeed);
    const targetSteer = drifting
      ? THREE.MathUtils.clamp(this.slip + c.steer * t.driftSteer, -t.driftLock, t.driftLock)
      : c.steer * THREE.MathUtils.lerp(t.maxSteer, t.highSpeedSteer, speedT);
    const maxDelta = t.steerRate * (drifting ? 2 : 1) * dt;
    this.steerAngle += THREE.MathUtils.clamp(targetSteer - this.steerAngle, -maxDelta, maxDelta);

    const fwd = this.forwardSpeed;
    const wantsReverse = c.brake > 0.1 && c.throttle < 0.1 && fwd < 1.5;
    let drive = 0;
    let brake = 0;
    if (wantsReverse) {
      drive = fwd > -t.reverseTopSpeed ? -t.reverseForce * c.brake : 0;
    } else if (c.brake > 0.1) {
      brake = t.brakeForce * c.brake;
    } else if (c.throttle > 0) {
      drive = t.engineForce * c.throttle * fade(fwd, t.topSpeed);
    }
    if (this.drift.boosting) drive += t.boostForce * fade(fwd, t.boostTopSpeed);
    if (drive === 0 && brake === 0) brake = t.coastBrake;
    this.braking = c.brake > 0.1 && !wantsReverse;

    const drivenWheels = (t.driveFront ? 2 : 0) + (t.driveRear ? 2 : 0);
    for (let i = 0; i < 4; i++) {
      const front = isFront(i);
      const rearLocked = !front && c.handbrake;
      const driven = front ? t.driveFront : t.driveRear;
      this.vehicle.setWheelSteering(i, front ? STEER_SIGN * this.steerAngle : 0);
      this.vehicle.setWheelEngineForce(i, driven && !rearLocked ? drive / drivenWheels : 0);
      // Rapier treats brake as a per-step impulse cap, so convert force to impulse
      const wheelBrake = rearLocked ? Math.max(brake / 4, t.handbrakeForce / 2) : brake / 4;
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
      if (offroad) grip *= t.offroadGrip;
      this.vehicle.setWheelFrictionSlip(i, grip);
      this.vehicle.setWheelSideFrictionStiffness(i, side);
    }

    this.vehicle.updateVehicle(dt, RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC);
    this.wheelsInContact = 0;
    for (let i = 0; i < 4; i++) if (this.vehicle.wheelIsInContact(i)) this.wheelsInContact++;
    const grounded = this.wheelsInContact >= 2;

    // Aero drag and grass rolling resistance oppose travel; downforce adds grip at speed
    if (this.speed > 0.1) {
      const resist = t.drag * this.speed ** 2 + (offroad && grounded ? t.offroadDrag * this.speed : 0);
      this.body.applyImpulse(this.tmp.copy(this.velocity).multiplyScalar((-resist * dt) / this.speed), true);
    }
    if (grounded) {
      this.body.applyImpulse(this.tmp.copy(this.up).multiplyScalar(-t.downforce * this.speed ** 2 * dt), true);
    }

    const slipRate = (this.slip - this.prevSlip) / dt;
    this.prevSlip = this.slip;
    if (drifting && grounded && this.speed > 5) {
      // Drift angle controller: steering picks a target slip angle (into the corner = wider, counter-steer =
      // narrower) and a damped yaw torque holds the car there, so drifts neither spin out nor snap straight.
      // Torque about +up turns the nose left, which increases slip.
      const side = Math.abs(this.slip) > 0.1 ? Math.sign(this.slip) : -Math.sign(c.steer);
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
      // Air control: gently level the car so ramp jumps land on the wheels
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

  /** World-space contact point of a wheel, or null when it's in the air. */
  contactPoint(i: number, target: THREE.Vector3): THREE.Vector3 | null {
    if (!this.vehicle.wheelIsInContact(i)) return null;
    const p = this.vehicle.wheelContactPoint(i);
    return p ? target.set(p.x, p.y, p.z) : null;
  }

  reset(position: THREE.Vector3, yaw: number): void {
    this.body.setTranslation(position, true);
    this.body.setRotation(new THREE.Quaternion().setFromAxisAngle(UP, yaw), true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.steerAngle = 0;
    this.drift.reset();
    this.readState();
  }

  syncVisuals(): void {
    const p = this.body.translation();
    const r = this.body.rotation();
    this.mesh.position.set(p.x, p.y, p.z);
    this.mesh.quaternion.set(r.x, r.y, r.z, r.w);
    this.wheelVisuals.forEach((w, i) => {
      const length = this.vehicle.wheelSuspensionLength(i) ?? this.tuning.suspensionRest;
      w.steer.position.set(w.mount.x, w.mount.y - length, w.mount.z);
      w.steer.rotation.y = this.vehicle.wheelSteering(i) ?? 0;
      w.spin.rotation.z = -(this.vehicle.wheelRotation(i) ?? 0);
    });
    this.tailMaterial.emissiveIntensity = this.braking ? 3 : 0.8;
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

  private buildMesh(mounts: THREE.Vector3[]): void {
    const t = this.tuning;
    const paint = new THREE.MeshStandardMaterial({ color: t.paint, metalness: 0.4, roughness: 0.35 });
    const glass = new THREE.MeshStandardMaterial({ color: 0x1a2230, metalness: 0.6, roughness: 0.15 });
    const trim = new THREE.MeshStandardMaterial({ color: 0x1b1b1f, roughness: 0.6 });
    const stripe = new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.4 });
    const headlight = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff2cc, emissiveIntensity: 1.5 });

    const part = (w: number, h: number, d: number, mat: THREE.Material, x: number, y: number, z: number) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      m.position.set(x, y, z);
      m.castShadow = true;
      this.mesh.add(m);
    };
    const L = t.chassisHalf.x * 2 + 0.1;
    const W = t.chassisHalf.z * 2 + 0.08;
    part(L, 0.5, W, paint, 0, -0.2, 0); // body
    part(1.9, 0.46, W * 0.8, glass, -0.3, 0.28, 0); // cabin
    part(1.5, 0.05, W * 0.76, paint, -0.35, 0.53, 0); // roof
    part(L * 0.4, 0.01, 0.34, stripe, L * 0.28, 0.055, 0); // hood stripe
    part(0.3, 0.05, W * 0.95, trim, -L / 2 + 0.15, 0.34, 0); // wing
    for (const z of [-0.6, 0.6]) {
      part(0.08, 0.28, 0.08, trim, -L / 2 + 0.2, 0.18, z); // wing posts
      part(0.05, 0.1, 0.36, headlight, L / 2, -0.08, z);
      part(0.05, 0.1, 0.4, this.tailMaterial, -L / 2, -0.05, z);
    }

    const r = t.wheelRadius;
    const tireGeo = new THREE.CylinderGeometry(r, r, 0.28, 20).rotateX(Math.PI / 2);
    const rimGeo = new THREE.CylinderGeometry(r * 0.6, r * 0.6, 0.3, 10).rotateX(Math.PI / 2);
    const tireMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.9 });
    const rimMat = new THREE.MeshStandardMaterial({ color: 0xbfc3c7, metalness: 0.8, roughness: 0.3 });
    for (const mount of mounts) {
      const steer = new THREE.Group();
      const spin = new THREE.Group();
      const tire = new THREE.Mesh(tireGeo, tireMat);
      tire.castShadow = true;
      spin.add(tire, new THREE.Mesh(rimGeo, rimMat));
      steer.add(spin);
      this.mesh.add(steer);
      this.wheelVisuals.push({ steer, spin, mount });
    }
  }
}

/** Drive force multiplier that fades to zero as forward speed approaches the limit. */
function fade(forwardSpeed: number, limit: number): number {
  return Math.max(0, 1 - (Math.max(0, forwardSpeed) / limit) ** 2);
}
