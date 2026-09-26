#!/usr/bin/env node
// A stand-in for the mod assets, for testing without them: writes a small synthetic world in the same
// formats the converters produce into .build/test-public/mods/ (three box cities with streets, path
// nodes and collision; one box car for every garage and traffic slot; a sky, water normals and short
// sounds). Nothing here is meant to look good: it lets the game, npm run smoke and the map tools run in
// a checkout with no mods (a CI box, a cloud session).
//   node scripts/make-test-world.mjs
//   TEST_WORLD=1 npm run dev        # play it (vite.config.ts serves .build/test-public instead of public/)
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Document, NodeIO } from '@gltf-transform/core';
import sharp from 'sharp';

const OUT = '.build/test-public/mods';
const CELL = 200;

const CARS = ['lambo-huracan', 'ferrari-sf90', 'bugatti-chiron', 'lambo-centenario', 'ferrari-812', 'bugatti-divo', 'lambo-terzo', 'ferrari-fxxk', 'bugatti-bolide'];
const TRAFFIC = ['traffic-camry', 'traffic-civic', 'traffic-passat', 'traffic-prius', 'traffic-crownvic', 'traffic-landcruiser', 'traffic-f150', 'traffic-sprinter'];
const ENGINES = ['lambo-v12', 'ferrari-v8', 'hyper-v8', 'ferrari-v12'];

// Cities: extent along x (north) and z (east), ground height, and optional features
const CITIES = [
  { id: 'testcity', name: 'Test City', area: 'grid downtown', w: 1000, d: 800, y: 3, seed: 1 },
  { id: 'highland', name: 'Highland', area: 'city on a plateau', w: 700, d: 700, y: 42, seed: 2 },
  { id: 'rivertown', name: 'River Town', area: 'two banks of a river', w: 900, d: 1000, y: 1.5, seed: 3, river: true },
];

let seed = 1;
const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// --- Maps ---

const MATERIALS = [
  { shader: 'normal', diffuse: 't_asphalt', rgb: [52, 54, 58] },
  { shader: 'normal', diffuse: 't_pavement', rgb: [150, 146, 138] },
  { shader: 'normal', diffuse: 't_grass', rgb: [70, 112, 52] },
  { shader: 'normal_spec', diffuse: 't_facade', rgb: [120, 128, 140] },
  { shader: 'normal', diffuse: 't_roof', rgb: [88, 84, 80] },
];
const [ASPHALT, PAVEMENT, GRASS, FACADE, ROOF] = [0, 1, 2, 3, 4];

function gtx(rgb, size = 8) {
  const head = Buffer.alloc(16);
  head.write('GTX1', 0);
  head.writeUInt32LE(0, 4);
  head.writeUInt16LE(size, 8);
  head.writeUInt16LE(size, 10);
  head.writeUInt16LE(1, 12);
  const px = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const n = 0.85 + rand() * 0.3;
    px.set([Math.min(255, rgb[0] * n), Math.min(255, rgb[1] * n), Math.min(255, rgb[2] * n), 255], i * 4);
  }
  return Buffer.concat([head, px]);
}

function makeCity(c) {
  seed = c.seed * 7919;
  const dir = join(OUT, 'maps', c.id);
  mkdirSync(join(dir, 'cells'), { recursive: true });
  mkdirSync(join(dir, 'col'), { recursive: true });
  mkdirSync(join(dir, 'tex'), { recursive: true });
  const x0 = -c.w / 2, x1 = c.w / 2, z0 = -c.d / 2, z1 = c.d / 2;
  const ROAD = 7; // half width
  const BLOCK = 100;
  const roadsX = []; // z positions of roads running along x
  const roadsZ = []; // x positions of roads running along z
  for (let z = z0 + 50; z < z1 - 20; z += BLOCK) roadsX.push(z);
  for (let x = x0 + 50; x < x1 - 20; x += BLOCK) roadsZ.push(x);
  const inRiver = (x) => c.river && Math.abs(x) < 60;
  const onRoad = (x, z) => roadsX.some((rz) => Math.abs(z - rz) < ROAD) || roadsZ.some((rx) => Math.abs(x - rx) < ROAD);

  const render = new Map(); // cell key → material → { p: [], n: [], uv: [], i: [] }
  const col = new Map(); // cell key → { v: [], i: [] }
  const key = (x, z) => `${Math.floor(x / CELL)},${Math.floor(z / CELL)}`;
  const tri = (m, a, b, cc, solid = true) => {
    const n = normal(a, b, cc);
    const k = key((a[0] + b[0] + cc[0]) / 3, (a[2] + b[2] + cc[2]) / 3);
    if (!render.has(k)) render.set(k, new Map());
    const cell = render.get(k);
    if (!cell.has(m)) cell.set(m, { p: [], n: [], uv: [], i: [] });
    const batch = cell.get(m);
    for (const v of [a, b, cc]) {
      batch.i.push(batch.p.length / 3);
      batch.p.push(...v);
      batch.n.push(...n);
      batch.uv.push(v[0] / 8 + v[1] / 8, v[2] / 8);
    }
    if (!solid) return;
    if (!col.has(k)) col.set(k, { v: [], i: [] });
    const cc2 = col.get(k);
    for (const v of [a, b, cc]) {
      cc2.i.push(cc2.v.length / 3);
      cc2.v.push(...v);
    }
  };
  // Quads wound so the face points along the right-hand normal of (b - a) × (d - a)
  const quad = (m, a, b, cc, d, solid) => {
    tri(m, a, b, cc, solid);
    tri(m, a, cc, d, solid);
  };

  // Ground: 10 m tiles, road / pavement / park
  const parks = new Set();
  for (let i = 0; i < 6; i++) parks.add(`${Math.floor(rand() * 10)},${Math.floor(rand() * 10)}`);
  const block = (x, z) => `${Math.floor((x - x0) / BLOCK)},${Math.floor((z - z0) / BLOCK)}`;
  const T = 10;
  for (let x = x0; x < x1; x += T) {
    for (let z = z0; z < z1; z += T) {
      const cx = x + T / 2, cz = z + T / 2;
      if (inRiver(cx) && !(roadsX[Math.floor(roadsX.length / 2)] !== undefined && Math.abs(cz - roadsX[Math.floor(roadsX.length / 2)]) < ROAD + 3)) continue;
      const m = onRoad(cx, cz) ? ASPHALT : parks.has(block(cx, cz)) ? GRASS : PAVEMENT;
      const y = c.y + (m === ASPHALT ? 0 : 0.15);
      quad(m, [x, y, z], [x, y, z + T], [x + T, y, z + T], [x + T, y, z]);
    }
  }
  // Curb faces are skipped; roads and pavement differ by 15 cm, which the wheels ride over

  // Buildings: boxes set back from the streets, none in parks or the river
  for (let bx = x0; bx < x1; bx += BLOCK) {
    for (let bz = z0; bz < z1; bz += BLOCK) {
      const cx = bx + BLOCK / 2, cz = bz + BLOCK / 2;
      if (parks.has(block(cx, cz)) || inRiver(cx) || inRiver(bx) || inRiver(bx + BLOCK)) continue;
      const lots = 1 + Math.floor(rand() * 3);
      for (let l = 0; l < lots; l++) {
        const w = 18 + rand() * 20, d = 18 + rand() * 20, h = 12 + rand() ** 2 * 110;
        const px = bx + 15 + rand() * (BLOCK - 30 - w), pz = bz + 15 + rand() * (BLOCK - 30 - d);
        if (onRoad(px, pz) || onRoad(px + w, pz + d) || onRoad(px + w, pz) || onRoad(px, pz + d)) continue;
        if (px < x0 + 5 || pz < z0 + 5 || px + w > x1 - 5 || pz + d > z1 - 5) continue;
        const y0 = c.y + 0.15, y1 = y0 + h;
        const A = [px, y0, pz], B = [px + w, y0, pz], C = [px + w, y0, pz + d], D = [px, y0, pz + d];
        const up = (p) => [p[0], y1, p[2]];
        quad(FACADE, A, up(A), up(B), B);
        quad(FACADE, B, up(B), up(C), C);
        quad(FACADE, C, up(C), up(D), D);
        quad(FACADE, D, up(D), up(A), A);
        quad(ROOF, up(A), up(D), up(C), up(B));
      }
    }
  }

  // A road bridge across the river: a deck over the gap is already in the ground tiles (the middle road)

  // Path nodes: every road crossing, plus points every 25 m between them; roads run to the city's edge
  const nodes = [];
  const index = new Map();
  const node = (x, z) => {
    const k = `${x.toFixed(1)},${z.toFixed(1)}`;
    if (!index.has(k)) {
      index.set(k, nodes.length);
      nodes.push([x, c.y, z]);
    }
    return index.get(k);
  };
  const links = [];
  const road = (points) => {
    for (let i = 0; i + 1 < points.length; i++) {
      const [ax, az] = points[i];
      const [bx, bz] = points[i + 1];
      const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 25));
      let prev = node(ax, az);
      for (let s = 1; s <= steps; s++) {
        const n = node(ax + ((bx - ax) * s) / steps, az + ((bz - az) * s) / steps);
        links.push([prev, n, 1, 1]);
        prev = n;
      }
    }
  };
  const midRoad = roadsX[Math.floor(roadsX.length / 2)];
  for (const rz of roadsX) {
    // Roads along x stop at the river, except the middle one (the bridge)
    const stops = [x0, ...roadsZ, x1].sort((a, b) => a - b);
    let run = [];
    for (const x of stops) {
      if (c.river && rz !== midRoad && Math.abs(x) < 60) continue;
      if (run.length && c.river && rz !== midRoad && Math.sign(run.at(-1)[0]) !== Math.sign(x) && Math.abs(run.at(-1)[0] - x) > 1) {
        road(run);
        run = [];
      }
      run.push([x, rz]);
    }
    road(run);
  }
  for (const rx of roadsZ) {
    if (inRiver(rx)) continue;
    road([[rx, z0], ...roadsX.map((z) => [rx, z]), [rx, z1]]);
  }
  writeFileSync(join(dir, 'roads.json'), JSON.stringify({ nodes, flags: nodes.map(() => 0), links }));

  // Cells
  const cells = [];
  const keys = [...new Set([...render.keys(), ...col.keys()])].sort();
  keys.forEach((k, id) => {
    const [kx, kz] = k.split(',').map(Number);
    const batches = render.get(k);
    let triangles = 0;
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    if (batches) {
      const header = [];
      const parts = [];
      for (const [m, b] of batches) {
        header.push({ material: m, vertices: b.p.length / 3, indices: b.i.length });
        triangles += b.i.length / 3;
        const inter = new Float32Array((b.p.length / 3) * 8);
        for (let v = 0; v < b.p.length / 3; v++) {
          inter.set([b.p[v * 3], b.p[v * 3 + 1], b.p[v * 3 + 2], b.n[v * 3], b.n[v * 3 + 1], b.n[v * 3 + 2], b.uv[v * 2], b.uv[v * 2 + 1]], v * 8);
          for (let a = 0; a < 3; a++) {
            min[a] = Math.min(min[a], b.p[v * 3 + a]);
            max[a] = Math.max(max[a], b.p[v * 3 + a]);
          }
        }
        parts.push(Buffer.from(inter.buffer), Buffer.from(new Uint32Array(b.i).buffer));
      }
      const json = Buffer.from(JSON.stringify({ batches: header }));
      const len = Buffer.alloc(4);
      len.writeUInt32LE(json.length);
      const pad = Buffer.alloc((4 - ((4 + json.length) % 4)) % 4);
      writeFileSync(join(dir, 'cells', `${id}.bin`), Buffer.concat([len, json, pad, ...parts]));
    }
    const cc = col.get(k);
    if (cc) {
      const head = Buffer.alloc(8);
      head.writeUInt32LE(cc.v.length / 3, 0);
      head.writeUInt32LE(cc.i.length, 4);
      writeFileSync(join(dir, 'col', `${id}.bin`), Buffer.concat([head, Buffer.from(new Float32Array(cc.v).buffer), Buffer.from(new Uint32Array(cc.i).buffer)]));
    }
    cells.push({
      id, x: kx * CELL, z: kz * CELL, render: !!batches, collision: !!cc, triangles,
      textures: batches ? [...batches.keys()].map((m) => MATERIALS[m].diffuse) : [],
      min: batches ? min : null, max: batches ? max : null,
    });
  });
  for (const m of MATERIALS) writeFileSync(join(dir, 'tex', `${m.diffuse}.gtx`), gtx(m.rgb));
  const centre = nodes.reduce((best, n) => (n[0] ** 2 + n[2] ** 2 < best[0] ** 2 + best[2] ** 2 ? n : best));
  const manifest = {
    origin: [0, 0, 0], cellSize: CELL, spawn: [centre[0], centre[1] + 1, centre[2]], cells,
    materials: MATERIALS.map((m) => ({ shader: m.shader, diffuse: m.diffuse, normal: null, emissive: false, blend: false, mask: false })),
    stats: { test: true, roadNodes: nodes.length },
  };
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 1));
  return { id: c.id, name: c.name, area: c.area };
}

function normal(a, b, c) {
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const l = Math.hypot(...n) || 1;
  return n.map((x) => x / l);
}

const index = CITIES.map(makeCity);
writeFileSync(join(OUT, 'maps', 'index.json'), JSON.stringify(index, null, 2));

// --- Cars: a box car in the converter's layout (named parts, wheel nodes at the hubs, extras) ---

async function makeCar() {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const mat = (name, color, extras, emissive) => {
    const m = doc.createMaterial(name).setBaseColorFactor([...color, 1]).setRoughnessFactor(0.5).setMetallicFactor(0.2);
    if (emissive) m.setEmissiveFactor(emissive);
    if (extras.glass) m.setAlphaMode('BLEND').setBaseColorFactor([...color, 0.5]);
    return m.setExtras(extras);
  };
  const paint = mat('paint', [0.8, 0.1, 0.1], { shader: 'vehicle_paint1', paint: 1 });
  const glass = mat('glass', [0.1, 0.12, 0.15], { shader: 'vehicle_vehglass', glass: true });
  const lamp = mat('lamp', [1, 1, 0.9], { shader: 'vehicle_lightsemissive', emissive: true }, [1, 1, 0.9]);
  const tail = mat('tail', [0.9, 0.05, 0.05], { shader: 'vehicle_lightsemissive', emissive: true }, [0.9, 0.05, 0.05]);
  const tire = mat('tire', [0.08, 0.08, 0.08], { shader: 'vehicle_tire', average: [0.1, 0.1, 0.1] });
  const box = (name, material, [xa, ya, za], [xb, yb, zb]) => {
    const p = [];
    const n = [];
    const idx = [];
    const face = (o, u, v, nn) => {
      const base = p.length / 3;
      p.push(...o, ...o.map((c, i) => c + u[i]), ...o.map((c, i) => c + u[i] + v[i]), ...o.map((c, i) => c + v[i]));
      for (let k = 0; k < 4; k++) n.push(...nn);
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    };
    const dx = xb - xa, dy = yb - ya, dz = zb - za;
    face([xa, ya, za], [0, dy, 0], [dx, 0, 0], [0, 0, -1]);
    face([xa, ya, zb], [dx, 0, 0], [0, dy, 0], [0, 0, 1]);
    face([xa, ya, za], [0, 0, dz], [0, dy, 0], [-1, 0, 0]);
    face([xb, ya, za], [0, dy, 0], [0, 0, dz], [1, 0, 0]);
    face([xa, yb, za], [0, 0, dz], [dx, 0, 0], [0, 1, 0]);
    face([xa, ya, za], [dx, 0, 0], [0, 0, dz], [0, -1, 0]);
    return mesh(name, material, p, n, idx);
  };
  const mesh = (name, material, p, n, idx) => {
    const prim = doc.createPrimitive()
      .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(new Float32Array(p)).setBuffer(buffer))
      .setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(new Float32Array(n)).setBuffer(buffer))
      .setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint32Array(idx)).setBuffer(buffer))
      .setMaterial(material);
    return doc.createMesh(name).addPrimitive(prim);
  };
  const wheelMesh = (() => {
    const p = [];
    const n = [];
    const idx = [];
    const S = 16, R = 0.34, W = 0.24;
    for (let i = 0; i <= S; i++) {
      const a = (i / S) * Math.PI * 2;
      const x = Math.cos(a) * R, y = Math.sin(a) * R;
      p.push(x, y, -W / 2, x, y, W / 2);
      n.push(Math.cos(a), Math.sin(a), 0, Math.cos(a), Math.sin(a), 0);
      if (i < S) idx.push(i * 2, i * 2 + 2, i * 2 + 1, i * 2 + 1, i * 2 + 2, i * 2 + 3);
    }
    for (const side of [-1, 1]) {
      const c = p.length / 3;
      p.push(0, 0, (side * W) / 2);
      n.push(0, 0, side);
      for (let i = 0; i <= S; i++) {
        const a = (i / S) * Math.PI * 2;
        p.push(Math.cos(a) * R, Math.sin(a) * R, (side * W) / 2);
        n.push(0, 0, side);
        if (i < S) idx.push(...(side > 0 ? [c, c + 1 + i, c + 2 + i] : [c, c + 2 + i, c + 1 + i]));
      }
    }
    return mesh('wheel', tire, p, n, idx);
  })();
  const hubs = { wheel_lf: [1.4, 0.34, -0.8], wheel_rf: [1.4, 0.34, 0.8], wheel_lr: [-1.4, 0.34, -0.8], wheel_rr: [-1.4, 0.34, 0.8] };
  const car = doc.createNode('testcar').setExtras({
    wheels: Object.entries(hubs).map(([name, position]) => ({ name, position, radius: 0.34, width: 0.24 })),
    pivots: { seat_dside_f: [-0.2, 0.35, -0.4] },
  });
  car.addChild(doc.createNode('chassis').setMesh(box('chassis', paint, [-2.3, 0.3, -0.95], [2.3, 0.85, 0.95])));
  car.addChild(doc.createNode('windscreen').setMesh(box('cabin', glass, [-1.2, 0.85, -0.85], [0.8, 1.3, 0.85])));
  car.addChild(doc.createNode('headlight_l').setMesh(box('headlight', lamp, [2.28, 0.6, -0.85], [2.32, 0.75, -0.5])));
  car.addChild(doc.createNode('taillight_l').setMesh(box('taillight', tail, [-2.32, 0.6, -0.85], [-2.28, 0.75, -0.5])));
  for (const [name, pos] of Object.entries(hubs)) car.addChild(doc.createNode(name).setMesh(wheelMesh).setTranslation(pos));
  doc.createScene('car').addChild(car);
  return new NodeIO().writeBinary(doc);
}

mkdirSync(join(OUT, 'cars'), { recursive: true });
const glb = await makeCar();
for (const id of [...CARS, ...TRAFFIC]) {
  writeFileSync(join(OUT, 'cars', `${id}.glb`), glb);
  writeFileSync(join(OUT, 'cars', `${id}_lod.glb`), glb);
  writeFileSync(join(OUT, 'cars', `${id}.json`), JSON.stringify({ id, name: id, make: 'Test', handling: null }));
}

// --- Sky, water, sounds ---

mkdirSync(join(OUT, 'sky'), { recursive: true });
for (const [time, sunY, tint] of [['day', 0.55, [1, 1, 1]], ['sunset', 0.08, [1.3, 0.8, 0.55]], ['night', 0.4, [0.05, 0.06, 0.1]]]) {
  writeFileSync(join(OUT, 'sky', `${time}.hdr`), hdrSky(512, 256, sunY, tint));
}
mkdirSync(join(OUT, 'water'), { recursive: true });
await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 128, g: 128, b: 255 } } }).jpeg().toFile(join(OUT, 'water', 'waternormals.jpg'));

mkdirSync(join(OUT, 'audio', 'crash'), { recursive: true });
mkdirSync(join(OUT, 'audio', 'skid'), { recursive: true });
const tone = (file, expr) => execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', expr, '-t', '0.4', '-c:a', 'libvorbis', file]);
try {
  for (const n of ['crash-1', 'crash-2', 'glass-01', 'glass-02', 'glass-03', 'glass-05', 'glass-06', 'glass-07', 'glass-alpha']) tone(join(OUT, 'audio', 'crash', `${n}.ogg`), 'anoisesrc=d=0.4:a=0.3');
  tone(join(OUT, 'audio', 'skid', 'tarmac.ogg'), 'sine=f=900:d=0.4');
} catch {
  console.warn('ffmpeg missing: no test sounds (the game plays without them)');
}
for (const set of ENGINES) {
  mkdirSync(join(OUT, 'audio', set), { recursive: true });
  writeFileSync(join(OUT, 'audio', set, 'manifest.json'), JSON.stringify({ streams: [], engines: [] }));
}

/** Radiance .hdr (flat RGBE scanlines): a blue gradient sky with a bright sun disc, ground below. */
function hdrSky(w, h, sunY, tint) {
  const head = Buffer.from(`#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y ${h} +X ${w}\n`);
  const px = Buffer.alloc(w * h * 4);
  const sun = [Math.cos(sunY) * Math.cos(0.6), Math.sin(sunY), Math.cos(sunY) * Math.sin(0.6)];
  for (let y = 0; y < h; y++) {
    const el = (0.5 - (y + 0.5) / h) * Math.PI;
    for (let x = 0; x < w; x++) {
      const az = ((x + 0.5) / w - 0.5) * 2 * Math.PI;
      const d = [Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az)];
      const up = Math.max(0, d[1]);
      let rgb = el > 0 ? [0.35 + 0.25 * (1 - up), 0.55 + 0.2 * (1 - up), 1.0] : [0.3, 0.32, 0.35];
      const s = d[0] * sun[0] + d[1] * sun[1] + d[2] * sun[2];
      if (s > 0.9995) rgb = [60, 55, 45];
      rgb = rgb.map((v, i) => v * tint[i]);
      const m = Math.max(...rgb);
      const e = m < 1e-32 ? 0 : Math.ceil(Math.log2(m));
      const k = (y * w + x) * 4;
      const f = m < 1e-32 ? 0 : 256 / 2 ** e;
      px[k] = Math.min(255, rgb[0] * f);
      px[k + 1] = Math.min(255, rgb[1] * f);
      px[k + 2] = Math.min(255, rgb[2] * f);
      px[k + 3] = m < 1e-32 ? 0 : e + 128;
    }
  }
  // The flat format must not start with the RLE marker (2, 2): nudge the first pixel if it does
  if (px[0] === 2 && px[1] === 2) px[0] = 3;
  return Buffer.concat([head, px]);
}

console.log(`test world: ${index.map((m) => m.id).join(', ')} → ${OUT}`);
