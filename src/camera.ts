import * as THREE from 'three';
import type { Car } from './car';

const BASE_FOV = 62;
const SPEED_FOV = 24; // added at SPEED_FOR_MAX_FOV
const BOOST_FOV = 10;
const SPEED_FOR_MAX_FOV = 70; // m/s
const FOCUS_HEIGHT = 1.3;
const WALL_MARGIN = 0.35;

export type CameraMode = 'chase' | 'cockpit';
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
  private snapped = false;

  toggle(): void {
    this.mode = this.mode === 'chase' ? 'cockpit' : 'chase';
    this.snapped = false;
  }

  /** Jump straight to the target next frame (after a reset) instead of swinging over. */
  snap(): void {
    this.snapped = false;
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

    if (this.mode === 'cockpit') {
      this.camera.position.copy(car.visual.eye).applyQuaternion(car.mesh.quaternion).add(this.carPos);
      this.camera.lookAt(this.tmp.copy(car.forward).multiplyScalar(20).add(this.camera.position));
      return;
    }

    // Aim between the nose and the travel direction so drifts show the car's angle
    const target = this.tmp.set(car.forward.x, 0, car.forward.z).normalize();
    const vx = car.velocity.x;
    const vz = car.velocity.z;
    const flatSpeed = Math.hypot(vx, vz);
    if (flatSpeed > 4 && vx * target.x + vz * target.z > 0) {
      const blend = 0.4 * Math.min(1, (flatSpeed - 4) / 16);
      target.lerp(new THREE.Vector3(vx / flatSpeed, 0, vz / flatSpeed), blend).normalize();
    }
    if (!this.snapped) this.dir.copy(target);
    else this.dir.lerp(target, 1 - Math.exp(-dt * 5)).normalize();

    const distance = 5.6 + 1.5 * speedT;
    const height = 2.1 + 0.3 * speedT;
    const desired = this.tmp.copy(this.dir).multiplyScalar(-distance).add(this.carPos);
    desired.y += height;
    if (!this.snapped) this.pos.copy(desired);
    else this.pos.lerp(desired, 1 - Math.exp(-dt * 12)); // slight lag reads as acceleration
    this.pos.y = Math.max(this.pos.y, 0.6);
    this.snapped = true;

    // Pull in front of any wall between the car and the camera
    const focus = new THREE.Vector3(this.carPos.x, this.carPos.y + FOCUS_HEIGHT, this.carPos.z);
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
    this.camera.lookAt(this.carPos.x + this.dir.x * 3, this.carPos.y + 1.1, this.carPos.z + this.dir.z * 3);
  }
}
