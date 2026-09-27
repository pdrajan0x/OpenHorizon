// The full-screen map (M): every island's streets on the open sea, north up, with the events, rivals,
// the GPS route and the player. The game pauses while it's open; M or Escape goes back to driving.
// Mouse wheel or +/- zooms, dragging or the arrow keys pan. Click any city label to jump to it; click
// anywhere else to set a GPS waypoint, right-click or Delete to clear it. The view stays where you
// left it between visits (F fits everything again).
import * as THREE from 'three';
import type { Islands } from './islands';
import { MapTiles, type MapExtras } from './minimap';

const MIN_SCALE = 0.001; // px per m: the whole archipelago
const MAX_SCALE = 1.2; // px per m: a few blocks
const LEGEND: [string, string][] = [['race', '#00e5ff'], ['road rage', '#ff2030'], ['stunt run', '#ffd166']];

export class WorldMap {
  open = false;
  private readonly canvas: HTMLCanvasElement;
  private readonly g: CanvasRenderingContext2D;
  private readonly centre = new THREE.Vector2(); // world (x north, z east) at the middle of the screen
  private scale = 0.025;
  private fitted = false; // the first opening fits the whole world; later ones keep the last view
  private waypoint: THREE.Vector2 | null = null;
  private drag: { x: number; y: number; moved: boolean } | null = null;
  private player = { x: 0, z: 0, heading: 0 };
  private extras: MapExtras | null = null;
  private readonly tiles: MapTiles;
  private redraw = 0;
  private readonly labels: { name: string; x: number; z: number; box?: { x0: number; y0: number; x1: number; y1: number } }[];

  constructor(
    private readonly islands: Islands,
    private readonly onToggle: (open: boolean) => void,
    /** A GPS waypoint was set (world x, z) or cleared (null). */
    private readonly onWaypoint: (at: THREE.Vector2 | null) => void = () => {},
  ) {
    this.canvas = document.createElement('canvas');
    this.canvas.id = 'worldmap';
    this.canvas.className = 'hidden';
    document.body.appendChild(this.canvas);
    this.g = this.canvas.getContext('2d')!;

    // Top-down map images from scripts/map-extras.mjs, shared with the minimap; redraw as they arrive
    this.tiles = new MapTiles(islands.maps);
    MapTiles.shared = this.tiles;
    this.tiles.onLoad = () => {
      if (this.open && !this.redraw) this.redraw = requestAnimationFrame(() => { this.redraw = 0; this.draw(); });
    };

    // Each island is labelled at the middle of its streets
    this.labels = islands.maps.map((m, i) => {
      const nodes = m.roadData.nodes;
      const x = nodes.reduce((s, n) => s + n[0], 0) / nodes.length;
      const z = nodes.reduce((s, n) => s + n[2], 0) / nodes.length;
      return { name: islands.info[i].name, x, z };
    });

    // Capture phase: while the map is open, Escape closes it instead of quitting an event
    window.addEventListener('keydown', (e) => {
      if (e.code === 'KeyM' && !e.repeat) {
        this.toggle();
        e.stopImmediatePropagation();
      } else if (this.open) {
        if (e.code === 'Escape') this.toggle();
        else if (e.code === 'Equal' || e.code === 'NumpadAdd') this.zoom(1.4);
        else if (e.code === 'Minus' || e.code === 'NumpadSubtract') this.zoom(1 / 1.4);
        else if (e.code === 'KeyF') this.fitAll();
        else if (e.code === 'Delete' || e.code === 'Backspace') this.setWaypoint(null);
        else if (e.code.startsWith('Arrow')) this.pan(e.code);
        else return;
        e.stopImmediatePropagation();
        e.preventDefault();
      }
    }, true);

    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.zoom(e.deltaY < 0 ? 1.25 : 1 / 1.25, e.clientX, e.clientY);
    }, { passive: false });

    this.canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.setWaypoint(null);
    });

    this.canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      this.drag = { x: e.clientX, y: e.clientY, moved: false };
      this.canvas.setPointerCapture(e.pointerId);
    });

    this.canvas.addEventListener('pointermove', (e) => {
      if (!this.drag) return;
      const dx = e.clientX - this.drag.x;
      const dy = e.clientY - this.drag.y;
      if (Math.hypot(dx, dy) > 4) this.drag.moved = true;
      // Screen right is east (+z), screen up is north (+x)
      this.centre.x += dy / this.scale;
      this.centre.y -= dx / this.scale;
      this.drag.x = e.clientX;
      this.drag.y = e.clientY;
      this.draw();
    });

    this.canvas.addEventListener('pointerup', (e) => {
      if (this.drag && !this.drag.moved) {
        // A click without dragging: a city label zooms to that city, the waypoint marker clears it,
        // anywhere else sets the waypoint there
        const clickX = e.clientX;
        const clickY = e.clientY;
        const label = this.labels.find((l) => l.box && clickX >= l.box.x0 && clickX <= l.box.x1 && clickY >= l.box.y0 && clickY <= l.box.y1);
        if (label) {
          this.centre.set(label.x, label.z);
          this.scale = 0.15;
          this.draw();
        } else if (this.waypoint && Math.hypot(...this.toScreen(this.waypoint.x, this.waypoint.y).map((v, k) => v - [clickX, clickY][k])) < 14) {
          this.setWaypoint(null);
        } else {
          const w = this.toWorld(clickX, clickY);
          this.setWaypoint(w);
        }
      }
      this.drag = null;
    });

    this.canvas.addEventListener('dblclick', (e) => {
      this.zoom(2.0, e.clientX, e.clientY);
    });

    window.addEventListener('resize', () => this.open && this.draw());
  }

  /** Where the player is and what to show; call before opening (cheap: it only draws when open). */
  setState(x: number, z: number, heading: number, extras: MapExtras): void {
    this.player = { x, z, heading };
    this.extras = extras;
  }

  toggle(): void {
    this.open = !this.open;
    this.canvas.classList.toggle('hidden', !this.open);
    if (this.open && !this.fitted) {
      this.fitted = true;
      this.fitAll();
    } else if (this.open) this.draw();
    this.onToggle(this.open);
  }

  /** Show fresh extras now (e.g. the route to a waypoint just set) while the map is open. */
  refresh(extras: MapExtras): void {
    this.extras = extras;
    if (this.open) this.draw();
  }

  /** The waypoint was reached: take the pin off the map. */
  clearWaypoint(): void {
    this.waypoint = null;
  }

  private setWaypoint(at: THREE.Vector2 | null): void {
    this.waypoint = at;
    this.onWaypoint(at);
    this.draw();
  }

  /** Fit the entire archipelago of islands inside the screen viewport. */
  private fitAll(): void {
    if (this.labels.length === 0) return;
    const minX = Math.min(...this.labels.map((l) => l.x));
    const maxX = Math.max(...this.labels.map((l) => l.x));
    const minZ = Math.min(...this.labels.map((l) => l.z));
    const maxZ = Math.max(...this.labels.map((l) => l.z));

    this.centre.set((minX + maxX) / 2, (minZ + maxZ) / 2);

    const spanZ = Math.max(2000, maxZ - minZ + 8000);
    const spanX = Math.max(2000, maxX - minX + 8000);
    const w = innerWidth || 1920;
    const h = innerHeight || 1080;

    const scaleZ = (w * 0.82) / spanZ;
    const scaleX = (h * 0.82) / spanX;
    this.scale = THREE.MathUtils.clamp(Math.min(scaleZ, scaleX), MIN_SCALE, MAX_SCALE);
    this.draw();
  }

  private zoom(factor: number, sx = innerWidth / 2, sy = innerHeight / 2): void {
    // Keep the world point under the cursor where it is
    const before = this.toWorld(sx, sy);
    this.scale = THREE.MathUtils.clamp(this.scale * factor, MIN_SCALE, MAX_SCALE);
    const after = this.toWorld(sx, sy);
    this.centre.x += before.x - after.x;
    this.centre.y += before.y - after.y;
    this.draw();
  }

  private pan(code: string): void {
    const step = 180 / this.scale;
    if (code === 'ArrowUp') this.centre.x += step;
    if (code === 'ArrowDown') this.centre.x -= step;
    if (code === 'ArrowRight') this.centre.y += step;
    if (code === 'ArrowLeft') this.centre.y -= step;
    this.draw();
  }

  private toScreen(x: number, z: number): [number, number] {
    return [innerWidth / 2 + (z - this.centre.y) * this.scale, innerHeight / 2 - (x - this.centre.x) * this.scale];
  }

  private toWorld(sx: number, sy: number): THREE.Vector2 {
    return new THREE.Vector2(this.centre.x - (sy - innerHeight / 2) / this.scale, this.centre.y + (sx - innerWidth / 2) / this.scale);
  }

  private draw(): void {
    const dpr = Math.min(devicePixelRatio, 2);
    const w = innerWidth;
    const h = innerHeight;
    if (this.canvas.width !== w * dpr) {
      this.canvas.width = w * dpr;
      this.canvas.height = h * dpr;
    }
    const g = this.g;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Deep oceanic background with subtle radial gradient
    const bgGrad = g.createRadialGradient(w / 2, h / 2, 50, w / 2, h / 2, Math.max(w, h));
    bgGrad.addColorStop(0, '#0d2838');
    bgGrad.addColorStop(1, '#06131c');
    g.fillStyle = bgGrad;
    g.fillRect(0, 0, w, h);

    // World (x north, z east) → screen: z to the right, x up
    g.save();
    g.translate(w / 2, h / 2);
    g.scale(this.scale, this.scale);
    g.rotate(-Math.PI / 2);
    g.translate(-this.centre.x, -this.centre.y);

    const roads = this.islands.roads;
    const nodes = roads.nodes;
    g.lineCap = 'round';
    g.lineJoin = 'round';

    // Land: every island's outline, lakes cut out, under everything else
    g.beginPath();
    for (const { offset, loops } of this.islands.outlines) {
      for (const l of loops) {
        l.points.forEach(([x, z], i) => (i === 0 ? g.moveTo(x + offset.x, z + offset.z) : g.lineTo(x + offset.x, z + offset.z)));
        g.closePath();
      }
    }
    g.fillStyle = '#18332c';
    g.fill('evenodd');
    g.strokeStyle = '#2f5a4c';
    g.lineWidth = 2 / this.scale;
    g.stroke();

    // Visible world rectangle, for picking tiles
    const c0 = this.toWorld(0, h), c1 = this.toWorld(w, 0);
    this.tiles.draw(g, c0.x, c0.y, c1.x, c1.y, this.scale);

    // Road links where there are no map images (bridges, islands without extras): the old stroked look
    const tiles = this.tiles;
    const bare = roads.links.filter((l) => !(tiles.covers(nodes[l.a].x, nodes[l.a].z) && tiles.covers(nodes[l.b].x, nodes[l.b].z)));
    const strokeRoads = (links: typeof bare, width: (lanes: number) => number, colour: string) => {
      g.strokeStyle = colour;
      for (const l of links) {
        const a = nodes[l.a];
        const b = nodes[l.b];
        g.lineWidth = width(l.lanesAB + l.lanesBA);
        g.beginPath();
        g.moveTo(a.x, a.z);
        g.lineTo(b.x, b.z);
        g.stroke();
      }
    };
    // Road asphalt and street outlines
    strokeRoads(bare, (lanes) => Math.max(2.8 / this.scale, 4.5 * Math.max(1, lanes)), '#3a4454');
    strokeRoads(bare, (lanes) => Math.max(1.8 / this.scale, 3.2 * Math.max(1, lanes)), tiles.any ? '#8894a6' : '#e0e6ed');

    const ex = this.extras;
    if (ex?.route && ex.route.length > 1) {
      g.beginPath();
      g.moveTo(ex.route[0].x, ex.route[0].z);
      for (const p of ex.route) g.lineTo(p.x, p.z);
      g.strokeStyle = 'rgba(40, 0, 32, 0.85)';
      g.lineWidth = Math.max(7 / this.scale, 12);
      g.stroke();
      g.strokeStyle = '#ff2bd6';
      g.lineWidth = Math.max(4 / this.scale, 8);
      g.stroke();
    }
    g.restore();

    // Markers in screen space so they stay the same size at any zoom
    const at = (x: number, z: number) => [w / 2 + (z - this.centre.y) * this.scale, h / 2 - (x - this.centre.x) * this.scale];

    // Island badges
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = '700 13px system-ui, sans-serif';

    for (const l of this.labels) {
      const [sx, sy] = at(l.x, l.z);
      const text = l.name.toUpperCase();
      const metrics = g.measureText(text);
      const pw = metrics.width + 18;
      const ph = 26;
      const x0 = sx - pw / 2;
      const y0 = sy - ph / 2;
      l.box = { x0, y0, x1: x0 + pw, y1: y0 + ph };

      // Dark translucent pill with cyan neon outline
      g.fillStyle = 'rgba(7, 20, 36, 0.92)';
      g.beginPath();
      g.roundRect(x0, y0, pw, ph, 6);
      g.fill();
      g.strokeStyle = '#00e5ff';
      g.lineWidth = 1.6;
      g.stroke();

      g.fillStyle = '#ffffff';
      g.fillText(text, sx, sy);
    }

    // Events
    for (const m of ex?.events ?? []) {
      const [sx, sy] = at(m.x, m.z);
      g.beginPath();
      g.arc(sx, sy, 7, 0, Math.PI * 2);
      g.fillStyle = m.color;
      g.globalAlpha = m.done ? 0.35 : 1;
      g.fill();
      g.globalAlpha = 1;
      g.strokeStyle = '#000';
      g.lineWidth = 2;
      g.stroke();
    }

    if (ex?.destination && !this.waypoint) {
      const [sx, sy] = at(ex.destination.x, ex.destination.z);
      g.strokeStyle = '#ff2bd6';
      g.lineWidth = 3;
      g.strokeRect(sx - 8, sy - 8, 16, 16);
    }
    if (this.waypoint) {
      // A map pin at the waypoint, on the road the route ends at
      const pin = ex?.destination ?? new THREE.Vector3(this.waypoint.x, 0, this.waypoint.y);
      const [sx, sy] = at(pin.x, pin.z);
      g.beginPath();
      g.moveTo(sx, sy);
      g.bezierCurveTo(sx - 4, sy - 9, sx - 11, sy - 13, sx - 11, sy - 21);
      g.arc(sx, sy - 21, 11, Math.PI, 0);
      g.bezierCurveTo(sx + 11, sy - 13, sx + 4, sy - 9, sx, sy);
      g.fillStyle = '#ff2bd6';
      g.fill();
      g.strokeStyle = '#2a0022';
      g.lineWidth = 2;
      g.stroke();
      g.beginPath();
      g.arc(sx, sy - 21, 4, 0, Math.PI * 2);
      g.fillStyle = '#fff';
      g.fill();
    }

    g.fillStyle = '#ff9a3c';
    for (const r of ex?.rivals ?? []) {
      const [sx, sy] = at(r.x, r.z);
      g.fillRect(sx - 4, sy - 4, 8, 8);
    }

    // The player: an arrow along the heading (heading 0 = north, turning toward east)
    const [px, py] = at(this.player.x, this.player.z);
    g.save();
    g.translate(px, py);
    g.rotate(this.player.heading);
    g.beginPath();
    g.moveTo(0, -14);
    g.lineTo(9, 10);
    g.lineTo(0, 5);
    g.lineTo(-9, 10);
    g.closePath();
    g.fillStyle = '#27e1ff';
    g.fill();
    g.strokeStyle = '#001018';
    g.lineWidth = 2;
    g.stroke();
    g.restore();

    // Footer bar and instructions
    g.textAlign = 'left';
    g.font = '13px system-ui, sans-serif';
    g.fillStyle = 'rgba(232, 244, 255, 0.9)';
    g.fillText('MAP — M / Esc back · Click a city to focus · Click the map to set GPS, right-click / Del to clear · Wheel / +/- zoom · Drag / arrows pan · F fit all', 18, h - 20);

    let lx = 18;
    for (const [label, colour] of LEGEND) {
      g.fillStyle = colour;
      g.fillText(`● ${label}`, lx, h - 46);
      lx += g.measureText(`● ${label}`).width + 18;
    }
  }
}
