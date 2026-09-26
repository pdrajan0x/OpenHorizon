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
