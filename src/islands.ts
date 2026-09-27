// The world: every city from a GTA V map mod is an island in one sea at height 0, packed close together
// and joined by causeways (bridges.ts) so every city is reachable by road. To the rest of the game this
// looks like one map: one road graph (the islands' graphs plus the bridge decks), one spawn, one
// streaming loop. HANDOFF plan B.
//
// Per island:
//   vertical offset  a map with its own sea plane (stats.water) puts that plane at 0 (and its water
//                    surfaces are hidden under our ocean); otherwise a map whose ground sits high
//                    (2nd percentile > 8 m, e.g. Hong Kong at GTA Z 500) is lowered to sit at +3 m
//   land outline     coast.json (scripts/map-extras.mjs), else island.json (scripts/island-stats.mjs),
//                    else a coarse outline around the roads, worked out here
//   layout           src/layout.ts: three continents side by side, each with a temperate north and a
//                    warm south, neighbours a short bridge apart; a city the design doesn't name is
//                    packed by shape next to the rest, GAP m of sea from any other land
import type RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { BridgeNetwork, LANES, planLinks, type IslandPlan } from './bridges';
import { Coast, area } from './coast';
import { Corridors } from './corridors';
import { GameMap, RoadGraph, litMaterial, type Manifest, type RoadData } from './map';
import { Markings } from './markings';
import { worldLayout } from './layout';
import { cleanMask, traceLoops, verticalOffset, type CoastLoop } from './outline';

const GAP = 300; // m of open sea between neighbouring islands' land
const PACK_CELL = 100; // m per cell of the packing grid
const STREAM_MARGIN = 900; // m beyond an island's shore at which it starts streaming in

export interface IslandInfo {
  id: string;
  name: string;
  area?: string;
}

/** The default archipelago when there's no index of converted maps: the cities converted so far. */
const DEFAULT_ISLANDS: IslandInfo[] = [
  { id: 'chicago', name: 'Chicago', area: 'downtown' },
  { id: 'miami', name: 'Miami', area: 'coastal city' },
  { id: 'dubai-highway', name: 'Dubai Highway', area: 'desert highway' },
  { id: 'dubai-islands', name: 'Dubai Islands', area: 'coastal resort' },
  { id: 'fukuoka-expressway', name: 'Fukuoka', area: 'expressway' },
  { id: 'hong-kong', name: 'Hong Kong', area: 'hillside city' },
  { id: 'midnight-shuto', name: 'Shuto Expressway', area: 'expressway' },
  { id: 'monaco-gp', name: 'Monaco', area: 'coastal street circuit' },
  { id: 'nfsu2-bayview', name: 'Bayview', area: 'tuner city' },
  { id: 'shibuya', name: 'Shibuya', area: 'Japanese district' },
  { id: 'tokyo-shinjuku', name: 'Shinjuku', area: 'Japanese district' },
];

interface Outline {
  version: number;
  loops: CoastLoop[];
}
interface IslandStats extends Outline {
  dy: number;
  groundP2: number;
  roadP1: number;
  /** Highest collision per cell, local frame: metres as base64 Int16, −32768 for none (scripts/island-stats.mjs). */
  tops?: { cell: number; x0: number; z0: number; nx: number; nz: number; h: string };
}

/** World-space height of the tallest thing (ground, hill, roof) under a point, or −Infinity. */
function heightMap(tops: IslandStats['tops'], offset: THREE.Vector3): ((x: number, z: number) => number) | undefined {
  if (!tops) return undefined;
  const bytes = Uint8Array.from(atob(tops.h), (c) => c.charCodeAt(0));
  const h = new Int16Array(bytes.buffer);
  return (x, z) => {
    const i = Math.floor((x - offset.x - tops.x0) / tops.cell);
    const j = Math.floor((z - offset.z - tops.z0) / tops.cell);
    if (i < 0 || j < 0 || i >= tops.nx || j >= tops.nz) return -Infinity;
    const v = h[i * tops.nz + j];
    return v === -32768 ? -Infinity : v + offset.y;
  };
}
type ManifestWithStats = Manifest & { stats?: { water?: { minY: number; textures?: string[] } | null } };

interface MapData {
  manifest: ManifestWithStats;
  roads: RoadData;
  stats: IslandStats | null;
  coast: Outline | null;
}

async function json<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url);
    return r.ok ? ((await r.json()) as T) : null;
  } catch {
    return null;
  }
}

/** A coarse outline when a map has no coast.json or island.json: land within reach of its roads. */
function roadOutline(roads: RoadData): CoastLoop[] {
  const cell = 40;
  const reach = 80;
  let [minX, minZ, maxX, maxZ] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, , z] of roads.nodes) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
  }
  const x0 = Math.floor((minX - reach) / cell) * cell - cell;
  const z0 = Math.floor((minZ - reach) / cell) * cell - cell;
  const nx = Math.ceil((maxX + reach - x0) / cell) + 2;
  const nz = Math.ceil((maxZ + reach - z0) / cell) + 2;
  const land = new Uint8Array(nx * nz);
  const height = new Float32Array(nx * nz).fill(Infinity);
  const r = Math.ceil(reach / cell);
  const stamp = (x: number, y: number, z: number) => {
    const ci = Math.floor((x - x0) / cell);
    const cj = Math.floor((z - z0) / cell);
    for (let i = ci - r; i <= ci + r; i++) for (let j = cj - r; j <= cj + r; j++) {
      if (i < 0 || j < 0 || i >= nx || j >= nz) continue;
      if (Math.hypot(x0 + (i + 0.5) * cell - x, z0 + (j + 0.5) * cell - z) > reach) continue;
      const k = i * nz + j;
      land[k] = 1;
      height[k] = Math.min(height[k], y - 0.5);
    }
  };
  for (const [a, b] of roads.links) {
    const p = roads.nodes[a];
    const q = roads.nodes[b];
    const n = Math.max(1, Math.ceil(Math.hypot(q[0] - p[0], q[2] - p[2]) / cell));
    for (let s = 0; s <= n; s++) stamp(p[0] + ((q[0] - p[0]) * s) / n, p[1] + ((q[1] - p[1]) * s) / n, p[2] + ((q[2] - p[2]) * s) / n);
  }
  const mask = { nx, nz, x0, z0, cell, land, height };
  cleanMask(mask, 40000, 20000);
  return traceLoops(mask, 16);
}

function percentile(values: number[], q: number): number {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * q))] ?? 0;
}

/** Land cells (PACK_CELL m) inside a map's outer loops, less its lakes (even-odd over all loops). */
interface LandMask {
  i0: number;
  j0: number;
  cells: [number, number][];
  ci: number; // centroid cell
  cj: number;
}

function rasterize(loops: CoastLoop[]): LandMask {
  const big = loops.filter((l) => Math.abs(area(l.points)) > 20000);
  let [minX, minZ, maxX, maxZ] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const l of big) for (const [x, z] of l.points) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
  }
  const cells: [number, number][] = [];
  if (!big.length) return { i0: 0, j0: 0, cells, ci: 0, cj: 0 };
  const i0 = Math.floor(minX / PACK_CELL);
  const i1 = Math.ceil(maxX / PACK_CELL);
  const j0 = Math.floor(minZ / PACK_CELL);
  const j1 = Math.ceil(maxZ / PACK_CELL);
  // Scanline per row of constant x: z crossings of every edge
  for (let i = i0; i <= i1; i++) {
    const x = (i + 0.5) * PACK_CELL;
    const zs: number[] = [];
    for (const l of big) {
      const p = l.points;
      for (let k = 0; k < p.length; k++) {
        const a = p[k];
        const b = p[(k + 1) % p.length];
        if ((a[0] <= x) !== (b[0] <= x)) zs.push(a[1] + ((x - a[0]) / (b[0] - a[0])) * (b[1] - a[1]));
      }
    }
    zs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < zs.length; k += 2) {
      for (let j = Math.floor(zs[k] / PACK_CELL); j <= Math.floor(zs[k + 1] / PACK_CELL); j++) {
        if (j >= j0 && j <= j1) cells.push([i, j]);
      }
    }
  }
  const ci = Math.round(cells.reduce((s, c) => s + c[0], 0) / Math.max(1, cells.length));
  const cj = Math.round(cells.reduce((s, c) => s + c[1], 0) / Math.max(1, cells.length));
  return { i0, j0, cells, ci, cj };
}

function landArea(loops: CoastLoop[]): number {
  return loops.reduce((s, l) => s + (l.outer ? Math.abs(area(l.points)) : 0), 0);
}

/** The world's packing grid: which island owns each PACK_CELL cell. */
class Occupancy {
  private readonly owner = new Map<number, number>();
  private sumI = 0;
  private sumJ = 0;
  count = 0;
  private bounds = [Infinity, Infinity, -Infinity, -Infinity];
  private key = (i: number, j: number) => (i + 5000) * 10000 + (j + 5000);

  add(m: LandMask, di: number, dj: number, id: number): void {
    for (const [i, j] of m.cells) {
      this.owner.set(this.key(i + di, j + dj), id);
      this.bounds = [Math.min(this.bounds[0], i + di), Math.min(this.bounds[1], j + dj), Math.max(this.bounds[2], i + di), Math.max(this.bounds[3], j + dj)];
    }
    this.sumI += (m.ci + di) * m.cells.length;
    this.sumJ += (m.cj + dj) * m.cells.length;
    this.count += m.cells.length;
  }

  /** Island owning the land at a world point, or -1 for sea. */
  at(x: number, z: number): number {
    return this.owner.get(this.key(Math.floor(x / PACK_CELL), Math.floor(z / PACK_CELL))) ?? -1;
  }

  /** The offset (in cells) nearest the cluster's centre where a mask fits GAP from all land. */
  fit(m: LandMask): [number, number] {
    const gap = Math.ceil(GAP / PACK_CELL);
    // Only the mask's cells within `gap` of its own shore can collide first; test those, then the rest
    const own = new Set(m.cells.map(([i, j]) => this.key(i, j)));
    const rim = m.cells.filter(([i, j]) => [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([a, b]) => !own.has(this.key(i + a, j + b))));
    const probe: [number, number][] = [];
    for (const [i, j] of rim) {
      for (let a = -gap; a <= gap; a++) for (let b = -gap; b <= gap; b++) {
        if (a * a + b * b <= gap * gap) probe.push([i + a, j + b]);
      }
    }
    const uniq = [...new Map(probe.map((p) => [this.key(p[0], p[1]), p])).values()];
    const inner = m.cells; // a small island could still land inside another's lake
    const ci = this.sumI / Math.max(1, this.count);
    const cj = this.sumJ / Math.max(1, this.count);
    const [bi0, bj0, bi1, bj1] = this.bounds;
    const w = Math.max(...m.cells.map((c) => c[0])) - Math.min(...m.cells.map((c) => c[0]));
    const h = Math.max(...m.cells.map((c) => c[1])) - Math.min(...m.cells.map((c) => c[1]));
    const cands: [number, number, number][] = [];
    for (let i = bi0 - w - 2 * gap; i <= bi1 + w + 2 * gap; i += 2) {
      for (let j = bj0 - h - 2 * gap; j <= bj1 + h + 2 * gap; j += 2) {
        const di = i - m.ci;
        const dj = j - m.cj;
        cands.push([di, dj, (i - ci) ** 2 + (j - cj) ** 2]);
      }
    }
    cands.sort((a, b) => a[2] - b[2]);
    const clear = (cells: [number, number][], di: number, dj: number) => cells.every(([i, j]) => !this.owner.has(this.key(i + di, j + dj)));
    for (const [di, dj] of cands) {
      if (clear(uniq, di, dj) && clear(inner, di, dj)) return [di, dj];
    }
    return [bi1 + w + 2 * gap - m.ci, 0];
  }
}

export class Islands {
  readonly root = new THREE.Group();
  readonly roads: RoadGraph;
  readonly spawn: THREE.Vector3;
  readonly bridges?: BridgeNetwork;
  readonly coast?: Coast;
  private frame = 0;

  private constructor(
    readonly maps: GameMap[],
    readonly info: IslandInfo[],
    roads: RoadData,
    bridges: BridgeNetwork | undefined,
    coast: Coast | undefined,
    /** Per map: texture names of its own sea surface, hidden under the shared ocean. */
    private readonly water: (Set<string> | null)[],
    /** Per map: its land outline (its own frame) and where that frame sits, for the big map. */
    readonly outlines: { offset: THREE.Vector3; loops: CoastLoop[] }[],
  ) {
    for (const m of maps) this.root.add(m.root);
    this.root.name = 'islands';
    this.bridges = bridges;
    this.coast = coast;
    if (bridges) this.root.add(bridges.root);
    if (coast) this.root.add(coast.root);
    // The world doesn't move: world matrices once, here, so the renderer's per-frame update of the scene
    // doesn't recompute thousands of them. Cells that stream in later compute their own (map.ts).
    this.root.traverse((o) => { o.matrixAutoUpdate = false; o.updateMatrix(); });
    this.root.updateMatrixWorld(true);
    // …and the renderer's per-frame pass over the scene skips this whole subtree (thousands of meshes)
    this.root.updateMatrixWorld = () => {};
    this.roads = new RoadGraph(roads);
    this.spawn = maps[0].spawn.clone();
  }

  /**
   * Load the islands. `only` loads a single map on its own (tests, ?map=<id>); otherwise every city in
   * public/mods/maps/index.json (or the default list) is placed, first in the list is where you start.
   */
  static async load(world: RAPIER.World, scene: THREE.Scene, only?: string): Promise<Islands> {
    void scene;
    let list: IslandInfo[] = only ? [{ id: only, name: only }] : (await json<IslandInfo[]>('/mods/maps/index.json')) ?? DEFAULT_ISLANDS;
    list = list.filter((i) => !i.id.startsWith('bridge-') && !i.id.endsWith('-test'));
    const data = await Promise.all(list.map(async (i): Promise<MapData | null> => {
      const base = `/mods/maps/${i.id}`;
      const d = await GameMap.fetchData(i.id).catch(() => null);
      if (!d || !d.roads.nodes.length) return null;
      const [stats, coast] = await Promise.all([json<IslandStats>(`${base}/island.json`), json<Outline>(`${base}/coast.json`)]);
      return { manifest: d.manifest as ManifestWithStats, roads: d.roads, stats, coast };
    }));
    const loaded = list.map((info, k) => ({ info, data: data[k] })).filter((x): x is { info: IslandInfo; data: MapData } => x.data !== null);

    // Height and outline of each island, in its own frame
    const shaped = loaded.map(({ info, data }) => {
      const water = data.manifest.stats?.water ?? null;
      const roadYs = data.roads.nodes.map((n) => n[1]);
      const dy = data.stats?.dy ?? verticalOffset(water, percentile(roadYs, 0.02), percentile(roadYs, 0.01));
      const loops = data.coast?.loops?.length ? data.coast.loops : data.stats?.loops?.length ? data.stats.loops : roadOutline(data.roads);
      // The land rectangle: outer loops of any size (tiny specks don't count)
      const rect: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
      for (const l of loops) {
        if (!l.outer || Math.abs(area(l.points)) < 50000) continue;
        for (const [x, z] of l.points) {
          rect[0] = Math.min(rect[0], x); rect[1] = Math.min(rect[1], z);
          rect[2] = Math.max(rect[2], x); rect[3] = Math.max(rect[3], z);
        }
      }
      if (!Number.isFinite(rect[0])) {
        const f = GameMap.footprint(data.manifest);
        rect.splice(0, 4, ...f);
      }
      return { info, data, dy, loops, rect, water };
    });

    // Layout: the designed places for the cities src/layout.ts names; any other, largest first, packed by shape
    // as close to the rest as it fits with GAP m of sea to any other land
    const occ = new Occupancy();
    const offsets: THREE.Vector3[] = shaped.map((s) => new THREE.Vector3(0, s.dy, 0));
    const masks = shaped.map((s) => rasterize(s.loops));
    const design = only ? null : worldLayout(shaped.map((s) => ({ id: s.info.id, rect: s.rect })));
    const free: number[] = [];
    shaped.forEach((_, k) => {
      const at = design?.placed[k];
      if (!at) {
        free.push(k);
        return;
      }
      const [di, dj] = [Math.round(at[0] / PACK_CELL), Math.round(at[1] / PACK_CELL)];
      offsets[k].x = di * PACK_CELL;
      offsets[k].z = dj * PACK_CELL;
      occ.add(masks[k], di, dj, k);
    });
    free.sort((p, q) => landArea(shaped[q].loops) - landArea(shaped[p].loops));
    for (const k of free) {
      const [di, dj] = occ.count ? occ.fit(masks[k]) : [0, 0];
      offsets[k].x = di * PACK_CELL;
      offsets[k].z = dj * PACK_CELL;
      occ.add(masks[k], di, dj, k);
    }
    const placed = shaped.map((s, k): [number, number, number, number] =>
      [s.rect[0] + offsets[k].x, s.rect[1] + offsets[k].z, s.rect[2] + offsets[k].x, s.rect[3] + offsets[k].z]);
    // A map's stray pieces far outside its own land (Chicago has a few, kilometres out) would stand inside
    // whichever city now sits there: cells centred on another island's land are left out
    shaped.forEach((sh, k) => {
      const half = sh.data.manifest.cellSize / 2;
      for (const c of sh.data.manifest.cells) {
        const owner = occ.at(c.x + half + offsets[k].x, c.z + half + offsets[k].z);
        if (owner >= 0 && owner !== k) { c.render = false; c.collision = false; }
      }
    });
    const maps = shaped.map((s, k) => GameMap.from(s.info.id, s.data, world, offsets[k]));
    // Painted lines where a map has none of its own (CARLA's towns, from their road networks)
    await Promise.all(maps.map(async (m) => {
      m.markings = await Markings.load(`/mods/maps/${m.id}`, litMaterial);
      if (m.markings) m.root.add(m.markings.root);
    }));
    console.log('islands:', shaped.map((s, k) => `${s.info.id} @ ${offsets[k].toArray().map((v) => v.toFixed(0)).join(',')}`).join('; '));

    // One road graph: every island's, then the bridge decks
    const merged: RoadData = { nodes: [], flags: [], links: [] };
    const plans: IslandPlan[] = [];
    for (const [k, m] of maps.entries()) {
      const base = merged.nodes.length;
      merged.nodes.push(...m.roadData.nodes);
      merged.flags.push(...(m.roadData.flags ?? m.roadData.nodes.map(() => 0)));
      merged.links.push(...m.roadData.links.map(([a, b, ab, ba]) => [a + base, b + base, ab, ba] as [number, number, number, number]));
      const adjacent: IslandPlan['adjacent'] = m.roadData.nodes.map(() => []);
      for (const [a, b, ab, ba] of m.roadData.links) {
        adjacent[a].push({ other: b, lanes: ab + ba });
        adjacent[b].push({ other: a, lanes: ab + ba });
      }
      const o = offsets[k];
      const shore: [number, number][] = [];
      for (const l of shaped[k].loops) {
        if (!l.outer) continue;
        for (let i = 0; i < l.points.length; i += 2) shore.push([l.points[i][0] + o.x, l.points[i][1] + o.z]);
      }
      plans.push({
        nodes: m.roadData.nodes.map(([x, y, z]) => new THREE.Vector3(x, y, z)),
        adjacent, shore, rect: placed[k], base,
        top: heightMap(shaped[k].data.stats?.tops, o),
      });
    }
    let bridges: BridgeNetwork | undefined;
    const corridors = new Corridors();
    if (maps.length > 1) {
      const links = planLinks(plans, (x, z) => occ.at(x, z), 2, design?.links);
      bridges = await BridgeNetwork.load(world, plans, links, (x, z) => occ.at(x, z));
      for (const b of bridges.bridges) {
        const ga = plans[b.plan.a].base + b.plan.na;
        const gb = plans[b.plan.b].base + b.plan.nb;
        let prev = ga;
        for (const p of b.nodes) {
          const i = merged.nodes.length;
          merged.nodes.push([p.x, p.y, p.z]);
          merged.flags.push(0);
          merged.links.push([prev, i, LANES, LANES]);
          prev = i;
        }
        merged.links.push([prev, gb, LANES, LANES]);
        // Whatever the cities and their shores have standing on the way to the deck is cut away
        corridors.add([plans[b.plan.a].nodes[b.plan.na], ...b.nodes, plans[b.plan.b].nodes[b.plan.nb]],
          [b.endHalf[0], ...b.halfWidths, b.endHalf[1]].map((h) => h + 1.5));
      }
      for (const m of maps) m.corridors = corridors;
      console.log(`bridges: ${bridges.bridges.length}`, bridges.bridges.map((b) =>
        `${shaped[b.plan.a].info.id}↔${shaped[b.plan.b].info.id} ${b.length.toFixed(0)} m`).join(', '));
    }
    const coast = await Coast.load(world, shaped.map((s, k) => ({
      offset: offsets[k],
      loops: s.loops.map((l) => ({ outer: l.outer, points: l.points.map(([x, z, y]) => [x, z, y] as [number, number, number]) })),
    })), corridors).catch((e) => {
      console.warn('coast not built', e);
      return undefined;
    });
    const water = shaped.map((s) => (s.water ? new Set((s.water.textures ?? ['water']).map((t) => t.toLowerCase())) : null));
    const outlines = shaped.map((s, k) => ({ offset: offsets[k], loops: s.loops.filter((l) => Math.abs(area(l.points)) > 20000) }));
    return new Islands(maps, shaped.map((s) => s.info), merged, bridges, coast, water, outlines);
  }

  /** The island a point is on (or nearest to). */
  islandAt(p: THREE.Vector3): { map: GameMap; info: IslandInfo } {
    let best = 0;
    let bestD = Infinity;
    this.maps.forEach((m, i) => {
      const d = m.distanceTo(p);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return { map: this.maps[best], info: this.info[best] };
  }

  async prime(at: THREE.Vector3): Promise<void> {
    await Promise.all(this.maps.filter((m) => m.distanceTo(at) < STREAM_MARGIN).map((m) => m.prime(at)));
  }

  update(camera: THREE.Vector3, solid: THREE.Vector3[]): void {
    for (const m of this.maps) {
      const near = m.distanceTo(camera) < STREAM_MARGIN || solid.some((p) => m.distanceTo(p) < STREAM_MARGIN);
      if (near || m.active) m.update(camera, solid);
    }
    for (const m of this.maps) m.markings?.update(camera, m.offset);
    this.coast?.update(camera);
    this.bridges?.update(camera);
  }

  cull(camera: THREE.Vector3): void {
    for (const m of this.maps) if (m.active) m.cull(camera);
    // A map's own sea is replaced by the shared ocean: hide its water surfaces as they stream in
    if (this.frame++ % 30 === 0) {
      this.maps.forEach((m, i) => {
        const names = this.water[i];
        if (!names || !m.active) return;
        m.root.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (!mesh.isMesh) return;
          const mat = mesh.material as THREE.MeshStandardMaterial;
          const tex = mat.map?.name?.toLowerCase();
          if (tex && (names.has(tex) || /^water|_water|water_/.test(tex))) mat.visible = false;
        });
      });
    }
  }

  setNight(amount: number): void {
    for (const m of this.maps) m.setNight(amount);
  }

  get loadedCells(): number {
    return this.maps.reduce((s, m) => s + m.loadedCells, 0);
  }

  /** Every island's shore-to-shore rectangle, for the minimap and the big map. */
  footprints(): { name: string; min: THREE.Vector2; max: THREE.Vector2 }[] {
    return this.maps.map((m, i) => ({ name: this.info[i].name, min: m.min, max: m.max }));
  }
}
