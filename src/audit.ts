// Geometry and visibility audit (?debug&audit): finds the places where the player or the camera could see
// through, or pass through, something that should be solid, and says why. It works on what's streamed in
// around a point (the cities' render cells, the coast, the bridges) and on the Rapier collision, from the
// road network: every road node within RADIUS, at car height and chase-camera height, casts rays along
// the ground in every direction, angled down at the street, and straight down at the road. Each ray is
// traced twice, through the render geometry (both faces of every triangle, with a BVH) and through the
// collision, and the two are compared:
//
//   D backface / material  the first surface a ray meets faces away from it and its material draws one
//                          side only: from there you see through it (into a hollow inside, or the void)
//   C collision            a collision surface with nothing visible there (an invisible wall), or a visible
//                          solid surface with no collision behind it (the car, and the chase camera, which
//                          only avoids collision, go through it)
//   B geometry hole        at a road: collision but no visible ground (a hole you see through), or visible
//                          ground with no collision (you fall through)
//   E missing piece        at a road: neither visible ground nor collision (nothing there at all)
//   A rendering            the surface exists but isn't drawn there: hidden by distance culling
//
// Structures with nothing under them (a building missing its lower storeys) and surfaces drawn without a
// texture (blank white walls) are reported too.
// Each render mesh's own geometry is checked too: triangles wound against their stored normals (drawn
// from the wrong side, so a wall vanishes from the front), exact duplicate triangles (z-fighting) and
// degenerate ones. fix() repairs only the first two, and only where it's unambiguous. Findings are
// clustered (CLUSTER m) so one broken wall is one issue. show() draws markers and the failed rays; the
// panel lists every issue and a click goes there.
import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';

export type IssueKind = 'A' | 'B' | 'C' | 'D' | 'E';
export const KIND_NAMES: Record<IssueKind, string> = {
  A: 'visual rendering problem',
  B: 'geometry hole / gap',
  C: 'collision problem',
  D: 'backface / normal / material problem',
  E: 'missing piece of environment',
};

export interface Issue {
  id: number;
  kind: IssueKind;
  type: string;
  severity: 'high' | 'medium' | 'low';
  mesh: string; // object / mesh name
  group: string; // parent group (city and cell)
  position: [number, number, number];
  size: number; // m across the cluster
  hits: number; // rays or triangles that found it
  why: string;
  ray?: [number, number, number, number, number, number]; // one failed ray: from, to
  /** Floating structures: [map, cell, mesh name, x0, y0, z0, x1, y1, z1] per piece, in the map's frame. */
  pieces?: [string, number, string, number, number, number, number, number, number][];
  fixed?: boolean;
}

const RADIUS = 220; // m around the audit point: road nodes sampled
const NODE_SPACING = 12; // m: at most one sample point per this much road
const HEIGHTS = [1.0, 2.8]; // m above the road: car body, chase camera
const AZIMUTHS = 16;
const REACH = 70; // m a ray is followed
const PITCH_DOWN = 0.35; // rad: the angled-down rays
const TOLERANCE = 1.2; // m: render and collision surfaces this close are the same surface
const CLUSTER = 6; // m: ray findings closer than this are one issue
const MESH_CLUSTER = 25; // m: the same for triangles found by the mesh checks
/** ?auditTextures: also report surfaces drawn without a texture (off by default: geometry first). */
const TEXTURES = typeof location !== 'undefined' && new URLSearchParams(location.search).has('auditTextures');
const MARK_COLOURS: Record<IssueKind, number> = { A: 0x4da3ff, B: 0xff8c1a, C: 0xff2a2a, D: 0xd43cff, E: 0xffe600 };

interface RenderHit {
  distance: number;
  point: THREE.Vector3;
  normal: THREE.Vector3; // world, from the triangle's winding
  object: THREE.Mesh;
  material: THREE.Material;
  frontFacing: boolean; // the ray meets the triangle's front
  drawn: boolean; // the mesh is visible (not culled) where the ray meets it
}

/**
 * Exact duplicate triangles (the same three corners to 2 cm, in any order): a numeric hash of the corners
 * picks candidates, which are then compared corner by corner. Returns a test for each triangle in turn.
 */
function duplicateFinder(pos: THREE.BufferAttribute | THREE.InterleavedBufferAttribute): (i0: number, i1: number, i2: number) => boolean {
  const buckets = new Map<number, number[]>(); // hash → corner triples, 9 quantized ints each, flattened
  const q = (i: number, k: number) => Math.round((k === 0 ? pos.getX(i) : k === 1 ? pos.getY(i) : pos.getZ(i)) * 50);
  return (i0, i1, i2) => {
    const corners = [i0, i1, i2].map((i) => [q(i, 0), q(i, 1), q(i, 2)]).sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
    const flat = corners.flat();
    let h = 2166136261;
    for (const v of flat) h = Math.imul(h ^ v, 16777619);
    const list = buckets.get(h);
    if (list) {
      for (let k = 0; k < list.length; k += 9) {
        let same = true;
        for (let j = 0; j < 9 && same; j++) same = list[k + j] === flat[j];
        if (same) return true;
      }
      list.push(...flat);
    } else buckets.set(h, flat);
    return false;
  };
}

const tmpRay = new THREE.Ray();
const tmpInv = new THREE.Matrix4();
const tmpSphere = new THREE.Sphere();
const tmpNormalMatrix = new THREE.Matrix3();

function materialOf(mesh: THREE.Mesh, faceMaterialIndex: number | undefined): THREE.Material {
  const m = mesh.material;
  if (!Array.isArray(m)) return m;
  const groups = mesh.geometry.groups;
  const g = groups.find((q) => faceMaterialIndex !== undefined && q.materialIndex === faceMaterialIndex);
  return m[g?.materialIndex ?? 0] ?? m[0];
}

/** Things a ray may pass: glass, cut-out leaves and fences, decals, anything see-through. */
function seeThrough(m: THREE.Material): boolean {
  const s = (m.userData?.shader as string | undefined) ?? '';
  return m.transparent || (m as THREE.MeshStandardMaterial).alphaTest > 0 || /glass|decal|water|foliage|leaf|tree|grass/i.test(s + (m.name ?? ''));
}

function describe(o: THREE.Object3D): { mesh: string; group: string } {
  const names: string[] = [];
  for (let p = o.parent; p; p = p.parent) if (p.name) names.push(p.name);
  const mat = (o as THREE.Mesh).material as THREE.Material;
  const shader = (mat?.userData?.shader as string | undefined) ?? mat?.name ?? '';
  const tex = ((mat as THREE.MeshStandardMaterial)?.map?.name as string | undefined) ?? '';
  return { mesh: o.name || [shader, tex].filter(Boolean).join(' / ') || o.type, group: names.reverse().join(' › ') || '(scene)' };
}

export class Audit {
  readonly issues: Issue[] = [];
  private readonly debug = new THREE.Group();
  private panel: HTMLDivElement | null = null;
  private nextId = 1;
  private readonly checkedMeshes = new WeakSet<THREE.BufferGeometry>();
  private readonly floatChecked = new WeakSet<THREE.BufferGeometry>();
  private readonly clusters = new Map<string, Issue>();
  /** Rays cast and sample points taken, for the report. */
  stats = { points: 0, rays: 0, meshesChecked: 0, trianglesChecked: 0, places: 0 };

  constructor(
    scene: THREE.Scene,
    private readonly root: THREE.Object3D, // the islands: every city, the coast and the bridges
    private readonly world: RAPIER.World,
    private readonly roadNodes: () => THREE.Vector3[],
    private readonly goTo: (p: THREE.Vector3) => void,
  ) {
    this.debug.name = 'audit-debug';
    this.debug.visible = false;
    scene.add(this.debug);
    window.addEventListener('keydown', (e) => {
      if (e.code === 'F9') this.show(!this.debug.visible);
    });
  }

  // ---------------------------------------------------------------- tracing

  private targets(): THREE.Mesh[] {
    const list: THREE.Mesh[] = [];
    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      // Instanced kit pieces (bridge barriers, lamps, coast rocks) are traced per copy
      if (!m.isMesh || !m.geometry.index || !m.geometry.attributes.position) return;
      list.push(m);
    });
    return list;
  }

  private ensureBvh(meshes: THREE.Mesh[]): void {
    for (const m of meshes) {
      const g = m.geometry as THREE.BufferGeometry & { boundsTree?: MeshBVH };
      if (!g.boundsTree) g.boundsTree = new MeshBVH(g);
      if (!g.boundingSphere) g.computeBoundingSphere();
      const im = m as THREE.InstancedMesh;
      if (im.isInstancedMesh && !im.boundingSphere) im.computeBoundingSphere();
    }
  }

  /** The first triangle (either face) a ray meets within `far`, over every loaded render mesh. */
  private castRender(meshes: THREE.Mesh[], from: THREE.Vector3, dir: THREE.Vector3, far: number): RenderHit | null {
    let best: RenderHit | null = null;
    const world = new THREE.Ray(from, dir);
    const inst = new THREE.Matrix4();
    const one = (m: THREE.Mesh, matrix: THREE.Matrix4, mirroredCopy: boolean) => {
      const g = m.geometry as THREE.BufferGeometry & { boundsTree?: MeshBVH };
      tmpSphere.copy(g.boundingSphere!).applyMatrix4(matrix);
      if (world.distanceSqToPoint(tmpSphere.center) > tmpSphere.radius * tmpSphere.radius) return;
      if (from.distanceTo(tmpSphere.center) - tmpSphere.radius > (best?.distance ?? far)) return;
      tmpInv.copy(matrix).invert();
      tmpRay.copy(world).applyMatrix4(tmpInv);
      const hit = g.boundsTree!.raycastFirst(tmpRay, THREE.DoubleSide);
      if (!hit || !hit.face) return;
      const point = hit.point.clone().applyMatrix4(matrix);
      const distance = point.distanceTo(from);
      if (distance > far || (best && distance >= best.distance)) return;
      // The triangle's own facing, from its winding (not the stored normals)
      const pos = g.attributes.position;
      const a = new THREE.Vector3().fromBufferAttribute(pos, hit.face.a);
      const b = new THREE.Vector3().fromBufferAttribute(pos, hit.face.b);
      const c = new THREE.Vector3().fromBufferAttribute(pos, hit.face.c);
      const normal = new THREE.Vector3().subVectors(c, b).cross(new THREE.Vector3().subVectors(a, b)).normalize();
      tmpNormalMatrix.getNormalMatrix(matrix);
      normal.applyMatrix3(tmpNormalMatrix).normalize();
      // The renderer allows for a mirrored object but not for a mirrored copy within an instanced batch:
      // that copy is drawn inside out
      if (mirroredCopy) normal.negate();
      const material = materialOf(m, hit.face.materialIndex);
      let drawn = m.visible;
      for (let p = m.parent; p && drawn; p = p.parent) drawn = p.visible;
      best = { distance, point, normal, object: m, material, frontFacing: normal.dot(dir) < 0, drawn: drawn && material.visible };
    };
    for (const m of meshes) {
      const im = m as THREE.InstancedMesh;
      if (!im.isInstancedMesh) { one(m, m.matrixWorld, false); continue; }
      // All the copies' sphere first, then each copy
      tmpSphere.copy(im.boundingSphere!).applyMatrix4(m.matrixWorld);
      if (world.distanceSqToPoint(tmpSphere.center) > tmpSphere.radius * tmpSphere.radius) continue;
      for (let k = 0; k < im.count; k++) {
        im.getMatrixAt(k, inst);
        const mirrored = inst.determinant() < 0;
        one(m, inst.premultiply(m.matrixWorld), mirrored);
      }
    }
    return best;
  }

  /** The first static collider a ray meets within `far` (cars and other moving bodies aren't in the way). */
  private castCollision(from: THREE.Vector3, dir: THREE.Vector3, far: number): { distance: number; point: THREE.Vector3 } | null {
    const ray = new RAPIER.Ray({ x: from.x, y: from.y, z: from.z }, { x: dir.x, y: dir.y, z: dir.z });
    const hit = this.world.castRay(ray, far, true, RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC | RAPIER.QueryFilterFlags.EXCLUDE_SENSORS);
    if (!hit) return null;
    return { distance: hit.timeOfImpact, point: from.clone().addScaledVector(dir, hit.timeOfImpact) };
  }

  // ---------------------------------------------------------------- findings

  private report(kind: IssueKind, type: string, at: THREE.Vector3, o: THREE.Object3D | null, why: string, severity: Issue['severity'], ray?: [THREE.Vector3, THREE.Vector3], cluster = CLUSTER): Issue {
    // Ray findings merge by place; the mesh checks' by place within one mesh
    const key = `${kind}|${type}|${cluster === CLUSTER ? '' : o?.uuid}|${Math.round(at.x / cluster)},${Math.round(at.y / cluster)},${Math.round(at.z / cluster)}`;
    const found = this.clusters.get(key);
    if (found) {
      found.hits++;
      const d = Math.hypot(found.position[0] - at.x, found.position[1] - at.y, found.position[2] - at.z);
      found.size = Math.max(found.size, Math.min(cluster * 2, 2 * d));
      if (severity === 'high') found.severity = 'high';
      return found;
    }
    const names = o ? describe(o) : { mesh: '(nothing)', group: '(none)' };
    const issue: Issue = {
      id: this.nextId++, kind, type, severity, ...names, position: [+at.x.toFixed(2), +at.y.toFixed(2), +at.z.toFixed(2)],
      size: 0.5, hits: 1, why,
      ray: ray ? [ray[0].x, ray[0].y, ray[0].z, ray[1].x, ray[1].y, ray[1].z].map((v) => +v.toFixed(2)) as Issue['ray'] : undefined,
    };
    this.clusters.set(key, issue);
    this.issues.push(issue);
    return issue;
  }

  /** One ray, traced through both worlds and compared. */
  private probe(meshes: THREE.Mesh[], from: THREE.Vector3, dir: THREE.Vector3, far: number, roadY: number, down: boolean): void {
    this.stats.rays++;
    const r = this.castRender(meshes, from, dir, far);
    const c = this.castCollision(from, dir, far);
    const end = (d: number) => from.clone().addScaledVector(dir, d);
    if (down) {
      if (!r && !c) {
        this.report('E', 'nothing under the road', end(Math.min(far, from.y - roadY + 2)), null,
          'A road node with neither visible ground nor collision under it: the car falls into the void and the camera sees it.', 'high', [from, end(far)]);
        return;
      }
      if (c && (!r || r.distance > c.distance + TOLERANCE)) {
        this.report('B', 'invisible ground (hole in the road surface)', c.point, r?.object ?? null,
          'Collision holds the car up but no visible surface is there: you drive over a hole and see through it.', 'high', [from, c.point]);
        return;
      }
      if (r && !seeThrough(r.material) && (!c || c.distance > r.distance + TOLERANCE)) {
        this.report('C', 'visible ground with no collision', r.point, r.object,
          'The road surface is drawn but has no collision under it: the car falls through.', 'high', [from, r.point]);
        return;
      }
      if (r && !r.frontFacing && (r.material as THREE.MeshStandardMaterial).side === THREE.FrontSide) {
        this.report('D', 'ground drawn from below only', r.point, r.object,
          'The ground triangle faces down (wrong winding), so it is invisible from above: the road looks like a hole.', 'high', [from, r.point]);
      }
      return;
    }
    // Along the ground or angled at it
    if (r && !r.frontFacing && (r.material as THREE.MeshStandardMaterial).side === THREE.FrontSide && !seeThrough(r.material)) {
      const high = r.distance < 35;
      this.report('D', 'back face in view (see-through wall)', r.point, r.object,
        'The first surface this view meets faces away from it and its material draws one side only, so it is not drawn: you look through it, into a hollow inside or the void. Either the wall is wound the wrong way (normals flipped) or the viewpoint is inside a shell with no back.',
        high ? 'high' : 'medium', [from, r.point]);
      return;
    }
    if (r && r.frontFacing && !r.drawn && r.distance < 40) {
      this.report('A', 'surface hidden by distance culling', r.point, r.object,
        'The surface exists and faces the viewer but its batch is hidden at this distance (detail culling), so the view passes through where it should be.', 'medium', [from, r.point]);
    }
    const mat = r?.material as THREE.MeshStandardMaterial | undefined;
    if (TEXTURES && r && r.frontFacing && r.drawn && r.distance < 60 && mat && !mat.map && !seeThrough(mat) && !(mat.emissiveMap || (mat.emissive && mat.emissive.getHex()))) {
      this.report('A', 'surface with no texture (plain white or grey)', r.point, r.object,
        "The surface is drawn without its texture (the mod's texture wasn't found or couldn't be converted): a blank white or grey wall or ground.",
        r.distance < 25 ? 'medium' : 'low', [from, r.point], MESH_CLUSTER);
    }
    const nearRoad = from.y - roadY < 2;
    if (c && (!r || r.distance > c.distance + TOLERANCE) && c.distance < 30) {
      this.report('C', 'invisible wall (collision with nothing drawn)', c.point, r?.object ?? null,
        'A collision surface stands here with no visible surface: the car hits an invisible hurdle and the chase camera stops against nothing.',
        nearRoad && c.distance < 15 ? 'high' : 'medium', [from, c.point]);
      return;
    }
    if (r && r.frontFacing && r.drawn && !seeThrough(r.material) && (!c || c.distance > r.distance + TOLERANCE) && r.distance < 30 && r.point.y - roadY < 3.5) {
      this.report('C', 'solid-looking surface with no collision', r.point, r.object,
        'A visible surface at car height has no collision behind it: the car drives into it, and the chase camera (which only avoids collision) slides inside it and shows its hollow inside.',
        r.distance < 12 ? 'high' : 'medium', [from, r.point]);
    }
  }

  // ---------------------------------------------------------------- mesh geometry

  /** Per render mesh: triangles wound against their normals, duplicates, degenerates. */
  private checkMeshes(meshes: THREE.Mesh[]): void {
    const a = new THREE.Vector3(); const b = new THREE.Vector3(); const c = new THREE.Vector3();
    const fn = new THREE.Vector3(); const vn = new THREE.Vector3(); const na = new THREE.Vector3();
    for (const m of meshes) {
      const g = m.geometry;
      if ((m as THREE.InstancedMesh).isInstancedMesh || this.checkedMeshes.has(g)) continue;
      this.checkedMeshes.add(g);
      const pos = g.attributes.position;
      const nrm = g.attributes.normal;
      const idx = g.index!;
      this.stats.meshesChecked++;
      const flippedAt: THREE.Vector3[] = [];
      const isDuplicate = duplicateFinder(pos);
      let dups = 0;
      let degenerate = 0;
      const dupAt: THREE.Vector3[] = [];
      for (let t = 0; t + 2 < idx.count; t += 3) {
        const i0 = idx.getX(t); const i1 = idx.getX(t + 1); const i2 = idx.getX(t + 2);
        a.fromBufferAttribute(pos, i0); b.fromBufferAttribute(pos, i1); c.fromBufferAttribute(pos, i2);
        fn.subVectors(c, b).cross(na.subVectors(a, b));
        const area2 = fn.length();
        this.stats.trianglesChecked++;
        if (area2 < 1e-6) { degenerate++; continue; }
        fn.divideScalar(area2);
        if (nrm) {
          vn.fromBufferAttribute(nrm, i0).add(na.fromBufferAttribute(nrm, i1)).add(na.fromBufferAttribute(nrm, i2));
          if (vn.lengthSq() > 1e-6 && fn.dot(vn.normalize()) < -0.9 && area2 > 0.02) flippedAt.push(a.clone().add(b).add(c).divideScalar(3));
        }
        if (isDuplicate(i0, i1, i2)) { dups++; if (dupAt.length < 50) dupAt.push(a.clone().add(b).add(c).divideScalar(3)); }
      }
      const side = (m.material as THREE.MeshStandardMaterial).side;
      // Leaves, cut-outs and glass bend their normals on purpose: only opaque surfaces count
      const surface = m.userData.surface as { mask?: boolean; blend?: boolean } | undefined;
      if (surface?.mask || surface?.blend || seeThrough(m.material as THREE.Material)) flippedAt.length = 0;
      const total = Math.floor(idx.count / 3);
      for (const p of flippedAt) {
        p.applyMatrix4(m.matrixWorld);
        this.report('D', 'triangles wound against their normals', p, m,
          `${flippedAt.length} of this batch's ${total} triangles have a winding that faces the opposite way to their stored normals: with ${side === THREE.FrontSide ? 'one-sided' : 'two-sided'} drawing they ${side === THREE.FrontSide ? 'disappear when seen from the front (see-through holes in the wall) and are lit wrong' : 'are lit from the wrong side'}.`,
          side === THREE.FrontSide ? 'high' : 'low', undefined, MESH_CLUSTER);
      }
      if (dups) {
        // One finding per batch: its copies are usually whole duplicated pieces, not scattered triangles
        const issue = this.report('A', 'duplicate triangles (z-fighting)', dupAt[0].applyMatrix4(m.matrixWorld), m,
          `${dups} of this batch's ${total} triangles are exact copies of others: the two copies fight for the same pixels and flicker.`, 'low', undefined, 1e9);
        issue.hits = dups;
      }
      if (degenerate > 50) {
        const s = g.boundingSphere ?? (g.computeBoundingSphere(), g.boundingSphere!);
        this.report('A', 'degenerate triangles', s.center.clone().applyMatrix4(m.matrixWorld), m,
          `${degenerate} zero-area triangles: harmless to look at, but they can confuse collision built from this mesh.`, 'low');
      }
    }
  }

  /**
   * Floating structures: each render mesh within RADIUS is split into pieces (triangles joined by shared
   * corners, welded by position), and a piece that stands FLOAT_TALL m or more, is building-sized, and has
   * nothing under its lowest corners (no visible surface and no collision within FLOAT_GAP m) is reported:
   * a building whose lower storeys are gone, a wall hanging in the air. Foliage and glass don't count.
   */
  private checkFloating(meshes: THREE.Mesh[], at: THREE.Vector3): void {
    const FLOAT_TALL = 8;
    const FLOAT_GAP = 6;
    // Trees (a trunk's lowest point is often in a hollow of the ground), foliage and GTA's untextured
    // stand-in shells aren't structures
    const NOT_STRUCTURE = /tree|trunk|branch|leaf|leaves|oak|pine|cedar|palm|bush|veg|foliage|grass|ivy/i;
    const v = new THREE.Vector3();
    const down = new THREE.Vector3(0, -1, 0);
    for (const m of meshes) {
      if ((m as THREE.InstancedMesh).isInstancedMesh || this.floatChecked.has(m.geometry)) continue;
      const surface = m.userData.surface as { mask?: boolean; blend?: boolean; shader?: string } | undefined;
      if (surface?.mask || surface?.blend || seeThrough(m.material as THREE.Material)) continue;
      if (surface?.shader === 'cpv_only' || NOT_STRUCTURE.test(m.name)) continue;
      const g = m.geometry;
      if (!g.boundingSphere) g.computeBoundingSphere();
      const centre = g.boundingSphere!.center.clone().applyMatrix4(m.matrixWorld);
      if (Math.hypot(centre.x - at.x, centre.z - at.z) > RADIUS + g.boundingSphere!.radius) continue;
      this.floatChecked.add(g);
      const pos = g.attributes.position;
      const idx = g.index!;
      const tris = Math.floor(idx.count / 3);
      const parent = new Int32Array(tris).map((_, i) => i);
      const find = (i: number): number => { while (parent[i] !== i) i = parent[i] = parent[parent[i]]; return i; };
      const corner = new Map<number, number>();
      for (let t = 0; t < tris; t++) {
        for (let k = 0; k < 3; k++) {
          const i = idx.getX(t * 3 + k);
          const key = Math.round(pos.getX(i) * 10) * 73856093 ^ Math.round(pos.getY(i) * 10) * 19349663 ^ Math.round(pos.getZ(i) * 10) * 83492791;
          const other = corner.get(key);
          if (other === undefined) corner.set(key, t); else parent[find(t)] = find(other);
        }
      }
      const pieces = new Map<number, { x0: number; x1: number; y0: number; y1: number; z0: number; z1: number; low: number }>();
      for (let t = 0; t < tris; t++) {
        const r = find(t);
        let p = pieces.get(r);
        if (!p) pieces.set(r, (p = { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity, z0: Infinity, z1: -Infinity, low: -1 }));
        for (let k = 0; k < 3; k++) {
          const i = idx.getX(t * 3 + k);
          const y = pos.getY(i);
          if (y < p.y0) { p.y0 = y; p.low = i; }
          p.y1 = Math.max(p.y1, y);
          p.x0 = Math.min(p.x0, pos.getX(i)); p.x1 = Math.max(p.x1, pos.getX(i));
          p.z0 = Math.min(p.z0, pos.getZ(i)); p.z1 = Math.max(p.z1, pos.getZ(i));
        }
      }
      for (const p of pieces.values()) {
        const w = Math.max(p.x1 - p.x0, p.z1 - p.z0);
        if (p.y1 - p.y0 < FLOAT_TALL || w < 8 || w > 150) continue;
        // Under its base: its lowest corner, the middle of its footprint and the footprint's corners, a little
        // inside, all at the base's height; floating when at least 4 of the 5 have nothing under them
        const ix = (p.x1 - p.x0) * 0.15;
        const iz = (p.z1 - p.z0) * 0.15;
        const probes = [
          v.fromBufferAttribute(pos, p.low).applyMatrix4(m.matrixWorld).clone(),
          ...[[0.5, 0.5], [0, 0], [1, 0], [0, 1], [1, 1]].map(([a, b]) =>
            new THREE.Vector3(p.x0 + ix + (p.x1 - p.x0 - 2 * ix) * a, p.y0, p.z0 + iz + (p.z1 - p.z0 - 2 * iz) * b).applyMatrix4(m.matrixWorld)),
        ];
        const clear = probes.slice(1).filter((q) => {
          const from = q.clone().add(new THREE.Vector3(0, -0.3, 0));
          return !this.castCollision(from, down, FLOAT_GAP) && !this.castRender(meshes, from, down, FLOAT_GAP);
        }).length;
        const floating = clear >= 4;
        if (floating) {
          const issue = this.report('B', 'floating structure (nothing under it)', probes[0], m,
            `A piece ${(p.y1 - p.y0).toFixed(0)} m tall and ${w.toFixed(0)} m across has nothing under its base for ${FLOAT_GAP} m or more, neither drawn nor solid: a building missing its lower storeys, or a wall hanging in the air.`,
            'high', [probes[0], probes[0].clone().addScaledVector(down, FLOAT_GAP)], MESH_CLUSTER);
          // What to leave out to fix it (scripts/floating.mjs): the piece's cell, mesh and bounds in its map's frame
          const cell = /^cell (\d+)$/.exec(m.parent?.name ?? '')?.[1];
          const map = /^map:(.+)$/.exec(m.parent?.parent?.name ?? '')?.[1];
          if (cell && map) {
            issue.pieces ??= [];
            const r = (v: number) => +v.toFixed(2);
            issue.pieces.push([map, +cell, m.name, r(p.x0), r(p.y0), r(p.z0), r(p.x1), r(p.y1), r(p.z1)]);
          }
        }
      }
    }
  }

  /**
   * Safe repairs only: triangles clearly wound against their normals get their winding turned round, and
   * exact duplicate triangles are dropped. Everything else is only reported.
   */
  fix(): { flipped: number; duplicates: number } {
    let flipped = 0;
    let duplicates = 0;
    const a = new THREE.Vector3(); const b = new THREE.Vector3(); const c = new THREE.Vector3();
    const fn = new THREE.Vector3(); const vn = new THREE.Vector3(); const na = new THREE.Vector3();
    for (const m of this.targets()) {
      if ((m as THREE.InstancedMesh).isInstancedMesh) continue; // shared kit models: left alone
      const g = m.geometry;
      const pos = g.attributes.position;
      const nrm = g.attributes.normal;
      const idx = g.index!;
      const keep: number[] = [];
      const isDuplicate = duplicateFinder(pos);
      let changed = false;
      const surface = m.userData.surface as { mask?: boolean; blend?: boolean } | undefined;
      const mayFlip = !surface?.mask && !surface?.blend && !seeThrough(m.material as THREE.Material);
      for (let t = 0; t + 2 < idx.count; t += 3) {
        let i0 = idx.getX(t); const i1 = idx.getX(t + 1); let i2 = idx.getX(t + 2);
        a.fromBufferAttribute(pos, i0); b.fromBufferAttribute(pos, i1); c.fromBufferAttribute(pos, i2);
        if (isDuplicate(i0, i1, i2)) { duplicates++; changed = true; continue; }
        fn.subVectors(c, b).cross(na.subVectors(a, b));
        const area2 = fn.length();
        if (mayFlip && nrm && area2 > 0.02) {
          vn.fromBufferAttribute(nrm, i0).add(na.fromBufferAttribute(nrm, i1)).add(na.fromBufferAttribute(nrm, i2));
          if (vn.lengthSq() > 1e-6 && fn.divideScalar(area2).dot(vn.normalize()) < -0.9) { [i0, i2] = [i2, i0]; flipped++; changed = true; }
        }
        keep.push(i0, i1, i2);
      }
      if (!changed) continue;
      g.setIndex(keep);
      (g as THREE.BufferGeometry & { boundsTree?: MeshBVH }).boundsTree = undefined;
    }
    for (const i of this.issues) if (i.type === 'triangles wound against their normals' || i.type === 'duplicate triangles (z-fighting)') i.fixed = true;
    this.renderPanel();
    return { flipped, duplicates };
  }

  // ---------------------------------------------------------------- running

  /** Audit what's loaded around a point: sample the roads within RADIUS and trace. */
  run(at: THREE.Vector3): number {
    const before = this.issues.length;
    this.stats.places++;
    const meshes = this.targets();
    this.ensureBvh(meshes);
    this.checkMeshes(meshes);
    this.checkFloating(meshes, at);
    // Sample points: road nodes near the point, thinned to one per NODE_SPACING m
    const taken: THREE.Vector3[] = [];
    for (const n of this.roadNodes()) {
      if (Math.hypot(n.x - at.x, n.z - at.z) > RADIUS) continue;
      if (taken.some((t) => t.distanceToSquared(n) < NODE_SPACING * NODE_SPACING)) continue;
      taken.push(n);
    }
    const dir = new THREE.Vector3();
    for (const n of taken) {
      this.stats.points++;
      // Straight down from above the road
      this.probe(meshes, new THREE.Vector3(n.x, n.y + 4, n.z), new THREE.Vector3(0, -1, 0), 30, n.y, true);
      for (const h of HEIGHTS) {
        const from = new THREE.Vector3(n.x, n.y + h, n.z);
        for (let k = 0; k < AZIMUTHS; k++) {
          const az = (k / AZIMUTHS) * Math.PI * 2;
          dir.set(Math.cos(az), 0, Math.sin(az));
          this.probe(meshes, from, dir.clone(), REACH, n.y, false);
          dir.set(Math.cos(az) * Math.cos(PITCH_DOWN), -Math.sin(PITCH_DOWN), Math.sin(az) * Math.cos(PITCH_DOWN));
          this.probe(meshes, from, dir.clone(), REACH, n.y, false);
        }
      }
    }
    this.draw();
    return this.issues.length - before;
  }

  // ---------------------------------------------------------------- showing

  private draw(): void {
    this.debug.clear();
    // One instanced batch of markers per kind: tens of thousands of issues stay a handful of draw calls
    const marker = new THREE.SphereGeometry(0.6, 10, 8);
    const lines: number[] = [];
    const colours: number[] = [];
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    for (const kind of ['A', 'B', 'C', 'D', 'E'] as IssueKind[]) {
      const list = this.issues.filter((i) => i.kind === kind && !i.fixed);
      if (!list.length) continue;
      const mat = new THREE.MeshBasicMaterial({ color: MARK_COLOURS[kind], depthTest: false, transparent: true, opacity: 0.9 });
      const s = new THREE.InstancedMesh(marker, mat, list.length);
      list.forEach((i, n) => s.setMatrixAt(n, m4.compose(new THREE.Vector3(...i.position), q, scale.setScalar(Math.max(1, Math.min(4, i.size / 2))))));
      s.frustumCulled = false;
      s.renderOrder = 999;
      this.debug.add(s);
      const col = new THREE.Color(MARK_COLOURS[kind]);
      for (const i of list) {
        if (!i.ray) continue;
        lines.push(...i.ray);
        colours.push(col.r, col.g, col.b, col.r, col.g, col.b);
      }
    }
    if (lines.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(lines, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(colours, 3));
      const l = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, transparent: true, opacity: 0.8 }));
      l.renderOrder = 998;
      this.debug.add(l);
    }
    this.debug.updateMatrixWorld(true);
    this.renderPanel();
  }

  /** Markers, rays and the issue list on or off (F9). */
  show(on: boolean): void {
    this.debug.visible = on;
    if (on) this.renderPanel();
    if (this.panel) this.panel.style.display = on ? 'block' : 'none';
  }

  private renderPanel(): void {
    if (!this.debug.visible) return;
    if (!this.panel) {
      this.panel = document.createElement('div');
      this.panel.id = 'audit-panel';
      Object.assign(this.panel.style, {
        position: 'fixed', top: '12px', right: '12px', width: '420px', maxHeight: '70vh', overflowY: 'auto', zIndex: '50',
        background: 'rgba(8,16,24,0.88)', color: '#e8eef4', font: '12px/1.35 system-ui, sans-serif', padding: '10px 12px',
        borderRadius: '8px', border: '1px solid rgba(120,200,255,0.3)',
      } satisfies Partial<CSSStyleDeclaration>);
      document.body.appendChild(this.panel);
    }
    const order = { high: 0, medium: 1, low: 2 };
    const list = [...this.issues].sort((p, q) => order[p.severity] - order[q.severity] || q.hits - p.hits);
    const counts = (['A', 'B', 'C', 'D', 'E'] as IssueKind[]).map((k) => `<span style="color:#${MARK_COLOURS[k].toString(16).padStart(6, '0')}">${k} ${this.issues.filter((i) => i.kind === k && !i.fixed).length}</span>`).join(' · ');
    this.panel.innerHTML = `<b>Geometry audit</b> — F9 hides · ${this.stats.points} points, ${this.stats.rays} rays<br>${counts}<hr style="border-color:#345">` +
      list.slice(0, 300).map((i) => `<div data-id="${i.id}" style="cursor:pointer;padding:3px 0;border-bottom:1px solid #223;${i.fixed ? 'opacity:.45;text-decoration:line-through' : ''}">` +
        `<b style="color:#${MARK_COLOURS[i.kind].toString(16).padStart(6, '0')}">${i.kind}</b> <b>${i.severity}</b> ${i.type} <span style="opacity:.7">×${i.hits}</span><br>` +
        `<span style="opacity:.75">${i.group} · ${i.mesh} · (${i.position.map((v) => v.toFixed(0)).join(', ')})</span></div>`).join('');
    this.panel.querySelectorAll<HTMLDivElement>('[data-id]').forEach((el) => {
      el.onclick = () => {
        const i = this.issues.find((q) => q.id === Number(el.dataset.id));
        if (i) this.goTo(new THREE.Vector3(...i.position));
      };
    });
  }
}
