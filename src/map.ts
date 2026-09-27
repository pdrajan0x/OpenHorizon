// A city from a GTA V map mod, converted by `gta5conv map` into public/mods/maps/<id>/ (see
// tools/gta5conv/MapWriter.cs for the format). Streams render cells around the camera and collision
// cells around the player, and exposes the mod's vehicle path nodes as a road graph for traffic,
// rivals, events and the GPS.
import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import type { Corridors } from './corridors';
import { EFFECTS } from './quality';

const RENDER_RADIUS = 650; // m of city drawn around the camera (fog hides the edge)
const COLLISION_RADIUS = 600; // m of collision around the player and rivals (traffic lives within ~300 m)
const LOADS_PER_FRAME = 3;
const MAX_FETCHES = 8; // concurrent downloads: priming a big city all at once exhausts the browser's request slots
// Small things vanish into the fog early: a mesh is drawn out to this many times its size.
// Only detail (small entities, tagged by the converter) is culled this way; building structure stays
// until its cell streams out. Maps converted before the tags existed are culled far more gently.
const DRAW_DISTANCE_PER_METER = 18;
const MIN_DRAW_DISTANCE = 120;
const UNTAGGED_DRAW_DISTANCE_PER_METER = 40;
const UNTAGGED_MIN_DRAW_DISTANCE = 300;
// Far skyline (far/<cellId>.bin from scripts/map-extras.mjs, optional): simplified cells drawn beyond
// the render radius, swapped out when the full cell streams in
const FAR_RADIUS = 3000;
const FAR_LOADS_PER_FRAME = 2;

// Lighting hooks the atmosphere installs (shadows); applied to every map material, old and new
let lightingSetup: ((m: THREE.MeshStandardMaterial) => void) | null = null;
const litMaterials = new Set<THREE.MeshStandardMaterial>();
/** GTA's baked vertex shading: how strongly it darkens, and the night glow of its artificial ambient. */
const shadeUniforms = { uShadeNight: { value: 0 } };

/** Called by the atmosphere: `setup` patches a material for cascaded shadows (null: no shadows). */
export function setMapLighting(setup: ((m: THREE.MeshStandardMaterial) => void) | null): void {
  lightingSetup = setup;
  if (setup) for (const m of litMaterials) applyLighting(m);
}

function applyLighting(m: THREE.MeshStandardMaterial): void {
  if (!lightingSetup || m.userData.lit) return;
  m.userData.lit = true;
  const own = m.onBeforeCompile;
  lightingSetup(m);
  const extra = m.onBeforeCompile;
  m.onBeforeCompile = (shader, renderer) => {
    extra.call(m, shader, renderer);
    own.call(m, shader, renderer);
  };
  m.needsUpdate = true;
}

/**
 * GTA colour0 per vertex: R ≈ sky visibility (baked ambient occlusion), G ≈ artificial ambient (lamps,
 * lit interiors). It scales the sky light and reflections, darkens direct light a little, and at
 * night adds a faint warm glow where G says there's artificial light.
 */
function shadeMaterial(m: THREE.MeshStandardMaterial): void {
  m.defines = { ...m.defines, USE_SHADE: '' };
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uShadeNight = shadeUniforms.uShadeNight;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 shade;\nvarying vec4 vShade;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvShade = shade;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec4 vShade;\nuniform float uShadeNight;')
      .replace('#include <aomap_fragment>', `#include <aomap_fragment>
        float skyVis = mix(0.3, 1.0, vShade.r);
        reflectedLight.indirectDiffuse *= skyVis;
        reflectedLight.indirectSpecular *= skyVis * skyVis;
        reflectedLight.directDiffuse *= mix(0.7, 1.0, vShade.r);
        reflectedLight.indirectDiffuse += diffuseColor.rgb * vec3(1.0, 0.8, 0.55) * vShade.g * vShade.g * uShadeNight * 0.12;`);
  };
}

let fetching = 0;
const queued: (() => void)[] = [];
/** fetch() a few at a time, retried on network errors; the body, or null for an HTTP error. */
async function download(url: string): Promise<ArrayBuffer | null> {
  if (fetching >= MAX_FETCHES) await new Promise<void>((go) => queued.push(go));
  fetching++;
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await fetch(url);
        return r.ok ? await r.arrayBuffer() : null;
      } catch (e) {
        if (attempt >= 3) throw e;
        await new Promise((go) => setTimeout(go, 250 * (attempt + 1)));
      }
    }
  } finally {
    fetching--;
    queued.shift()?.();
  }
}

/** Collision groups: the city is in STATIC_GROUP; lane-following traffic skips it (see traffic.ts). */
export const STATIC_GROUP = 0x0001;
export const CAR_GROUP = 0x0002;
const groups = (member: number, filter: number) => (member << 16) | filter;
export const STATIC_GROUPS = groups(STATIC_GROUP, 0xffff);

interface CellInfo {
  id: number;
  x: number;
  z: number;
  render: boolean;
  collision: boolean;
  triangles: number;
  textures: string[];
}
interface MaterialInfo {
  shader: string;
  diffuse: string | null;
  normal: string | null;
  emissive: boolean;
  blend: boolean;
  mask: boolean;
}
export interface Manifest {
  origin: number[];
  cellSize: number;
  spawn: number[];
  cells: CellInfo[];
  materials: MaterialInfo[];
}

export class GameMap {
  readonly root = new THREE.Group();
  readonly roads: RoadGraph;
  readonly roadData: RoadData; // in world space (offset applied), for merging islands' graphs
  readonly spawn: THREE.Vector3;
  /** World-space footprint of the render cells. */
  readonly min = new THREE.Vector2(Infinity, Infinity);
  readonly max = new THREE.Vector2(-Infinity, -Infinity);
  private readonly local = new THREE.Vector3();
  // Per manifest material: [plain, with vertex shading]. Batches with and without colours share a
  // manifest material, so each variant is its own three.js material (different vertex attributes).
  private readonly materials: [Promise<THREE.Material> | null, Promise<THREE.Material> | null][];
  private readonly built: THREE.Material[] = [];
  private readonly textures = new Map<string, Promise<THREE.Texture | null>>();
  private readonly meshes = new Map<number, THREE.Group | 'loading'>();
  private readonly far = new Map<number, THREE.Group | 'loading' | 'none'>();
  private farState: 'unknown' | 'checking' | 'yes' | 'no' = 'unknown';
  private readonly colliders = new Map<number, RAPIER.Collider | 'loading' | 'none'>();
  /** Bridge approaches to keep clear of this map's geometry (islands.ts); set before cells load. */
  corridors: Corridors | null = null;

  private constructor(
    readonly id: string,
    private readonly base: string,
    readonly manifest: Manifest,
    roads: RoadData,
    private readonly world: RAPIER.World,
    /** Where the map's own origin sits in the world (islands are laid out side by side). */
    readonly offset: THREE.Vector3,
  ) {
    const [ox, oy, oz] = [offset.x, offset.y, offset.z];
    this.roadData = { ...roads, nodes: roads.nodes.map(([x, y, z]) => [x + ox, y + oy, z + oz]) };
    this.roads = new RoadGraph(this.roadData);
    this.spawn = new THREE.Vector3(...(manifest.spawn as [number, number, number])).add(offset);
    this.materials = manifest.materials.map(() => [null, null]);
    this.root.name = `map:${id}`;
    this.root.position.copy(offset);
    // Static: its world matrix is worked out once (islands.ts), not every frame for every cell under it
    this.root.matrixAutoUpdate = false;
    this.root.updateMatrix();
    const s = manifest.cellSize;
    for (const c of manifest.cells) {
      if (!c.render) continue;
      this.min.set(Math.min(this.min.x, c.x + ox), Math.min(this.min.y, c.z + oz));
      this.max.set(Math.max(this.max.x, c.x + s + ox), Math.max(this.max.y, c.z + s + oz));
    }
  }

  static async load(id: string, world: RAPIER.World, offset = new THREE.Vector3()): Promise<GameMap> {
    const { manifest, roads } = await GameMap.fetchData(id);
    return new GameMap(id, `/mods/maps/${id}`, manifest, roads, world, offset);
  }

  static async fetchData(id: string): Promise<{ manifest: Manifest; roads: RoadData }> {
    const base = `/mods/maps/${id}`;
    const [manifest, roads] = await Promise.all([
      fetch(`${base}/manifest.json`).then((r) => r.json() as Promise<Manifest>),
      fetch(`${base}/roads.json`).then((r) => r.json() as Promise<RoadData>),
    ]);
    return { manifest, roads };
  }

  /** Build from data already fetched with fetchData(). */
  static from(id: string, data: { manifest: Manifest; roads: RoadData }, world: RAPIER.World, offset: THREE.Vector3): GameMap {
    return new GameMap(id, `/mods/maps/${id}`, data.manifest, data.roads, world, offset);
  }

  /** Local footprint of a map's render cells, before it's placed: [minX, minZ, maxX, maxZ]. */
  static footprint(manifest: Manifest): [number, number, number, number] {
    const s = manifest.cellSize;
    const out: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const c of manifest.cells) {
      if (!c.render) continue;
      out[0] = Math.min(out[0], c.x);
      out[1] = Math.min(out[1], c.z);
      out[2] = Math.max(out[2], c.x + s);
      out[3] = Math.max(out[3], c.z + s);
    }
    return out;
  }

  /** Horizontal distance from a world point to this map's footprint (0 inside). */
  distanceTo(p: THREE.Vector3): number {
    const dx = Math.max(this.min.x - p.x, 0, p.x - this.max.x);
    const dz = Math.max(this.min.y - p.z, 0, p.z - this.max.y);
    return Math.hypot(dx, dz);
  }

  /** Anything streamed in right now (render or collision)? */
  get active(): boolean {
    return this.meshes.size > 0 || this.colliders.size > 0 || this.far.size > 0;
  }

  /** Emissive overlays (lit windows, signs) only glow at night: 0 by day, 1 at night. */
  setNight(amount: number): void {
    this.night = amount;
    shadeUniforms.uShadeNight.value = amount;
    for (const m of this.built) this.applyNight(m);
  }

  private night = 1;

  private applyNight(m: THREE.Material): void {
    const base = m.userData.glow as number | undefined;
    if (base === undefined) return;
    if (m instanceof THREE.MeshBasicMaterial) {
      m.color.setScalar(base * this.night);
      m.visible = this.night > 0.01;
    } else if (m instanceof THREE.MeshStandardMaterial) {
      m.emissiveIntensity = base * this.night;
    }
  }

  /** Load everything needed around a point right now (before the first frame). */
  async prime(at: THREE.Vector3): Promise<void> {
    const jobs: Promise<void>[] = [];
    for (const c of this.manifest.cells) {
      const d = this.distance(c, at);
      if (c.collision && d < COLLISION_RADIUS) jobs.push(this.loadCollision(c));
      if (c.render && d < RENDER_RADIUS * 0.5) jobs.push(this.loadCell(c));
    }
    await Promise.all(jobs);
  }

  /** Stream cells in and out. `camera` drives what's drawn; `solid` (player, rivals) what's collidable. */
  update(camera: THREE.Vector3, solid: THREE.Vector3[]): void {
    let budget = LOADS_PER_FRAME;
    let farBudget = FAR_LOADS_PER_FRAME;
    const wanted = this.manifest.cells
      .map((c) => ({ c, d: this.distance(c, camera) }))
      .sort((a, b) => a.d - b.d);
    for (const { c, d } of wanted) {
      if (c.render) {
        const have = this.meshes.get(c.id);
        if (!have && d < RENDER_RADIUS && budget > 0) {
          budget--;
          void this.loadCell(c);
        } else if (have && have !== 'loading' && d > RENDER_RADIUS + 250) {
          this.root.remove(have);
          have.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
          this.meshes.delete(c.id);
          const far = this.far.get(c.id);
          if (far && far !== 'loading' && far !== 'none') far.visible = true;
        }
        // The far skyline: from just inside the render radius (so it's there when the cell unloads)
        // out to FAR_RADIUS
        const far = this.far.get(c.id);
        const full = this.meshes.get(c.id);
        if (!far && d > RENDER_RADIUS * 0.8 && d < FAR_RADIUS && farBudget > 0 && (!full || d > RENDER_RADIUS)) {
          if (!EFFECTS.far) { /* ?quality=low: no far skyline */ } else if (this.farState === 'unknown') void this.checkFar();
          else if (this.farState === 'yes') {
            farBudget--;
            void this.loadFar(c);
          }
        } else if (far && far !== 'loading' && (d > FAR_RADIUS + 300 || (full && full !== 'loading' && d < RENDER_RADIUS * 0.7))) {
          this.dropFar(c.id);
        }
      }
      if (c.collision) {
        const near = Math.min(...solid.map((p) => this.distance(c, p)));
        const col = this.colliders.get(c.id);
        if (!col && near < COLLISION_RADIUS) void this.loadCollision(c);
        else if (col && col !== 'loading' && near > COLLISION_RADIUS + 150) {
          if (col !== 'none') this.world.removeCollider(col, false);
          this.colliders.delete(c.id);
        }
      }
    }
  }

  /** Hide meshes too small to matter at their distance (call each frame before rendering). */
  cull(world: THREE.Vector3): void {
    const camera = this.local.subVectors(world, this.offset);
    for (const group of this.meshes.values()) {
      if (group === 'loading') continue;
      for (const o of group.children) {
        const mesh = o as THREE.Mesh;
        const detail = mesh.userData.detail as boolean | null;
        if (detail === false) continue; // structure
        const sphere = mesh.geometry.boundingSphere!;
        const reach = detail
          ? Math.max(MIN_DRAW_DISTANCE, sphere.radius * DRAW_DISTANCE_PER_METER) + sphere.radius
          : Math.max(UNTAGGED_MIN_DRAW_DISTANCE, sphere.radius * UNTAGGED_DRAW_DISTANCE_PER_METER) + sphere.radius;
        mesh.visible = sphere.center.distanceToSquared(camera) < reach * reach;
      }
    }
  }

  get loadedCells(): number {
    return [...this.meshes.values()].filter((m) => m !== 'loading').length;
  }

  private distance(c: CellInfo, world: THREE.Vector3): number {
    const s = this.manifest.cellSize;
    const p = this.local.subVectors(world, this.offset);
    const dx = Math.max(c.x - p.x, 0, p.x - (c.x + s));
    const dz = Math.max(c.z - p.z, 0, p.z - (c.z + s));
    return Math.hypot(dx, dz);
  }

  private async loadCell(c: CellInfo): Promise<void> {
    if (this.meshes.has(c.id)) return;
    this.meshes.set(c.id, 'loading');
    const buf = await download(`${this.base}/cells/${c.id}.bin`);
    if (!buf) return;
    const group = await this.parseCell(buf, false);
    if (this.meshes.get(c.id) !== 'loading') return; // unloaded meanwhile
    this.meshes.set(c.id, group);
    this.root.add(group);
    group.updateMatrixWorld(true);
    const far = this.far.get(c.id);
    if (far && far !== 'loading' && far !== 'none') far.visible = false;
  }

  /** extras.json says whether this map has a far skyline (scripts/map-extras.mjs; optional). */
  private async checkFar(): Promise<void> {
    this.farState = 'checking';
    try {
      const r = await fetch(`${this.base}/extras.json`);
      const extras = r.ok ? ((await r.json()) as { hasFar?: boolean }) : null;
      this.farState = extras?.hasFar ? 'yes' : 'no';
    } catch {
      this.farState = 'no';
    }
  }

  private async loadFar(c: CellInfo): Promise<void> {
    this.far.set(c.id, 'loading');
    const buf = await download(`${this.base}/far/${c.id}.bin`);
    if (this.far.get(c.id) !== 'loading') return;
    // No far copy of this cell (nothing big enough in it). A dev server answers a missing file with its
    // index page, so check the file looks like a cell: a JSON header after the length.
    if (!buf || buf.byteLength < 8 || new Uint8Array(buf, 4, 1)[0] !== 0x7b) {
      this.far.set(c.id, 'none');
      return;
    }
    const group = await this.parseCell(buf, true);
    if (this.far.get(c.id) !== 'loading') return;
    const full = this.meshes.get(c.id);
    group.visible = !full || full === 'loading';
    this.far.set(c.id, group);
    this.root.add(group);
    group.updateMatrixWorld(true);
  }

  private dropFar(id: number): void {
    const far = this.far.get(id);
    if (far && far !== 'loading' && far !== 'none') {
      this.root.remove(far);
      far.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
    }
    this.far.delete(id);
  }

  /** A cell file (cells/ or far/): header JSON, then per batch interleaved vertices and indices. */
  private async parseCell(buf: ArrayBuffer, far: boolean): Promise<THREE.Group> {
    const view = new DataView(buf);
    const jsonLength = view.getUint32(0, true);
    const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, jsonLength))) as {
      batches: { material: number; vertices: number; indices: number; colors?: boolean; detail?: boolean }[];
    };
    let offset = 4 + jsonLength;
    offset += (4 - (offset % 4)) % 4;
    const group = new THREE.Group();
    for (const b of header.batches) {
      // 8 floats per vertex, plus GTA's baked vertex shading (RGBA8) when the batch has it
      const stride = b.colors ? 9 : 8;
      const interleaved = new Float32Array(buf, offset, b.vertices * stride);
      const geo = new THREE.BufferGeometry();
      if (b.colors) {
        const bytes = new Uint8Array(buf, offset, b.vertices * stride * 4);
        const shade = new Uint8Array(b.vertices * 4);
        for (let v = 0; v < b.vertices; v++) shade.set(bytes.subarray(v * 36 + 32, v * 36 + 36), v * 4);
        geo.setAttribute('shade', new THREE.BufferAttribute(shade, 4, true));
      }
      offset += b.vertices * stride * 4;
      const raw = new Uint32Array(buf, offset, b.indices);
      offset += b.indices * 4;
      const index = this.corridors ? this.corridors.cut(interleaved, stride, raw, this.offset) : raw;
      if (!index.length) continue;
      const ib = new THREE.InterleavedBuffer(interleaved, stride);
      geo.setAttribute('position', new THREE.InterleavedBufferAttribute(ib, 3, 0));
      geo.setAttribute('normal', new THREE.InterleavedBufferAttribute(ib, 3, 3));
      geo.setAttribute('uv', new THREE.InterleavedBufferAttribute(ib, 2, 6));
      geo.setIndex(new THREE.BufferAttribute(index, 1));
      geo.computeBoundingSphere();
      const material = await this.material(b.material, !!b.colors);
      const mesh = new THREE.Mesh(geo, material);
      mesh.matrixAutoUpdate = false;
      // null: an old map without structure/detail tags. Far cells are never culled (already simplified).
      mesh.userData.detail = far ? false : (b.detail ?? null);
      const m = this.manifest.materials[b.material];
      if (m.blend) mesh.renderOrder = 1;
      // Solid surfaces cast and take the sun's shadows; the far skyline is beyond the shadow range
      const solid = material instanceof THREE.MeshStandardMaterial && !m.blend && !material.transparent;
      mesh.castShadow = !far && solid;
      // Far cells too, though beyond the shadows' reach: a material shared by meshes that differ here
      // makes the renderer switch shader programs on almost every draw
      mesh.receiveShadow = material instanceof THREE.MeshStandardMaterial;
      if (material.userData.shadowProxy) {
        // GTA's invisible shadow casters (tree canopies): only drawn into the shadow map
        if (far || !EFFECTS.shadows) continue;
        mesh.castShadow = true;
        mesh.userData.detail = false;
      }
      group.add(mesh);
    }
    group.matrixAutoUpdate = false;
    return group;
  }

  private async loadCollision(c: CellInfo): Promise<void> {
    if (this.colliders.has(c.id)) return;
    this.colliders.set(c.id, 'loading');
    const buf = await download(`${this.base}/col/${c.id}.bin`);
    if (!buf) return;
    const view = new DataView(buf);
    const vertices = view.getUint32(0, true);
    const indices = view.getUint32(4, true);
    const pos = new Float32Array(buf, 8, vertices * 3);
    const idx = this.corridors ? this.corridors.cut(pos, 3, new Uint32Array(buf, 8 + vertices * 12, indices), this.offset)
      : new Uint32Array(buf, 8 + vertices * 12, indices);
    if (!idx.length) {
      this.colliders.set(c.id, 'none');
      return;
    }
    const desc = RAPIER.ColliderDesc.trimesh(pos, idx).setFriction(0.9).setCollisionGroups(STATIC_GROUPS)
      .setTranslation(this.offset.x, this.offset.y, this.offset.z);
    const collider = this.world.createCollider(desc);
    this.colliders.set(c.id, collider);
  }

  /** The material for a manifest entry; `shaded` for batches carrying GTA's vertex shading. */
  private material(i: number, shaded: boolean): Promise<THREE.Material> {
    const slot = this.materials[i];
    const k = shaded ? 1 : 0;
    const made = (slot[k] ??= this.makeMaterial(i, shaded).then((mat) => {
      this.built.push(mat);
      return mat;
    }));
    return made;
  }

  private async makeMaterial(i: number, shaded: boolean): Promise<THREE.Material> {
    const m = this.manifest.materials[i];
    const [map, normalMap] = await Promise.all([
      m.diffuse ? this.texture(m.diffuse, true) : null,
      m.normal ? this.texture(m.normal, false) : null,
    ]);
    if (m.shader.includes('shadow_proxy')) {
      const proxy = new THREE.MeshStandardMaterial({ colorWrite: false, depthWrite: false });
      proxy.userData.shadowProxy = true;
      return proxy;
    }
    // GTA's emissive shaders are overlays: lit windows and signs drawn over the building, shaped by the
    // texture's alpha. Add them as glow on top rather than as solid surfaces.
    if (m.shader.startsWith('emissive') && map) {
      const glow = new THREE.MeshBasicMaterial({
        map,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
      });
      glow.userData.glow = m.shader.includes('night') ? 2.5 : 1.8;
      this.applyNight(glow);
      return glow;
    }
    const spec = m.shader.includes('spec');
    const isGlass = m.shader.includes('glass') || (m.diffuse && /glass|window/i.test(m.diffuse));
    const isRoad = m.shader.includes('terrain') || (m.diffuse && /road|asphalt|tarmac|pavement/i.test(m.diffuse));
    const isMetal = m.shader.includes('metal') || (m.diffuse && /metal|chrome|steel/i.test(m.diffuse));

    let roughness = 0.75;
    let metalness = 0.0;

    if (isGlass) {
      roughness = 0.1;
      metalness = 0.9;
    } else if (isRoad) {
      roughness = 0.45; // Wet/smooth asphalt look
      metalness = 0.05;
    } else if (isMetal) {
      roughness = 0.25;
      metalness = 0.85;
    } else if (spec) {
      roughness = 0.4;
      metalness = 0.1;
    }

    const mat = new THREE.MeshStandardMaterial({
      map, normalMap,
      color: map ? 0xffffff : 0x808080,
      roughness,
      metalness,
      transparent: !!(m.blend || isGlass),
      opacity: isGlass ? 0.85 : 1.0,
      depthWrite: !m.blend,
      alphaTest: m.mask ? 0.5 : 0,
      side: m.mask ? THREE.DoubleSide : THREE.FrontSide,
    });
    if (normalMap) mat.normalScale.set(1, -1); // GTA normal maps are DirectX-style (green down)
    if (m.emissive && map) {
      mat.emissiveMap = map;
      mat.emissive.set(0xffffff);
      // "emissivenight" is signage and lit windows; plain "emissive" often covers whole facades
      mat.userData.glow = m.shader.includes('night') ? 2.2 : 0.25;
      this.applyNight(mat);
    }
    if (shaded && EFFECTS.shade) shadeMaterial(mat);
    litMaterials.add(mat);
    applyLighting(mat);
    return mat;
  }

  private texture(name: string, color: boolean): Promise<THREE.Texture | null> {
    let t = this.textures.get(name);
    if (!t) {
      t = download(`${this.base}/tex/${name}.gtx`)
        .then((buf) => {
          const t = buf ? decodeGtx(buf, color) : null;
          if (t) t.name = name;
          return t;
        })
        .catch(() => null);
      this.textures.set(name, t);
    }
    return t;
  }
}

/** GTX: "GTX1", u32 format (1/3/5 = DXT1/3/5, 0 = RGBA8), u16 w, u16 h, u16 mips, u16 pad, mip chain. */
function decodeGtx(buf: ArrayBuffer, color: boolean): THREE.Texture {
  const view = new DataView(buf);
  const format = view.getUint32(4, true);
  const width = view.getUint16(8, true);
  const height = view.getUint16(10, true);
  const mips = view.getUint16(12, true);
  let texture: THREE.Texture;
  if (format === 0) {
    texture = new THREE.DataTexture(new Uint8Array(buf, 16, width * height * 4), width, height, THREE.RGBAFormat);
    texture.generateMipmaps = true;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
  } else {
    const block = format === 1 ? 8 : 16;
    const mipmaps: { data: Uint8Array; width: number; height: number }[] = [];
    let offset = 16;
    for (let l = 0; l < mips; l++) {
      const w = Math.max(1, width >> l);
      const h = Math.max(1, height >> l);
      const size = Math.max(1, Math.ceil(w / 4)) * Math.max(1, Math.ceil(h / 4)) * block;
      if (offset + size > buf.byteLength) break;
      mipmaps.push({ data: new Uint8Array(buf, offset, size), width: w, height: h });
      offset += size;
    }
    const fmt = format === 1 ? THREE.RGBA_S3TC_DXT1_Format : format === 3 ? THREE.RGBA_S3TC_DXT3_Format : THREE.RGBA_S3TC_DXT5_Format;
    texture = new THREE.CompressedTexture(mipmaps as unknown as ImageData[], width, height, fmt);
    texture.minFilter = mipmaps.length > 1 ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  }
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 8;
  texture.flipY = false;
  if (color) texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

// --- Roads ---

export interface RoadData {
  nodes: [number, number, number][];
  flags: number[];
  links: [number, number, number, number][]; // a, b, lanes a→b, lanes b→a
}

export interface RoadLink {
  a: number;
  b: number;
  lanesAB: number;
  lanesBA: number;
  length: number;
}

const LANE_WIDTH = 3.4;

/** The mod's vehicle path network: nodes on road centerlines, links between them. */
export class RoadGraph {
  readonly nodes: THREE.Vector3[];
  readonly links: RoadLink[];
  readonly adjacent: { link: RoadLink; other: number }[][];
  private readonly grid = new Map<string, number[]>(); // link indices bucketed by 50 m cell

  constructor(data: RoadData) {
    this.nodes = data.nodes.map(([x, y, z]) => new THREE.Vector3(x, y, z));
    this.links = data.links.map(([a, b, lanesAB, lanesBA]) => ({
      a, b, lanesAB, lanesBA, length: this.nodes[a].distanceTo(this.nodes[b]),
    }));
    this.adjacent = this.nodes.map(() => []);
    this.links.forEach((l, i) => {
      this.adjacent[l.a].push({ link: l, other: l.b });
      this.adjacent[l.b].push({ link: l, other: l.a });
      const pa = this.nodes[l.a];
      const pb = this.nodes[l.b];
      const steps = Math.ceil(l.length / 25);
      for (let s = 0; s <= steps; s++) {
        const x = pa.x + ((pb.x - pa.x) * s) / steps;
        const z = pa.z + ((pb.z - pa.z) * s) / steps;
        const key = `${Math.floor(x / 50)},${Math.floor(z / 50)}`;
        let bucket = this.grid.get(key);
        if (!bucket) this.grid.set(key, (bucket = []));
        if (bucket[bucket.length - 1] !== i) bucket.push(i);
      }
    });
  }

  /** Nodes with three or more connections: intersections. */
  junctions(): number[] {
    return this.adjacent.map((a, i) => (a.length >= 3 ? i : -1)).filter((i) => i >= 0);
  }

  nearestNode(x: number, z: number): number {
    const link = this.nearestLink(x, z);
    if (!link) {
      let best = 0;
      let bestD = Infinity;
      this.nodes.forEach((n, i) => {
        const d = (n.x - x) ** 2 + (n.z - z) ** 2;
        if (d < bestD) { bestD = d; best = i; }
      });
      return best;
    }
    const da = (this.nodes[link.link.a].x - x) ** 2 + (this.nodes[link.link.a].z - z) ** 2;
    const db = (this.nodes[link.link.b].x - x) ** 2 + (this.nodes[link.link.b].z - z) ** 2;
    return da < db ? link.link.a : link.link.b;
  }

  /** Closest link to a point within ~50 m: how far along it (0..1) and signed side distance (+ = right of a→b). */
  nearestLink(x: number, z: number): { link: RoadLink; t: number; side: number; distance: number } | null {
    let best: { link: RoadLink; t: number; side: number; distance: number } | null = null;
    const cx = Math.floor(x / 50);
    const cz = Math.floor(z / 50);
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        for (const li of this.grid.get(`${cx + i},${cz + j}`) ?? []) {
          const l = this.links[li];
          const a = this.nodes[l.a];
          const b = this.nodes[l.b];
          const abx = b.x - a.x;
          const abz = b.z - a.z;
          const len2 = abx * abx + abz * abz || 1;
          const t = THREE.MathUtils.clamp(((x - a.x) * abx + (z - a.z) * abz) / len2, 0, 1);
          const px = a.x + abx * t;
          const pz = a.z + abz * t;
          const distance = Math.hypot(x - px, z - pz);
          if (!best || distance < best.distance) {
            // Right of travel a→b: heading +x has +z on its right, i.e. right = (-dz, dx)
            const side = ((x - a.x) * -abz + (z - a.z) * abx) / Math.sqrt(len2);
            best = { link: l, t, side, distance };
          }
        }
      }
    }
    return best;
  }

  /**
   * Signed distance from the road's centerline, positive on the correct (right-hand) side for travel
   * direction (fx, fz). Null off the road network.
   */
  laneOffset(x: number, z: number, fx: number, fz: number): number | null {
    const near = this.nearestLink(x, z);
    if (!near || near.distance > (Math.max(near.link.lanesAB, near.link.lanesBA, 1) + 1) * LANE_WIDTH) return null;
    const a = this.nodes[near.link.a];
    const b = this.nodes[near.link.b];
    const along = (b.x - a.x) * fx + (b.z - a.z) * fz;
    if (Math.abs(along) < near.link.length * 0.6) return null; // crossing the road, not driving along it
    // One-way roads have no oncoming side
    if (near.link.lanesAB === 0 || near.link.lanesBA === 0) return Math.abs(near.side);
    return along > 0 ? near.side : -near.side;
  }

  /** Shortest route between nodes (A*), as node indices; empty if unreachable. */
  route(from: number, to: number, avoid?: number): number[] {
    const open = new Map<number, number>([[from, 0]]);
    const g = new Map<number, number>([[from, 0]]);
    const came = new Map<number, number>();
    const h = (n: number) => this.nodes[n].distanceTo(this.nodes[to]);
    while (open.size > 0) {
      let cur = -1;
      let best = Infinity;
      for (const [n, f] of open) if (f < best) { best = f; cur = n; }
      if (cur === to) break;
      open.delete(cur);
      for (const { link, other } of this.adjacent[cur]) {
        if (other === avoid && cur === from) continue;
        const cost = g.get(cur)! + link.length;
        if (cost < (g.get(other) ?? Infinity)) {
          g.set(other, cost);
          came.set(other, cur);
          open.set(other, cost + h(other));
        }
      }
    }
    if (!came.has(to) && from !== to) return [];
    const path = [to];
    while (path[0] !== from) path.unshift(came.get(path[0])!);
    return path;
  }

  /** Remaining driving distance from every node to `to` (Dijkstra), for race positions and GPS. */
  distancesTo(to: number): Float32Array {
    const dist = new Float32Array(this.nodes.length).fill(Infinity);
    dist[to] = 0;
    const open = new Set([to]);
    while (open.size > 0) {
      let cur = -1;
      let best = Infinity;
      for (const n of open) if (dist[n] < best) { best = dist[n]; cur = n; }
      open.delete(cur);
      for (const { link, other } of this.adjacent[cur]) {
        const d = dist[cur] + link.length;
        if (d < dist[other]) {
          dist[other] = d;
          open.add(other);
        }
      }
    }
    return dist;
  }

  /** Points along a node route, `offset` meters right of the centerline (lanes drive on the right). */
  polyline(route: number[], offset = LANE_WIDTH / 2): THREE.Vector3[] {
    const pts: THREE.Vector3[] = [];
    for (let k = 0; k < route.length; k++) {
      const p = this.nodes[route[k]].clone();
      const prev = this.nodes[route[Math.max(0, k - 1)]];
      const next = this.nodes[route[Math.min(route.length - 1, k + 1)]];
      const dir = new THREE.Vector3().subVectors(next, prev).setY(0);
      if (dir.lengthSq() > 1e-6) {
        dir.normalize();
        p.x += -dir.z * offset;
        p.z += dir.x * offset;
      }
      pts.push(p);
    }
    return pts;
  }

  /** A pose on the nearest road, in a right-hand lane, facing the way closest to `heading`. */
  roadPose(x: number, z: number, heading: number): { position: THREE.Vector3; yaw: number } {
    const near = this.nearestLink(x, z);
    if (!near) {
      // Off the network (in the sea): the closest road anywhere
      const n = this.nodes[this.nearestNode(x, z)];
      if (!n || (n.x === x && n.z === z)) return { position: new THREE.Vector3(x, 2, z), yaw: -heading };
      return this.roadPose(n.x, n.z, heading);
    }
    const a = this.nodes[near.link.a];
    const b = this.nodes[near.link.b];
    let dx = b.x - a.x;
    let dz = b.z - a.z;
    const len = Math.hypot(dx, dz) || 1;
    dx /= len;
    dz /= len;
    let forward = Math.cos(heading) * dx + Math.sin(heading) * dz >= 0;
    if (forward && near.link.lanesAB === 0) forward = false;
    if (!forward && near.link.lanesBA === 0) forward = true;
    if (!forward) { dx = -dx; dz = -dz; }
    const p = new THREE.Vector3().lerpVectors(a, b, near.t);
    const oneWay = near.link.lanesAB === 0 || near.link.lanesBA === 0;
    const offset = oneWay ? 0 : LANE_WIDTH * 0.5;
    p.x += -dz * offset;
    p.z += dx * offset;
    p.y += 1;
    return { position: p, yaw: -Math.atan2(dz, dx) };
  }
}

/** Driving distances toward one destination node: race positions, the GPS and rival routes. */
export class RaceField {
  readonly dist: Float32Array;

  constructor(readonly roads: RoadGraph, readonly dest: number) {
    this.dist = roads.distancesTo(dest);
  }

  /** Remaining distance from a world position, via the nearer-to-home end of the road it's on. */
  remaining(x: number, z: number): number {
    const near = this.roads.nearestLink(x, z);
    if (!near) {
      const n = this.roads.nearestNode(x, z);
      return this.dist[n] + Math.hypot(this.roads.nodes[n].x - x, this.roads.nodes[n].z - z);
    }
    const { link, t } = near;
    return Math.min(this.dist[link.a] + t * link.length, this.dist[link.b] + (1 - t) * link.length) + near.distance;
  }

  /** The node to head for next from a world position. */
  nextNode(x: number, z: number): number {
    const near = this.roads.nearestLink(x, z);
    if (!near) return this.roads.nearestNode(x, z);
    const { link, t } = near;
    return this.dist[link.a] + t * link.length <= this.dist[link.b] + (1 - t) * link.length ? link.a : link.b;
  }

  /** Shortest route from a node to the destination, as node indices. */
  route(from: number): number[] {
    const out = [from];
    let cur = from;
    while (this.dist[cur] > 0 && out.length < 5000) {
      let next = -1;
      let best = this.dist[cur];
      for (const { other } of this.roads.adjacent[cur]) if (this.dist[other] < best) { best = this.dist[other]; next = other; }
      if (next < 0) break;
      out.push(next);
      cur = next;
    }
    return out;
  }
}
