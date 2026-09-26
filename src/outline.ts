// Land outlines from a grid mask: the shore of each island as closed loops, land on the left of travel
// (left of heading (dx, dz) is (dz, -dx) in the game frame: x north, y up, z east). Pure functions, no
// three.js, so scripts/island-stats.mjs can run the same code in node.

export interface CoastLoop {
  outer: boolean;
  points: [number, number, number][]; // x, z, ground height at the edge
}

export interface Mask {
  nx: number; // cells along x
  nz: number; // cells along z
  x0: number; // map-local position of cell (0, 0)'s low corner
  z0: number;
  cell: number; // m
  land: Uint8Array; // nx * nz, index i * nz + j
  height: Float32Array; // ground height per land cell
}

/** Close gaps (dilate then erode), fill small holes, drop small specks. Areas in m². */
export function cleanMask(m: Mask, holeArea = 2500, speckArea = 5000): void {
  const { nx, nz } = m;
  const at = (a: Uint8Array, i: number, j: number) => (i >= 0 && j >= 0 && i < nx && j < nz ? a[i * nz + j] : 0);
  const morph = (src: Uint8Array, dilate: boolean) => {
    const out = new Uint8Array(src.length);
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < nz; j++) {
        let v = dilate ? 0 : 1;
        for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
          const s = at(src, i + di, j + dj);
          v = dilate ? v | s : v & s;
        }
        out[i * nz + j] = v;
      }
    }
    return out;
  };
  const closed = morph(morph(m.land, true), false);
  // Newly added cells borrow a neighbour's height
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < nz; j++) {
      const k = i * nz + j;
      if (closed[k] && !m.land[k]) m.height[k] = neighbourHeight(m, i, j);
    }
  }
  m.land.set(closed);
  const cellArea = m.cell * m.cell;
  // Components: small water pockets become land, small land specks become water
  for (const value of [0, 1]) {
    const seen = new Uint8Array(nx * nz);
    for (let s = 0; s < nx * nz; s++) {
      if (seen[s] || m.land[s] !== value) continue;
      const comp: number[] = [s];
      seen[s] = 1;
      let edge = false;
      for (let q = 0; q < comp.length; q++) {
        const k = comp[q];
        const i = Math.floor(k / nz);
        const j = k % nz;
        if (i === 0 || j === 0 || i === nx - 1 || j === nz - 1) edge = true;
        for (const [a, b] of [[i - 1, j], [i + 1, j], [i, j - 1], [i, j + 1]]) {
          if (a < 0 || b < 0 || a >= nx || b >= nz) continue;
          const n = a * nz + b;
          if (!seen[n] && m.land[n] === value) { seen[n] = 1; comp.push(n); }
        }
      }
      const area = comp.length * cellArea;
      if (value === 0 && !edge && area < holeArea) {
        for (const k of comp) { m.land[k] = 1; m.height[k] = neighbourHeight(m, Math.floor(k / nz), k % nz); }
      } else if (value === 1 && area < speckArea) {
        for (const k of comp) m.land[k] = 0;
      }
    }
  }
}

function neighbourHeight(m: Mask, i: number, j: number): number {
  for (let r = 1; r < 6; r++) {
    for (let di = -r; di <= r; di++) for (let dj = -r; dj <= r; dj++) {
      const a = i + di;
      const b = j + dj;
      if (a < 0 || b < 0 || a >= m.nx || b >= m.nz) continue;
      const k = a * m.nz + b;
      if (m.land[k] && Number.isFinite(m.height[k])) return m.height[k];
    }
  }
  return 1;
}

/** Trace the mask's boundary into loops (land on the left), simplified and smoothed. */
export function traceLoops(m: Mask, spacing = 12): CoastLoop[] {
  const { nx, nz } = m;
  const land = (i: number, j: number) => i >= 0 && j >= 0 && i < nx && j < nz && m.land[i * nz + j] === 1;
  const vid = (i: number, j: number) => i * (nz + 1) + j;
  // Directed boundary edges, keyed by start vertex
  const next = new Map<number, number[]>();
  const add = (a: number, b: number) => {
    const l = next.get(a);
    if (l) l.push(b);
    else next.set(a, [b]);
  };
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < nz; j++) {
      if (!land(i, j)) continue;
      if (!land(i - 1, j)) add(vid(i, j), vid(i, j + 1));
      if (!land(i + 1, j)) add(vid(i + 1, j + 1), vid(i + 1, j));
      if (!land(i, j - 1)) add(vid(i + 1, j), vid(i, j));
      if (!land(i, j + 1)) add(vid(i, j + 1), vid(i + 1, j + 1));
    }
  }
  const loops: CoastLoop[] = [];
  for (const start of [...next.keys()]) {
    while ((next.get(start)?.length ?? 0) > 0) {
      const ring: number[] = [start];
      let cur = next.get(start)!.pop()!;
      while (cur !== start) {
        ring.push(cur);
        const l = next.get(cur);
        if (!l || l.length === 0) break;
        cur = l.pop()!;
      }
      if (ring.length < 8) continue;
      let pts: [number, number][] = ring.map((v) => [m.x0 + Math.floor(v / (nz + 1)) * m.cell, m.z0 + (v % (nz + 1)) * m.cell]);
      pts = simplifyClosed(pts, m.cell * 0.75);
      if (pts.length < 4) continue;
      pts = chaikin(chaikin(pts));
      pts = resample(pts, spacing);
      // Shoelace in (x, z): with land on the left, an island's outer shore winds negative
      let area = 0;
      for (let k = 0; k < pts.length; k++) {
        const [ax, az] = pts[k];
        const [bx, bz] = pts[(k + 1) % pts.length];
        area += ax * bz - bx * az;
      }
      loops.push({ outer: area < 0, points: pts.map(([x, z]) => [x, z, groundAt(m, x, z)]) });
    }
  }
  return loops;
}

/** Ground height of the nearest land cell to a point near the shore. */
function groundAt(m: Mask, x: number, z: number): number {
  const ci = Math.floor((x - m.x0) / m.cell);
  const cj = Math.floor((z - m.z0) / m.cell);
  let best = Infinity;
  let h = 1;
  for (let di = -2; di <= 2; di++) for (let dj = -2; dj <= 2; dj++) {
    const i = ci + di;
    const j = cj + dj;
    if (i < 0 || j < 0 || i >= m.nx || j >= m.nz || !m.land[i * m.nz + j]) continue;
    const d = (m.x0 + (i + 0.5) * m.cell - x) ** 2 + (m.z0 + (j + 0.5) * m.cell - z) ** 2;
    if (d < best) { best = d; h = m.height[i * m.nz + j]; }
  }
  return Math.round(h * 10) / 10;
}

function simplifyClosed(pts: [number, number][], tol: number): [number, number][] {
  // Split at the point farthest from the first so both halves are open polylines
  let far = 0;
  let fd = -1;
  for (let k = 1; k < pts.length; k++) {
    const d = (pts[k][0] - pts[0][0]) ** 2 + (pts[k][1] - pts[0][1]) ** 2;
    if (d > fd) { fd = d; far = k; }
  }
  const a = dp(pts.slice(0, far + 1), tol);
  const b = dp([...pts.slice(far), pts[0]], tol);
  return [...a.slice(0, -1), ...b.slice(0, -1)];
}

function dp(pts: [number, number][], tol: number): [number, number][] {
  if (pts.length < 3) return pts;
  const [ax, az] = pts[0];
  const [bx, bz] = pts[pts.length - 1];
  const len = Math.hypot(bx - ax, bz - az) || 1;
  let worst = 0;
  let wi = 0;
  for (let k = 1; k < pts.length - 1; k++) {
    const d = Math.abs((pts[k][0] - ax) * (bz - az) - (pts[k][1] - az) * (bx - ax)) / len;
    if (d > worst) { worst = d; wi = k; }
  }
  if (worst <= tol) return [pts[0], pts[pts.length - 1]];
  return [...dp(pts.slice(0, wi + 1), tol).slice(0, -1), ...dp(pts.slice(wi), tol)];
}

function chaikin(pts: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  for (let k = 0; k < pts.length; k++) {
    const [ax, az] = pts[k];
    const [bx, bz] = pts[(k + 1) % pts.length];
    out.push([ax * 0.75 + bx * 0.25, az * 0.75 + bz * 0.25], [ax * 0.25 + bx * 0.75, az * 0.25 + bz * 0.75]);
  }
  return out;
}

function resample(pts: [number, number][], spacing: number): [number, number][] {
  const out: [number, number][] = [];
  for (let k = 0; k < pts.length; k++) {
    const [ax, az] = pts[k];
    const [bx, bz] = pts[(k + 1) % pts.length];
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / spacing));
    for (let s = 0; s < n; s++) out.push([ax + ((bx - ax) * s) / n, az + ((bz - az) * s) / n]);
  }
  return out;
}

/** Vertical shift that puts a map on the shared sea (HANDOFF plan B). */
export function verticalOffset(water: { minY: number } | null | undefined, groundP2: number, roadP1: number): number {
  if (water && Number.isFinite(water.minY)) return -water.minY;
  const base = Math.min(groundP2, roadP1);
  return base > 8 ? 3 - base : 0;
}
