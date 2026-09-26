#!/usr/bin/env node
// Downloads the environment into public/mods/ (gitignored): the sky photographs (HDRIs, CC0, from
// Poly Haven) that are both the backdrop and the light the islands are lit by, one per time of day,
// and the ocean's wave normal map (from the three.js examples, MIT).
// Usage: node scripts/fetch-environment.mjs
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SKIES = {
  day: 'kloofendal_48d_partly_cloudy_puresky',
  sunset: 'belfast_sunset_puresky',
  night: 'kloppenheim_02_puresky',
  'night-city': 'shanghai_bund',
};
const RES = '4k';
const WATER_NORMALS = 'https://raw.githubusercontent.com/mrdoob/three.js/r170/examples/textures/waternormals.jpg';

const MODS = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'public', 'mods');
const OUT = join(MODS, 'sky');
mkdirSync(OUT, { recursive: true });
for (const [time, id] of Object.entries(SKIES)) {
  const dest = join(OUT, `${time}.hdr`);
  if (existsSync(dest)) { console.log(`= ${time}: ${id}`); continue; }
  const files = await fetch(`https://api.polyhaven.com/files/${id}`).then((r) => r.json());
  const url = files.hdri[RES].hdr.url;
  console.log(`v ${time}: ${id} (${(files.hdri[RES].hdr.size / 1e6).toFixed(0)} MB)`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

mkdirSync(join(MODS, 'water'), { recursive: true });
const normals = join(MODS, 'water', 'waternormals.jpg');
if (!existsSync(normals)) {
  const res = await fetch(WATER_NORMALS);
  if (!res.ok) throw new Error(`${WATER_NORMALS}: HTTP ${res.status}`);
  writeFileSync(normals, Buffer.from(await res.arrayBuffer()));
  console.log('v water normals');
}

// The coast: 2k PBR textures (sand, wet sand, cliff rock, sea wall, riprap, asphalt) and glTF rock /
// cliff models, all CC0 from Poly Haven, into public/mods/coast/<id>/.
export const COAST_TEXTURES = [
  'coast_sand_01', 'damp_beach_sand', 'coast_sand_rocks_02', 'aerial_beach_01', 'rock_face_03',
  'concrete_wall_008', 'gray_rocks', 'rock_boulder_dry', 'asphalt_02',
];
export const COAST_MODELS = [
  'coastal_cliff_04', 'coastal_cliff_02', 'coast_land_rocks_04', 'coast_rocks_05', 'coast_line_01',
  'boulder_01', 'namaqualand_boulder_02', 'rock_09', 'sand_rocks_small_01',
];
const MAPS = ['Diffuse', 'nor_gl', 'Rough', 'AO'];
async function download(url, dest) {
  if (existsSync(dest)) return;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}
const COAST = join(MODS, 'coast');
for (const id of [...COAST_TEXTURES, ...COAST_MODELS]) {
  const files = await fetch(`https://api.polyhaven.com/files/${id}`).then((r) => r.json());
  const out = join(COAST, id);
  const jobs = [];
  if (COAST_TEXTURES.includes(id)) {
    for (const m of MAPS) {
      const f = files[m]?.['2k']?.jpg;
      if (f) jobs.push([f.url, join(out, `${id}_${m}_2k.jpg`)]);
    }
  } else {
    const g = files.gltf['2k'].gltf;
    jobs.push([g.url, join(out, g.url.split('/').pop())]);
    for (const [path, f] of Object.entries(g.include ?? {})) jobs.push([f.url, join(out, path)]);
  }
  if (jobs.every(([, d]) => existsSync(d))) { console.log(`= coast ${id}`); continue; }
  await Promise.all(jobs.map(([u, d]) => download(u, d)));
  console.log(`v coast ${id} (${jobs.length} files)`);
}
