// Bridge approaches cut through whatever a city or its coast has standing in the way: sea walls,
// expressway sound walls, fences, embankments, the odd building. A corridor is the deck's centreline
// (road-surface points) with a half width. Any triangle overlapping it that rises more than CLEAR_BELOW
// above that road and starts below CLEAR_ABOVE is dropped, from the render cells and the collision
// alike, so nothing solid or invisible stands between a city's streets and its bridges.
import type * as THREE from 'three';

const CLEAR_BELOW = 0.35; // m above the road: the road itself and kerbs stay
const CLEAR_ABOVE = 9; // m above the road: flyovers and gantries over it stay
const JOINT = 3; // m each segment reaches past its ends, closing the gaps at bends

interface Seg {
  ax: number; ay: number; az: number;
  by: number;
  ux: number; uz: number; // unit direction a→b
  len: number;
  half: number;
  cx: number; cz: number; // centre
  minX: number; minZ: number; maxX: number; maxZ: number;
}

export class Corridors {
  private readonly segs: Seg[] = [];

  get empty(): boolean {
    return this.segs.length === 0;
  }

  /** A run of road-surface points (world space) to keep clear, `half` m either side. */
  add(points: THREE.Vector3[], half: number): void {
    for (let i = 0; i + 1 < points.length; i++) {
      const a = points[i];
      const b = points[i + 1];
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      if (len < 0.01) continue;
      const r = half + JOINT;
      this.segs.push({
        ax: a.x, ay: a.y, az: a.z, by: b.y,
        ux: (b.x - a.x) / len, uz: (b.z - a.z) / len, len, half,
        cx: (a.x + b.x) / 2, cz: (a.z + b.z) / 2,
        minX: Math.min(a.x, b.x) - r, minZ: Math.min(a.z, b.z) - r, maxX: Math.max(a.x, b.x) + r, maxZ: Math.max(a.z, b.z) + r,
      });
    }
  }

  private near(minX: number, minZ: number, maxX: number, maxZ: number): Seg[] {
    return this.segs.filter((s) => s.maxX >= minX && s.minX <= maxX && s.maxZ >= minZ && s.minZ <= maxZ);
  }

  /** Whether a point (world space) stands in a corridor, above its road: for placing props. */
  blocks(x: number, y: number, z: number, radius = 0): boolean {
    for (const s of this.near(x - radius, z - radius, x + radius, z + radius)) {
      const t = (x - s.ax) * s.ux + (z - s.az) * s.uz;
      if (t < -JOINT - radius || t > s.len + JOINT + radius) continue;
      if (Math.abs((x - s.ax) * -s.uz + (z - s.az) * s.ux) > s.half + radius) continue;
      const floor = s.ay + ((s.by - s.ay) * Math.min(1, Math.max(0, t / s.len)));
      if (y + radius > floor + CLEAR_BELOW && y - radius < floor + CLEAR_ABOVE) return true;
    }
    return false;
  }

  /**
   * An index buffer less every triangle that stands in a corridor. Positions are `stride` floats apart
   * and `off` moves them into world space; `below` is how far above the road a triangle may reach and
   * stay. Returns the same index when nothing is cut.
   */
  cut<T extends Uint32Array | number[]>(
    pos: ArrayLike<number>, stride: number, index: T, off: { x: number; y: number; z: number }, below = CLEAR_BELOW,
  ): T {
    if (!this.segs.length || !index.length) return index;
    // Bounds of the geometry first: most cells are nowhere near a bridge
    let [minX, minZ, maxX, maxZ] = [Infinity, Infinity, -Infinity, -Infinity];
    for (let v = 0; v < pos.length; v += stride) {
      const x = pos[v];
      const z = pos[v + 2];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    const segs = this.near(minX + off.x, minZ + off.z, maxX + off.x, maxZ + off.z);
    if (!segs.length) return index;
    const keep: number[] = [];
    let cut = 0;
    const px = [0, 0, 0];
    const pz = [0, 0, 0];
    for (let i = 0; i + 2 < index.length; i += 3) {
      let yMin = Infinity;
      let yMax = -Infinity;
      for (let k = 0; k < 3; k++) {
        const v = index[i + k] * stride;
        px[k] = pos[v] + off.x;
        const y = pos[v + 1] + off.y;
        pz[k] = pos[v + 2] + off.z;
        if (y < yMin) yMin = y;
        if (y > yMax) yMax = y;
      }
      if (hits(segs, px, pz, yMin, yMax, below)) {
        cut++;
        continue;
      }
      keep.push(index[i], index[i + 1], index[i + 2]);
    }
    if (!cut) return index;
    return (index instanceof Uint32Array ? new Uint32Array(keep) : keep) as T;
  }
}

/** Whether a triangle (xz corners, y range) overlaps any segment's strip above its road. */
function hits(segs: Seg[], px: number[], pz: number[], yMin: number, yMax: number, below: number): boolean {
  const tMinX = Math.min(px[0], px[1], px[2]);
  const tMaxX = Math.max(px[0], px[1], px[2]);
  const tMinZ = Math.min(pz[0], pz[1], pz[2]);
  const tMaxZ = Math.max(pz[0], pz[1], pz[2]);
  for (const s of segs) {
    if (s.maxX < tMinX || s.minX > tMaxX || s.maxZ < tMinZ || s.minZ > tMaxZ) continue;
    // Height: the road under the triangle's centre
    const cx = (px[0] + px[1] + px[2]) / 3;
    const cz = (pz[0] + pz[1] + pz[2]) / 3;
    const t = Math.min(1, Math.max(0, ((cx - s.ax) * s.ux + (cz - s.az) * s.uz) / s.len));
    const floor = s.ay + (s.by - s.ay) * t;
    if (yMax <= floor + below || yMin >= floor + CLEAR_ABOVE) continue;
    if (overlaps(s, px, pz)) return true;
  }
  return false;
}

/** Separating-axis test in plan: the segment's rectangle against a triangle. */
function overlaps(s: Seg, px: number[], pz: number[]): boolean {
  const hu = s.len / 2 + JOINT;
  const hv = s.half;
  const vx = -s.uz;
  const vz = s.ux;
  const axes: [number, number][] = [[s.ux, s.uz], [vx, vz]];
  for (let k = 0; k < 3; k++) {
    const ex = px[(k + 1) % 3] - px[k];
    const ez = pz[(k + 1) % 3] - pz[k];
    axes.push([-ez, ex]);
  }
  for (const [nx, nz] of axes) {
    const c = s.cx * nx + s.cz * nz;
    const r = hu * Math.abs(s.ux * nx + s.uz * nz) + hv * Math.abs(vx * nx + vz * nz);
    let lo = Infinity;
    let hi = -Infinity;
    for (let k = 0; k < 3; k++) {
      const d = px[k] * nx + pz[k] * nz;
      if (d < lo) lo = d;
      if (d > hi) hi = d;
    }
    if (hi < c - r || lo > c + r) return false;
  }
  return true;
}
