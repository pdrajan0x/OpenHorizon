import * as THREE from 'three';

const MAX_MARKS = 4000;
const MIN_SEGMENT = 0.4; // meters of travel before laying another mark
const MAX_SEGMENT = 3; // longer jumps mean a reset or teleport, so start a new trail

/** Tire skid trails as a ring buffer of flat quads, one instanced draw call. */
export class SkidMarks {
  private readonly mesh: THREE.InstancedMesh;
  private readonly last: (THREE.Vector3 | null)[] = [];
  private readonly dummy = new THREE.Object3D();
  private next = 0;

  constructor(scene: THREE.Scene) {
    const geo = new THREE.PlaneGeometry(1, 0.26).rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({
      color: 0x111111, transparent: true, opacity: 0.55, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -2,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, MAX_MARKS);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
  }

  /** Extend trail `id` to `point`, or end it when `point` is null. */
  update(id: number, point: THREE.Vector3 | null): void {
    if (!point) {
      this.last[id] = null;
      return;
    }
    const prev = this.last[id];
    if (!prev) {
      this.last[id] = point.clone();
      return;
    }
    const dx = point.x - prev.x;
    const dz = point.z - prev.z;
    const length = Math.hypot(dx, dz);
    if (length < MIN_SEGMENT) return;
    if (length < MAX_SEGMENT) {
      this.dummy.position.set((prev.x + point.x) / 2, point.y + 0.035, (prev.z + point.z) / 2);
      this.dummy.rotation.set(0, Math.atan2(-dz, dx), 0);
      this.dummy.scale.set(length, 1, 1);
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(this.next, this.dummy.matrix);
      this.mesh.instanceMatrix.needsUpdate = true;
      this.next = (this.next + 1) % MAX_MARKS;
      this.mesh.count = Math.min(MAX_MARKS, this.mesh.count + 1);
    }
    prev.copy(point);
  }

  breakAll(): void {
    this.last.fill(null);
  }
}

const MAX_SPARKS = 600;
const SPARK_LIFE = 0.9;

/** Crash sparks: short-lived additive points thrown out of an impact, one draw call. */
export class Sparks {
  private readonly points: THREE.Points;
  private readonly pos = new Float32Array(MAX_SPARKS * 3);
  private readonly vel = new Float32Array(MAX_SPARKS * 3);
  private readonly life = new Float32Array(MAX_SPARKS);
  private readonly color = new Float32Array(MAX_SPARKS * 3);
  private next = 0;

  constructor(scene: THREE.Scene) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.color, 3));
    this.points = new THREE.Points(geo, new THREE.PointsMaterial({
      size: 0.16, vertexColors: true, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending,
    }));
    this.points.frustumCulled = false;
    scene.add(this.points);
  }

  /** Throw `count` sparks from `at`, biased along `dir` (any length), with speed around `speed`. */
  burst(at: THREE.Vector3, dir: THREE.Vector3, count: number, speed: number): void {
    const d = dir.clone().normalize();
    for (let n = 0; n < count; n++) {
      const i = this.next;
      this.next = (this.next + 1) % MAX_SPARKS;
      const s = speed * (0.3 + Math.random() * 0.9);
      this.pos.set([at.x, at.y, at.z], i * 3);
      this.vel.set([
        d.x * s + (Math.random() - 0.5) * speed,
        Math.random() * speed * 0.6 + 1,
        d.z * s + (Math.random() - 0.5) * speed,
      ], i * 3);
      this.life[i] = SPARK_LIFE * (0.5 + Math.random() * 0.5);
    }
  }

  update(dt: number): void {
    for (let i = 0; i < MAX_SPARKS; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      const k = i * 3;
      this.vel[k + 1] -= 9.81 * dt;
      this.pos[k] += this.vel[k] * dt;
      this.pos[k + 1] = Math.max(0.02, this.pos[k + 1] + this.vel[k + 1] * dt);
      this.pos[k + 2] += this.vel[k + 2] * dt;
      // Fade white-hot → orange → out; dead sparks go black, which additive blending hides
      const t = Math.max(0, this.life[i] / SPARK_LIFE);
      this.color[k] = t > 0 ? 1.6 * t + 0.2 : 0;
      this.color[k + 1] = t > 0 ? 1.1 * t * t + 0.05 : 0;
      this.color[k + 2] = t > 0 ? 0.5 * t * t * t : 0;
    }
    this.points.geometry.attributes.position.needsUpdate = true;
    this.points.geometry.attributes.color.needsUpdate = true;
  }
}

/** Soft round sprite: white center fading to transparent (smoke, glows). */
export function radialTexture(): THREE.CanvasTexture {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d')!;
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.5, 'rgba(255,255,255,0.4)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(canvas);
}
