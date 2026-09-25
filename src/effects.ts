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
