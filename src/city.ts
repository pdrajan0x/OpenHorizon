import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { adTexture, facadeTextures, NEON_COLORS, radialTexture, SIGN_TEXTS, signTexture } from './neon';
import { mulberry32, pick } from './random';

// --- Layout: a square grid of blocks separated by four-lane streets, driving on the right ---
export const BLOCKS = 10;
export const BLOCK = 76; // block footprint including sidewalks
export const ROAD = 16; // curb to curb: two lanes each way around a 2 m median
export const PITCH = BLOCK + ROAD; // street centerline spacing
export const HALF = (BLOCKS * PITCH + ROAD) / 2; // outer curb of the edge streets
export const LANES = [2.75, 6.25] as const; // lane centers, meters right of the street centerline
export const CURB = 0.15;
const SIDEWALK = 5;
const WINDOW_REPEAT = 25.6; // meters of facade per texture tile horizontally (16 windows)
const FLOOR_REPEAT = 27.2; // and vertically (8 floors)
const LIGHT_POOL = 15; // street light pool diameter on the road

/** Centerline coordinate of street k (0..BLOCKS), same for both axes. */
export function streetAt(k: number): number {
  return -HALF + ROAD / 2 + k * PITCH;
}

/**
 * A pose on the nearest street, in the right-hand outer lane of whichever direction is closest to
 * `heading` (radians, atan2(forward.z, forward.x)). Used to put a stuck car back on the road.
 */
export function roadPose(x: number, z: number, heading: number): { position: THREE.Vector3; yaw: number } {
  const nearest = (c: number) => streetAt(THREE.MathUtils.clamp(Math.round((c - streetAt(0)) / PITCH), 0, BLOCKS));
  const sx = nearest(x); // street running along z
  const sz = nearest(z); // street running along x
  if (Math.abs(z - sz) <= Math.abs(x - sx)) {
    const dir = Math.cos(heading) >= 0 ? 1 : -1;
    return { position: new THREE.Vector3(x, 0.3, sz + dir * LANES[1]), yaw: dir > 0 ? 0 : Math.PI };
  }
  const dir = Math.sin(heading) >= 0 ? 1 : -1;
  return { position: new THREE.Vector3(sx - dir * LANES[1], 0.3, z), yaw: -dir * (Math.PI / 2) };
}

// A 2×2-block open lot (the drift meet): streets 7..9 along x, 1..3 along z. The street segments
// inside it are closed to traffic and have no furniture.
const LOT = new Set(['7,1', '8,1', '7,2', '8,2']);
const LOT_X = [7, 9];
const LOT_Z = [1, 3];
export const LOT_CENTER = new THREE.Vector3(streetAt(8), 0, streetAt(2));

/** True if the street segment between cross streets `a` and `b` (adjacent), on street `street`, lies inside the lot. */
export function isLotSegment(axis: 0 | 1, street: number, a: number, b: number): boolean {
  const [along, across] = axis === 0 ? [LOT_X, LOT_Z] : [LOT_Z, LOT_X];
  return street > across[0] && street < across[1] && Math.min(a, b) >= along[0] && Math.max(a, b) <= along[1];
}

function inLot(x: number, z: number): boolean {
  return x > streetAt(LOT_X[0]) + ROAD / 2 - 2 && x < streetAt(LOT_X[1]) - ROAD / 2 + 2
    && z > streetAt(LOT_Z[0]) + ROAD / 2 - 2 && z < streetAt(LOT_Z[1]) - ROAD / 2 + 2;
}

// --- Traffic signals ---
const SIGNAL_CYCLE = 22;
export type Signal = 'green' | 'yellow' | 'red';
/** Signal shown at intersection (ix, iz) to traffic moving along `axis` (0 = x, 1 = z). */
export function signalAt(ix: number, iz: number, axis: 0 | 1, time: number): Signal {
  const t = (time + ((ix + iz) % 4) * 5.5) % SIGNAL_CYCLE;
  const xPhase: Signal = t < 9 ? 'green' : t < 11 ? 'yellow' : 'red';
  const zPhase: Signal = t < 11 ? 'red' : t < 20 ? 'green' : t < 22 ? 'yellow' : 'red';
  return axis === 0 ? xPhase : zPhase;
}

export interface BlockInfo {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  kind: 'buildings' | 'park' | 'lot';
}

interface Wall {
  ax: number; az: number; bx: number; bz: number; nx: number; nz: number; y0: number; y1: number; street: boolean;
}

export class City {
  readonly blocks: BlockInfo[] = [];
  private readonly lamps: THREE.InstancedMesh;
  private readonly lampInfo: { ix: number; iz: number; axis: 0 | 1; color: Signal }[] = [];
  private readonly lampState: (Signal | null)[] = [];
  private readonly blink = new THREE.MeshBasicMaterial({ color: 0xff2020 });
  private readonly flicker: THREE.MeshBasicMaterial[] = [];
  private readonly ads: THREE.MeshBasicMaterial[] = [];

  constructor(scene: THREE.Scene, world: RAPIER.World) {
    const rng = mulberry32(2077);
    scene.add(this.ground());
    world.createCollider(RAPIER.ColliderDesc.cuboid(HALF + 600, 1, HALF + 600).setTranslation(0, -1, 0).setFriction(0.9));

    const facade = new BoxBuilder();
    const walls: Wall[] = [];
    const slabs: THREE.BufferGeometry[] = [];
    const parks: THREE.BufferGeometry[] = [];
    const trees: THREE.Vector3[] = [];
    const antennas: THREE.Vector3[] = [];
    const roofTrim: { x: number; y: number; z: number; len: number; yaw: number; color: THREE.Color }[] = [];

    for (let i = 0; i < BLOCKS; i++) {
      for (let j = 0; j < BLOCKS; j++) {
        const x0 = streetAt(i) + ROAD / 2;
        const x1 = streetAt(i + 1) - ROAD / 2;
        const z0 = streetAt(j) + ROAD / 2;
        const z1 = streetAt(j + 1) - ROAD / 2;
        const cx = (x0 + x1) / 2;
        const cz = (z0 + z1) / 2;
        const central = Math.abs(i - 4.5) < 1 && Math.abs(j - 4.5) < 1;
        const kind: BlockInfo['kind'] = LOT.has(`${i},${j}`) ? 'lot' : !central && rng() < 0.07 ? 'park' : 'buildings';
        this.blocks.push({ x0, z0, x1, z1, kind });
        if (kind === 'lot') continue;

        const slab = new THREE.BoxGeometry(BLOCK, CURB, BLOCK).translate(cx, CURB / 2, cz);
        (kind === 'park' ? parks : slabs).push(slab);
        world.createCollider(RAPIER.ColliderDesc.cuboid(BLOCK / 2, CURB / 2, BLOCK / 2).setTranslation(cx, CURB / 2, cz));
        if (kind === 'park') {
          for (let k = 0; k < 14; k++) trees.push(new THREE.Vector3(x0 + 8 + rng() * (BLOCK - 16), CURB, z0 + 8 + rng() * (BLOCK - 16)));
          continue;
        }

        // Split the block interior into lots with narrow alleys between them
        const ix0 = x0 + SIDEWALK;
        const ix1 = x1 - SIDEWALK;
        const iz0 = z0 + SIDEWALK;
        const iz1 = z1 - SIDEWALK;
        const midX = (ix0 + ix1) / 2;
        const midZ = (iz0 + iz1) / 2;
        const r = rng();
        const lots: [number, number, number, number][] =
          r < 0.25 ? [[ix0, ix1, iz0, iz1]]
          : r < 0.6 ? (rng() < 0.5
            ? [[ix0, midX - 1, iz0, iz1], [midX + 1, ix1, iz0, iz1]]
            : [[ix0, ix1, iz0, midZ - 1], [ix0, ix1, midZ + 1, iz1]])
          : [[ix0, midX - 1, iz0, midZ - 1], [midX + 1, ix1, iz0, midZ - 1], [ix0, midX - 1, midZ + 1, iz1], [midX + 1, ix1, midZ + 1, iz1]];

        const centerFactor = 1 - smooth(60, HALF * 0.95, Math.hypot(cx, cz));
        for (const [lx0, lx1, lz0, lz1] of lots) {
          const inset = rng() * 1.5;
          const bx0 = lx0 + inset;
          const bx1 = lx1 - inset;
          const bz0 = lz0 + inset;
          const bz1 = lz1 - inset;
          const height = Math.max(14, (22 + 200 * centerFactor ** 2) * (0.5 + rng() * 0.9));
          const tint = new THREE.Color(pick(rng, [0x9aa0ad, 0x6d86b8, 0xb5a28f, 0x5f8a8a, 0x8a7fa0, 0xc0c4cc]));
          const baseTop = height > 70 && rng() < 0.6 ? height * (0.55 + rng() * 0.2) : height;
          facade.box(bx0, bx1, CURB, baseTop, bz0, bz1, tint, rng);
          world.createCollider(
            RAPIER.ColliderDesc.cuboid((bx1 - bx0) / 2, baseTop / 2, (bz1 - bz0) / 2).setTranslation((bx0 + bx1) / 2, baseTop / 2, (bz0 + bz1) / 2),
          );
          const near = 3.5 + inset;
          walls.push(
            { ax: bx0, az: bz1, bx: bx1, bz: bz1, nx: 0, nz: 1, y0: CURB, y1: baseTop, street: bz1 > z1 - SIDEWALK - near },
            { ax: bx1, az: bz0, bx: bx0, bz: bz0, nx: 0, nz: -1, y0: CURB, y1: baseTop, street: bz0 < z0 + SIDEWALK + near },
            { ax: bx1, az: bz1, bx: bx1, bz: bz0, nx: 1, nz: 0, y0: CURB, y1: baseTop, street: bx1 > x1 - SIDEWALK - near },
            { ax: bx0, az: bz0, bx: bx0, bz: bz1, nx: -1, nz: 0, y0: CURB, y1: baseTop, street: bx0 < x0 + SIDEWALK + near },
          );

          let top = baseTop;
          let tx0 = bx0;
          let tx1 = bx1;
          let tz0 = bz0;
          let tz1 = bz1;
          while (top < height - 1) {
            // Setback tiers
            const shrinkX = (tx1 - tx0) * (0.1 + rng() * 0.12);
            const shrinkZ = (tz1 - tz0) * (0.1 + rng() * 0.12);
            tx0 += shrinkX;
            tx1 -= shrinkX;
            tz0 += shrinkZ;
            tz1 -= shrinkZ;
            const next = Math.min(height, top + (height - baseTop) * (0.5 + rng() * 0.5));
            facade.box(tx0, tx1, top, next, tz0, tz1, tint, rng);
            top = next;
          }
          if (height > 90) antennas.push(new THREE.Vector3((tx0 + tx1) / 2, top, (tz0 + tz1) / 2));
          if (height > 40 && rng() < 0.35) {
            const color = new THREE.Color(pick(rng, NEON_COLORS)).multiplyScalar(2.5);
            roofTrim.push(
              { x: (tx0 + tx1) / 2, y: top, z: tz0, len: tx1 - tx0, yaw: 0, color },
              { x: (tx0 + tx1) / 2, y: top, z: tz1, len: tx1 - tx0, yaw: 0, color },
              { x: tx0, y: top, z: (tz0 + tz1) / 2, len: tz1 - tz0, yaw: Math.PI / 2, color },
              { x: tx1, y: top, z: (tz0 + tz1) / 2, len: tz1 - tz0, yaw: Math.PI / 2, color },
            );
          }
        }
      }
    }

    this.boundary(facade, world, rng);
    const { map, emissive } = facadeTextures();
    const buildings = new THREE.Mesh(
      facade.geometry(),
      new THREE.MeshStandardMaterial({
        map, emissiveMap: emissive, emissive: 0xffffff, emissiveIntensity: 1.35, vertexColors: true, roughness: 0.55, metalness: 0.35,
      }),
    );
    scene.add(buildings);

    scene.add(new THREE.Mesh(mergeGeometries(slabs), new THREE.MeshStandardMaterial({ map: sidewalkTexture(), roughness: 0.45, metalness: 0.1 })));
    if (parks.length) scene.add(new THREE.Mesh(mergeGeometries(parks), new THREE.MeshStandardMaterial({ color: 0x1f3a24, roughness: 0.9 })));
    this.addTrees(scene, world, trees);
    this.addStorefronts(scene, walls, rng);
    this.addSigns(scene, walls, rng);
    this.addRoofDetails(scene, antennas, roofTrim);
    this.addStreetLights(scene, world, rng);
    this.lamps = this.addSignals(scene, world);
  }

  /** Signals, blinking antenna lights, flickering signs and cycling ad screens. */
  update(time: number): void {
    const colors: Record<Signal, THREE.Color> = {
      red: new THREE.Color(0xff1a1a).multiplyScalar(4),
      yellow: new THREE.Color(0xffb000).multiplyScalar(4),
      green: new THREE.Color(0x19ff8c).multiplyScalar(4),
    };
    const off = new THREE.Color(0x0a0a0a);
    let changed = false;
    this.lampInfo.forEach((lamp, k) => {
      const state = signalAt(lamp.ix, lamp.iz, lamp.axis, time);
      if (this.lampState[k] === state) return;
      this.lampState[k] = state;
      this.lamps.setColorAt(k, state === lamp.color ? colors[lamp.color] : off);
      changed = true;
    });
    if (changed && this.lamps.instanceColor) this.lamps.instanceColor.needsUpdate = true;

    this.blink.color.setHex(time % 1.2 < 0.25 ? 0xff2020 : 0x200000).multiplyScalar(3);
    for (const [k, m] of this.flicker.entries()) {
      const on = Math.sin(time * (7 + k * 3.1)) + Math.sin(time * (13 + k)) > -1.2;
      m.color.setScalar(on ? 1.8 : 0.25);
    }
    this.ads.forEach((m, k) => m.color.setHSL((time * 0.05 + k * 0.17) % 1, 0.7, 0.6).multiplyScalar(1.6));
  }

  private ground(): THREE.Mesh {
    const size = HALF * 2 + 1200;
    const geo = new THREE.PlaneGeometry(size, size).rotateX(-Math.PI / 2);
    // One texture tile per street pitch, aligned so every tile starts with a street
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const uv = geo.attributes.uv as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) uv.setXY(i, (pos.getX(i) + HALF) / PITCH, (pos.getZ(i) + HALF) / PITCH);
    const mesh = new THREE.Mesh(
      geo,
      new THREE.MeshStandardMaterial({ map: roadTexture(), roughnessMap: puddleTexture(), roughness: 1, metalness: 0.2, envMapIntensity: 0.55 }),
    );
    return mesh;
  }

  private addTrees(scene: THREE.Scene, world: RAPIER.World, spots: THREE.Vector3[]): void {
    if (!spots.length) return;
    const trunks = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.2, 0.3, 3, 6).translate(0, 1.5, 0), new THREE.MeshStandardMaterial({ color: 0x3a2a20 }), spots.length);
    const tops = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(2.4, 0).translate(0, 4.2, 0), new THREE.MeshStandardMaterial({ color: 0x1f4a2a, flatShading: true }), spots.length);
    const m = new THREE.Matrix4();
    spots.forEach((p, k) => {
      m.makeTranslation(p.x, p.y, p.z);
      trunks.setMatrixAt(k, m);
      tops.setMatrixAt(k, m);
      world.createCollider(RAPIER.ColliderDesc.cylinder(1.5, 0.3).setTranslation(p.x, p.y + 1.5, p.z));
    });
    scene.add(trunks, tops);
  }

  /** Glowing storefront bands at street level. */
  private addStorefronts(scene: THREE.Scene, walls: Wall[], rng: () => number): void {
    const bands = walls.filter((w) => w.street && rng() < 0.65);
    const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 0.35, 0.08), new THREE.MeshBasicMaterial(), bands.length);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    bands.forEach((w, k) => {
      const len = Math.hypot(w.bx - w.ax, w.bz - w.az) - 1;
      q.setFromAxisAngle(up, Math.atan2(w.nx, w.nz));
      m.compose(
        new THREE.Vector3((w.ax + w.bx) / 2 + w.nx * 0.08, 4.2, (w.az + w.bz) / 2 + w.nz * 0.08),
        q,
        new THREE.Vector3(len, 1, 1),
      );
      mesh.setMatrixAt(k, m);
      mesh.setColorAt(k, new THREE.Color(pick(rng, NEON_COLORS)).multiplyScalar(1.3));
    });
    scene.add(mesh);
  }

  /** Horizontal shop signs and vertical blade signs on street-facing walls; ad screens up high. */
  private addSigns(scene: THREE.Scene, walls: Wall[], rng: () => number): void {
    const kinds = SIGN_TEXTS.flatMap((text) => [
      { text, vertical: false, color: pick(rng, NEON_COLORS) },
      { text, vertical: true, color: pick(rng, NEON_COLORS) },
    ]);
    const placements: THREE.Matrix4[][] = kinds.map(() => []);
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    for (const w of walls) {
      if (!w.street) continue;
      const len = Math.hypot(w.bx - w.ax, w.bz - w.az);
      const along = new THREE.Vector3((w.bx - w.ax) / len, 0, (w.bz - w.az) / len);
      const facing = Math.atan2(w.nx, w.nz);
      if (rng() < 0.55) {
        const width = Math.min(len * 0.6, 7 + rng() * 4);
        const t = 0.2 + rng() * 0.6;
        const k = 2 * Math.floor(rng() * SIGN_TEXTS.length);
        q.setFromAxisAngle(up, facing);
        placements[k].push(new THREE.Matrix4().compose(
          new THREE.Vector3(w.ax + (w.bx - w.ax) * t + w.nx * 0.15, 5.6 + rng() * 2.5, w.az + (w.bz - w.az) * t + w.nz * 0.15),
          q,
          new THREE.Vector3(width, width / 4, 1),
        ));
      }
      if (rng() < 0.4 && w.y1 > 22) {
        const k = 2 * Math.floor(rng() * SIGN_TEXTS.length) + 1;
        const end = rng() < 0.5 ? 1.2 : len - 1.2;
        q.setFromAxisAngle(up, facing + Math.PI / 2); // blade sticks out from the wall
        placements[k].push(new THREE.Matrix4().compose(
          new THREE.Vector3(w.ax + along.x * end + w.nx * 1.1, 10 + rng() * Math.min(18, w.y1 - 20), w.az + along.z * end + w.nz * 1.1),
          q,
          new THREE.Vector3(1.8, 7.2, 1),
        ));
      }
    }
    const plane = new THREE.PlaneGeometry(1, 1);
    kinds.forEach((kind, k) => {
      if (!placements[k].length) return;
      const material = new THREE.MeshBasicMaterial({
        map: signTexture(kind.text, kind.color, kind.vertical), color: new THREE.Color(1.8, 1.8, 1.8), transparent: true, side: THREE.DoubleSide,
      });
      if (this.flicker.length < 4 && rng() < 0.3) this.flicker.push(material);
      const mesh = new THREE.InstancedMesh(plane, material, placements[k].length);
      placements[k].forEach((m, n) => mesh.setMatrixAt(n, m));
      scene.add(mesh);
    });

    // Big ad screens near the top of the tallest street-facing walls
    const tall = walls.filter((w) => w.street && w.y1 > 90).sort((a, b) => b.y1 - a.y1).slice(0, 14);
    for (const [k, w] of tall.entries()) {
      const len = Math.hypot(w.bx - w.ax, w.bz - w.az);
      const width = Math.min(len * 0.8, 34);
      const material = new THREE.MeshBasicMaterial({ map: adTexture(SIGN_TEXTS[(k * 5) % SIGN_TEXTS.length]), transparent: true });
      this.ads.push(material);
      const ad = new THREE.Mesh(plane, material);
      ad.position.set((w.ax + w.bx) / 2 + w.nx * 0.3, w.y1 - width * 0.35 - 4, (w.az + w.bz) / 2 + w.nz * 0.3);
      ad.rotation.y = Math.atan2(w.nx, w.nz);
      ad.scale.set(width, width * 0.5, 1);
      scene.add(ad);
    }
  }

  private addRoofDetails(
    scene: THREE.Scene,
    antennas: THREE.Vector3[],
    trim: { x: number; y: number; z: number; len: number; yaw: number; color: THREE.Color }[],
  ): void {
    const masts = new THREE.InstancedMesh(new THREE.BoxGeometry(0.4, 14, 0.4).translate(0, 7, 0), new THREE.MeshStandardMaterial({ color: 0x222228 }), antennas.length);
    const tips = new THREE.InstancedMesh(new THREE.BoxGeometry(0.7, 0.7, 0.7).translate(0, 14.3, 0), this.blink, antennas.length);
    const m = new THREE.Matrix4();
    antennas.forEach((p, k) => {
      m.makeTranslation(p.x, p.y, p.z);
      masts.setMatrixAt(k, m);
      tips.setMatrixAt(k, m);
    });
    const strips = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 0.3, 0.3), new THREE.MeshBasicMaterial(), Math.max(1, trim.length));
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    trim.forEach((t, k) => {
      strips.setMatrixAt(k, m.compose(new THREE.Vector3(t.x, t.y + 0.15, t.z), q.setFromAxisAngle(up, t.yaw), new THREE.Vector3(t.len, 1, 1)));
      strips.setColorAt(k, t.color);
    });
    strips.count = trim.length;
    scene.add(masts, tips, strips);
  }

  /** Poles along both curbs of every street, with fake light pools on the road below each head. */
  private addStreetLights(scene: THREE.Scene, world: RAPIER.World, rng: () => number): void {
    const spots: { x: number; z: number; yaw: number; warm: boolean }[] = [];
    for (const axis of [0, 1]) {
      for (let s = 0; s <= BLOCKS; s++) {
        const warm = rng() < 0.6;
        for (let seg = 0; seg < BLOCKS; seg++) {
          for (const f of [0.25, 0.5, 0.75]) {
            const along = streetAt(seg) + PITCH * f;
            for (const side of [-1, 1]) {
              const across = streetAt(s) + side * (ROAD / 2 + 0.8);
              // The arm (local +z) reaches back over the road
              const yaw = axis === 0 ? (side > 0 ? Math.PI : 0) : side > 0 ? -Math.PI / 2 : Math.PI / 2;
              const spot = axis === 0 ? { x: along, z: across, yaw, warm } : { x: across, z: along, yaw, warm };
              if (!inLot(spot.x, spot.z)) spots.push(spot);
            }
          }
        }
      }
    }
    const n = spots.length;
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x2a2c33, metalness: 0.6, roughness: 0.5 });
    const poles = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.09, 0.13, 8, 6).translate(0, 4, 0), poleMat, n);
    const arms = new THREE.InstancedMesh(new THREE.BoxGeometry(0.1, 0.1, 2.2).translate(0, 7.9, 1.1), poleMat, n);
    const heads = new THREE.InstancedMesh(new THREE.BoxGeometry(0.35, 0.12, 0.9).translate(0, 7.82, 2.1), new THREE.MeshBasicMaterial(), n);
    const pools = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(LIGHT_POOL, LIGHT_POOL).rotateX(-Math.PI / 2).translate(0, 0.02, 3.5),
      new THREE.MeshBasicMaterial({ map: radialTexture(), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }),
      n,
    );
    const warmHead = new THREE.Color(1, 0.72, 0.4).multiplyScalar(3);
    const coolHead = new THREE.Color(0.75, 0.88, 1).multiplyScalar(3);
    const warmPool = new THREE.Color(1, 0.65, 0.35).multiplyScalar(0.16);
    const coolPool = new THREE.Color(0.6, 0.75, 1).multiplyScalar(0.15);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const one = new THREE.Vector3(1, 1, 1);
    spots.forEach((s, k) => {
      m.compose(new THREE.Vector3(s.x, CURB, s.z), q.setFromAxisAngle(up, s.yaw), one);
      poles.setMatrixAt(k, m);
      arms.setMatrixAt(k, m);
      heads.setMatrixAt(k, m);
      heads.setColorAt(k, s.warm ? warmHead : coolHead);
      pools.setMatrixAt(k, m.compose(new THREE.Vector3(s.x, 0, s.z), q, one));
      pools.setColorAt(k, s.warm ? warmPool : coolPool);
      world.createCollider(RAPIER.ColliderDesc.cylinder(4, 0.15).setTranslation(s.x, CURB + 4, s.z));
    });
    scene.add(poles, arms, heads, pools);
  }

  /** A signal head for every approach to every intersection: red, amber and green lamps. */
  private addSignals(scene: THREE.Scene, world: RAPIER.World): THREE.InstancedMesh {
    const heads: { x: number; z: number; yaw: number }[] = [];
    for (let ix = 0; ix <= BLOCKS; ix++) {
      for (let iz = 0; iz <= BLOCKS; iz++) {
        for (const axis of [0, 1] as const) {
          for (const dir of [1, -1]) {
            const k = axis === 0 ? ix : iz;
            if (k - dir < 0 || k - dir > BLOCKS) continue; // no street leading into this side
            if (isLotSegment(axis, axis === 0 ? iz : ix, k - dir, k)) continue;
            const fx = axis === 0 ? dir : 0;
            const fz = axis === 1 ? dir : 0;
            const rx = -fz; // right of travel
            const rz = fx;
            const c = ROAD / 2 + 1.2;
            heads.push({ x: streetAt(ix) - fx * c + rx * c, z: streetAt(iz) - fz * c + rz * c, yaw: Math.atan2(-fx, -fz) });
            for (const color of ['red', 'yellow', 'green'] as const) this.lampInfo.push({ ix, iz, axis, color });
          }
        }
      }
    }
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x1c1d22, metalness: 0.5, roughness: 0.6 });
    const poles = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.1, 0.12, 6, 6).translate(0, 3, 0), poleMat, heads.length);
    const boxes = new THREE.InstancedMesh(new THREE.BoxGeometry(0.45, 1.3, 0.35).translate(0, 5.6, 0), poleMat, heads.length);
    const lamps = new THREE.InstancedMesh(new THREE.BoxGeometry(0.28, 0.28, 0.06), new THREE.MeshBasicMaterial(), heads.length * 3);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const one = new THREE.Vector3(1, 1, 1);
    const offsets = [6.0, 5.6, 5.2]; // red on top
    heads.forEach((h, k) => {
      q.setFromAxisAngle(up, h.yaw);
      m.compose(new THREE.Vector3(h.x, CURB, h.z), q, one);
      poles.setMatrixAt(k, m);
      boxes.setMatrixAt(k, m);
      const front = new THREE.Vector3(0, 0, 0.19).applyQuaternion(q);
      offsets.forEach((y, n) => lamps.setMatrixAt(k * 3 + n, m.compose(new THREE.Vector3(h.x + front.x, CURB + y, h.z + front.z), q, one)));
      world.createCollider(RAPIER.ColliderDesc.cylinder(3, 0.15).setTranslation(h.x, CURB + 3, h.z));
    });
    for (let k = 0; k < lamps.count; k++) lamps.setColorAt(k, new THREE.Color(0x0a0a0a));
    scene.add(poles, boxes, lamps);
    return lamps;
  }

  /** Continuous wall of towers around the city edge, and a hazy skyline beyond it. */
  private boundary(facade: BoxBuilder, world: RAPIER.World, rng: () => number): void {
    const edge = HALF + 3;
    const depth = 40;
    const tint = new THREE.Color(0x7a7f8c);
    const sides: [number, number, number, number][] = [
      [-edge - depth, edge + depth, edge, edge + depth],
      [-edge - depth, edge + depth, -edge - depth, -edge],
      [edge, edge + depth, -edge, edge],
      [-edge - depth, -edge, -edge, edge],
    ];
    for (const [x0, x1, z0, z1] of sides) {
      // Break each side into towers of varying height
      const alongX = x1 - x0 > z1 - z0;
      const len = alongX ? x1 - x0 : z1 - z0;
      for (let a = 0; a < len; ) {
        const w = 30 + rng() * 40;
        const b = Math.min(len, a + w);
        const h = 50 + rng() * 90;
        if (alongX) facade.box(x0 + a, x0 + b, 0, h, z0, z1, tint, rng);
        else facade.box(x0, x1, 0, h, z0 + a, z0 + b, tint, rng);
        a = b;
      }
      world.createCollider(RAPIER.ColliderDesc.cuboid((x1 - x0) / 2, 60, (z1 - z0) / 2).setTranslation((x0 + x1) / 2, 60, (z0 + z1) / 2));
    }
    for (let k = 0; k < 110; k++) {
      const angle = rng() * Math.PI * 2;
      const dist = HALF + 90 + rng() * 450;
      const x = Math.cos(angle) * dist;
      const z = Math.sin(angle) * dist;
      const w = 30 + rng() * 70;
      const h = 70 + rng() * 260;
      facade.box(x - w / 2, x + w / 2, 0, h, z - w / 2, z + w / 2, tint, rng);
    }
  }
}

/** Accumulates axis-aligned buildings into one geometry with facade UVs in meters and a tint per building. */
class BoxBuilder {
  private readonly pos: number[] = [];
  private readonly nrm: number[] = [];
  private readonly uv: number[] = [];
  private readonly col: number[] = [];
  private readonly idx: number[] = [];

  box(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, tint: THREE.Color, rng: () => number): void {
    // Wall corners listed left → right as seen from outside
    const walls: [number, number, number, number, number, number][] = [
      [x0, z1, x1, z1, 0, 1],
      [x1, z0, x0, z0, 0, -1],
      [x1, z1, x1, z0, 1, 0],
      [x0, z0, x0, z1, -1, 0],
    ];
    for (const [ax, az, bx, bz, nx, nz] of walls) {
      const len = Math.hypot(bx - ax, bz - az);
      const u0 = Math.floor(rng() * 8) / 8;
      const v0 = Math.floor(rng() * 8) / 8;
      this.quad(
        [ax, y0, az, bx, y0, bz, bx, y1, bz, ax, y1, az],
        [nx, 0, nz],
        [u0, v0 + y0 / FLOOR_REPEAT, u0 + len / WINDOW_REPEAT, v0 + y0 / FLOOR_REPEAT, u0 + len / WINDOW_REPEAT, v0 + y1 / FLOOR_REPEAT, u0, v0 + y1 / FLOOR_REPEAT],
        tint,
      );
    }
    // Roof samples the bare facade corner of the texture
    const r = 0.004;
    this.quad([x0, y1, z0, x0, y1, z1, x1, y1, z1, x1, y1, z0], [0, 1, 0], [r, r, r, r, r, r, r, r], tint.clone().multiplyScalar(0.5));
  }

  geometry(): THREE.BufferGeometry {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    geo.setIndex(this.idx);
    return geo;
  }

  private quad(p: number[], n: number[], uv: number[], c: THREE.Color): void {
    const base = this.pos.length / 3;
    this.pos.push(...p);
    this.uv.push(...uv);
    for (let k = 0; k < 4; k++) {
      this.nrm.push(...n);
      this.col.push(c.r, c.g, c.b);
    }
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
}

/** One street pitch of asphalt: a street along each axis with lane markings, crosswalks and stop lines. */
function roadTexture(): THREE.CanvasTexture {
  const px = 1024;
  const s = px / PITCH;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = px;
  const g = canvas.getContext('2d')!;
  // Draw in local meters with z growing up the texture (canvas rows are flipped on upload)
  const rect = (x: number, z: number, w: number, h: number) => g.fillRect(x * s, px - (z + h) * s, w * s, h * s);
  g.fillStyle = '#131317';
  g.fillRect(0, 0, px, px);
  g.fillStyle = '#1c1d22';
  rect(0, 0, ROAD, PITCH);
  rect(0, 0, PITCH, ROAD);
  for (let i = 0; i < 9000; i++) {
    const v = 20 + Math.random() * 22;
    g.fillStyle = `rgb(${v},${v},${v + 3})`;
    g.fillRect(Math.random() * px, Math.random() * px, 2, 2);
  }
  const c = ROAD / 2;
  for (const swap of [false, true]) {
    // swap = draw the street that runs along x (by mirroring the one along z)
    const r = (a: number, b: number, w: number, h: number) => (swap ? rect(b, a, h, w) : rect(a, b, w, h));
    g.fillStyle = '#d8b52a';
    r(c - 0.3, ROAD, 0.15, PITCH - ROAD); // double yellow median lines
    r(c + 0.15, ROAD, 0.15, PITCH - ROAD);
    g.fillStyle = '#c9ccd2';
    for (let z = ROAD + 6; z < PITCH - 6; z += 9) {
      r(c - 4.55, z, 0.14, 3); // lane dividers
      r(c + 4.41, z, 0.14, 3);
    }
    for (let x = 0.8; x < ROAD - 0.6; x += 1.2) {
      r(x, ROAD + 0.4, 0.6, 3); // crosswalks at both ends of the block
      r(x, PITCH - 3.4, 0.6, 3);
    }
    // Stop lines, in the lanes approaching each intersection. Mirroring across the diagonal flips which
    // side of the road that is, so the two streets use opposite halves.
    const near = swap ? 0.4 : c;
    const far = swap ? c : 0.4;
    r(near, ROAD + 3.8, c - 0.4, 0.4);
    r(far, PITCH - 4.2, c - 0.4, 0.4);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  return tex;
}

/** Wet asphalt: mostly glossy with rougher dry patches. */
function puddleTexture(): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d')!;
  g.fillStyle = 'rgb(95,95,95)';
  g.fillRect(0, 0, size, size);
  for (let i = 0; i < 40; i++) {
    const r = 10 + Math.random() * 40;
    const grad = g.createRadialGradient(0, 0, 0, 0, 0, r);
    grad.addColorStop(0, 'rgba(20,20,20,0.9)');
    grad.addColorStop(1, 'rgba(20,20,20,0)');
    g.save();
    g.translate(Math.random() * size, Math.random() * size);
    g.fillStyle = grad;
    g.fillRect(-r, -r, 2 * r, 2 * r);
    g.restore();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

function sidewalkTexture(): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#3a3b40';
  g.fillRect(0, 0, size, size);
  g.fillStyle = '#2c2d31';
  g.fillRect(0, 0, size, 3);
  g.fillRect(0, 0, 3, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(BLOCK / 2, BLOCK / 2);
  tex.anisotropy = 8;
  return tex;
}

function smooth(edge0: number, edge1: number, x: number): number {
  const t = THREE.MathUtils.clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}
