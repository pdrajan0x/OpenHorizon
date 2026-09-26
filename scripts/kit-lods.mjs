// Game-ready copies of the bridge-kit and coast models (Poly Haven CC0 scans are 60k–1.5M triangles,
// far too many to instance along kilometres of bridge and shore): welded, simplified to a budget,
// WebP textures, meshopt-compressed.
//   public/mods/bridges/<name>/<name>.gltf → public/mods/bridges/<name>.glb
//   public/mods/coast/<name>/<name>_2k.gltf → public/mods/coast/<name>.glb
// Usage: node scripts/kit-lods.mjs
import { existsSync, readdirSync } from 'node:fs';
import { NodeIO } from '@gltf-transform/core';
import { EXTMeshoptCompression, EXTTextureWebP, KHRMeshQuantization, KHRTextureTransform } from '@gltf-transform/extensions';
import { dedup, meshopt, prune, simplify, textureCompress, weld } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';

const BUDGET = {
  concrete_road_barrier: 600, concrete_road_barrier_02: 600, street_lamp_01: 1500,
  boulder_01: 1500, namaqualand_boulder_02: 1500, coast_rocks_05: 3000, sand_rocks_small_01: 3000,
  coast_land_rocks_04: 4000, coastal_cliff_02: 12000, coastal_cliff_04: 16000, coast_line_01: 12000, rock_09: 800,
};
const TEXTURE = 1024;

await MeshoptEncoder.ready;
await MeshoptSimplifier.ready;
const io = new NodeIO()
  .registerExtensions([EXTMeshoptCompression, EXTTextureWebP, KHRMeshQuantization, KHRTextureTransform])
  .registerDependencies({ 'meshopt.encoder': MeshoptEncoder });
const triangles = (doc) => doc.getRoot().listMeshes().flatMap((m) => m.listPrimitives())
  .reduce((n, p) => n + (p.getIndices()?.getCount() ?? p.getAttribute('POSITION').getCount()) / 3, 0);

for (const dir of ['public/mods/bridges', 'public/mods/coast']) {
  if (!existsSync(dir)) continue;
  for (const name of readdirSync(dir)) {
    const src = [`${dir}/${name}/${name}_2k.gltf`, `${dir}/${name}/${name}.gltf`].find(existsSync);
    if (!src || !BUDGET[name]) continue;
    const doc = await io.read(src);
    const before = triangles(doc);
    let ratio = Math.min(1, BUDGET[name] / before);
    await doc.transform(weld(), dedup(), simplify({ simplifier: MeshoptSimplifier, ratio, error: 0.05 }));
    // Scans keep UV seams that stop simplification early: loosen until it fits
    for (let error = 0.1; triangles(doc) > BUDGET[name] * 1.5 && error < 1; error *= 2) {
      ratio = Math.min(1, BUDGET[name] / triangles(doc));
      await doc.transform(simplify({ simplifier: MeshoptSimplifier, ratio, error, lockBorder: false }));
    }
    await doc.transform(
      prune(),
      textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [TEXTURE, TEXTURE], quality: 85 }),
      meshopt({ encoder: MeshoptEncoder, level: 'medium' }),
    );
    await io.write(`${dir}/${name}.glb`, doc);
    console.log(`${name}: ${before} → ${triangles(doc)} triangles`);
  }
}
