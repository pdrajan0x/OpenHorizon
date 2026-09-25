import type * as THREE from 'three';
import type { BlockInfo } from './city';

const VIEW_RADIUS = 230; // meters from the player to the map edge

/** Heading-up circular minimap: city blocks, traffic dots and the player arrow. */
export class Minimap {
  private readonly g: CanvasRenderingContext2D;
  private readonly size: number;

  constructor(canvas: HTMLCanvasElement, private readonly blocks: BlockInfo[]) {
    this.g = canvas.getContext('2d')!;
    this.size = canvas.width;
  }

  draw(x: number, z: number, heading: number, traffic: THREE.Vector3[]): void {
    const g = this.g;
    const r = this.size / 2;
    const scale = r / VIEW_RADIUS;
    g.clearRect(0, 0, this.size, this.size);
    g.save();
    g.beginPath();
    g.arc(r, r, r - 2, 0, Math.PI * 2);
    g.clip();
    g.fillStyle = 'rgba(40,38,58,0.85)'; // streets
    g.fillRect(0, 0, this.size, this.size);

    // World → map: forward points up the canvas
    g.translate(r, r);
    g.rotate(-Math.PI / 2 - heading);
    g.scale(scale, scale);
    g.translate(-x, -z);
    for (const b of this.blocks) {
      g.fillStyle = b.kind === 'park' ? 'rgba(30,70,45,0.95)' : b.kind === 'lot' ? 'rgba(70,40,90,0.9)' : 'rgba(12,12,20,0.95)';
      g.fillRect(b.x0, b.z0, b.x1 - b.x0, b.z1 - b.z0);
    }
    g.fillStyle = '#9aa3b8';
    for (const p of traffic) g.fillRect(p.x - 2.5, p.z - 2.5, 5, 5);
    g.restore();

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
