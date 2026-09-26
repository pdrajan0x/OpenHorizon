// Every island's shore: a skirt from just inside the land's edge out and down under the sea, so no city
// ends in a sheer drop into the void. Profile by the ground height at the edge (HANDOFF plan B):
//   under 4 m  beach: sand sloping to −3 m over ~40 m
//   4–15 m     sea wall: concrete face with a parapet, riprap rocks at its foot
//   over 15 m  rocky cliff: a noisy rock slope
// Lakes and rivers inside a city (interior loops) get the wall. Surfaces are Poly Haven CC0 scans
// (public/mods/coast/, fetched by scripts/fetch-environment.mjs) and the rocks are Poly Haven models,
// simplified by scripts/kit-lods.mjs. Collision is a trimesh per chunk.
import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { STATIC_GROUPS } from './map';
import type { CoastLoop } from './outline';

const BEACH_MAX = 4; // m of ground height at the edge
const WALL_MAX = 15;
const CHUNK = 48; // loop vertices per mesh chunk (≈ 500 m of shore)
const DRAW_DISTANCE = 4000; // m; beyond this the fog has the shore anyway
const ROCK_DISTANCE = 900; // m; rock instances are only drawn this close
const MIN_HOLE_AREA = 20000; // m²; smaller interior loops are gaps in the data, not lakes
const INSET = 2.5; // m inside the edge where the skirt starts, just under the map's own ground
const TILE = 6; // m per texture repeat

type Kind = 'beach' | 'wall' | 'cliff';
type Surface = 'sand' | 'damp' | 'concrete' | 'riprap' | 'rock';
const SURFACES: Record<Surface, string> = {
  sand: 'coast_sand_01',
  damp: 'damp_beach_sand',
  concrete: 'concrete_wall_008',
  riprap: 'gray_rocks',
  rock: 'rock_face_03',
};
const ROCKS = ['boulder_01', 'coast_rocks_05', 'namaqualand_boulder_02', 'sand_rocks_small_01', 'coast_land_rocks_04'];

/** One cross-section: points out from the edge (d, y) and the surface of each strip between them. */
interface Profile {
  pts: [number, number][];
  surf: Surface[];
}

function profile(kind: Kind, h: number, noise: (k: number) => number): Profile {
  if (kind === 'beach') {
    const top = Math.max(h, 0.4);
    return {
      pts: [[-INSET, top - 0.3], [0, top - 0.08], [Math.max(6, top * 5), Math.min(top, 0.6)], [40, -3], [80, -9]],
      surf: ['sand', 'sand', 'damp', 'damp'],
    };
  }
  if (kind === 'wall') {
    return {
      pts: [[-INSET, h - 0.3], [0, h - 0.05], [0, h + 0.85], [0.6, h + 0.85], [0.9, -1], [10, -4.5], [25, -10]],
      surf: ['concrete', 'concrete', 'concrete', 'concrete', 'riprap', 'riprap'],
    };
  }
  const w = 12 + h * 0.55;
  const pts: [number, number][] = [[-INSET, h - 0.3], [0, h - 0.1]];
  for (const t of [0.12, 0.3, 0.5, 0.72, 0.9]) {
    pts.push([w * t + noise(t * 7) * 3, h * (1 - t) ** 1.25 + noise(t * 13 + 3) * 2.5 - t * 2]);
  }
  pts.push([w, -4], [w + 15, -12]);
  return { pts, surf: ['rock', 'rock', 'rock', 'rock', 'rock', 'rock', 'rock', 'riprap'] };
}

const hash = (x: number) => {
  const s = Math.sin(x * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
};

export class Coast {
  readonly root = new THREE.Group();
  private readonly chunks: { mesh: THREE.Object3D; center: THREE.Vector3; radius: number }[] = [];
  private readonly rocks: { mesh: THREE.InstancedMesh; center: THREE.Vector3; radius: number }[] = [];

  private constructor(
    world: RAPIER.World,
    islands: { loops: CoastLoop[]; offset: THREE.Vector3 }[],
    private readonly materials: Record<Surface, THREE.Material>,
    rockModels: { geometry: THREE.BufferGeometry; material: THREE.Material; size: number }[],
  ) {
    this.root.name = 'coast';
    let seed = 1;
    for (const { loops, offset } of islands) {
      for (const loop of loops) {
        const pts = loop.points;
        if (pts.length < 6) continue;
        if (!loop.outer && Math.abs(area(pts)) < MIN_HOLE_AREA) continue;
        seed++;
        this.buildLoop(world, loop, offset, seed, rockModels);
      }
    }
  }

  static async load(world: RAPIER.World, islands: { loops: CoastLoop[]; offset: THREE.Vector3 }[]): Promise<Coast> {
    const tex = new THREE.TextureLoader();
    const load = (name: string, kind: string, color: boolean) =>
      tex.loadAsync(`/mods/coast/${name}/${name}_${kind}_2k.jpg`).then((t) => {
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.anisotropy = 8;
        if (color) t.colorSpace = THREE.SRGBColorSpace;
        return t;
      }).catch(() => null);
    const entries = await Promise.all((Object.keys(SURFACES) as Surface[]).map(async (s) => {
      const n = SURFACES[s];
      const [map, normalMap, roughnessMap] = await Promise.all([load(n, 'Diffuse', true), load(n, 'nor_gl', false), load(n, 'Rough', false)]);
      const fallback = { sand: 0xc8b48a, damp: 0x8c7a5c, concrete: 0x9a9a96, riprap: 0x6c6a66, rock: 0x6e6558 }[s];
      const m = new THREE.MeshStandardMaterial({ map, normalMap, roughnessMap, color: map ? 0xffffff : fallback, roughness: 1, side: THREE.DoubleSide });
      return [s, m] as const;
    }));
    const materials = Object.fromEntries(entries) as unknown as Record<Surface, THREE.Material>;
    const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
    const rockModels = (await Promise.all(ROCKS.map((r) => loader.loadAsync(`/mods/coast/${r}.glb`).then((g) => {
      let found: THREE.Mesh | null = null;
      g.scene.traverse((o) => { if (!found && (o as THREE.Mesh).isMesh) found = o as THREE.Mesh; });
      if (!found) return null;
      const mesh = found as THREE.Mesh;
      mesh.updateWorldMatrix(true, false);
      const geometry = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
      geometry.computeBoundingBox();
      const size = geometry.boundingBox!.getSize(new THREE.Vector3());
      return { geometry, material: mesh.material as THREE.Material, size: Math.max(size.x, size.z) };
    }).catch(() => null)))).filter((r): r is NonNullable<typeof r> => r !== null);
    return new Coast(world, islands, materials, rockModels);
  }

  private buildLoop(
    world: RAPIER.World, loop: CoastLoop, offset: THREE.Vector3, seed: number,
    rockModels: { geometry: THREE.BufferGeometry; material: THREE.Material; size: number }[],
  ): void {
    const pts = loop.points;
    const n = pts.length;
    // Heights along the shore, smoothed so the profile doesn't flicker between kinds
    const hs = pts.map((_, i) => {
      let s = 0;
      for (let k = -3; k <= 3; k++) s += pts[(i + k + n) % n][2];
      return s / 7 + offset.y;
    });
    const kinds: Kind[] = hs.map((h) => (!loop.outer ? 'wall' : h < BEACH_MAX ? 'beach' : h < WALL_MAX ? 'wall' : 'cliff'));
    // Runs of one kind, split into chunks; each run shares its end vertex with the next
    const runs: { kind: Kind; from: number; to: number }[] = [];
    let start = 0;
    // Start a run at a kind change so the loop's seam isn't inside a run
    for (let i = 0; i < n; i++) if (kinds[i] !== kinds[(i + n - 1) % n]) { start = i; break; }
    let from = start;
    for (let s = 1; s <= n; s++) {
      const i = (start + s) % n;
      if (s === n || kinds[i] !== kinds[from] || s - (from - start + n) % n >= CHUNK) {
        runs.push({ kind: kinds[from], from, to: i });
        from = i;
      }
    }
    // Along-shore distance for texture u
    const along = new Float32Array(n + 1);
    for (let i = 1; i <= n; i++) along[i] = along[i - 1] + Math.hypot(pts[i % n][0] - pts[i - 1][0], pts[i % n][1] - pts[i - 1][1]);
    // Seaward normal at each vertex: right of travel, (-dz, dx)
    const normals = pts.map((_, i) => {
      const a = pts[(i + n - 1) % n];
      const b = pts[(i + 1) % n];
      const dx = b[0] - a[0];
      const dz = b[1] - a[1];
      const l = Math.hypot(dx, dz) || 1;
      return [-dz / l, dx / l];
    });
    for (const run of runs) {
      const idx: number[] = [];
      for (let i = run.from; ; i = (i + 1) % n) {
        idx.push(i);
        if (i === run.to) break;
      }
      if (idx.length < 2) continue;
      this.buildRun(world, run.kind, idx, pts, hs, normals, along, offset, seed);
      if (rockModels.length) this.scatterRocks(run.kind, idx, pts, hs, normals, offset, seed, rockModels);
    }
  }

  private buildRun(
    world: RAPIER.World, kind: Kind, idx: number[], pts: [number, number, number][], hs: number[],
    normals: number[][], along: Float32Array, offset: THREE.Vector3, seed: number,
  ): void {
    const profiles = idx.map((i) => profile(kind, hs[i], (k) => hash(i * 0.37 + k + seed) - 0.5));
    const m = profiles[0].pts.length;
    const bySurface = new Map<Surface, { pos: number[]; uv: number[]; index: number[] }>();
    const colPos: number[] = [];
    const colIdx: number[] = [];
    const vert = (k: number, j: number): [number, number, number] => {
      const i = idx[k];
      const [d, y] = profiles[k].pts[j];
      return [pts[i][0] + normals[i][0] * d + offset.x, y, pts[i][1] + normals[i][1] * d + offset.z];
    };
    // Profile arc length for texture v
    const arc = profiles.map((p) => {
      const out = [0];
      for (let j = 1; j < m; j++) out.push(out[j - 1] + Math.hypot(p.pts[j][0] - p.pts[j - 1][0], p.pts[j][1] - p.pts[j - 1][1]));
      return out;
    });
    for (let j = 0; j < m - 1; j++) {
      const surf = profiles[0].surf[j];
      let b = bySurface.get(surf);
      if (!b) bySurface.set(surf, (b = { pos: [], uv: [], index: [] }));
      const base = b.pos.length / 3;
      for (let k = 0; k < idx.length; k++) {
        const u = along[idx[k]] / TILE;
        for (const jj of [j, j + 1]) {
          b.pos.push(...vert(k, jj));
          b.uv.push(u, arc[k][jj] / TILE);
        }
      }
      for (let k = 0; k < idx.length - 1; k++) {
        const a = base + k * 2;
        // Quad (k, j)-(k+1, j)-(k+1, j+1)-(k, j+1), wound to face up and out to sea
        b.index.push(a, a + 1, a + 2, a + 2, a + 1, a + 3);
      }
    }
    const group = new THREE.Group();
    const box = new THREE.Box3();
    for (const [surf, b] of bySurface) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2));
      geo.setIndex(b.index);
      fixWinding(geo);
      geo.computeVertexNormals();
      geo.computeBoundingSphere();
      geo.computeBoundingBox();
      box.union(geo.boundingBox!);
      const mesh = new THREE.Mesh(geo, this.materials[surf]);
      mesh.receiveShadow = true;
      group.add(mesh);
      const base = colPos.length / 3;
      colPos.push(...b.pos);
      for (const i of geo.index!.array) colIdx.push(i + base);
    }
    this.root.add(group);
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    this.chunks.push({ mesh: group, center: sphere.center, radius: sphere.radius });
    const desc = RAPIER.ColliderDesc.trimesh(new Float32Array(colPos), new Uint32Array(colIdx))
      .setFriction(0.9).setCollisionGroups(STATIC_GROUPS);
    world.createCollider(desc);
  }

  private scatterRocks(
    kind: Kind, idx: number[], pts: [number, number, number][], hs: number[], normals: number[][],
    offset: THREE.Vector3, seed: number, models: { geometry: THREE.BufferGeometry; material: THREE.Material; size: number }[],
  ): void {
    // Riprap at the foot of walls, boulders along cliffs, the odd rock on a beach
    const every = kind === 'wall' ? 1 : kind === 'cliff' ? 2 : 6;
    const per = new Map<number, THREE.Matrix4[]>();
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const center = new THREE.Vector3();
    let count = 0;
    for (let k = 0; k < idx.length; k += every) {
      const i = idx[k];
      const r = (s: number) => hash(i * 1.618 + s + seed * 3.1);
      if (kind === 'beach' && r(1) > 0.35) continue;
      const pick = kind === 'wall' ? (r(2) < 0.6 ? 0 : 2) : kind === 'cliff' ? (r(2) < 0.5 ? 1 : 4) : 3;
      const model = Math.min(pick, models.length - 1);
      const size = kind === 'wall' ? 2.2 + r(3) * 1.6 : kind === 'cliff' ? 5 + r(3) * 6 : 2 + r(3) * 2;
      const scale = size / models[model].size;
      const d = kind === 'wall' ? 2 + r(4) * 5 : kind === 'cliff' ? 10 + hs[i] * 0.45 + r(4) * 6 : 25 + r(4) * 15;
      const y = kind === 'wall' ? -1.5 - (d - 2) * 0.35 : kind === 'cliff' ? -2.5 : -2;
      const x = pts[i][0] + normals[i][0] * d + offset.x;
      const z = pts[i][1] + normals[i][1] * d + offset.z;
      q.setFromEuler(e.set((r(5) - 0.5) * 0.4, r(6) * Math.PI * 2, (r(7) - 0.5) * 0.4));
      m4.compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(scale, scale * (0.8 + r(8) * 0.5), scale));
      let list = per.get(model);
      if (!list) per.set(model, (list = []));
      list.push(m4.clone());
      center.x += x;
      center.z += z;
      count++;
    }
    if (!count) return;
    center.divideScalar(count);
    for (const [model, list] of per) {
      const mesh = new THREE.InstancedMesh(models[model].geometry, models[model].material, list.length);
      list.forEach((mm, k) => mesh.setMatrixAt(k, mm));
      mesh.computeBoundingSphere();
      mesh.receiveShadow = true;
      this.root.add(mesh);
      const s = mesh.boundingSphere!;
      this.rocks.push({ mesh, center: s.center.clone(), radius: s.radius });
    }
  }

  /** Hide shore chunks far from the camera. */
  update(camera: THREE.Vector3): void {
    for (const c of this.chunks) c.mesh.visible = c.center.distanceTo(camera) - c.radius < DRAW_DISTANCE;
    for (const c of this.rocks) c.mesh.visible = c.center.distanceTo(camera) - c.radius < ROCK_DISTANCE;
  }
}

/** Flip triangles whose normal points down, so every strip faces up/out whatever the loop's winding. */
function fixWinding(geo: THREE.BufferGeometry): void {
  const p = geo.attributes.position.array as Float32Array;
  const ix = geo.index!.array as Uint32Array | Uint16Array;
  for (let t = 0; t < ix.length; t += 3) {
    const a = ix[t] * 3, b = ix[t + 1] * 3, c = ix[t + 2] * 3;
    const ux = p[b] - p[a], uz = p[b + 2] - p[a + 2];
    const wx = p[c] - p[a], wz = p[c + 2] - p[a + 2];
    const ny = uz * wx - ux * wz;
    if (ny < 0) { const s = ix[t + 1]; ix[t + 1] = ix[t + 2]; ix[t + 2] = s; }
  }
}

export function area(pts: [number, number, number][] | [number, number][]): number {
  let a = 0;
  for (let k = 0; k < pts.length; k++) {
    const p = pts[k];
    const q = pts[(k + 1) % pts.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}
