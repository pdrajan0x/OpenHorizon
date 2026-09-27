#!/usr/bin/env node
// Downloads the environment into public/mods/ (gitignored): the sky photographs (HDRIs, CC0, from
// Poly Haven) that are both the backdrop and the light the islands are lit by, one per time of day,
// and the ocean's wave normal map (from the three.js examples, MIT).
// Usage: node scripts/fetch-environment.mjs
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

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
  // beaches: dry, wet and tidal sand, shells, pebbles
  'aerial_beach_02', 'aerial_beach_03', 'coast_sand_02', 'coast_sand_03', 'coast_sand_04', 'coast_sand_05',
  'damp_beach_sand_02', 'damp_sand', 'sand_02', 'sand_03', 'shell_floor_01', 'low_tide_rocks',
  'coast_land_rocks_01',
  // sea rock and cliff faces
  'seaside_rock', 'rock_3', 'marble_cliff_05', 'dark_rock_02', 'coral_ground_02',
  // seabed
  'coral_gravel', 'ganges_river_pebbles', 'river_small_rocks',
  // boardwalks, jetties, beach huts
  'wood_planks_grey', 'brown_planks_09',
];
export const COAST_MODELS = [
  'coastal_cliff_04', 'coastal_cliff_02', 'coast_land_rocks_04', 'coast_rocks_05', 'coast_line_01',
  'boulder_01', 'namaqualand_boulder_02', 'rock_09', 'sand_rocks_small_01',
  // shoreline rock formations
  'coast_land_rocks_02', 'coast_land_rocks_03', 'coast_line_02', 'coast_rocks_01', 'coast_rocks_02',
  'coast_rocks_03',
  // harbour: channel marker, light buoy, lifebuoy, wooden jetty kit
  'lateral_sea_marker', 'ocean_buoy', 'lifebuoy', 'modular_wooden_pier',
];
// Detail maps (src/map.ts): fine surface grain blended into every city surface up close, so
// low-resolution map textures read as real material. Same 2k set, into public/mods/coast/<id>/.
export const DETAIL_TEXTURES = ['grey_plaster', 'beige_wall_001'];
COAST_TEXTURES.push(...DETAIL_TEXTURES);
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

// The land between and around the cities (countryside, forest, mountains, desert, snow), all CC0, into
// public/mods/terrain/<id>/. The full-size fir and pine trees are in .mods/veg-polyhaven-trees.
// Poly Haven ground textures, 2k: Diffuse, nor_gl, Rough, AO and Displacement (for height blending).
export const TERRAIN_TEXTURES = [
  // grass, meadow, farmland
  'aerial_grass_rock', 'sparse_grass', 'grass_path_2', 'grass_ground', 'withered_grass', 'farm_soil',
  'dry_mud_field_001',
  // forest floor, dirt, mud
  'forrest_ground_01', 'forest_leaves_02', 'forrest_ground_03', 'forest_ground_04', 'brown_mud_leaves_01',
  'brown_mud_02', 'brown_mud_03', 'dirt_floor', 'red_dirt_mud_01', 'aerial_mud_1', 'muddy_tracks',
  // gravel
  'rocky_trail', 'gravel_ground_01', 'rocks_ground_05', 'gravelly_sand',
  // desert sand, cracked earth
  'sandy_gravel_02', 'sand_01', 'red_sand', 'aerial_sand', 'dry_ground_01', 'mud_cracked_dry_03',
  'mud_cracked_dry_riverbed_002', 'dry_ground_rocks', 'cracked_red_ground',
  // snow
  'snow_02', 'snow_01', 'snow_03', 'snow_field_aerial',
  // rock, mountain, canyon
  'aerial_rocks_02', 'aerial_rocks_04', 'rocky_terrain_02', 'rocky_terrain_03', 'rock_face', 'cliff_side',
  'rock_06', 'lichen_rock', 'mossy_rock', 'rock_pitted_mossy', 'rock_boulder_cracked', 'worn_rock_natural_01',
  'tiger_rock', 'marble_cliff_03', 'dark_rock', 'rock_wall_02',
];
// Poly Haven glTF models, 2k textures.
export const TERRAIN_MODELS = [
  // forest: young conifers, dead wood, undergrowth
  'fir_sapling', 'fir_sapling_medium', 'pine_sapling_small', 'dead_tree_trunk', 'dead_tree_trunk_02',
  'tree_stump_01', 'tree_stump_02', 'dry_branches_medium_01', 'pine_roots', 'root_cluster_01', 'bark_debris_01',
  'fern_02', 'moss_01', 'nettle_plant', 'weed_plant_02',
  // grass clumps and flowers
  'grass_medium_01', 'grass_medium_02', 'grass_bermuda_01', 'celandine_01', 'dandelion_01', 'periwinkle_plant',
  'flower_empodium', 'flower_gazania', 'flower_heliophila', 'flower_stinkkruid', 'flower_ursinia',
  // desert and dry scrub: quiver trees (aloe), succulents, shrubs, dead quiver wood
  'quiver_tree_01', 'quiver_tree_02', 'dead_quiver_trunk', 'dead_quiver_branch_01', 'othonna_cerarioides',
  'searsia_burchellii', 'searsia_lucida', 'didelta_spinosa', 'leipoldtia_schultzei', 'cheiridopsis_succulent',
  'crystalline_iceplant',
  // mountains, cliffs, large rocks
  'mountainside', 'namaqualand_cliff_01', 'namaqualand_cliff_02', 'coastal_cliff_01', 'rock_face_01',
  'rock_face_02', 'namaqualand_boulder_03', 'namaqualand_boulder_04', 'namaqualand_boulder_05',
  'namaqualand_boulder_06', 'namaqualand_boulders_01', 'namaqualand_rocks_01', 'namaqualand_stones_01',
  'rock_07', 'rock_moss_set_01', 'rock_moss_set_02', 'stone_01',
];
// ambientCG sets where Poly Haven has no match (id: download variant). The zip is unpacked to its colour,
// GL normal, roughness, AO and height maps. Terrain00x are photogrammetry mountain heightmaps (16-bit
// PNG) for backdrop ranges.
export const TERRAIN_AMBIENTCG = {
  Grass001: '2K-JPG', Grass002: '2K-JPG', Grass004: '2K-JPG', Grass005: '2K-JPG', Ground037: '2K-JPG',
  Ground003: '2K-JPG', Moss002: '2K-JPG', Ground048: '2K-JPG', Ground036: '2K-JPG', Ground023: '2K-JPG',
  Ground067: '2K-JPG', ScatteredLeaves008: '2K-JPG', Gravel022: '2K-JPG', Gravel023: '2K-JPG',
  Ground031: '2K-JPG', Ground093C: '2K-JPG', Ground096B: '2K-JPG', Ground080: '2K-JPG',
  Snow005: '2K-JPG', Snow010A: '2K-JPG', Snow008A: '2K-JPG', Snow006: '2K-JPG', Snow015: '2K-JPG',
  Ice002: '2K-JPG', Ice003: '2K-JPG',
  Rock051: '2K-JPG', Rock056: '2K-JPG', Rock035: '2K-JPG', Rock030: '2K-JPG', Rock029: '2K-JPG', Rock064: '2K-JPG',
  Terrain001: '2K-PNG', Terrain002: '2K-PNG', Terrain003: '2K-PNG', Terrain004: '2K-PNG', Terrain005: '2K-PNG',
};
const TERRAIN = join(MODS, 'terrain');
for (const id of [...TERRAIN_TEXTURES, ...TERRAIN_MODELS]) {
  const files = await fetch(`https://api.polyhaven.com/files/${id}`).then((r) => r.json());
  const out = join(TERRAIN, id);
  const jobs = [];
  if (TERRAIN_TEXTURES.includes(id)) {
    for (const m of [...MAPS, 'Displacement']) {
      const f = files[m]?.['2k']?.jpg;
      if (f) jobs.push([f.url, join(out, `${id}_${m}_2k.jpg`)]);
    }
  } else {
    const g = files.gltf['2k'].gltf;
    jobs.push([g.url, join(out, g.url.split('/').pop())]);
    for (const [path, f] of Object.entries(g.include ?? {})) jobs.push([f.url, join(out, path)]);
  }
  if (jobs.every(([, d]) => existsSync(d))) { console.log(`= terrain ${id}`); continue; }
  await Promise.all(jobs.map(([u, d]) => download(u, d)));
  console.log(`v terrain ${id} (${jobs.length} files)`);
}
// The entries of a zip (no zip64) whose names pass keep(), as [name, bytes].
function unzip(buf, keep) {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  let p = buf.readUInt32LE(end + 16);
  const entries = [];
  for (let i = buf.readUInt16LE(end + 10); i > 0; i--) {
    const method = buf.readUInt16LE(p + 10), size = buf.readUInt32LE(p + 20), local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + buf.readUInt16LE(p + 28));
    p += 46 + buf.readUInt16LE(p + 28) + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
    if (!keep(name)) continue;
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + size);
    entries.push([name, method === 0 ? data : inflateRawSync(data)]);
  }
  return entries;
}
const ACG_MAPS = /_(Color|NormalGL|Roughness|AmbientOcclusion|Displacement|Opacity)\.(jpg|png)$/;
for (const [id, variant] of Object.entries(TERRAIN_AMBIENTCG)) {
  const out = join(TERRAIN, id);
  if (existsSync(out)) { console.log(`= terrain ${id}`); continue; }
  const url = `https://ambientcg.com/get?file=${id}_${variant}.zip`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const maps = unzip(Buffer.from(await res.arrayBuffer()), (name) => ACG_MAPS.test(name));
  const tmp = `${out}.part`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  for (const [name, data] of maps) writeFileSync(join(tmp, name.split('/').pop()), data);
  renameSync(tmp, out);
  console.log(`v terrain ${id} (ambientCG ${variant}, ${maps.length} maps)`);
}

// More coast sets from ambientCG (CC0) where Poly Haven has no match: beach, wet and shell sand, beach
// pebbles, wet shoreline and sea-cliff rock, seabed gravel. Unpacked like the terrain ones, into
// public/mods/coast/<id>/.
export const COAST_AMBIENTCG = {
  Ground054: '2K-JPG', Ground055L: '2K-JPG', Ground057: '2K-JPG', Ground059: '2K-JPG', Ground060: '2K-JPG',
  Ground061: '2K-JPG', Ground092A: '2K-JPG', Ground093A: '2K-JPG', Ground093B: '2K-JPG', Gravel041: '2K-JPG',
  Rock020: '2K-JPG', Rock050: '2K-JPG', Rock057: '2K-JPG', Rock058: '2K-JPG', Rock060: '2K-JPG',
  Rock061: '2K-JPG', Rock063: '2K-JPG', Gravel036L: '2K-JPG', Ground022: '2K-JPG',
};
for (const [id, variant] of Object.entries(COAST_AMBIENTCG)) {
  const out = join(COAST, id);
  if (existsSync(out)) { console.log(`= coast ${id}`); continue; }
  const url = `https://ambientcg.com/get?file=${id}_${variant}.zip`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const maps = unzip(Buffer.from(await res.arrayBuffer()), (name) => ACG_MAPS.test(name));
  const tmp = `${out}.part`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  for (const [name, data] of maps) writeFileSync(join(tmp, name.split('/').pop()), data);
  renameSync(tmp, out);
  console.log(`v coast ${id} (ambientCG ${variant}, ${maps.length} maps)`);
}
