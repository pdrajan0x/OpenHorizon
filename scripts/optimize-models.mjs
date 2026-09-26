// Makes game-ready models from raw converter output: .build/cars/<id>.glb →
//   public/mods/cars/<id>.glb      welded, deduplicated, WebP textures (≤2048), meshopt-compressed
//   public/mods/cars/<id>_lod.glb  also simplified to ~LOD_TRIANGLES (TRAFFIC_TRIANGLES for traffic-*)
//                                  with small textures, for rivals and traffic
// Usage: node scripts/optimize-models.mjs [id ...]
import { readdirSync } from 'node:fs';
import { NodeIO } from '@gltf-transform/core';
import { EXTMeshoptCompression, EXTTextureWebP, KHRMeshQuantization } from '@gltf-transform/extensions';
import { compactPrimitive, dedup, meshopt, prune, simplify, textureCompress, weld } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';

const RAW = '.build/cars';
const OUT = 'public/mods/cars';
const HERO_TEXTURE = 2048;
const LOD_TEXTURE = 512;
const LOD_TRIANGLES = 40000;
const TRAFFIC_TRIANGLES = 35000; // ambient traffic: instanced per material, textures and normal maps kept
const TRAFFIC_TEXTURE = 1024;
const NORMAL_WEIGHT = 0.1; // meters of error per unit of normal change
const UV_WEIGHT = 0.05; // per unit of UV change
const ERRORS = [0.004, 0.007, 0.012, 0.02]; // traffic simplify bounds in meters, tried in turn
const CULL_VIEWS = 80; // directions the car is seen from when finding hidden triangles
const CULL_RES = 1024; // z-buffer size per view
const CULL_EPS = 0.004; // m: surfaces this close behind the front one still count as seen (decals)
const WHEEL = /^wheel_/; // wheels spin and steer: never culled, never occluders

await MeshoptEncoder.ready;
await MeshoptSimplifier.ready;
const io = new NodeIO()
  .registerExtensions([EXTMeshoptCompression, EXTTextureWebP, KHRMeshQuantization])
  .registerDependencies({ 'meshopt.encoder': MeshoptEncoder });

const triangles = (doc) => doc.getRoot().listMeshes().flatMap((m) => m.listPrimitives())
  .reduce((n, p) => n + (p.getIndices()?.getCount() ?? p.getAttribute('POSITION').getCount()) / 3, 0);

const only = process.argv.slice(2);
for (const file of readdirSync(RAW).filter((f) => f.endsWith('.glb'))) {
  const id = file.replace(/\.glb$/, '');
  if (only.length && !only.includes(id)) continue;
  const t0 = Date.now();

  const hero = await io.read(`${RAW}/${file}`);
  await hero.transform(
    weld(),
    dedup(),
    prune(),
    textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [HERO_TEXTURE, HERO_TEXTURE], quality: 88 }),
    meshopt({ encoder: MeshoptEncoder, level: 'medium' }),
  );
  await io.write(`${OUT}/${id}.glb`, hero);
  const heroTris = triangles(hero);

  const traffic = id.startsWith('traffic-');
  const budget = traffic ? TRAFFIC_TRIANGLES : LOD_TRIANGLES;
  // Traffic: simplify each part with normal/UV-aware, absolute (meters) error, loosening it until the
  // car fits its budget (+15 %). Position-only simplify leaves dark smudges where creases collapse.
  let lod;
  if (traffic) {
    for (const error of ERRORS) {
      lod = await io.read(`${RAW}/${file}`);
      await lod.transform(weld(), dedup());
      const hidden = cullHidden(lod);
      if (error === ERRORS[0]) console.log(`${id}: ${hidden} hidden triangles removed`);
      // The error bound, not the ratio, decides: flat panels shrink a lot, curved and detailed ones less
      simplifyParts(lod, Math.min(1, budget / triangles(lod)) * 0.3, error);
      if (triangles(lod) <= budget * 1.15) break;
    }
  } else {
    lod = await io.read(`${RAW}/${file}`);
    const ratio = Math.min(1, budget / triangles(lod));
    await lod.transform(weld(), dedup(), simplify({ simplifier: MeshoptSimplifier, ratio, error: 0.02 }));
  }
  await lod.transform(
    prune(),
    textureCompress({ encoder: sharp, targetFormat: 'webp', resize: traffic ? [TRAFFIC_TEXTURE, TRAFFIC_TEXTURE] : [LOD_TEXTURE, LOD_TEXTURE], quality: 80 }),
    meshopt({ encoder: MeshoptEncoder, level: 'medium' }),
  );
  await io.write(`${OUT}/${id}_lod.glb`, lod);
  console.log(`${id}: hero ${Math.round(heroTris)} tris, lod ${Math.round(triangles(lod))} tris (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
}

/** Attribute-aware simplify of every indexed triangle primitive to `ratio` within `error` meters. */
function simplifyParts(doc, ratio, error) {
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const idx = prim.getIndices();
      const pos = prim.getAttribute('POSITION');
      if (!idx || prim.getMode() !== 4 || idx.getCount() < 36) continue;
      const n = pos.getCount();
      const positions = new Float32Array(n * 3);
      const attrs = new Float32Array(n * 5);
      const normal = prim.getAttribute('NORMAL');
      const uv = prim.getAttribute('TEXCOORD_0');
      const e = [0, 0, 0];
      for (let i = 0; i < n; i++) {
        positions.set(pos.getElement(i, e), i * 3);
        if (normal) attrs.set(normal.getElement(i, e), i * 5);
        if (uv) attrs.set(uv.getElement(i, [0, 0]), i * 5 + 3);
      }
      const indices = new Uint32Array(idx.getArray());
      const target = Math.max(3, Math.floor((indices.length * ratio) / 3) * 3);
      const [out] = MeshoptSimplifier.simplifyWithAttributes(indices, positions, 3, attrs, 5,
        [NORMAL_WEIGHT, NORMAL_WEIGHT, NORMAL_WEIGHT, UV_WEIGHT, UV_WEIGHT], null, target, error, ['ErrorAbsolute', 'Prune', 'LockBorder']);
      if (out.length === 0) {
        mesh.removePrimitive(prim);
        prim.dispose();
        continue;
      }
      idx.setArray(n > 65535 ? out : new Uint16Array(out));
      compactPrimitive(prim);
    }
  }
}


/**
 * Remove triangles that can't be seen from outside the car: cabins, inner door skins, engine bays,
 * the backs of layered panels. Traffic draws opaque glass, so glass occludes too. Software z-buffers
 * from CULL_VIEWS directions; a triangle is kept if it's within CULL_EPS of the front surface at any
 * pixel it covers (or at its centroid, when it covers no pixel center). Returns triangles removed.
 */
function cullHidden(doc) {
  const tris = []; // per primitive: { prim, index array, world positions }
  let total = 0;
  const walk = (node, wheel) => {
    wheel ||= WHEEL.test(node.getName());
    const mesh = node.getMesh();
    if (mesh) {
      const m = node.getWorldMatrix();
      for (const prim of mesh.listPrimitives()) {
        const idx = prim.getIndices();
        if (!idx || prim.getMode() !== 4) continue;
        const pos = prim.getAttribute('POSITION');
        const world = new Float32Array(pos.getCount() * 3);
        const e = [0, 0, 0];
        for (let i = 0; i < pos.getCount(); i++) {
          const [x, y, z] = pos.getElement(i, e);
          world[i * 3] = m[0] * x + m[4] * y + m[8] * z + m[12];
          world[i * 3 + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
          world[i * 3 + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
        }
        tris.push({ prim, mesh, wheel, indices: idx.getArray(), world, seen: new Uint8Array(idx.getCount() / 3) });
        total += idx.getCount() / 3;
      }
    }
    for (const c of node.listChildren()) walk(c, wheel);
  };
  for (const scene of doc.getRoot().listScenes()) for (const n of scene.listChildren()) walk(n, false);
  // A mesh used by several nodes would be culled per use; don't touch those (rare: usually wheels)
  const uses = new Map();
  for (const t of tris) uses.set(t.prim, (uses.get(t.prim) ?? 0) + 1);

  let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const t of tris) for (let i = 0; i < t.world.length; i++) {
    min[i % 3] = Math.min(min[i % 3], t.world[i]);
    max[i % 3] = Math.max(max[i % 3], t.world[i]);
  }
  const c = [0, 1, 2].map((k) => (min[k] + max[k]) / 2);
  const radius = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2;
  const scale = (CULL_RES - 1) / (2 * radius);
  const depth = new Float32Array(CULL_RES * CULL_RES);
  const sx = new Float32Array(3), sy = new Float32Array(3), sz = new Float32Array(3);

  // Rasterize one triangle; pass 0 writes depth, pass 1 marks it seen if it's at the front anywhere
  const raster = (pass) => {
    const x0 = Math.max(0, Math.ceil(Math.min(sx[0], sx[1], sx[2]) - 0.5));
    const x1 = Math.min(CULL_RES - 1, Math.floor(Math.max(sx[0], sx[1], sx[2]) - 0.5));
    const y0 = Math.max(0, Math.ceil(Math.min(sy[0], sy[1], sy[2]) - 0.5));
    const y1 = Math.min(CULL_RES - 1, Math.floor(Math.max(sy[0], sy[1], sy[2]) - 0.5));
    const area = (sx[1] - sx[0]) * (sy[2] - sy[0]) - (sx[2] - sx[0]) * (sy[1] - sy[0]);
    let covered = false;
    if (Math.abs(area) > 1e-9) {
      for (let py = y0; py <= y1; py++) {
        const y = py + 0.5;
        for (let px = x0; px <= x1; px++) {
          const x = px + 0.5;
          const w0 = ((sx[1] - x) * (sy[2] - y) - (sx[2] - x) * (sy[1] - y)) / area;
          const w1 = ((sx[2] - x) * (sy[0] - y) - (sx[0] - x) * (sy[2] - y)) / area;
          const w2 = 1 - w0 - w1;
          if (w0 < 0 || w1 < 0 || w2 < 0) continue;
          covered = true;
          const z = w0 * sz[0] + w1 * sz[1] + w2 * sz[2];
          const k = py * CULL_RES + px;
          if (pass === 0) { if (z < depth[k]) depth[k] = z; }
          else if (z <= depth[k] + CULL_EPS) return true;
        }
      }
    }
    if (covered || pass === 0) return false;
    const px = Math.min(CULL_RES - 1, Math.max(0, Math.floor((sx[0] + sx[1] + sx[2]) / 3)));
    const py = Math.min(CULL_RES - 1, Math.max(0, Math.floor((sy[0] + sy[1] + sy[2]) / 3)));
    return (sz[0] + sz[1] + sz[2]) / 3 <= depth[py * CULL_RES + px] + CULL_EPS;
  };

  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let v = 0; v < CULL_VIEWS; v++) {
    // Fibonacci sphere of view directions d; screen axes u, w perpendicular to it
    const dy = 1 - (2 * (v + 0.5)) / CULL_VIEWS;
    const r = Math.sqrt(1 - dy * dy);
    const d = [Math.cos(golden * v) * r, dy, Math.sin(golden * v) * r];
    const up = Math.abs(d[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
    const u = norm(cross(up, d));
    const w = cross(d, u);
    depth.fill(Infinity);
    for (const pass of [0, 1]) {
      for (const t of tris) {
        if (t.wheel || uses.get(t.prim) > 1) continue;
        const { indices, world, seen } = t;
        for (let f = 0; f < seen.length; f++) {
          if (pass === 1 && seen[f]) continue;
          for (let j = 0; j < 3; j++) {
            const i = indices[f * 3 + j] * 3;
            const px = world[i] - c[0], py = world[i + 1] - c[1], pz = world[i + 2] - c[2];
            sx[j] = (px * u[0] + py * u[1] + pz * u[2] + radius) * scale;
            sy[j] = (px * w[0] + py * w[1] + pz * w[2] + radius) * scale;
            sz[j] = px * d[0] + py * d[1] + pz * d[2];
          }
          if (raster(pass)) seen[f] = 1;
        }
      }
    }
  }

  let removed = 0;
  for (const t of tris) {
    if (t.wheel || uses.get(t.prim) > 1) continue;
    const keep = [];
    for (let f = 0; f < t.seen.length; f++) {
      if (t.seen[f]) keep.push(t.indices[f * 3], t.indices[f * 3 + 1], t.indices[f * 3 + 2]);
      else removed++;
    }
    if (keep.length === 0) {
      t.mesh.removePrimitive(t.prim);
      t.prim.dispose();
      continue;
    }
    t.prim.getIndices().setArray(new Uint32Array(keep));
    compactPrimitive(t.prim);
  }
  return removed;
}

function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function norm(a) {
  const l = Math.hypot(...a);
  return a.map((x) => x / l);
}
