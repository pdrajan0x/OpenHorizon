import type * as THREE from 'three';
import type { MapMarker } from './events';
import type { RoadGraph } from './map';

export interface MapExtras {
  events: MapMarker[];
  rivals: THREE.Vector3[];
  route: THREE.Vector3[] | null;
  destination: THREE.Vector3 | null;
}

const VIEW_RADIUS = 230; // meters from the player to the map edge

/** Heading-up circular minimap: the road network, traffic, events, rivals, the GPS route and the player arrow. */
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
    g.fillStyle = 'rgba(10,10,18,0.85)';
    g.fillRect(0, 0, this.size, this.size);

    // World → map: forward points up the canvas
    g.translate(r, r);
    g.rotate(-Math.PI / 2 - heading);
    g.scale(scale, scale);
    g.translate(-x, -z);
    // Streets within view, drawn wider for more lanes
    const nodes = this.roads.nodes;
    g.strokeStyle = 'rgba(120,116,150,0.9)';
    g.lineCap = 'round';
    for (const l of this.roads.links) {
      const a = nodes[l.a];
      const b = nodes[l.b];
      if (Math.abs(a.x - x) > VIEW_RADIUS * 1.5 && Math.abs(b.x - x) > VIEW_RADIUS * 1.5) continue;
      if (Math.abs(a.z - z) > VIEW_RADIUS * 1.5 && Math.abs(b.z - z) > VIEW_RADIUS * 1.5) continue;
      g.lineWidth = 3.4 * Math.max(1, l.lanesAB + l.lanesBA);
      g.beginPath();
      g.moveTo(a.x, a.z);
      g.lineTo(b.x, b.z);
      g.stroke();
    }
    g.fillStyle = '#9aa3b8';
    for (const p of traffic) g.fillRect(p.x - 2.5, p.z - 2.5, 5, 5);

    if (extras.route && extras.route.length > 1) {
      g.strokeStyle = 'rgba(255, 43, 214, 0.9)';
      g.lineWidth = 7;
      g.lineJoin = 'round';
      g.beginPath();
      extras.route.forEach((p, i) => (i === 0 ? g.moveTo(p.x, p.z) : g.lineTo(p.x, p.z)));
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
    g.beginPath();
    g.moveTo(r, r - 9);
    g.lineTo(r + 6, r + 7);
    g.lineTo(r, r + 3);
    g.lineTo(r - 6, r + 7);
    g.closePath();
    g.fill();
    g.strokeStyle = 'rgba(0,229,255,0.6)';
    g.lineWidth = 2;
    g.beginPath();
    g.arc(r, r, r - 2, 0, Math.PI * 2);
    g.stroke();
  }
}
