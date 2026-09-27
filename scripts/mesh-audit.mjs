// Offline render-geometry audit of every converted map: the per-mesh checks of the in-game audit
// (src/audit.ts checkMeshes, fix and duplicateFinder) run in Node over public/mods/maps/<id>/cells/*.bin,
// one cell at a time, so the 30–70M-triangle Unreal towns stream through in bounded memory. Per map,
// material and batch (one material in one cell):
//
//   wound wrong  the winding's face normal n = (c−b)×(a−b) (three.js: counter-clockwise is the front)
//                points against the corners' summed stored normals (cos < −0.9), for |n| > 0.02. Only
//                opaque materials count: not mask, blend, glass, glow overlays (the game's exclusions),
//                nor what the name says is see-through, nor shadow proxies (see `category`)
//   duplicate    the same three corners, quantised to 2 cm, in any order (duplicateFinder), in one batch
//   degenerate   |n| < 1e-6
//
// A wound-wrong triangle says only that the winding and the normals disagree, not which one is wrong, and
// the game's fix() assumes the winding. Offline there's the whole batch to ask: corners are welded at
// 2 cm, and wound-wrong triangles sharing edges with a consistent winding are grouped into pieces. Then:
//   paired   it has a back-to-back twin (same corners, opposite winding): one face of a thin surface drawn
//            from both sides. Flipping it would make the twin a duplicate and open a hole: left alone
//   outlier  its piece is wound against the right-facing surface around it (neighbours whose winding and
//            normals agree): the winding is the odd one out. Safe to flip
//   fold     its piece is wound the same way as the right surface around it, so it's the normals that are
//            odd (bad or rotated normals, a crease): flipping would cut a hole into a correct surface
//   island   a piece with no right neighbours at all: topology can't say which is wrong. As evidence, whether
//            the piece's winding faces away from its own centre (normals pointing in: the normals are wrong)
//            or towards it (inside out: a mirrored placement, or a room seen from inside)
//   mixed    both kinds of neighbour, equally
// Two more measures of the normals themselves (opaque, judged triangles): wall faces (|n̂.y| < 0.25)
// whose stored normal is turned 45–135° from the face about the vertical ("sideways": neither a winding
// flip nor anything the asset would do, a normal transform bug), and level faces wound facing down.
// Duplicates split into same-winding copies (they z-fight) and back-to-back pairs (with one-sided drawing
// they never overlap on screen; the game's duplicateFinder counts both).
//
// Repairs (only these, and never the vertex data): drop same-winding duplicates, keeping the first, and
// flip the winding (swap the 1st and 3rd index, as fix() does) of wound-wrong triangles in opaque
// materials as --flip says. Only index lists and the header's index counts change; cells with no change
// aren't written. The far skyline (far/, scripts/map-extras.mjs) is built from cells/: rebuild it after
// --in-place. manifest.json's triangle counts are left as they were.
//
//   node scripts/mesh-audit.mjs [id ...]                   report → test-results/mesh-audit/
//   node scripts/mesh-audit.mjs --fix <outdir> [id ...]    repaired copies of the changed cells → <outdir>/<id>/cells/
//   node scripts/mesh-audit.mjs --in-place [id ...]        rewrite public/mods/maps/<id>/cells/ (each file atomically)
//   --flip=outliers|all|none  outliers (default): only outliers. all: every wound-wrong triangle that isn't
//                             paired, as the game's fix() (which flips paired ones too). none: dedupe only
//   --report <dir>            where summary.json and report.md go
//   --root <dir>              the maps (default public/mods/maps; the test world's are in .build/test-public/mods/maps)
import fs from 'node:fs';
import path from 'node:path';

let ROOT = 'public/mods/maps';
const Q = 50; // duplicateFinder's quantisation: 1/50 m
const WRONG_COS = -0.9;
const MIN_AREA2 = 0.02; // |n| (twice the area) below which the game doesn't judge the winding
const DEGENERATE = 1e-6;
const INVERTED = 0.9; // share of a batch or material wound wrong that points at a systematic cause
const MIN_JUDGED = 20; // triangles a batch or material needs before its ratio means anything
const TOP = 30;

const args = process.argv.slice(2);
let fixDir = null;
let inPlace = false;
let flip = 'outliers';
let reportDir = 'test-results/mesh-audit';
const ids = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--fix') fixDir = args[++i];
  else if (a === '--in-place') inPlace = true;
  else if (a === '--report') reportDir = args[++i];
  else if (a === '--root') ROOT = args[++i];
  else if (a.startsWith('--flip=')) flip = a.slice(7);
  else if (a.startsWith('-')) throw new Error(`unknown option ${a}`);
  else ids.push(a);
}
if (!['outliers', 'all', 'none'].includes(flip)) throw new Error(`--flip=${flip}: outliers, all or none`);
if (args.includes('--fix') && !fixDir) throw new Error('--fix needs an output directory');
if (fixDir && inPlace) throw new Error('--fix <outdir> or --in-place, not both');
const fixing = !!fixDir || inPlace;
const maps = ids.length ? ids : fs.readdirSync(ROOT).filter((d) => fs.existsSync(`${ROOT}/${d}/manifest.json`)).sort();

/**
 * Which materials the winding check covers, as map.ts makeMaterial builds them and audit.ts seeThrough
 * reads them. The game leaves out mask (alphaTest), blend and glass (transparent) and emissive overlays
 * (a transparent MeshBasicMaterial). seeThrough's name test reads material.userData.shader, which map.ts
 * never sets (it's on mesh.userData.surface), so in the game it matches nothing; here it runs on
 * "shader:diffuse", the mesh name, and without its "tree" in "street" (CARLA's street lights are poles).
 * Shadow proxies are never drawn in colour.
 */
function category(m) {
  if (m.mask) return 'mask';
  if (m.blend) return 'blend';
  if (m.shader.includes('glass') || (m.diffuse && /glass|window/i.test(m.diffuse))) return 'glass';
  if (m.shader.startsWith('emissive') && m.diffuse) return 'glow overlay';
  if (m.shader.includes('shadow_proxy')) return 'shadow proxy';
  if (/glass|decal|water|foliage|leaf|(?<!s)tree|grass/i.test(`${m.shader}:${m.diffuse ?? ''}`)) return 'see-through by name';
  return 'opaque';
}
const IN_GAME = new Set(['opaque', 'see-through by name', 'shadow proxy']); // what the game's check and fix() cover

// ---------------------------------------------------------------- hashing

function hash(a, b, c) {
  let h = Math.imul(a, 0x9e3779b1) ^ Math.imul(b, 0x85ebca77) ^ Math.imul(c, 0xc2b2ae3d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  return h ^ (h >>> 12);
}

/** Int triples → dense ids, open addressing. Reused batch to batch: a generation stamp empties it. */
class Triples {
  cap = 0;
  gen = 0;
  size = 0;
  mask = 0;
  fresh = false;
  begin(n) {
    let cap = 1024;
    while (cap < n * 2) cap *= 2;
    if (cap > this.cap) {
      this.cap = cap;
      this.keys = new Int32Array(cap * 3);
      this.stamp = new Uint32Array(cap);
      this.id = new Int32Array(cap);
      this.gen = 0;
    }
    this.mask = cap - 1;
    this.gen++;
    this.size = 0;
  }
  add(a, b, c) {
    const k = this.keys, st = this.stamp, g = this.gen;
    for (let s = hash(a, b, c) & this.mask; ; s = (s + 1) & this.mask) {
      if (st[s] !== g) {
        st[s] = g; k[s * 3] = a; k[s * 3 + 1] = b; k[s * 3 + 2] = c;
        this.fresh = true;
        return (this.id[s] = this.size++);
      }
      if (k[s * 3] === a && k[s * 3 + 1] === b && k[s * 3 + 2] === c) { this.fresh = false; return this.id[s]; }
    }
  }
  get(a, b, c) {
    const k = this.keys, st = this.stamp, g = this.gen;
    for (let s = hash(a, b, c) & this.mask; ; s = (s + 1) & this.mask) {
      if (st[s] !== g) return -1;
      if (k[s * 3] === a && k[s * 3 + 1] === b && k[s * 3 + 2] === c) return this.id[s];
    }
  }
}

const weld = new Triples(); // quantised position → corner id
const tris = new Triples(); // sorted corner ids → triangle key
const edges = new Triples(); // directed edge (corner, corner, 0) → edge id

// Grow-only scratch, per vertex, triangle, triangle key or edge
let wid = new Int32Array(0); // vertex → corner id
let tkey, tinfo, seen, wseen, rseen, kept, parent, tAgainst, tAlong, cAgainst, cAlong, piece; // per triangle / key
let eright = new Int32Array(0), ewrong, efirst; // per edge: right and wrong triangles running it that way, the first wrong one
function room(vertices, triangles) {
  if (wid.length < vertices) wid = new Int32Array(vertices * 1.25 | 0);
  if (!tkey || tkey.length < triangles) {
    const n = triangles * 1.25 | 0;
    tkey = new Int32Array(n); tinfo = new Uint16Array(n); kept = new Uint8Array(n);
    seen = new Int32Array(n * 2); wseen = new Int32Array(n * 2); rseen = new Int32Array(n * 2); // per key and parity
    parent = new Int32Array(n); tAgainst = new Int32Array(n); tAlong = new Int32Array(n); cAgainst = new Int32Array(n); cAlong = new Int32Array(n);
    piece = new Float64Array(n * 5); // per island piece: area-weighted centre (x, y, z), area, outwardness
  }
  if (eright.length < triangles * 3) {
    const n = triangles * 3.75 | 0;
    eright = new Int32Array(n); ewrong = new Int32Array(n); efirst = new Int32Array(n);
  }
}
const DEG = 1, JUDGED = 2, WRONG = 4, ODD = 8, COLLAPSED = 16, PAIRED = 32, OUTLIER = 64, FOLD = 128, ISLAND = 256, MIXED = 512;
const FACES_OUT = 0.25; // an island's mean outwardness beyond which it counts as facing out (or in)

// ---------------------------------------------------------------- per batch

// Per material counters, one Float64Array row each
const FIELDS = ['tris', 'degenerate', 'judged', 'wrong', 'paired', 'outlier', 'fold', 'island', 'mixed', 'islandOut', 'islandIn', 'facingDown', 'facingUp',
  'walls', 'sideways', 'dupSame', 'dupReversed', 'batches', 'invertedBatches', 'invertedTris', 'flipped', 'dropped'];
const F = Object.fromEntries(FIELDS.map((k, i) => [k, i]));
const NF = FIELDS.length;
const last = { flipped: 0, dropped: 0 }; // the repair of the batch just audited

/**
 * One batch: adds to its material's row of `acc`. With `fix`, returns the repaired index list (null when
 * nothing changes).
 */
function auditBatch(f32, vBase, stride, nv, idx, checked, flipOk, acc, row, fix) {
  const T = (idx.length / 3) | 0;
  room(nv, T);
  // Corners: vertices at the same quantised position are one corner (seams split vertices, not corners)
  weld.begin(nv);
  for (let v = 0, o = vBase; v < nv; v++, o += stride) {
    wid[v] = weld.add(Math.round(f32[o] * Q), Math.round(f32[o + 1] * Q), Math.round(f32[o + 2] * Q));
  }
  tris.begin(T);
  let degenerate = 0, judged = 0, wrong = 0, down = 0, up = 0, walls = 0, sideways = 0, dupSame = 0, dupRev = 0;
  for (let t = 0; t < T; t++) {
    const i0 = idx[t * 3], i1 = idx[t * 3 + 1], i2 = idx[t * 3 + 2];
    const a = vBase + i0 * stride, b = vBase + i1 * stride, c = vBase + i2 * stride;
    const bx = f32[b], by = f32[b + 1], bz = f32[b + 2];
    const ux = f32[c] - bx, uy = f32[c + 1] - by, uz = f32[c + 2] - bz;
    const vx = f32[a] - bx, vy = f32[a + 1] - by, vz = f32[a + 2] - bz;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const area2 = Math.sqrt(nx * nx + ny * ny + nz * nz);
    // As checkMeshes: a degenerate triangle is counted and goes no further (not even the duplicate test)
    if (area2 < DEGENERATE) { degenerate++; tinfo[t] = DEG; continue; }
    let info = 0;
    if (checked && area2 > MIN_AREA2) {
      const sx = f32[a + 3] + f32[b + 3] + f32[c + 3], sy = f32[a + 4] + f32[b + 4] + f32[c + 4], sz = f32[a + 5] + f32[b + 5] + f32[c + 5];
      const s2 = sx * sx + sy * sy + sz * sz;
      if (s2 > 1e-6) {
        judged++;
        info = JUDGED;
        const s = Math.sqrt(s2);
        if ((nx * sx + ny * sy + nz * sz) / (area2 * s) < WRONG_COS) {
          wrong++;
          info |= WRONG;
          // Level ones: a floor wound facing down is a hole seen from above
          if (ny < -0.7 * area2) down++;
          else if (ny > 0.7 * area2) up++;
        }
        // Walls: how far the stored normal is turned about the vertical from the face's own
        const fh = Math.sqrt(nx * nx + nz * nz), sh = Math.sqrt(sx * sx + sz * sz);
        if (Math.abs(ny) < 0.25 * area2 && sh > 0.5 * s) {
          walls++;
          if (Math.abs(nx * sx + nz * sz) < Math.SQRT1_2 * fh * sh) sideways++;
        }
      }
    }
    // Duplicates: corners sorted, with the parity of the sort (the winding relative to that order)
    let w0 = wid[i0], w1 = wid[i1], w2 = wid[i2], x, odd = 0;
    if (w0 > w1) { x = w0; w0 = w1; w1 = x; odd ^= 1; }
    if (w1 > w2) { x = w1; w1 = w2; w2 = x; odd ^= 1; }
    if (w0 > w1) { x = w0; w0 = w1; w1 = x; odd ^= 1; }
    if (w0 === w1 || w1 === w2) { info |= COLLAPSED; odd = 0; } // under 2 cm across somewhere: no winding to compare
    const k = tris.add(w0, w1, w2);
    if (tris.fresh) { seen[k * 2] = seen[k * 2 + 1] = wseen[k * 2] = wseen[k * 2 + 1] = rseen[k * 2] = rseen[k * 2 + 1] = kept[k] = 0; }
    if (seen[k * 2 + odd] > 0) dupSame++;
    else if (seen[k * 2 + (odd ^ 1)] > 0) dupRev++;
    seen[k * 2 + odd]++;
    if (info & WRONG) wseen[k * 2 + odd]++;
    else if (info & JUDGED) rseen[k * 2 + odd]++;
    tkey[t] = k;
    tinfo[t] = info | (odd ? ODD : 0);
  }
  const r = row * NF;
  acc[r + F.tris] += T;
  acc[r + F.degenerate] += degenerate;
  acc[r + F.dupSame] += dupSame;
  acc[r + F.dupReversed] += dupRev;
  acc[r + F.batches]++;
  if (checked) {
    acc[r + F.judged] += judged;
    acc[r + F.wrong] += wrong;
    acc[r + F.facingDown] += down;
    acc[r + F.facingUp] += up;
    acc[r + F.walls] += walls;
    acc[r + F.sideways] += sideways;
    if (judged >= MIN_JUDGED && wrong >= INVERTED * judged) { acc[r + F.invertedBatches]++; acc[r + F.invertedTris] += wrong; }
    if (wrong) classify(f32, vBase, stride, idx, T, acc, r);
  }
  if (!fix) return null;

  // The repair: flip what --flip allows, keep the first of each set of same-winding copies (after flipping)
  const flipMask = !flipOk || flip === 'none' ? 0 : flip === 'outliers' ? OUTLIER : OUTLIER | FOLD | ISLAND | MIXED | COLLAPSED;
  const out = new Uint32Array(T * 3);
  let n = 0, flipped = 0, dropped = 0;
  for (let t = 0; t < T; t++) {
    const i0 = idx[t * 3], i1 = idx[t * 3 + 1], i2 = idx[t * 3 + 2];
    const info = tinfo[t];
    if (info & DEG) { out[n++] = i0; out[n++] = i1; out[n++] = i2; continue; }
    const turn = (info & WRONG) !== 0 && (info & PAIRED) === 0 && (info & flipMask) !== 0;
    const bit = (info & COLLAPSED) ? 1 : 1 << (((info & ODD) ? 1 : 0) ^ (turn ? 1 : 0));
    const k = tkey[t];
    if (kept[k] & bit) { dropped++; continue; }
    kept[k] |= bit;
    if (turn) { out[n++] = i2; out[n++] = i1; out[n++] = i0; flipped++; } else { out[n++] = i0; out[n++] = i1; out[n++] = i2; }
  }
  acc[r + F.flipped] += flipped;
  acc[r + F.dropped] += dropped;
  last.flipped = flipped;
  last.dropped = dropped;
  return flipped || dropped ? out.subarray(0, n) : null;
}

function find(t) {
  while (parent[t] !== t) t = parent[t] = parent[parent[t]];
  return t;
}

/**
 * Sorts the batch's wound-wrong triangles (see the top). A neighbour across an edge, running it the other
 * way, is wound like the triangle ("along"); running it the same way, against it. Right neighbours are
 * judged triangles whose winding and normals agree. Wrong triangles joined along edges form a piece,
 * and the piece's right neighbours decide for all of it.
 */
function classify(f32, vBase, stride, idx, T, acc, r) {
  let paired = 0, outlier = 0, fold = 0, island = 0, mixed = 0, islandOut = 0, islandIn = 0;
  for (let t = 0; t < T; t++) {
    const info = tinfo[t];
    if ((info & (WRONG | COLLAPSED)) !== WRONG) continue;
    const k = tkey[t];
    if (seen[k * 2 + ((info & ODD) ? 0 : 1)] > 0) { tinfo[t] |= PAIRED; paired++; }
  }
  edges.begin(T * 3);
  for (let t = 0; t < T; t++) {
    const info = tinfo[t];
    if (!(info & JUDGED) || (info & (COLLAPSED | PAIRED))) continue;
    const bad = (info & WRONG) !== 0;
    for (let j = 0; j < 3; j++) {
      const e = edges.add(wid[idx[t * 3 + j]], wid[idx[t * 3 + (j + 1) % 3]], 0);
      if (edges.fresh) { eright[e] = ewrong[e] = 0; efirst[e] = -1; }
      if (!bad) eright[e]++;
      else if (ewrong[e]++ === 0) efirst[e] = t;
    }
    if (bad) { parent[t] = t; cAgainst[t] = cAlong[t] = 0; }
  }
  for (let t = 0; t < T; t++) {
    const info = tinfo[t];
    if ((info & (WRONG | COLLAPSED | PAIRED)) !== WRONG) continue;
    const k = tkey[t];
    // Its right copies (same corners, same winding) run all three edges its way too: not neighbours
    let against = -3 * rseen[k * 2 + ((info & ODD) ? 1 : 0)], along = 0;
    for (let j = 0; j < 3; j++) {
      const p = wid[idx[t * 3 + j]], q = wid[idx[t * 3 + (j + 1) % 3]];
      against += eright[edges.get(p, q, 0)];
      const back = edges.get(q, p, 0);
      if (back < 0) continue;
      along += eright[back];
      if (ewrong[back]) { const x = find(t), y = find(efirst[back]); if (x !== y) parent[x] = y; }
    }
    tAgainst[t] = Math.max(0, against);
    tAlong[t] = along;
  }
  for (let t = 0; t < T; t++) {
    if ((tinfo[t] & (WRONG | COLLAPSED | PAIRED)) !== WRONG) continue;
    const p = find(t);
    cAgainst[p] += tAgainst[t];
    cAlong[p] += tAlong[t];
  }
  let islands = false;
  for (let t = 0; t < T; t++) {
    const info = tinfo[t];
    if (!(info & WRONG) || (info & PAIRED)) continue;
    if (info & COLLAPSED) { island++; continue; }
    const p = find(t), against = cAgainst[p], along = cAlong[p];
    if (against > along) { tinfo[t] |= OUTLIER; outlier++; }
    else if (along > against) { tinfo[t] |= FOLD; fold++; }
    else if (!along) { tinfo[t] |= ISLAND; island++; islands = true; }
    else { tinfo[t] |= MIXED; mixed++; }
  }
  // Islands: does the piece's winding face away from its own centre (so its normals point in: wrong
  // normals) or towards it (a piece inside out: a mirrored placement, or the inside of a room)? Only
  // reported: open shells seen from inside face in on purpose, so it's evidence, not a verdict.
  if (islands) {
    const tri = (t, fn) => {
      const a = vBase + idx[t * 3] * stride, b = vBase + idx[t * 3 + 1] * stride, c = vBase + idx[t * 3 + 2] * stride;
      const ux = f32[c] - f32[b], uy = f32[c + 1] - f32[b + 1], uz = f32[c + 2] - f32[b + 2];
      const vx = f32[a] - f32[b], vy = f32[a + 1] - f32[b + 1], vz = f32[a + 2] - f32[b + 2];
      fn((f32[a] + f32[b] + f32[c]) / 3, (f32[a + 1] + f32[b + 1] + f32[c + 1]) / 3, (f32[a + 2] + f32[b + 2] + f32[c + 2]) / 3,
        uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
    };
    for (let t = 0; t < T; t++) if (tinfo[t] & ISLAND) { const p = find(t) * 5; piece[p] = piece[p + 1] = piece[p + 2] = piece[p + 3] = piece[p + 4] = 0; }
    for (let t = 0; t < T; t++) {
      if (!(tinfo[t] & ISLAND)) continue;
      const p = find(t) * 5;
      tri(t, (gx, gy, gz, nx, ny, nz) => {
        const w = Math.sqrt(nx * nx + ny * ny + nz * nz); // twice the area: only ratios matter
        piece[p] += gx * w; piece[p + 1] += gy * w; piece[p + 2] += gz * w; piece[p + 3] += w;
      });
    }
    for (let t = 0; t < T; t++) {
      if (!(tinfo[t] & ISLAND)) continue;
      const p = find(t) * 5, w = piece[p + 3];
      tri(t, (gx, gy, gz, nx, ny, nz) => {
        const dx = gx - piece[p] / w, dy = gy - piece[p + 1] / w, dz = gz - piece[p + 2] / w;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d > 1e-4) piece[p + 4] += (nx * dx + ny * dy + nz * dz) / d; // cos(face, away from the centre), area-weighted
      });
    }
    for (let t = 0; t < T; t++) {
      if (!(tinfo[t] & ISLAND)) continue;
      const p = find(t) * 5, out = piece[p + 4] / piece[p + 3];
      if (out > FACES_OUT) islandOut++;
      else if (out < -FACES_OUT) islandIn++;
    }
  }
  acc[r + F.islandOut] += islandOut;
  acc[r + F.islandIn] += islandIn;
  acc[r + F.paired] += paired;
  acc[r + F.outlier] += outlier;
  acc[r + F.fold] += fold;
  acc[r + F.island] += island;
  acc[r + F.mixed] += mixed;
}

// ---------------------------------------------------------------- per map

function auditMap(id) {
  const t0 = Date.now();
  const dir = `${ROOT}/${id}`;
  const manifest = JSON.parse(fs.readFileSync(`${dir}/manifest.json`, 'utf8'));
  const mats = manifest.materials;
  const cats = mats.map(category);
  // The Unreal towns (tools/ueconv) say where their sea is; the GTA V maps (tools/gta5conv) have their own
  const converter = Number.isFinite(manifest.stats?.seaLevel) || id.startsWith('carla') ? 'ueconv' : 'gta5conv';
  const acc = new Float64Array(mats.length * NF);
  const outCells = fixDir ? path.join(fixDir, id, 'cells') : inPlace ? `${dir}/cells` : null;
  if (fixDir) fs.mkdirSync(outCells, { recursive: true });
  let cells = 0, missing = 0, bad = 0, batches = 0, written = 0;
  const changes = {};
  for (const c of manifest.cells) {
    if (c.render === false) continue;
    let buf;
    try { buf = fs.readFileSync(`${dir}/cells/${c.id}.bin`); } catch { missing++; continue; }
    if (buf.byteOffset % 4) buf = Buffer.from(buf); // typed views need 4-byte alignment
    let header;
    const len = buf.length >= 4 ? buf.readUInt32LE(0) : 0;
    try { header = JSON.parse(buf.toString('utf8', 4, 4 + len)); } catch { bad++; continue; }
    const f32 = new Float32Array(buf.buffer, buf.byteOffset, buf.length >> 2);
    let offset = 4 + len;
    offset += (4 - (offset % 4)) % 4;
    const parts = []; // per batch: vertex bytes and index list, for a rewrite
    let changed = false, broken = false, cellFlipped = 0, cellDropped = 0;
    for (const b of header.batches) {
      const stride = b.colors ? 9 : 8;
      const vBytes = b.vertices * stride * 4;
      const ni = b.indices;
      if (offset + vBytes + ni * 4 > buf.length) { broken = true; break; }
      const idx = new Uint32Array(buf.buffer, buf.byteOffset + offset + vBytes, ni);
      const cat = cats[b.material] ?? 'opaque';
      const fixed = auditBatch(f32, offset >> 2, stride, b.vertices, idx, IN_GAME.has(cat), cat === 'opaque', acc, b.material, fixing);
      batches++;
      if (fixing) parts.push([buf.subarray(offset, offset + vBytes), fixed ?? idx]);
      if (fixed) {
        changed = true;
        b.indices = fixed.length;
        cellFlipped += last.flipped;
        cellDropped += last.dropped;
      }
      offset += vBytes + ni * 4;
    }
    if (broken) { bad++; continue; } // cut short (mid re-conversion?): counted as far as it goes, never rewritten
    cells++;
    if (changed) {
      writeCell(path.join(outCells, `${c.id}.bin`), header, parts);
      changes[c.id] = { flipped: cellFlipped, dropped: cellDropped };
      written++;
    }
  }
  if (fixDir) fs.writeFileSync(path.join(fixDir, id, 'fix.json'), JSON.stringify({ map: id, flip, cells: changes }, null, 1));

  // Per material, then per map
  const materials = [];
  const used = [];
  for (let m = 0; m < mats.length; m++) {
    const r = m * NF;
    if (!acc[r + F.batches]) continue;
    used.push(m);
    const row = Object.fromEntries(FIELDS.map((k, i) => [k, acc[r + i]]));
    if (!(row.wrong || row.dupSame || row.dupReversed || row.degenerate || row.sideways)) continue;
    materials.push({ map: id, converter, material: m, shader: mats[m].shader, diffuse: mats[m].diffuse, category: cats[m], ...row,
      ratio: row.tris ? row.wrong / row.tris : 0, judgedRatio: row.judged ? row.wrong / row.judged : 0 });
  }
  const sum = (field, pick = () => true) => used.reduce((s, m) => s + (pick(m) ? acc[m * NF + F[field]] : 0), 0);
  const opaque = (m) => cats[m] === 'opaque';
  const byCategory = {};
  for (const m of used) {
    const k = (byCategory[cats[m]] ??= { materials: 0, tris: 0, wrong: 0 });
    k.materials++;
    k.tris += acc[m * NF + F.tris];
    k.wrong += acc[m * NF + F.wrong];
  }
  const suspects = materials.filter((q) => q.category === 'opaque' && q.judged >= MIN_JUDGED && q.judgedRatio >= INVERTED);
  const summary = {
    id, converter, cells, missingCells: missing, badCells: bad, batches,
    triangles: sum('tris'), degenerate: sum('degenerate'),
    duplicates: sum('dupSame') + sum('dupReversed'), dupSame: sum('dupSame'), dupReversed: sum('dupReversed'),
    opaqueTriangles: sum('tris', opaque), judged: sum('judged', opaque), woundWrong: sum('wrong', opaque),
    ...Object.fromEntries(['paired', 'outlier', 'fold', 'island', 'mixed', 'islandOut', 'islandIn', 'facingDown', 'facingUp', 'walls', 'sideways', 'invertedBatches']
      .map((k) => [k, sum(k, opaque)])),
    invertedBatchTris: sum('invertedTris', opaque),
    suspectMaterials: suspects.length, suspectTris: suspects.reduce((s, q) => s + q.wrong, 0),
    // What the game's check covers besides (see `category`): flagged there, and flipped by its fix()
    inGameOnlyWrong: sum('wrong', (m) => IN_GAME.has(cats[m]) && !opaque(m)),
    materialCount: {
      total: mats.length, used: used.length,
      oneSided: mats.filter((q) => !q.mask).length, usedOneSided: used.filter((m) => !mats[m].mask).length,
    },
    byCategory,
    ...(fixing ? { fix: { flip, flipped: sum('flipped'), dropped: sum('dropped'), cellsWritten: written, to: outCells } } : {}),
    seconds: +((Date.now() - t0) / 1000).toFixed(1),
  };
  return { summary, materials };
}

/** A cell again: the header with the new index counts, padding, then each batch's vertices and indices. */
function writeCell(file, header, parts) {
  const json = Buffer.from(JSON.stringify(header));
  const head = Buffer.alloc(4 + json.length + ((4 - ((4 + json.length) % 4)) % 4));
  head.writeUInt32LE(json.length, 0);
  json.copy(head, 4);
  const chunks = [head];
  for (const [verts, idx] of parts) chunks.push(verts, Buffer.from(idx.buffer, idx.byteOffset, idx.byteLength));
  // Written beside it and renamed: a reader (the dev server) never sees half a file
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, Buffer.concat(chunks));
  fs.renameSync(tmp, file);
}

// ---------------------------------------------------------------- run and report

const results = [];
const allMaterials = [];
for (const id of maps) {
  const { summary: s, materials } = auditMap(id);
  results.push(s);
  allMaterials.push(...materials);
  console.log(`${id}: ${s.triangles} tris; wound wrong ${s.woundWrong} (${pct(s.woundWrong, s.opaqueTriangles)} of opaque: paired ${s.paired}, ` +
    `outlier ${s.outlier}, fold ${s.fold}, island ${s.island} (out ${s.islandOut}, in ${s.islandIn}), mixed ${s.mixed}); sideways normals ${pct(s.sideways, s.walls)} of walls; ` +
    `duplicates ${s.dupSame} + ${s.dupReversed} back-to-back; degenerate ${s.degenerate}` +
    (s.fix ? `; fixed: ${s.fix.flipped} flipped, ${s.fix.dropped} dropped in ${s.fix.cellsWritten} cells` : '') + ` (${s.seconds} s)`);
}

function pct(a, b) { return b ? `${((100 * a) / b).toFixed(a && a < b / 1000 ? 3 : 1)} %` : '–'; }
const num = (v) => Math.round(v).toLocaleString('en-US');
const total = (k, list = results) => list.reduce((s, r) => s + r[k], 0);

fs.mkdirSync(reportDir, { recursive: true });
const byWrong = allMaterials.filter((m) => m.category === 'opaque' && m.wrong).sort((a, b) => b.wrong - a.wrong);
const suspects = byWrong.filter((m) => m.judged >= MIN_JUDGED && m.judgedRatio >= INVERTED);
const inGameOnly = allMaterials.filter((m) => m.category !== 'opaque' && IN_GAME.has(m.category) && m.wrong).sort((a, b) => b.wrong - a.wrong);
const KEYS = ['triangles', 'opaqueTriangles', 'judged', 'woundWrong', 'paired', 'outlier', 'fold', 'island', 'mixed', 'islandOut', 'islandIn', 'facingDown', 'walls', 'sideways',
  'invertedBatches', 'invertedBatchTris', 'suspectTris', 'dupSame', 'dupReversed', 'degenerate', 'inGameOnlyWrong'];
fs.writeFileSync(`${reportDir}/summary.json`, JSON.stringify({
  generated: new Date().toISOString(),
  criteria: { quantise: `1/${Q} m`, wrongCos: WRONG_COS, minArea2: MIN_AREA2, degenerate: DEGENERATE, inverted: INVERTED, minJudged: MIN_JUDGED },
  totals: Object.fromEntries(KEYS.map((k) => [k, total(k)])),
  byConverter: Object.fromEntries(['gta5conv', 'ueconv'].map((c) => [c, Object.fromEntries(KEYS.map((k) => [k, total(k, results.filter((r) => r.converter === c))]))])),
  maps: results,
  materials: allMaterials,
}, null, 1));

const md = [];
md.push('# Mesh audit', '', `\`node scripts/mesh-audit.mjs\`, ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC. ` +
  'Criteria as src/audit.ts checkMeshes: wound wrong = cos(winding normal, summed vertex normals) < −0.9 and |n| > 0.02, opaque materials only; ' +
  'duplicates = same corners (2 cm grid) in one batch; degenerate = |n| < 1e-6. Paired / outlier / fold / island / mixed and "sideways" are defined in the script header: ' +
  'only outliers are wound wrong for certain; folds are correct windings with wrong normals.', '');
md.push('## Per map', '');
md.push('| map | conv | triangles | opaque | wound wrong | % of opaque | paired | outlier | fold | island (faces out / in) | mixed | level, facing down | ≥90 % batches | sideways normals (of walls) | duplicates same / back-to-back | degenerate | one-sided mats (used) |');
md.push('|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|');
const mapRow = (r, name, conv, mats) => `| ${name} | ${conv} | ${num(r.triangles)} | ${num(r.opaqueTriangles)} | ${num(r.woundWrong)} | ${pct(r.woundWrong, r.opaqueTriangles)} | ` +
  `${num(r.paired)} | ${num(r.outlier)} | ${num(r.fold)} | ${num(r.island)} (${num(r.islandOut)} / ${num(r.islandIn)}) | ${num(r.mixed)} | ${num(r.facingDown)} | ${num(r.invertedBatches)} | ` +
  `${pct(r.sideways, r.walls)} | ${num(r.dupSame)} / ${num(r.dupReversed)} | ${num(r.degenerate)} | ${mats} |`;
for (const r of results) md.push(mapRow(r, r.id, r.converter, `${r.materialCount.usedOneSided} / ${r.materialCount.used}`));
const totals = Object.fromEntries(KEYS.map((k) => [k, total(k)]));
md.push(mapRow(totals, '**all**', '', ''), '');
if (fixing) {
  md.push('## Repairs', '', `Flip policy: ${flip}. Written to ${fixDir ?? `${ROOT}/<id>/cells (in place)`}.`, '', '| map | flipped | dropped | cells written |', '|---|--:|--:|--:|');
  for (const r of results) md.push(`| ${r.id} | ${num(r.fix.flipped)} | ${num(r.fix.dropped)} | ${r.fix.cellsWritten} |`);
  md.push('');
}
const matHead = ['| map | # | shader | diffuse | triangles | wound wrong | of all | of judged | paired / outlier / fold / island (out / in) / mixed | level down / up | sideways (of walls) | ≥90 % batches |',
  '|---|--:|---|---|--:|--:|--:|--:|--:|--:|--:|--:|'];
const matRow = (m) => `| ${m.map} | ${m.material} | ${m.shader || '–'} | ${m.diffuse ?? '–'} | ${num(m.tris)} | ${num(m.wrong)} | ${pct(m.wrong, m.tris)} | ${pct(m.wrong, m.judged)} | ` +
  `${num(m.paired)} / ${num(m.outlier)} / ${num(m.fold)} / ${num(m.island)} (${num(m.islandOut)} / ${num(m.islandIn)}) / ${num(m.mixed)} | ${num(m.facingDown)} / ${num(m.facingUp)} | ${num(m.sideways)} / ${num(m.walls)} | ${m.invertedBatches} / ${m.batches} |`;
md.push(`## Top ${TOP} materials by wound-wrong triangles`, '', ...matHead, ...byWrong.slice(0, TOP).map(matRow), '');
md.push(`## Materials ≥ ${INVERTED * 100} % wound wrong (of ≥ ${MIN_JUDGED} judged triangles)`, '');
const perMap = {};
for (const m of suspects) { const p = (perMap[m.map] ??= { n: 0, wrong: 0 }); p.n++; p.wrong += m.wrong; }
md.push(`${suspects.length} materials, ${num(suspects.reduce((s, m) => s + m.wrong, 0))} triangles` +
  (suspects.length ? `: ${Object.entries(perMap).map(([k, v]) => `${k} ${v.n} (${num(v.wrong)})`).join(', ')}.` : '.') +
  ` Whole batches (one material in one cell) ≥ ${INVERTED * 100} % wrong: ${num(totals.invertedBatches)}, holding ${num(totals.invertedBatchTris)} wound-wrong triangles ` +
  `(${results.filter((r) => r.invertedBatches).map((r) => `${r.id} ${num(r.invertedBatches)}`).join(', ') || 'none'}).`, '');
if (suspects.length) md.push(...matHead, ...suspects.slice(0, 60).map(matRow), suspects.length > 60 ? `\n…and ${suspects.length - 60} more in summary.json.\n` : '');
const bySideways = allMaterials.filter((m) => m.category === 'opaque' && m.sideways).sort((a, b) => b.sideways - a.sideways);
if (bySideways.length) {
  md.push('## Top 15 materials by sideways wall normals', '', 'Wall faces whose stored normal is turned 45–135° from the face: the normals don\'t belong to this geometry (winding can\'t explain it).', '',
    ...matHead, ...bySideways.slice(0, 15).map(matRow), '');
}
if (inGameOnly.length) {
  md.push('## Flagged in materials the game checks but shouldn\'t', '', 'Shadow proxies, and names that say see-through (the game\'s name test never fires, see `category` in the script). Its fix() flips these too.', '',
    ...matHead, ...inGameOnly.slice(0, 15).map(matRow), '');
}

// Interpretation, from the numbers
const W = totals.woundWrong;
md.push('## Interpretation', '');
md.push(`- ${num(W)} opaque triangles are wound against their normals (${pct(W, totals.opaqueTriangles)} of opaque). ` +
  `${pct(totals.suspectTris, W)} of them are in materials ≥ ${INVERTED * 100} % wrong, ${pct(totals.invertedBatchTris, W)} in batches ≥ ${INVERTED * 100} % wrong.`);
md.push(`- Which side is wrong: outlier ${pct(totals.outlier, W)} (winding contradicted by the right surface around it: flip), ` +
  `fold ${pct(totals.fold, W)} (winding agrees with the right surface around it, the normals are wrong: flipping would cut a hole), ` +
  `paired ${pct(totals.paired, W)} (back-to-back twins), mixed ${pct(totals.mixed, W)} (no verdict), island ${pct(totals.island, W)} ` +
  `(of which ${pct(totals.islandOut, totals.island)} are pieces whose winding faces away from their centre, so their normals point in, and ${pct(totals.islandIn, totals.island)} face in: inside out, or seen from inside). ` +
  (totals.outlier < 0.05 * W ? 'Almost nothing is wound wrong for certain: this is a normals problem, and flipping windings (the game\'s fix()) would do more harm than good.' : ''));
for (const c of ['gta5conv', 'ueconv']) {
  const l = results.filter((r) => r.converter === c);
  if (!l.length) continue;
  const t = Object.fromEntries(KEYS.map((k) => [k, total(k, l)]));
  md.push(`- ${c} (${l.map((r) => r.id).join(', ')}): ${num(t.woundWrong)} wound wrong of ${num(t.opaqueTriangles)} opaque (${pct(t.woundWrong, t.opaqueTriangles)}); ` +
    `outlier ${num(t.outlier)}, fold ${num(t.fold)}, island ${num(t.island)} (out ${num(t.islandOut)}, in ${num(t.islandIn)}), paired ${num(t.paired)}. Wall normals turned sideways: ${pct(t.sideways, t.walls)} of ${num(t.walls)}` +
    (t.sideways > 0.05 * t.walls ? ' — far beyond smoothing: the normals are rotated relative to their faces, a normal transform bug in the converter; the wound-wrong walls are the same error at ~180°.' : '.'));
}
const twisted = results.filter((r) => r.walls >= 1000 && r.sideways > 0.05 * r.walls);
if (twisted.length) md.push(`- Maps with more than 5 % of wall normals turned sideways: ${twisted.map((r) => `${r.id} ${pct(r.sideways, r.walls)}`).join(', ')}.`);
md.push(`- Duplicates: ${num(totals.dupSame)} same-winding copies (z-fighting; a fix drops them) and ${num(totals.dupReversed)} back-to-back pairs (thin two-sided surfaces: kept, though the game's duplicateFinder counts and its fix() drops them).`);
md.push(`- The game's check also covers shadow proxies and see-through names: ${num(totals.inGameOnlyWrong)} more triangles would be flagged there, and flipped by its fix().`);
md.push(`- ${num(totals.degenerate)} degenerate triangles: invisible, left as they are.`, '');
fs.writeFileSync(`${reportDir}/report.md`, md.join('\n'));
console.log(`→ ${reportDir}/summary.json, ${reportDir}/report.md`);
