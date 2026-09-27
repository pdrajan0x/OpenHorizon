// Bridge approaches cut through whatever a city or its coast has standing in the way: sea walls,
// expressway sound walls, fences, embankments, the odd building. A corridor is the deck's centreline
// (road-surface points) with a half width. Any triangle overlapping it that rises more than CLEAR_BELOW
// above that road and starts below CLEAR_ABOVE is dropped, from the render cells and the collision
// alike, so nothing solid or invisible stands between a city's streets and its bridges. A building cut
// into goes whole, not just its lower storeys.
import type * as THREE from 'three';

const CLEAR_BELOW = 0.35; // m above the road: the road itself and kerbs stay
const CLEAR_ABOVE = 9; // m above the road: flyovers and gantries over it stay
const JOINT = 3; // m each segment reaches past its ends, closing the gaps at bends
const BUILDING_MAX = 150; // m across at most for a piece cut into to go whole (wider: ground, a block's mesh)
// (only in what's drawn, and never a piece with 40 m² or more of level surface at the road's height: ground)

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

  /** A run of road-surface points (world space) to keep clear, `half` m either side (or per point). */
  add(points: THREE.Vector3[], halfWidth: number | number[]): void {
    for (let i = 0; i + 1 < points.length; i++) {
      const a = points[i];
      const b = points[i + 1];
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      if (len < 0.01) continue;
      const half = typeof halfWidth === 'number' ? halfWidth : Math.max(halfWidth[i], halfWidth[i + 1]);
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
    pos: ArrayLike<number>, stride: number, index: T, off: { x: number; y: number; z: number }, below = CLEAR_BELOW, whole = false,
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
    const tris = index.length / 3;
    const dropped = new Uint8Array(tris);
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
        dropped[i / 3] = 1;
        cut++;
      }
    }
    if (!cut) return index;
    if (whole) wholeBuildings(pos, stride, index, off, dropped, segs);
    const keep: number[] = [];
    for (let t = 0; t < tris; t++) if (!dropped[t]) keep.push(index[t * 3], index[t * 3 + 1], index[t * 3 + 2]);
    return (index instanceof Uint32Array ? new Uint32Array(keep) : keep) as T;
  }
}

/**
 * A building the corridor cut into goes whole: its lower storeys cut away, the rest would hang in the air.
 * Triangles are grouped into pieces by shared corners (welded by position: a wall's faces often don't
 * share vertices), and a piece that lost triangles, still stands higher than CLEAR_ABOVE and is no wider
 * than BUILDING_MAX m (the ground, or a whole block's mesh, is left be) is dropped altogether.
 */
function wholeBuildings(pos: ArrayLike<number>, stride: number, index: ArrayLike<number>, off: { x: number; y: number; z: number }, dropped: Uint8Array, segs: Seg[]): void {
  const tris = dropped.length;
  const parent = new Int32Array(tris).map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };
  const corner = new Map<string, number>();
  for (let t = 0; t < tris; t++) {
    for (let k = 0; k < 3; k++) {
      const v = index[t * 3 + k] * stride;
      const key = `${Math.round(pos[v] * 20)},${Math.round(pos[v + 1] * 20)},${Math.round(pos[v + 2] * 20)}`;
      const other = corner.get(key);
      if (other === undefined) corner.set(key, t);
      else parent[find(t)] = find(other);
    }
  }
  const pieces = new Map<number, { cut: boolean; x0: number; x1: number; z0: number; z1: number; y0: number; y1: number }>();
  for (let t = 0; t < tris; t++) {
    const r = find(t);
    let p = pieces.get(r);
    if (!p) pieces.set(r, (p = { cut: false, x0: Infinity, x1: -Infinity, z0: Infinity, z1: -Infinity, y0: Infinity, y1: -Infinity }));
    if (dropped[t]) p.cut = true;
    for (let k = 0; k < 3; k++) {
      const v = index[t * 3 + k] * stride;
      p.x0 = Math.min(p.x0, pos[v]); p.x1 = Math.max(p.x1, pos[v]);
      p.z0 = Math.min(p.z0, pos[v + 2]); p.z1 = Math.max(p.z1, pos[v + 2]);
      p.y0 = Math.min(p.y0, pos[v + 1] + off.y); p.y1 = Math.max(p.y1, pos[v + 1] + off.y);
    }
  }
  const gone = new Set<number>();
  for (const [r, p] of pieces) {
    if (p.cut && p.y1 - p.y0 > CLEAR_ABOVE && p.x1 - p.x0 <= BUILDING_MAX && p.z1 - p.z0 <= BUILDING_MAX) gone.add(r);
  }
  if (!gone.size) return;
  // Never ground: a piece with level surface at the road's height (a street, a plaza, a footpath) stays, only cut
  const ground = new Map<number, number>();
  const a = [0, 0, 0];
  for (let t = 0; t < tris; t++) {
    const r = find(t);
    if (!gone.has(r)) continue;
    const v = [0, 1, 2].map((k) => index[t * 3 + k] * stride);
    const ux = pos[v[1]] - pos[v[0]], uy = pos[v[1] + 1] - pos[v[0] + 1], uz = pos[v[1] + 2] - pos[v[0] + 2];
    const wx = pos[v[2]] - pos[v[0]], wy = pos[v[2] + 1] - pos[v[0] + 1], wz = pos[v[2] + 2] - pos[v[0] + 2];
    a[0] = uy * wz - uz * wy; a[1] = uz * wx - ux * wz; a[2] = ux * wy - uy * wx;
    const area2 = Math.hypot(a[0], a[1], a[2]);
    if (area2 < 1e-6 || Math.abs(a[1]) / area2 < 0.85) continue; // not level
    const cx = (pos[v[0]] + pos[v[1]] + pos[v[2]]) / 3 + off.x;
    const cy = (pos[v[0] + 1] + pos[v[1] + 1] + pos[v[2] + 1]) / 3 + off.y;
    const cz = (pos[v[0] + 2] + pos[v[1] + 2] + pos[v[2] + 2]) / 3 + off.z;
    for (const s of segs) {
      const u = (cx - s.ax) * s.ux + (cz - s.az) * s.uz;
      if (u < -60 || u > s.len + 60) continue;
      const floor = s.ay + (s.by - s.ay) * Math.min(1, Math.max(0, u / s.len));
      if (Math.abs(cy - floor) < 1.5) { ground.set(r, (ground.get(r) ?? 0) + area2 / 2); break; }
    }
  }
  for (const [r, area] of ground) if (area > 40) gone.delete(r);
  if (gone.size) for (let t = 0; t < tris; t++) if (gone.has(find(t))) dropped[t] = 1;
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
