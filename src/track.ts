import * as THREE from 'three';

// Test circuit centerline (x, z). Starts on the main straight heading +X.
const CONTROL_POINTS: [number, number][] = [
  [0, 0], [150, 0], [235, -35], [260, -115], [215, -190], [140, -205], [85, -165],
  [25, -195], [-45, -255], [-145, -250], [-225, -185], [-255, -95], [-225, -25], [-150, 0],
];

export const ROAD_HALF_WIDTH = 8;
const SAMPLE_SPACING = 2; // meters between centerline samples
const ROAD_Y = 0.02; // visual only; the physics ground is flat at y = 0
const OFFROAD_MARGIN = 0.8;

export class Track {
  readonly samples: THREE.Vector3[] = [];
  readonly tangents: THREE.Vector3[] = [];
  readonly length: number;

  constructor(scene: THREE.Scene) {
    const curve = new THREE.CatmullRomCurve3(
      CONTROL_POINTS.map(([x, z]) => new THREE.Vector3(x, 0, z)),
      true,
      'centripetal',
    );
    this.length = curve.getLength();
    const n = Math.round(this.length / SAMPLE_SPACING);
    for (let i = 0; i < n; i++) {
      this.samples.push(curve.getPointAt(i / n));
      this.tangents.push(curve.getTangentAt(i / n));
    }
    scene.add(this.buildRoad(), this.buildStartLine());
  }

  /** Nearest centerline sample to a point, and the horizontal distance to it. */
  nearest(x: number, z: number): { index: number; lateral: number } {
    let best = 0;
    let bestD2 = Infinity;
    for (let i = 0; i < this.samples.length; i++) {
      const s = this.samples[i];
      const d2 = (s.x - x) ** 2 + (s.z - z) ** 2;
      if (d2 < bestD2) {
        bestD2 = d2;
        best = i;
      }
    }
    return { index: best, lateral: Math.sqrt(bestD2) };
  }

  isOffroad(lateral: number): boolean {
    return lateral > ROAD_HALF_WIDTH + OFFROAD_MARGIN;
  }

  /** A spawn pose on the centerline, facing along the track. */
  spawnAt(index: number): { position: THREE.Vector3; yaw: number } {
    const p = this.samples[index];
    const t = this.tangents[index];
    return { position: new THREE.Vector3(p.x, 1.2, p.z), yaw: Math.atan2(-t.z, t.x) };
  }

  /** Sample indices at the sharpest corners, and which side (+1 right / -1 left) is the inside. */
  apexes(minTurn = 0.25, minGap = 40): { index: number; inside: number }[] {
    const n = this.samples.length;
    const turn = this.samples.map((_, i) => {
      const a = this.tangents[(i - 6 + n) % n];
      const b = this.tangents[(i + 6) % n];
      return a.x * b.z - a.z * b.x; // + = turning right
    });
    const picks: { index: number; inside: number }[] = [];
    const order = [...turn.keys()].sort((i, j) => Math.abs(turn[j]) - Math.abs(turn[i]));
    for (const i of order) {
      if (Math.abs(turn[i]) < minTurn) break;
      const gap = (j: number) => Math.min(Math.abs(i - j), n - Math.abs(i - j));
      if (picks.every((p) => gap(p.index) >= minGap)) picks.push({ index: i, inside: Math.sign(turn[i]) });
    }
    return picks;
  }

  /** Right-hand side direction at a sample (tangent × up). */
  sideAt(index: number, target = new THREE.Vector3()): THREE.Vector3 {
    const t = this.tangents[index];
    return target.set(-t.z, 0, t.x);
  }

  private buildRoad(): THREE.Mesh {
    const n = this.samples.length;
    const positions: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];
    const side = new THREE.Vector3();
    let distance = 0;
    for (let i = 0; i <= n; i++) {
      const p = this.samples[i % n];
      if (i > 0) distance += p.distanceTo(this.samples[i - 1]);
      this.sideAt(i % n, side).multiplyScalar(ROAD_HALF_WIDTH);
      positions.push(p.x - side.x, ROAD_Y, p.z - side.z, p.x + side.x, ROAD_Y, p.z + side.z);
      uvs.push(0, distance / 16, 1, distance / 16);
      if (i < n) {
        const a = i * 2;
        indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(
      geo,
      new THREE.MeshStandardMaterial({ map: roadTexture(), roughness: 0.92, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4 }),
    );
    mesh.receiveShadow = true;
    return mesh;
  }

  private buildStartLine(): THREE.Mesh {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 8;
    const g = canvas.getContext('2d')!;
    for (let x = 0; x < 16; x++) {
      for (let y = 0; y < 2; y++) {
        g.fillStyle = (x + y) % 2 ? '#111' : '#eee';
        g.fillRect(x * 4, y * 4, 4, 4);
      }
    }
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.magFilter = THREE.NearestFilter;
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(ROAD_HALF_WIDTH * 2, 2).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ map: tex, roughness: 0.8 }),
    );
    const { position, yaw } = this.spawnAt(0);
    mesh.position.set(position.x, ROAD_Y + 0.005, position.z);
    mesh.rotation.y = yaw + Math.PI / 2; // plane's width runs across the road
    mesh.receiveShadow = true;
    return mesh;
  }
}

function roadTexture(): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#3a3d42';
  g.fillRect(0, 0, size, size);
  for (let i = 0; i < 4000; i++) {
    const v = 50 + Math.random() * 30;
    g.fillStyle = `rgb(${v},${v},${v + 4})`;
    g.fillRect(Math.random() * size, Math.random() * size, 1.5, 1.5);
  }
  g.fillStyle = '#e8e8e8';
  g.fillRect(6, 0, 7, size); // edge lines
  g.fillRect(size - 13, 0, 7, size);
  g.fillStyle = '#f2c94c';
  g.fillRect(size / 2 - 3, 0, 6, size / 2); // dashed center line, one dash per 16 m
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  return tex;
}
