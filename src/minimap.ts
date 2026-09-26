import type * as THREE from 'three';
import type { MapMarker } from './events';
import type { GameMap, RoadGraph } from './map';

export interface MapExtras {
  events: MapMarker[];
  rivals: THREE.Vector3[];
  route: THREE.Vector3[] | null;
  destination: THREE.Vector3 | null;
}

const VIEW_RADIUS = 230; // meters from the player to the map edge
const SEA = '#081925';

/** extras.json written by scripts/map-extras.mjs (every field optional to the game). */
interface ExtrasFile {
  version: number;
  tiles: string[];
  overview: { file: string; min: [number, number]; max: [number, number]; mPerPx: number } | null;
}

interface IslandTiles {
  base: string;
  ox: number; // island offset in the world (x north, z east)
  oz: number;
  cellSize: number;
  min: [number, number]; // footprint in world space
  max: [number, number];
  extras: ExtrasFile | null | 'loading';
  tiles: Set<string>;
  overview: HTMLImageElement | null;
}

/**
 * The top-down map images from scripts/map-extras.mjs: map/tiles/<cx>_<cz>.webp (1 m/px, one per cell)
 * and map/overview.webp (8 m/px). Their pixel columns run along +x (north) and rows along +z (east), so
 * in a canvas transformed to world (x, z) coordinates they draw with a plain drawImage. Everything is
 * optional: islands without extras report no coverage and callers stroke their road links instead.
 */
export class MapTiles {
  /** Set by the world map (which knows the islands); the minimap picks it up from here. */
  static shared: MapTiles | null = null;
  onLoad: (() => void) | null = null;
  private readonly islands: IslandTiles[];
  private readonly images = new Map<string, HTMLImageElement | 'loading' | 'missing'>();
  private readonly lru: string[] = [];

  constructor(maps: GameMap[]) {
    this.islands = maps.map((m) => {
      const cs = m.manifest.cellSize;
      let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
      for (const c of m.manifest.cells) {
        x0 = Math.min(x0, c.x); z0 = Math.min(z0, c.z);
        x1 = Math.max(x1, c.x + cs); z1 = Math.max(z1, c.z + cs);
      }
      return {
        base: `/mods/maps/${m.id}`, ox: m.offset.x, oz: m.offset.z, cellSize: cs,
        min: [x0 + m.offset.x, z0 + m.offset.z], max: [x1 + m.offset.x, z1 + m.offset.z],
        extras: null, tiles: new Set(), overview: null,
      };
    });
    for (const isl of this.islands) void this.loadExtras(isl);
  }

  private async loadExtras(isl: IslandTiles): Promise<void> {
    isl.extras = 'loading';
    try {
      const r = await fetch(`${isl.base}/extras.json`);
      const e = r.ok ? ((await r.json()) as ExtrasFile) : null;
      isl.extras = e && e.version === 1 ? e : null;
    } catch {
      isl.extras = null;
    }
    if (!isl.extras) return;
    isl.tiles = new Set(isl.extras.tiles ?? []);
    if (isl.extras.overview) {
      const img = new Image();
      img.onload = () => { isl.overview = img; this.onLoad?.(); };
      img.src = `${isl.base}/${isl.extras.overview.file}`;
    }
  }

  private ready(isl: IslandTiles): isl is IslandTiles & { extras: ExtrasFile } {
    return !!isl.extras && isl.extras !== 'loading';
  }

  /** Whether a world point lies on an island that has map images (its roads needn't be stroked). */
  covers(x: number, z: number): boolean {
    return this.islands.some((i) => this.ready(i) && x >= i.min[0] && x <= i.max[0] && z >= i.min[1] && z <= i.max[1]);
  }

  /** Any island has images at all. */
  get any(): boolean {
    return this.islands.some((i) => this.ready(i));
  }

  private image(url: string): HTMLImageElement | null {
    const got = this.images.get(url);
    if (got instanceof HTMLImageElement) return got;
    if (got) return null;
    this.images.set(url, 'loading');
    const img = new Image();
    img.onload = () => {
      this.images.set(url, img);
      this.lru.push(url);
      while (this.lru.length > 400) this.images.delete(this.lru.shift()!);
      this.onLoad?.();
    };
    img.onerror = () => this.images.set(url, 'missing');
    img.src = url;
    return null;
  }

  /**
   * Draw into a context already transformed to world coordinates (canvas x = world x, canvas y = world z),
   * for the view rectangle given in world space. `pxPerM` picks tiles (close) or the overview (far).
   */
  draw(g: CanvasRenderingContext2D, x0: number, z0: number, x1: number, z1: number, pxPerM: number): void {
    for (const isl of this.islands) {
      if (!this.ready(isl)) continue;
      if (isl.max[0] < x0 || isl.min[0] > x1 || isl.max[1] < z0 || isl.min[1] > z1) continue;
      const ov = isl.extras.overview;
      if (ov && isl.overview) {
        g.imageSmoothingEnabled = true;
        g.drawImage(isl.overview, ov.min[0] + isl.ox, ov.min[1] + isl.oz, ov.max[0] - ov.min[0], ov.max[1] - ov.min[1]);
      }
      if (pxPerM < 0.1) continue; // overview is sharper than the tiles would be
      const cs = isl.cellSize;
      const cx0 = Math.floor((x0 - isl.ox) / cs), cx1 = Math.floor((x1 - isl.ox) / cs);
      const cz0 = Math.floor((z0 - isl.oz) / cs), cz1 = Math.floor((z1 - isl.oz) / cs);
      if ((cx1 - cx0 + 1) * (cz1 - cz0 + 1) > 160) continue; // too many to fetch: the overview will do
      for (let cx = cx0; cx <= cx1; cx++) {
        for (let cz = cz0; cz <= cz1; cz++) {
          const name = `${cx}_${cz}`;
          if (!isl.tiles.has(name)) continue;
          const img = this.image(`${isl.base}/map/tiles/${name}.webp`);
          // A hair of overlap hides seams between neighbouring tiles
          if (img) g.drawImage(img, cx * cs + isl.ox - 0.25, cz * cs + isl.oz - 0.25, cs + 0.5, cs + 0.5);
        }
      }
    }
  }
}

/** Heading-up circular minimap: the map tiles (or road network), traffic, events, rivals, the GPS route and the player arrow. */
export class Minimap {
  private readonly g: CanvasRenderingContext2D;
  private readonly size: number;

  constructor(canvas: HTMLCanvasElement, private readonly roads: RoadGraph) {
    this.g = canvas.getContext('2d')!;
    this.size = canvas.width;
  }

  draw(x: number, z: number, heading: number, traffic: THREE.Vector3[], extras: MapExtras): void {
    const g = this.g;
    const r = this.size / 2;
    const scale = r / VIEW_RADIUS;
    g.clearRect(0, 0, this.size, this.size);
    g.save();
    g.beginPath();
    g.arc(r, r, r - 2, 0, Math.PI * 2);
    g.clip();
    g.fillStyle = SEA;
    g.globalAlpha = 0.92;
    g.fillRect(0, 0, this.size, this.size);
    g.globalAlpha = 1;

    // World → map: forward points up the canvas
    g.translate(r, r);
    g.rotate(-Math.PI / 2 - heading);
    g.scale(scale, scale);
    g.translate(-x, -z);
    const reach = VIEW_RADIUS * 1.5;
    const tiles = MapTiles.shared;
    tiles?.draw(g, x - reach, z - reach, x + reach, z + reach, scale);

    // Streets within view, drawn wider for more lanes: only where there are no map tiles (bridges,
    // islands without extras)
    const nodes = this.roads.nodes;
    g.strokeStyle = tiles?.any ? '#525d6c' : 'rgba(120,116,150,0.9)';
    g.lineCap = 'round';
    for (const l of this.roads.links) {
      const a = nodes[l.a];
      const b = nodes[l.b];
      if (Math.abs(a.x - x) > reach && Math.abs(b.x - x) > reach) continue;
      if (Math.abs(a.z - z) > reach && Math.abs(b.z - z) > reach) continue;
      if (tiles && tiles.covers(a.x, a.z) && tiles.covers(b.x, b.z)) continue;
      g.lineWidth = 3.4 * Math.max(1, l.lanesAB + l.lanesBA);
      g.beginPath();
      g.moveTo(a.x, a.z);
      g.lineTo(b.x, b.z);
      g.stroke();
    }
    g.fillStyle = '#c7cfdd';
    for (const p of traffic) g.fillRect(p.x - 2.5, p.z - 2.5, 5, 5);

    if (extras.route && extras.route.length > 1) {
      g.lineJoin = 'round';
      g.lineCap = 'round';
      g.strokeStyle = 'rgba(40, 0, 32, 0.8)';
      g.lineWidth = 11;
      g.beginPath();
      extras.route.forEach((p, i) => (i === 0 ? g.moveTo(p.x, p.z) : g.lineTo(p.x, p.z)));
      g.stroke();
      g.strokeStyle = '#ff2bd6';
      g.lineWidth = 7;
      g.stroke();
    }
    const px = 1 / scale; // one screen pixel in world meters
    for (const e of extras.events) {
      g.globalAlpha = e.done ? 0.45 : 1;
      g.fillStyle = e.color;
      g.beginPath();
      g.arc(e.x, e.z, 6 * px, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = '#000';
      g.lineWidth = 1.5 * px;
      g.stroke();
    }
    g.globalAlpha = 1;
    g.fillStyle = '#ff2030';
    for (const p of extras.rivals) {
      g.beginPath();
      g.arc(p.x, p.z, 4.5 * px, 0, Math.PI * 2);
      g.fill();
    }
    g.restore();

    // Destination: on the map when in view, else pinned to the rim in its direction
    if (extras.destination) {
      const dx = extras.destination.x - x;
      const dz = extras.destination.z - z;
      const a = Math.atan2(dz, dx) - heading - Math.PI / 2;
      const d = Math.min(Math.hypot(dx, dz) * scale, r - 12);
      const fx = r + Math.cos(a) * d;
      const fy = r + Math.sin(a) * d;
      g.fillStyle = '#ffffff';
      g.strokeStyle = '#ff2bd6';
      g.lineWidth = 3;
      g.beginPath();
      g.arc(fx, fy, 8, 0, Math.PI * 2);
      g.fill();
      g.stroke();
    }

    // Player arrow at the center, pointing up
    g.fillStyle = '#00e5ff';
    g.strokeStyle = '#001018';
    g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(r, r - 9);
    g.lineTo(r + 6, r + 7);
    g.lineTo(r, r + 3);
    g.lineTo(r - 6, r + 7);
    g.closePath();
    g.fill();
    g.stroke();
    g.strokeStyle = 'rgba(0,229,255,0.6)';
    g.lineWidth = 2;
    g.beginPath();
    g.arc(r, r, r - 2, 0, Math.PI * 2);
    g.stroke();
  }
}
