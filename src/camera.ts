import * as THREE from 'three';
import type { Car } from './car';

const BASE_FOV = 60;
const SPEED_FOV = 10; // added at SPEED_FOR_MAX_FOV: enough to feel the speed, not so much the world shrinks away
const BOOST_FOV = 6;
const SPEED_FOR_MAX_FOV = 70; // m/s
const FOCUS_HEIGHT = 1.3;
const WALL_MARGIN = 0.35;
const MAX_LAG = 0.6; // m the chase camera may fall behind where it wants to be (hard acceleration)
// Looking around (mouse drag, right stick): how fast the view follows the input, and how it settles back
const LOOK_FOLLOW = 14; // 1/s
const LOOK_RETURN = 3.2; // 1/s, once the input is let go
const LOOK_RETURN_DELAY = 0.35; // s held where it was before it starts to settle back

/** Where the player is looking, relative to straight ahead: yaw (+ right) and pitch (+ up), radians. */
export interface Look {
  yaw: number;
  pitch: number;
  active: boolean; // input held; when let go the view settles back behind the car
}

export type CameraMode = 'chase' | 'chase_far' | 'hood' | 'cockpit' | 'drone';
const MODES: CameraMode[] = ['chase', 'chase_far', 'hood', 'cockpit', 'drone'];
/** Distance from `from` toward `to` before hitting world geometry (Infinity when clear). */
export type Clearance = (from: THREE.Vector3, to: THREE.Vector3) => number;

export class ChaseCamera {
  readonly camera = new THREE.PerspectiveCamera(BASE_FOV, 1, 0.3, 3000);
  mode: CameraMode = 'chase';
  private readonly pos = new THREE.Vector3();
  private readonly dir = new THREE.Vector3(1, 0, 0);
  private readonly carPos = new THREE.Vector3();
  private readonly tmp = new THREE.Vector3();
  private fov = BASE_FOV;
  private time = 0;
  private orbit = 0;
  private snapped = false;
  private lookYaw = 0;
  private lookPitch = 0;
  private lookIdle = 0; // s since the look input was let go

  toggle(): CameraMode {
    const nextIdx = (MODES.indexOf(this.mode) + 1) % MODES.length;
    this.mode = MODES[nextIdx];
    this.snapped = false;
    return this.mode;
  }

  /**
   * Crash cam: a slow orbit around the wreck, starting behind where the car was heading.
   * `t` is seconds since the crash.
   */
  crash(t: number, car: Car, clearance: Clearance): void {
    const p = car.body.translation();
    const focus = this.carPos.set(p.x, p.y + 0.6, p.z);
    if (t === 0) this.orbit = Math.atan2(-this.dir.z, -this.dir.x);
    const angle = this.orbit + t * 0.9;
    const want = this.tmp.set(focus.x + Math.cos(angle) * 8, focus.y + 2.2 + t * 0.6, focus.z + Math.sin(angle) * 8);
    const reach = focus.distanceTo(want);
    const clear = clearance(focus, want);
    if (clear < reach) want.lerpVectors(focus, want, Math.max(0.3, clear - WALL_MARGIN) / reach);
    this.camera.position.copy(want);
    this.camera.lookAt(focus);
    this.fov += (BASE_FOV - 6 - this.fov) * 0.1;
    this.camera.fov = this.fov;
    this.camera.updateProjectionMatrix();
    this.snapped = false;
  }

  /** Jump straight to the target next frame (after a reset) instead of swinging over. */
  snap(): void {
    this.snapped = false;
  }

  /** Feed the look input each frame, before update(). */
  look(dt: number, look: Look): void {
    if (look.active) {
      this.lookIdle = 0;
      const k = 1 - Math.exp(-dt * LOOK_FOLLOW);
      // The short way round, so a stick swinging past 180° doesn't spin the view
      const dy = Math.atan2(Math.sin(look.yaw - this.lookYaw), Math.cos(look.yaw - this.lookYaw));
      this.lookYaw += dy * k;
      this.lookPitch += (look.pitch - this.lookPitch) * k;
      return;
    }
    this.lookIdle += dt;
    if (this.lookIdle < LOOK_RETURN_DELAY) return;
    const k = 1 - Math.exp(-dt * LOOK_RETURN);
    this.lookYaw -= Math.atan2(Math.sin(this.lookYaw), Math.cos(this.lookYaw)) * k;
    this.lookPitch -= this.lookPitch * k;
  }

  update(dt: number, car: Car, clearance: Clearance): void {
    this.time += dt;
    const speedT = Math.min(1, car.speed / SPEED_FOR_MAX_FOV);
    const boost = car.drift.boosting ? 1 : 0;

    // Widening FOV with speed is the main sense-of-speed lever
    const targetFov = BASE_FOV + SPEED_FOV * speedT + BOOST_FOV * boost;
    this.fov += (targetFov - this.fov) * (1 - Math.exp(-dt * 4));
    this.camera.fov = this.fov;
    this.camera.updateProjectionMatrix();

    const p = car.body.translation();
    this.carPos.set(p.x, p.y, p.z);

    if (this.mode === 'cockpit' || this.mode === 'hood') {
      // In the car: the head turns (yaw about the car's up, pitch about its right)
      const at = this.mode === 'cockpit'
        ? car.visual.eye.clone()
        : new THREE.Vector3(car.visual.chassisCenter.x + car.visual.chassisHalf.x * 0.72, 0.78, 0);
      this.camera.position.copy(at).applyQuaternion(car.mesh.quaternion).add(this.carPos);
      const view = new THREE.Vector3(Math.cos(this.lookPitch) * Math.cos(this.lookYaw), Math.sin(this.lookPitch), Math.cos(this.lookPitch) * Math.sin(this.lookYaw));
      view.applyQuaternion(car.mesh.quaternion);
      this.camera.lookAt(this.tmp.copy(view).multiplyScalar(25).add(this.camera.position));
      return;
    }

    // Aim between the nose and the travel direction so drifts show the car's angle
    const target = this.tmp.set(car.forward.x, 0, car.forward.z).normalize();
    const vx = car.velocity.x;
    const vz = car.velocity.z;
    const flatSpeed = Math.hypot(vx, vz);
    if (flatSpeed > 4 && vx * target.x + vz * target.z > 0) {
      const blend = (this.mode === 'drone' ? 0.2 : 0.4) * Math.min(1, (flatSpeed - 4) / 16);
      target.lerp(new THREE.Vector3(vx / flatSpeed, 0, vz / flatSpeed), blend).normalize();
    }
    if (!this.snapped) this.dir.copy(target);
    else this.dir.lerp(target, 1 - Math.exp(-dt * 5)).normalize();

    // Close behind: pulls back a little with speed (the lag below adds a little more under hard acceleration)
    let distance = 4.5 + 0.5 * speedT;
    let height = 1.7 + 0.15 * speedT;
    let focusHeight = FOCUS_HEIGHT;
    let lookAhead = 3;
    let lookTargetY = 1.05;

    if (this.mode === 'chase_far') {
      distance = 6.6 + 1.2 * speedT;
      height = 2.5 + 0.3 * speedT;
      focusHeight = 1.4;
      lookAhead = 3.5;
      lookTargetY = 1.25;
    } else if (this.mode === 'drone') {
      distance = 14.0 + 3.0 * speedT;
      height = 8.5 + 1.5 * speedT;
      focusHeight = 1.5;
      lookAhead = 2.0;
      lookTargetY = 0.5;
    }

    // Looking around orbits the camera about the car: yaw round it, pitch up and over it
    const looking = Math.abs(this.lookYaw) > 0.02 || Math.abs(this.lookPitch) > 0.02;
    const cy = Math.cos(this.lookYaw);
    const sy = Math.sin(this.lookYaw);
    const orbitX = this.dir.x * cy - this.dir.z * sy;
    const orbitZ = this.dir.x * sy + this.dir.z * cy;
    const pitch = THREE.MathUtils.clamp(this.lookPitch, -0.15, 1.1);
    const flat = distance * Math.cos(pitch);
    const desired = this.tmp.set(-orbitX * flat, 0, -orbitZ * flat).add(this.carPos);
    desired.y += height + distance * Math.sin(pitch);
    if (!this.snapped) this.pos.copy(desired);
    else {
      this.pos.lerp(desired, 1 - Math.exp(-dt * (looking ? 20 : 12))); // slight lag reads as acceleration
      // …but never so much that the car runs away from the camera
      const behind = this.pos.distanceTo(desired);
      if (behind > MAX_LAG) this.pos.lerp(desired, 1 - MAX_LAG / behind);
    }
    this.pos.y = Math.max(this.pos.y, this.carPos.y + 0.6); // never down in the road
    this.snapped = true;

    // Pull in front of any wall between the car and the camera
    const focus = new THREE.Vector3(this.carPos.x, this.carPos.y + focusHeight, this.carPos.z);
    const reach = focus.distanceTo(this.pos);
    const clear = clearance(focus, this.pos);
    const eye = clear < reach ? this.tmp.lerpVectors(focus, this.pos, Math.max(0.8, clear - WALL_MARGIN) / reach) : this.tmp.copy(this.pos);

    // Shake at high speed and on boost
    const shake = 0.035 * Math.min(1, Math.max(0, (car.speed - 35) / 35)) + 0.05 * boost;
    this.camera.position.set(
      eye.x + Math.sin(this.time * 37) * shake,
      eye.y + Math.sin(this.time * 45 + 1.3) * shake,
      eye.z + Math.sin(this.time * 41 + 2.1) * shake,
    );
    // Ahead of the car normally; at the car itself while looking around it
    const ahead = looking ? lookAhead * Math.max(0, Math.cos(this.lookYaw)) : lookAhead;
    this.camera.lookAt(this.carPos.x + this.dir.x * ahead, this.carPos.y + lookTargetY, this.carPos.z + this.dir.z * ahead);
  }
}
