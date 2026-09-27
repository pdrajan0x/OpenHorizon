// Painted road markings for a map that has none of its own: CARLA's towns carry theirs as decals, which
// don't convert, but their OpenDRIVE road networks say where every line goes (ueconv markings: markings.json,
// per line yellow or white, its width, solid or broken, one line or two, its path in the map's frame, and
// the dash pattern for its kind of road: long dashes on wide roads, short on narrow streets; and patches:
// stop bars at stop signs and lights, give-way triangles, zebra crossings). Each is flat paint LIFT m above
// the road, grouped by colour into TILE m tiles so what's beyond DRAW m can be left out.
import * as THREE from 'three';

const LIFT = 0.04; // m above the road surface
const DASH = 3; // m painted, then GAP m clear
const GAP = 6;
const DOUBLE_GAP = 0.12; // m between the two lines of a double line
const TILE = 200; // m
const DRAW = 600; // m: tiles further than this from the camera aren't drawn

/** yellow, width, "solid" | "broken" | two of them, [x, y, z, …], dash and gap (m, by the kind of road) */
type Line = [0 | 1, number, string, number[], number?, number?];
/** yellow, corners [x, y, z, …]: a stop bar, a give-way triangle, a zebra stripe */
type Patch = [0 | 1, number[]];

export class Markings {
  readonly root = new THREE.Group();
  private readonly tiles: { mesh: THREE.Mesh; centre: THREE.Vector3; radius: number }[] = [];

  /** Markings for the map at `base` (its folder URL), or null when it has none. */
  static async load(base: string, lit: (m: THREE.MeshStandardMaterial) => void): Promise<Markings | null> {
    const data = await fetch(`${base}/markings.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null) as { lines: Line[]; patches?: Patch[] } | null;
    if (!data?.lines?.length) return null;
    return new Markings(data.lines, data.patches ?? [], lit);
  }

  private constructor(lines: Line[], patches: Patch[], lit: (m: THREE.MeshStandardMaterial) => void) {
    this.root.name = 'markings';
    const paint = [0xf1f0ea, 0xe3ad2a].map((color) => {
      const m = new THREE.MeshStandardMaterial({ color, roughness: 0.55, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
      lit(m);
      return m;
    });
    // Per tile and colour: the strips' corners and triangles
    const buckets = new Map<string, { pos: number[]; idx: number[] }>();
    const bucket = (x: number, z: number, yellow: number) => {
      const key = `${Math.floor(x / TILE)},${Math.floor(z / TILE)},${yellow}`;
      let b = buckets.get(key);
      if (!b) buckets.set(key, (b = { pos: [], idx: [] }));
      return b;
    };
    for (const [yellow, width, type, flat, dash = DASH, gap = GAP] of lines) {
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i + 2 < flat.length; i += 3) pts.push(new THREE.Vector3(flat[i], flat[i + 1] + LIFT, flat[i + 2]));
      if (pts.length < 2) continue;
      const kinds = type.split(' '); // one line ("solid", "broken") or two side by side ("solid broken")
      const across = kinds.length === 2 ? [-(width + DOUBLE_GAP) / 2, (width + DOUBLE_GAP) / 2] : [0];
      kinds.forEach((kind, k) => this.strip(pts, across[k], width, kind === 'broken' ? [dash, gap] : null, (x, z) => bucket(x, z, yellow)));
    }
    for (const [yellow, flat] of patches) {
      const n = flat.length / 3;
      if (n < 3) continue;
      let cx = 0;
      let cz = 0;
      for (let i = 0; i < n; i++) { cx += flat[i * 3] / n; cz += flat[i * 3 + 2] / n; }
      const out = bucket(cx, cz, yellow);
      const base = out.pos.length / 3;
      for (let i = 0; i < n; i++) out.pos.push(flat[i * 3], flat[i * 3 + 1] + LIFT, flat[i * 3 + 2]);
      // A fan, turned to face up whichever way round its corners run
      const ax = flat[3] - flat[0], az = flat[5] - flat[2], bx = flat[6] - flat[0], bz = flat[8] - flat[2];
      const up = ax * bz - az * bx < 0; // cross y > 0 ⇔ counter-clockwise seen from above
      for (let i = 1; i + 1 < n; i++) out.idx.push(base, base + (up ? i : i + 1), base + (up ? i + 1 : i));
    }
    for (const [key, b] of buckets) {
      if (!b.idx.length) continue;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
      const up = new Float32Array(b.pos.length);
      for (let i = 1; i < up.length; i += 3) up[i] = 1;
      g.setAttribute('normal', new THREE.BufferAttribute(up, 3));
      g.setIndex(b.idx);
      g.computeBoundingSphere();
      const mesh = new THREE.Mesh(g, paint[Number(key.split(',')[2])]);
      mesh.receiveShadow = true;
      mesh.renderOrder = 1;
      this.root.add(mesh);
      this.tiles.push({ mesh, centre: g.boundingSphere!.center.clone(), radius: g.boundingSphere!.radius });
    }
  }

  /** One line along `pts`, `offset` m to the right of it, as a flat strip (dashed: DASH on, GAP off). */
  private strip(pts: THREE.Vector3[], offset: number, width: number, dashes: [number, number] | null, to: (x: number, z: number) => { pos: number[]; idx: number[] }): void {
    // Walk the line in steps short enough to follow its curves, emitting quads where paint is
    const dashed = !!dashes;
    const DASH_M = dashes?.[0] ?? DASH;
    const period = DASH_M + (dashes?.[1] ?? GAP);
    let s = 0;
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      if (len < 1e-3) continue;
      const rx = -(b.z - a.z) / len;
      const rz = (b.x - a.x) / len;
      const steps = Math.max(1, Math.ceil(len / 2));
      for (let k = 0; k < steps; k++) {
        let t0 = k / steps;
        let t1 = (k + 1) / steps;
        if (dashed) {
          // Clip this step to the painted part of its dash period
          const u0 = s + t0 * len;
          const start = Math.floor(u0 / period) * period;
          const paintEnd = start + DASH_M;
          if (u0 >= paintEnd) continue;
          t1 = Math.min(t1, (paintEnd - s) / len);
          t0 = Math.max(t0, (start - s) / len);
          if (t1 <= t0) continue;
        }
        const p0 = a.clone().lerp(b, t0);
        const p1 = a.clone().lerp(b, t1);
        const out = to((p0.x + p1.x) / 2, (p0.z + p1.z) / 2);
        const base = out.pos.length / 3;
        const h = width / 2;
        for (const p of [p0, p1]) {
          out.pos.push(p.x + rx * (offset - h), p.y, p.z + rz * (offset - h));
          out.pos.push(p.x + rx * (offset + h), p.y, p.z + rz * (offset + h));
        }
        // Facing up (counter-clockwise seen from above)
        out.idx.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
      }
      s += len;
    }
  }

  /** Only the tiles near the camera (world position; the root sits at the map's offset). */
  update(camera: THREE.Vector3, offset: THREE.Vector3): void {
    for (const t of this.tiles) {
      const d = Math.hypot(t.centre.x + offset.x - camera.x, t.centre.z + offset.z - camera.z) - t.radius;
      t.mesh.visible = d < DRAW;
    }
  }
}
