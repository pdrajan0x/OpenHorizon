#!/usr/bin/env node
// Post-processes converted maps (public/mods/maps/<id>/, from gta5conv map) into extras the game uses
// when present. Works on existing data; re-runnable (every output is rewritten).
//
//   node scripts/map-extras.mjs [mapId…] [--no-tiles] [--no-coast] [--no-far] [--threads N]
//   (no ids: every map in public/mods/maps/index.json)
//
// Writes into public/mods/maps/<id>/:
//   map/tiles/<cx>_<cz>.webp  top-down map at 1 m/px, one tile per manifest cell (cx = cell.x / cellSize,
//                             cz = cell.z / cellSize). IMAGE AXES ARE THE GAME AXES: pixel column u runs
//                             along +x (north), row v along +z (east); pixel (u, v) covers
//                             x ∈ [cell.x + u, +1), z ∈ [cell.z + v, +1). Transparent where there's nothing.
//   map/overview.webp         the same at 8 m/px over extras.overview.min…max (same axis convention)
//   coast.json                { version: 1, cellSize, loops: [{ outer, points: [[x, z, groundY]…] }] }
//                             land outline loops in the map frame, land on the left of travel, DP 3 m.
//                             outer: the loop encloses land (false: a lake/river hole in the land)
//   far/<cellId>.bin          simplified (~6 %) far-LOD copy of cells/<cellId>.bin, same format
//   extras.json               { version: 1, tiles: ["cx_cz"…], overview: { file, min: [x, z], max: [x, z],
//                             mPerPx }, hasCoast, hasFar }
//
// How: worker threads rasterize every cell's up-facing render triangles (top surface and its material
// class) and collision (lowest surface above −2 m) into one shared 1 m raster, and simplify the cells for
// far/. Then the tiles are shaded from the raster (roads from materials and path links, buildings where
// the top is > 3.5 m above the ground, drawn lighter the taller, with outline and drop shadow), and the
// coast comes from a 4 m land mask via marching squares.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAPS = path.join(ROOT, 'public/mods/maps');

// Surface classes in the raster
const NONE = 0, GROUND = 1, ROAD = 2, PAVE = 3, PARK = 4, SAND = 5, WATER = 6;
const PALETTE = {
  [GROUND]: [0x26, 0x30, 0x3b], [ROAD]: [0x52, 0x5d, 0x6c], [PAVE]: [0x31, 0x3c, 0x4a],
  [PARK]: [0x1e, 0x3a, 0x2b], [SAND]: [0x3a, 0x3b, 0x33], [WATER]: [0x0e, 0x2b, 0x3d],
};
const BUILDING = [0x39, 0x46, 0x56];
const BUILDING_TALL = [0x74, 0x84, 0x98];
const OUTLINE = [0x15, 0x1b, 0x23];
const EMPTY_TOP = -32768, EMPTY_GROUND = 32767; // raster heights are Int16 decimetres
const BUILDING_MIN = 35; // dm: top − ground above this is a building

// ---------------------------------------------------------------- shared: cell / texture parsing
function readCell(buf) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const jsonLength = view.getUint32(0, true);
  const header = JSON.parse(buf.subarray(4, 4 + jsonLength).toString());
  let off = 4 + jsonLength;
  off += (4 - (off % 4)) % 4;
  const batches = [];
  for (const b of header.batches) {
    const stride = b.colors ? 9 : 8;
    const verts = new Float32Array(buf.buffer.slice(buf.byteOffset + off, buf.byteOffset + off + b.vertices * stride * 4));
    off += b.vertices * stride * 4;
    const idx = new Uint32Array(buf.buffer.slice(buf.byteOffset + off, buf.byteOffset + off + b.indices * 4));
    off += b.indices * 4;
    batches.push({ ...b, stride, verts, idx });
  }
  return batches;
}

function writeCell(file, batches) {
  const header = JSON.stringify({ batches: batches.map((b) => {
    const o = { material: b.material, vertices: b.verts.length / b.stride, indices: b.idx.length };
    if (b.colors) o.colors = true;
    if (b.detail !== undefined) o.detail = b.detail;
    return o;
  }) });
  const json = Buffer.from(header);
  let off = 4 + json.length;
  const pad = (4 - (off % 4)) % 4;
  const parts = [Buffer.alloc(4), json, Buffer.alloc(pad)];
  parts[0].writeUInt32LE(json.length, 0);
  for (const b of batches) parts.push(Buffer.from(b.verts.buffer, b.verts.byteOffset, b.verts.byteLength), Buffer.from(b.idx.buffer, b.idx.byteOffset, b.idx.byteLength));
  fs.writeFileSync(file, Buffer.concat(parts));
}

/** Average RGB of a .gtx texture from its smallest mip that's still at least one DXT block. */
function textureColour(file) {
  // Only the header and the one small mip are read (the files are big, the disk may be slow)
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    if (head.toString('latin1', 0, 4) !== 'GTX1') return null;
    const format = head.readUInt32LE(4);
    let w = head.readUInt16LE(8), h = head.readUInt16LE(10);
    const mips = head.readUInt16LE(12);
    const length = fs.fstatSync(fd).size;
    const size = (w, h) => (format === 0 ? w * h * 4 : Math.max(1, Math.ceil(w / 4)) * Math.max(1, Math.ceil(h / 4)) * (format === 1 ? 8 : 16));
    let off = 16, best = null;
    for (let m = 0; m < mips; m++) {
      if (off + size(w, h) > length) break;
      if ((w >= 4 && h >= 4) || !best) best = { off, w, h, bytes: size(w, h) };
      off += size(w, h);
      w = Math.max(1, w >> 1); h = Math.max(1, h >> 1);
    }
    if (!best) return null;
    const b = Buffer.alloc(best.bytes);
    fs.readSync(fd, b, 0, best.bytes, best.off);
    let r = 0, g = 0, bl = 0, n = 0;
    if (format === 0) {
      for (let p = 0; p + 3 < b.length; p += 4) { r += b[p]; g += b[p + 1]; bl += b[p + 2]; n++; }
    } else {
      const bs = format === 1 ? 8 : 16, co = format === 1 ? 0 : 8;
      for (let o = 0; o + bs <= b.length; o += bs) {
        for (const k of [0, 2]) {
          const c = b.readUInt16LE(o + co + k);
          r += ((c >> 11) & 31) * 255 / 31; g += ((c >> 5) & 63) * 255 / 63; bl += (c & 31) * 255 / 31; n++;
        }
      }
    }
    return n ? [r / n, g / n, bl / n] : null;
  } finally {
    fs.closeSync(fd);
  }
}

// ---------------------------------------------------------------- main thread
async function main() {
  const args = process.argv.slice(2);
  const flag = (f) => args.includes(f);
  const ti = args.indexOf('--threads');
  const threads = ti >= 0 ? +args[ti + 1] : Math.max(1, os.cpus().length - 1);
  let ids = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--threads');
  if (!ids.length) ids = JSON.parse(fs.readFileSync(path.join(MAPS, 'index.json'), 'utf8')).map((m) => m.id);
  for (const id of ids) {
    const dir = path.join(MAPS, id);
    if (!fs.existsSync(path.join(dir, 'manifest.json'))) { console.log(`${id}: no manifest, skipped`); continue; }
    const t0 = Date.now();
    try {
      await processMap(id, dir, { threads, tiles: !flag('--no-tiles'), coast: !flag('--no-coast'), far: !flag('--no-far') });
      console.log(`${id}: done in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    } catch (e) {
      console.error(`${id}: failed:`, e);
      process.exitCode = 1;
    }
  }
}

function classifyMaterials(dir, manifest) {
  const colourCache = new Map();
  return manifest.materials.map((m) => {
    const name = `${m.diffuse ?? ''} ${m.shader ?? ''}`.toLowerCase();
    if (m.blend || m.emissive || m.mask) return -1; // decals, glass, foliage, lights: leave out
    if (/decal|glass|window|foliage|leaf|leaves|tree|bush|hedge|ivy|shadow|puddle|graffiti|blood|dirt_?overlay|wire/.test(name)) return -1;
    const paved = /path|walk|bank|wall|edge|bed|pave|kerb|curb/.test(name);
    if (!paved && /(^|[^a-z])(water|sea|ocean|river|lake)([^a-z]|$)/.test(name)) return WATER;
    if (/road|asphalt|tarmac|street|highway|lane|tunnel_?floor|freeway/.test(name)) return ROAD;
    if (/grass|park|lawn|turf|field|meadow|moss/.test(name)) return PARK;
    if (/sand|beach|dune/.test(name)) return SAND;
    if (/pave|sidewalk|side_walk|kerb|curb|concrete|plaza|tile|brick_?floor|cobble|walk|path|parking/.test(name)) return PAVE;
    if (!m.diffuse) return GROUND;
    let c = colourCache.get(m.diffuse);
    if (c === undefined) {
      const f = path.join(dir, 'tex', `${m.diffuse}.gtx`);
      try { c = fs.existsSync(f) ? textureColour(f) : null; } catch { c = null; }
      colourCache.set(m.diffuse, c);
    }
    if (c) {
      const [r, g, b] = c;
      if (g > 45 && g > r * 1.12 && g > b * 1.08) return PARK;
      if (b > 70 && b > r * 1.35 && b > g * 1.05 && /sea|lake|pond|canal|pool/.test(name)) return WATER;
    }
    return GROUND;
  });
}

async function processMap(id, dir, opt) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const roads = fs.existsSync(path.join(dir, 'roads.json')) ? JSON.parse(fs.readFileSync(path.join(dir, 'roads.json'), 'utf8')) : { nodes: [], links: [] };
  const cs = manifest.cellSize;
  const cells = manifest.cells;
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (const c of cells) { minX = Math.min(minX, c.x); minZ = Math.min(minZ, c.z); maxX = Math.max(maxX, c.x + cs); maxZ = Math.max(maxZ, c.z + cs); }
  // Raster over the cells' extent plus a margin, 1 m per pixel, a multiple of 8 for the overview
  const M = 16;
  const x0 = Math.floor(minX) - M, z0 = Math.floor(minZ) - M;
  const W = Math.ceil((maxX - x0 + M) / 8) * 8, H = Math.ceil((maxZ - z0 + M) / 8) * 8;
  const px = W * H;
  console.log(`${id}: ${cells.length} cells, raster ${W}×${H} (${(px * 6 / 1e6).toFixed(0)} MB), ${opt.threads} threads`);
  const topBuf = new SharedArrayBuffer(px * 2), groundBuf = new SharedArrayBuffer(px * 2), clsBuf = new SharedArrayBuffer(px), roadBuf = new SharedArrayBuffer(px);
  new Int16Array(topBuf).fill(EMPTY_TOP);
  new Int16Array(groundBuf).fill(EMPTY_GROUND);
  const matClass = classifyMaterials(dir, manifest);
  const materials = manifest.materials.map((m) => ({ blend: !!m.blend, mask: !!m.mask, emissive: !!m.emissive }));

  if (opt.far) { fs.rmSync(path.join(dir, 'far'), { recursive: true, force: true }); fs.mkdirSync(path.join(dir, 'far'), { recursive: true }); }
  const grid = { x0, z0, W, H };
  const shared = { dir, grid, topBuf, groundBuf, clsBuf, roadBuf, matClass, materials, cellSize: cs };

  // Pass 1: rasterize + far LODs
  let t = Date.now();
  const farStats = await runPool(opt.threads, { ...shared, pass: 'raster', far: opt.far }, cells.map((c) => c.id));
  const farTris = farStats.reduce((s, r) => s + (r?.farTris ?? 0), 0), srcTris = farStats.reduce((s, r) => s + (r?.srcTris ?? 0), 0);
  console.log(`${id}: rasterized in ${((Date.now() - t) / 1000).toFixed(1)} s${opt.far ? `, far LOD ${farTris} of ${srcTris} triangles` : ''}`);
  const hasFar = opt.far && farTris > 0;

  // Road links (map frame), for the road overlay
  const links = [];
  for (const [a, b, ab, ba] of roads.links ?? []) {
    const p = roads.nodes[a], q = roads.nodes[b];
    if (!p || !q) continue;
    links.push([p[0], p[1], p[2], q[0], q[1], q[2], Math.max(6, 3.4 * Math.max(1, (ab ?? 1) + (ba ?? 0)))]);
  }

  const extras = { version: 1, tiles: [], overview: null, hasCoast: false, hasFar };
  const mapDir = path.join(dir, 'map');
  if (opt.tiles) {
    t = Date.now();
    fs.rmSync(mapDir, { recursive: true, force: true });
    fs.mkdirSync(path.join(mapDir, 'tiles'), { recursive: true });
    const jobs = cells.map((c) => ({ id: c.id, x: c.x, z: c.z, name: `${Math.round(c.x / cs)}_${Math.round(c.z / cs)}` }));
    const res = await runPool(opt.threads, { ...shared, pass: 'tiles', links }, jobs);
    extras.tiles = res.filter((r) => r?.written).map((r) => r.name);
    // Overview: 8×8 box average of the base colours (no shading), with alpha
    const sharp = (await import('sharp')).default;
    const OW = W / 8, OH = H / 8;
    const top = new Int16Array(topBuf), ground = new Int16Array(groundBuf), cls = new Uint8Array(clsBuf), road = new Uint8Array(roadBuf);
    const img = new Uint8Array(OW * OH * 4);
    const rgb = [0, 0, 0];
    for (let v = 0; v < OH; v++) for (let u = 0; u < OW; u++) {
      let r = 0, g = 0, b = 0, n = 0;
      for (let dv = 0; dv < 8; dv++) for (let du = 0; du < 8; du++) {
        const i = (v * 8 + dv) * W + u * 8 + du;
        if (!baseColour(top[i], ground[i], road[i] ? ROAD : cls[i], null, rgb)) continue;
        r += rgb[0]; g += rgb[1]; b += rgb[2]; n++;
      }
      // image rows are v (z), columns u (x)
      const o = (v * OW + u) * 4;
      if (n) { img[o] = r / n; img[o + 1] = g / n; img[o + 2] = b / n; img[o + 3] = Math.min(255, n * 255 / 32); }
    }
    await sharp(Buffer.from(img.buffer), { raw: { width: OW, height: OH, channels: 4 } }).webp({ quality: 85, alphaQuality: 80 }).toFile(path.join(mapDir, 'overview.webp'));
    extras.overview = { file: 'map/overview.webp', min: [x0, z0], max: [x0 + W, z0 + H], mPerPx: 8 };
    console.log(`${id}: ${extras.tiles.length} tiles + overview in ${((Date.now() - t) / 1000).toFixed(1)} s`);
  }

  if (opt.coast) {
    t = Date.now();
    const loops = coastLoops(grid, new Int16Array(topBuf), new Int16Array(groundBuf), new Uint8Array(clsBuf));
    fs.writeFileSync(path.join(dir, 'coast.json'), JSON.stringify({ version: 1, cellSize: cs, loops }));
    extras.hasCoast = loops.length > 0;
    console.log(`${id}: coast ${loops.length} loops (${loops.filter((l) => l.outer).length} outer, ${loops.reduce((s, l) => s + l.points.length, 0)} points) in ${((Date.now() - t) / 1000).toFixed(1)} s`);
  } else {
    const old = path.join(dir, 'coast.json');
    extras.hasCoast = fs.existsSync(old);
  }
  if (!opt.tiles) {
    // keep a previous run's tiles listed
    try { const prev = JSON.parse(fs.readFileSync(path.join(dir, 'extras.json'), 'utf8')); extras.tiles = prev.tiles ?? []; extras.overview = prev.overview ?? null; } catch { /* none */ }
  }
  if (!opt.far) extras.hasFar = fs.existsSync(path.join(dir, 'far'));
  fs.writeFileSync(path.join(dir, 'extras.json'), JSON.stringify(extras));
}

/** Runs jobs across worker threads; returns results in job order. */
function runPool(n, data, jobs) {
  return new Promise((resolve, reject) => {
    const results = new Array(jobs.length);
    let next = 0, done = 0, failed = false;
    if (!jobs.length) return resolve(results);
    const count = Math.min(n, jobs.length);
    const workers = [];
    for (let w = 0; w < count; w++) {
      const worker = new Worker(fileURLToPath(import.meta.url), { workerData: data });
      workers.push(worker);
      const feed = () => { if (next < jobs.length) { const k = next++; worker.postMessage({ k, job: jobs[k] }); } else worker.postMessage(null); };
      worker.on('message', (m) => {
        if (m.ready) return feed();
        results[m.k] = m.result;
        if (++done === jobs.length) { resolve(results); }
        if (done % 50 === 0) process.stdout.write(`  ${done}/${jobs.length}\r`);
        feed();
      });
      worker.on('error', (e) => { if (!failed) { failed = true; workers.forEach((x) => x.terminate()); reject(e); } });
    }
  });
}

// ---------------------------------------------------------------- coast
function coastLoops(grid, top, ground, cls) {
  const { x0, z0, W, H } = grid;
  const S = 4; // m per mask pixel
  const w = Math.floor(W / S) + 2, h = Math.floor(H / S) + 2; // +1 empty border each side
  const land = new Uint8Array(w * h);
  const gy = new Float32Array(w * h).fill(NaN);
  for (let j = 0; j < h - 2; j++) for (let i = 0; i < w - 2; i++) {
    let n = 0, sum = 0, cnt = 0;
    for (let dj = 0; dj < S; dj++) for (let di = 0; di < S; di++) {
      const p = (j * S + dj) * W + i * S + di;
      const g = ground[p];
      if (g === EMPTY_GROUND) continue;
      if (cls[p] === WATER && top[p] !== EMPTY_TOP && top[p] <= g + 5) continue; // water is the surface
      n++; sum += g; cnt++;
    }
    if (n >= 4) { land[(j + 1) * w + i + 1] = 1; gy[(j + 1) * w + i + 1] = sum / cnt / 10; }
  }
  // Close: dilate then erode by 1
  const morph = (src, grow) => {
    const out = new Uint8Array(w * h);
    for (let j = 1; j < h - 1; j++) for (let i = 1; i < w - 1; i++) {
      const k = j * w + i;
      let any = 0, all = 1;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) { const v = src[k + dj * w + di]; any |= v; all &= v; }
      out[k] = grow ? any : all;
    }
    return out;
  };
  let mask = morph(morph(land, true), false);
  // Fill holes under 2500 m², drop land specks under 5000 m²
  const components = (value, visit) => {
    const seen = new Uint8Array(w * h);
    const stack = [];
    for (let s = 0; s < w * h; s++) {
      if (seen[s] || mask[s] !== value) continue;
      const pix = [];
      let border = false;
      stack.push(s); seen[s] = 1;
      while (stack.length) {
        const k = stack.pop();
        pix.push(k);
        const i = k % w, j = (k / w) | 0;
        if (i === 0 || j === 0 || i === w - 1 || j === h - 1) border = true;
        for (const d of [k - 1, k + 1, k - w, k + w]) {
          if (d < 0 || d >= w * h || seen[d] || mask[d] !== value) continue;
          if ((d % w === 0 && k % w === w - 1) || (k % w === 0 && d % w === w - 1)) continue;
          seen[d] = 1; stack.push(d);
        }
      }
      visit(pix, border);
    }
  };
  components(0, (pix, border) => { if (!border && pix.length * S * S < 2500) for (const k of pix) mask[k] = 1; });
  components(1, (pix) => { if (pix.length * S * S < 5000) for (const k of pix) mask[k] = 0; });

  // Ground height near a mask pixel (nearest measured land pixel)
  const heightAt = (i, j) => {
    for (let r = 0; r <= 4; r++) {
      let s = 0, n = 0;
      for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
        if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
        const ii = i + di, jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= w || jj >= h) continue;
        const v = gy[jj * w + ii];
        if (!Number.isNaN(v)) { s += v; n++; }
      }
      if (n) return s / n;
    }
    return 0;
  };

  // Marching squares over corner samples (pixel centres). Point keys on a doubled grid.
  // Map: mask i along x, j along z. Segment p→q has land on its left when cross(q−p, land−p) < 0.
  const next = new Map();
  const key = (a, b) => a * 65536 * 4 + b; // a,b doubled coords
  const addSeg = (p, q, landCorner) => {
    const cross = (q[0] - p[0]) * (landCorner[1] - p[1]) - (q[1] - p[1]) * (landCorner[0] - p[0]);
    if (cross > 0) [p, q] = [q, p];
    next.set(key(p[0], p[1]), [q[0], q[1], p[0], p[1]]);
  };
  for (let j = 0; j < h - 1; j++) for (let i = 0; i < w - 1; i++) {
    // corners: 0 (i,j) 1 (i+1,j) 2 (i+1,j+1) 3 (i,j+1), doubled coords
    const c = [[2 * i, 2 * j], [2 * i + 2, 2 * j], [2 * i + 2, 2 * j + 2], [2 * i, 2 * j + 2]];
    const v = [mask[j * w + i], mask[j * w + i + 1], mask[(j + 1) * w + i + 1], mask[(j + 1) * w + i]];
    const sum = v[0] + v[1] + v[2] + v[3];
    if (sum === 0 || sum === 4) continue;
    // edge e between corner e and e+1: midpoint
    const mid = (e) => { const a = c[e], b = c[(e + 1) % 4]; return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; };
    const landCorner = (k) => c[k];
    if (sum === 2 && v[0] === v[2]) {
      // saddle: cut off each land corner on its own
      for (let k = 0; k < 4; k++) if (v[k]) addSeg(mid((k + 3) % 4), mid(k), landCorner(k));
      continue;
    }
    // the edges whose ends differ
    const es = [0, 1, 2, 3].filter((e) => v[e] !== v[(e + 1) % 4]);
    const lk = v.findIndex((x) => x === 1);
    addSeg(mid(es[0]), mid(es[1]), landCorner(lk));
  }
  // Chain into loops
  const loops = [];
  const used = new Set();
  for (const [k0, first] of next) {
    if (used.has(k0)) continue;
    const pts = [];
    let k = k0, seg = first;
    while (seg && !used.has(k)) {
      used.add(k);
      pts.push([seg[2], seg[3]]);
      k = key(seg[0], seg[1]);
      seg = next.get(k);
    }
    if (pts.length < 4) continue;
    // doubled mask coords → map metres (mask pixel i centre at x0 + (i − 1)·S + S/2)
    const world = pts.map(([a, b]) => [x0 + (a / 2 - 1) * S + S / 2, z0 + (b / 2 - 1) * S + S / 2, a, b]);
    const simple = dpClosed(world, 3);
    if (simple.length < 3) continue;
    let area = 0;
    for (let n = 0; n < simple.length; n++) { const p = simple[n], q = simple[(n + 1) % simple.length]; area += p[0] * q[1] - q[0] * p[1]; }
    // ground height per vertex, median-filtered along the loop (roof or pit spikes out)
    const ys = simple.map(([, , a, b]) => heightAt(Math.round(a / 2), Math.round(b / 2)));
    const med = ys.map((_, n) => {
      const win = [];
      for (let k = -2; k <= 2; k++) win.push(ys[(n + k + ys.length) % ys.length]);
      return win.sort((p, q) => p - q)[2];
    });
    loops.push({
      outer: area < 0, // land on the left of travel: an outer loop turns negative in (x, z)
      points: simple.map(([x, z], n) => [+x.toFixed(2), +z.toFixed(2), +med[n].toFixed(2)]),
    });
  }
  loops.sort((a, b) => b.points.length - a.points.length);
  return loops;
}

function dp(pts, tol) {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, az] = pts[a], [bx, bz] = pts[b];
    const dx = bx - ax, dz = bz - az, len = Math.hypot(dx, dz) || 1e-9;
    let best = -1, bd = tol;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((pts[i][0] - ax) * dz - (pts[i][1] - az) * dx) / len;
      if (d > bd) { bd = d; best = i; }
    }
    if (best >= 0) { keep[best] = 1; stack.push([a, best], [best, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

function dpClosed(pts, tol) {
  // split at the point farthest from the first so both halves are open polylines
  let far = 0, fd = -1;
  for (let i = 0; i < pts.length; i++) { const d = Math.hypot(pts[i][0] - pts[0][0], pts[i][1] - pts[0][1]); if (d > fd) { fd = d; far = i; } }
  const a = dp(pts.slice(0, far + 1), tol), b = dp([...pts.slice(far), pts[0]], tol);
  return [...a.slice(0, -1), ...b.slice(0, -1)];
}

// ---------------------------------------------------------------- shading (shared)
/** Base colour of a raster pixel; `building` overrides the building test (null: decide from heights). */
function baseColour(t, g, c, building, out) {
  if (t === EMPTY_TOP && g === EMPTY_GROUND) return false;
  if (building ?? (t !== EMPTY_TOP && g !== EMPTY_GROUND && t - g > BUILDING_MIN && (c === GROUND || c === NONE))) {
    const k = Math.min(1, (t - g - BUILDING_MIN) / 1200);
    for (let i = 0; i < 3; i++) out[i] = BUILDING[i] + (BUILDING_TALL[i] - BUILDING[i]) * k;
    return true;
  }
  const p = PALETTE[c] ?? PALETTE[GROUND];
  out[0] = p[0]; out[1] = p[1]; out[2] = p[2];
  return true;
}

// ---------------------------------------------------------------- workers
async function worker() {
  const d = workerData;
  const { x0, z0, W, H } = d.grid;
  const top = new Int16Array(d.topBuf), ground = new Int16Array(d.groundBuf), cls = new Uint8Array(d.clsBuf), road = new Uint8Array(d.roadBuf);
  let simplifier = null, sharp = null;
  if (d.pass === 'raster' && d.far) {
    const mo = await import('meshoptimizer');
    await mo.MeshoptSimplifier.ready;
    simplifier = mo.MeshoptSimplifier;
  }
  if (d.pass === 'tiles') sharp = (await import('sharp')).default;

  const clampY = (y) => Math.max(-32000, Math.min(32000, Math.round(y * 10)));

  // Rasterize one triangle with pixel-centre sampling; mode 0 = top (max, with class), 1 = ground (min, y > −2 m)
  function tri(ax, ay, az, bx, by, bz, cx, cy, cz, mode, c) {
    const minU = Math.max(0, Math.ceil(Math.min(ax, bx, cx) - x0 - 0.5));
    const maxU = Math.min(W - 1, Math.floor(Math.max(ax, bx, cx) - x0 - 0.5));
    const minV = Math.max(0, Math.ceil(Math.min(az, bz, cz) - z0 - 0.5));
    const maxV = Math.min(H - 1, Math.floor(Math.max(az, bz, cz) - z0 - 0.5));
    if (minU > maxU || minV > maxV) return;
    const det = (bx - ax) * (cz - az) - (cx - ax) * (bz - az);
    if (Math.abs(det) < 1e-9) return;
    const inv = 1 / det;
    for (let v = minV; v <= maxV; v++) {
      const pz = z0 + v + 0.5;
      for (let u = minU; u <= maxU; u++) {
        const pxx = x0 + u + 0.5;
        const l1 = ((pxx - ax) * (cz - az) - (cx - ax) * (pz - az)) * inv;
        const l2 = ((bx - ax) * (pz - az) - (pxx - ax) * (bz - az)) * inv;
        if (l1 < -1e-6 || l2 < -1e-6 || l1 + l2 > 1 + 1e-6) continue;
        const y = ay + l1 * (by - ay) + l2 * (cy - ay);
        const i = v * W + u;
        const q = clampY(y);
        if (mode === 0) {
          if (y < -2 && c !== WATER) continue; // sea bed
          let old = top[i];
          while (old < q) {
            const seen = Atomics.compareExchange(top, i, old, q);
            if (seen === old) { cls[i] = c; break; }
            old = seen;
          }
        } else if (y > -2) {
          let old = ground[i];
          while (old > q) {
            const seen = Atomics.compareExchange(ground, i, old, q);
            if (seen === old) break;
            old = seen;
          }
        }
      }
    }
  }

  function upTriangles(pos, stride, idx, mode, c) {
    for (let t = 0; t < idx.length; t += 3) {
      const a = idx[t] * stride, b = idx[t + 1] * stride, e = idx[t + 2] * stride;
      const ax = pos[a], ay = pos[a + 1], az = pos[a + 2];
      const bx = pos[b], by = pos[b + 1], bz = pos[b + 2];
      const cx = pos[e], cy = pos[e + 1], cz = pos[e + 2];
      // face normal's up component vs its length: keep surfaces within ~70° of flat (either winding)
      const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const len = Math.hypot(nx, ny, nz);
      if (len < 1e-9 || Math.abs(ny) < 0.34 * len) continue;
      tri(ax, ay, az, bx, by, bz, cx, cy, cz, mode, c);
    }
  }

  function farLod(batches) {
    const out = [];
    let src = 0, dst = 0;
    for (const b of batches) {
      const m = d.materials[b.material];
      const tris = b.idx.length / 3;
      if (!m || m.blend || m.mask || m.emissive || b.detail === true || tris < 30) continue;
      src += tris;
      const target = Math.max(12, Math.floor(tris * 0.06) * 3);
      let [idx] = simplifier.simplifySloppy(b.idx, b.verts, b.stride, null, target, 1);
      if (idx.length < 3) continue;
      // compact the vertices
      const remap = new Int32Array(b.verts.length / b.stride).fill(-1);
      let n = 0;
      const nidx = new Uint32Array(idx.length);
      for (let i = 0; i < idx.length; i++) { let r = remap[idx[i]]; if (r < 0) r = remap[idx[i]] = n++; nidx[i] = r; }
      const verts = new Float32Array(n * b.stride);
      for (let v = 0; v < remap.length; v++) if (remap[v] >= 0) verts.set(b.verts.subarray(v * b.stride, (v + 1) * b.stride), remap[v] * b.stride);
      out.push({ material: b.material, stride: b.stride, colors: b.colors, detail: b.detail, verts, idx: nidx });
      dst += nidx.length / 3;
    }
    return { out, src, dst };
  }

  function rasterCell(id) {
    const res = { srcTris: 0, farTris: 0 };
    const cf = path.join(d.dir, 'cells', `${id}.bin`);
    if (fs.existsSync(cf)) {
      const batches = readCell(fs.readFileSync(cf));
      for (const b of batches) {
        const c = d.matClass[b.material];
        if (c === undefined || c < 0) continue;
        if (b.detail === true && c !== ROAD && c !== WATER) continue; // small props: not map features
        upTriangles(b.verts, b.stride, b.idx, 0, c);
        if (c !== WATER) upTriangles(b.verts, b.stride, b.idx, 1, c);
      }
      if (simplifier) {
        const { out, src, dst } = farLod(batches);
        res.srcTris = src; res.farTris = dst;
        if (out.length) writeCell(path.join(d.dir, 'far', `${id}.bin`), out);
      }
    }
    const colf = path.join(d.dir, 'col', `${id}.bin`);
    if (fs.existsSync(colf)) {
      const buf = fs.readFileSync(colf);
      const nv = buf.readUInt32LE(0), ni = buf.readUInt32LE(4);
      const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      const pos = new Float32Array(ab, 8, nv * 3);
      const idx = new Uint32Array(ab, 8 + nv * 12, ni);
      upTriangles(pos, 3, idx, 1, 0);
    }
    return res;
  }

  // Road overlay: links near this tile, as (ax, ay, az, bx, by, bz, width)
  function roadMask(tx, tz, size) {
    const mask = new Uint8Array(size * size);
    for (const [ax, ay, az, bx, by, bz, wd] of d.links) {
      const r = wd / 2;
      if (Math.max(ax, bx) + r < tx || Math.min(ax, bx) - r > tx + size || Math.max(az, bz) + r < tz || Math.min(az, bz) - r > tz + size) continue;
      const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz || 1e-9;
      const u0 = Math.max(0, Math.floor(Math.min(ax, bx) - r - tx)), u1 = Math.min(size - 1, Math.ceil(Math.max(ax, bx) + r - tx));
      const v0 = Math.max(0, Math.floor(Math.min(az, bz) - r - tz)), v1 = Math.min(size - 1, Math.ceil(Math.max(az, bz) + r - tz));
      for (let v = v0; v <= v1; v++) for (let u = u0; u <= u1; u++) {
        const px = tx + u + 0.5, pz = tz + v + 0.5;
        const s = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / l2));
        const qx = ax + s * dx - px, qz = az + s * dz - pz;
        if (qx * qx + qz * qz > r * r) continue;
        const gi = (Math.floor(pz) - z0) * W + Math.floor(px) - x0;
        if (gi < 0 || gi >= W * H) continue;
        const y = (ay + s * (by - ay)) * 10;
        const t = top[gi], g = ground[gi];
        if ((t !== EMPTY_TOP && Math.abs(t - y) < 30) || (g !== EMPTY_GROUND && Math.abs(g - y) < 30)) mask[v * size + u] = 1;
      }
    }
    return mask;
  }

  async function tile(job) {
    const size = d.cellSize;
    const tx = job.x, tz = job.z;
    const roads = roadMask(tx, tz, size);
    const img = new Uint8Array(size * size * 4);
    const rgb = [0, 0, 0];
    const at = (x, z) => { const u = Math.floor(x) - x0, v = Math.floor(z) - z0; return u < 0 || v < 0 || u >= W || v >= H ? -1 : v * W + u; };
    const raw = (i) => i >= 0 && top[i] !== EMPTY_TOP && ground[i] !== EMPTY_GROUND && top[i] - ground[i] > BUILDING_MIN && cls[i] === GROUND;
    // Building mask over the tile plus a margin, with specks (poles, signs, bins) opened away: a pixel
    // stays a building when at least 6 of its 3×3 neighbourhood are
    const MG = 6, S2 = size + 2 * MG;
    const rawM = new Uint8Array(S2 * S2), bm = new Uint8Array(S2 * S2);
    for (let v = 0; v < S2; v++) for (let u = 0; u < S2; u++) rawM[v * S2 + u] = raw(at(tx + u - MG + 0.5, tz + v - MG + 0.5)) ? 1 : 0;
    for (let v = 1; v < S2 - 1; v++) for (let u = 1; u < S2 - 1; u++) {
      const k = v * S2 + u;
      if (!rawM[k]) continue;
      const n = rawM[k - S2 - 1] + rawM[k - S2] + rawM[k - S2 + 1] + rawM[k - 1] + rawM[k] + rawM[k + 1] + rawM[k + S2 - 1] + rawM[k + S2] + rawM[k + S2 + 1];
      if (n >= 6) bm[k] = 1;
    }
    const isBuilding = (x, z) => { const u = Math.floor(x - tx) + MG, v = Math.floor(z - tz) + MG; return u >= 0 && v >= 0 && u < S2 && v < S2 && bm[v * S2 + u] === 1; };
    let any = false;
    for (let v = 0; v < size; v++) for (let u = 0; u < size; u++) {
      const x = tx + u + 0.5, z = tz + v + 0.5;
      const i = at(x, z);
      if (i < 0) continue;
      const bld = isBuilding(x, z);
      let c = cls[i];
      if (!bld && roads[v * size + u] && c !== WATER) { c = ROAD; road[i] = 1; }
      if (!baseColour(top[i], ground[i], c, bld, rgb)) {
        if (!roads[v * size + u]) continue;
        const p = PALETTE[ROAD]; rgb[0] = p[0]; rgb[1] = p[1]; rgb[2] = p[2];
      }
      if (bld) {
        // dark outline where a neighbour isn't building
        if (!isBuilding(x + 1, z) || !isBuilding(x - 1, z) || !isBuilding(x, z + 1) || !isBuilding(x, z - 1)) {
          rgb[0] = OUTLINE[0]; rgb[1] = OUTLINE[1]; rgb[2] = OUTLINE[2];
        }
      } else {
        // drop shadow toward the south-east (screen down-right): a building up-left of here
        let sh = 0;
        for (let k = 1; k <= 4; k++) if (isBuilding(x + k, z - k)) { sh = 1 - (k - 1) * 0.15; break; }
        if (sh) for (let q = 0; q < 3; q++) rgb[q] *= 1 - 0.45 * sh;
      }
      const o = (v * size + u) * 4; // rows along z, columns along x
      img[o] = rgb[0]; img[o + 1] = rgb[1]; img[o + 2] = rgb[2]; img[o + 3] = 255;
      any = true;
    }
    if (!any) return { name: job.name, written: false };
    await sharp(Buffer.from(img.buffer), { raw: { width: size, height: size, channels: 4 } })
      .webp({ quality: 82, alphaQuality: 70, effort: 3 })
      .toFile(path.join(d.dir, 'map', 'tiles', `${job.name}.webp`));
    return { name: job.name, written: true };
  }

  parentPort.on('message', async (m) => {
    if (m === null) { process.exit(0); }
    const result = d.pass === 'raster' ? rasterCell(m.job) : await tile(m.job);
    parentPort.postMessage({ k: m.k, result });
  });
  parentPort.postMessage({ ready: true });
}

if (isMainThread) main();
else worker();
