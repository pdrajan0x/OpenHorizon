// Makes game-ready models from raw converter output: .build/cars/<id>.glb →
//   public/mods/cars/<id>.glb      welded, deduplicated, WebP textures (≤2048), meshopt-compressed
//   public/mods/cars/<id>_lod.glb  also simplified to ~LOD_TRIANGLES (TRAFFIC_TRIANGLES for traffic-*)
//                                  with small textures, for rivals and traffic
// Usage: node scripts/optimize-models.mjs [id ...]
import { readdirSync } from 'node:fs';
import { NodeIO } from '@gltf-transform/core';
import { EXTMeshoptCompression, EXTTextureWebP, KHRMeshQuantization } from '@gltf-transform/extensions';
import { dedup, meshopt, prune, simplify, textureCompress, weld } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';

const RAW = '.build/cars';
const OUT = 'public/mods/cars';
const HERO_TEXTURE = 2048;
const LOD_TEXTURE = 512;
const LOD_TRIANGLES = 40000;
const TRAFFIC_TRIANGLES = 12000; // ambient traffic: dozens on screen at once
const TRAFFIC_TEXTURE = 256;

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

  const lod = await io.read(`${RAW}/${file}`);
  const traffic = id.startsWith('traffic-');
  const ratio = Math.min(1, (traffic ? TRAFFIC_TRIANGLES : LOD_TRIANGLES) / heroTris);
  await lod.transform(
    weld(),
    dedup(),
    simplify({ simplifier: MeshoptSimplifier, ratio, error: traffic ? 0.05 : 0.02 }),
    prune(),
    textureCompress({ encoder: sharp, targetFormat: 'webp', resize: traffic ? [TRAFFIC_TEXTURE, TRAFFIC_TEXTURE] : [LOD_TEXTURE, LOD_TEXTURE], quality: 80 }),
    meshopt({ encoder: MeshoptEncoder, level: 'medium' }),
  );
  await io.write(`${OUT}/${id}_lod.glb`, lod);
  console.log(`${id}: hero ${Math.round(heroTris)} tris, lod ${Math.round(triangles(lod))} tris (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
}
