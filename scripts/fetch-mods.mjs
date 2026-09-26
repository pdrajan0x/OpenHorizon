#!/usr/bin/env node
// Fetches the third-party GTA V mod archives listed in assets/mods.json into
// .mods/<id>/ (gitignored) and extracts them with bsdtar. Local personal use only:
// nothing here is redistributed, and nothing downloaded is ever executed.
//
// Usage:
//   node scripts/fetch-mods.mjs                 # fetch + extract every missing entry
//   node scripts/fetch-mods.mjs id1 id2         # only these ids
//   node scripts/fetch-mods.mjs --category hero # only one category
//   node scripts/fetch-mods.mjs --list          # show status, download nothing
//   node scripts/fetch-mods.mjs --mark          # also set "downloaded": true in mods.json
//
// Idempotent: an entry is skipped when .mods/<id>/.extracted.json exists. Entries with a
// "rejected" reason are catalogued for reference but never fetched.
// After each run .mods/READY.txt is rewritten with one line per extracted mod
// pointing at its main model files (loose .yft/_hi.yft/.ytd, or the same inside dlc.rpf), or for
// map/prop/building/vegetation/audio entries the folder plus GTA file-type counts.

import { spawnSync } from 'node:child_process';
import { closeSync, createWriteStream, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MODS_JSON = join(ROOT, 'assets', 'mods.json');
const MODS_DIR = join(ROOT, '.mods');
const READY = join(MODS_DIR, 'READY.txt');
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const BUDGET = Number(process.env.MODS_BUDGET_GB ?? 15) * 1024 ** 3;
const DELAY_MS = 1500;
const ARCHIVE_EXT = new Set(['.zip', '.rar', '.7z', '.oiv']); // .oiv packages are zip files
// Never extract anything executable or scriptable.
const EXCLUDE = ['*.exe', '*.dll', '*.asi', '*.lua', '*.bat', '*.cmd', '*.ps1', '*.vbs', '*.msi', '*.jar', '*.scr', '*.com', '*.js', '*.sh', '*.lnk', '*.url'];

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const category = opt('--category');
const ids = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--category');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mb = (n) => `${(n / 1024 ** 2).toFixed(1)} MB`;

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile()) out.push(p);
  }
  return out;
}

function bsdtar(archive, dest) {
  mkdirSync(dest, { recursive: true });
  const r = spawnSync('bsdtar', ['-xf', archive, '-C', dest, ...EXCLUDE.flatMap((p) => ['--exclude', p])], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`bsdtar failed on ${basename(archive)}: ${r.stderr.trim()}`);
}

// Mediafire "file" pages only expose a short-lived direct link; scrape it at download time.
async function resolveUrl(url, referer) {
  if (!/^https:\/\/www\.mediafire\.com\/file\//.test(url)) return url;
  const html = await (await fetch(url, { headers: { 'User-Agent': UA, Referer: referer } })).text();
  const direct = html.match(/https:\/\/download\d+\.mediafire\.com\/[^"'\s<>]+/);
  if (!direct) throw new Error(`no direct link on ${url}`);
  return direct[0];
}

async function download(part, referer, dest) {
  const url = await resolveUrl(part.url, referer);
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Referer: referer, Accept: '*/*', 'Accept-Language': 'en-US,en;q=0.9' },
    redirect: 'follow',
  });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${url}`);
  const type = res.headers.get('content-type') ?? '';
  if (type.includes('text/html')) throw new Error(`got an HTML page instead of an archive (${url})`);
  const tmp = `${dest}.part`;
  await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
  const size = statSync(tmp).size;
  if (part.bytes && size !== part.bytes) console.warn(`  ! size ${size} differs from expected ${part.bytes}`);
  renameSync(tmp, dest);
  return size;
}

// Archives of an entry: fileUrl plus optional extraFiles [{url, bytes}] (mods split into parts).
const partsOf = (e) => [{ url: e.fileUrl, bytes: e.archiveBytes }, ...(e.extraFiles ?? [])];
const totalBytes = (e) => partsOf(e).reduce((s, p) => s + (p.bytes || 0), 0);
const archiveName = (url) => {
  const segs = new URL(url).pathname.split('/').filter(Boolean);
  const name = segs.at(-1) === 'file' && segs.length > 1 ? segs.at(-2) : segs.at(-1); // mediafire: /file/<id>/<name>/file
  return decodeURIComponent(name).replace(/[^\w.\-\[\]() ]+/g, '_');
};

// Extract the archive(s) into x/, then unpack nested archives (two levels deep) next to themselves.
function extractAll(archives, xdir) {
  rmSync(xdir, { recursive: true, force: true });
  for (const archive of archives) bsdtar(archive, xdir);
  for (let depth = 0; depth < 2; depth++) {
    const nested = walk(xdir).filter((f) => ARCHIVE_EXT.has(extname(f).toLowerCase()) && !existsSync(`${f}.x`));
    if (!nested.length) break;
    for (const n of nested) {
      try { bsdtar(n, `${n}.x`); } catch (e) { console.warn(`  ! nested: ${e.message}`); }
    }
  }
  // Drop files from nested extractions that duplicate a file already present (same name + size).
  const all = walk(xdir);
  const outer = new Set(all.filter((f) => !/\.(zip|rar|7z|oiv)\.x\//i.test(relative(xdir, f))).map((f) => `${basename(f).toLowerCase()}:${statSync(f).size}`));
  for (const f of all) {
    if (/\.(zip|rar|7z|oiv)\.x\//i.test(relative(xdir, f)) && outer.has(`${basename(f).toLowerCase()}:${statSync(f).size}`)) rmSync(f);
  }
}

const VEHICLE = new Set(['hero', 'cyberpunk', 'traffic']);
const rank = (p) => (p.includes('::') ? 3 : /fivem|stream|resource/i.test(p) ? 0 : /replace/i.test(p) ? 1 : 2);

// Read-only listing of an RPF7 archive's table of contents (unencrypted "OPEN" archives,
// which is what OpenIV writes for mods). Recurses into nested .rpf entries. Returns inner
// paths like "x64/vehicles.rpf/sf90.yft". Nothing is extracted.
function rpfList(file) {
  const out = [];
  const fd = openSync(file, 'r');
  const read = (pos, len) => { const b = Buffer.alloc(len); readSync(fd, b, 0, len, pos); return b; };
  const ls = (base, prefix, depth) => {
    const h = read(base, 16);
    if (h.readUInt32LE(0) !== 0x52504637) return;
    const [count, namesLen, enc] = [h.readUInt32LE(4), h.readUInt32LE(8), h.readUInt32LE(12)];
    if (enc !== 0x4e45504f && enc !== 0) { out.push(`${prefix}<encrypted-toc>`); return; }
    const ents = read(base + 16, count * 16);
    const names = read(base + 16 + count * 16, namesLen);
    const name = (o) => names.toString('utf8', o, names.indexOf(0, o));
    const E = [];
    for (let i = 0; i < count; i++) {
      const o = i * 16, lo = ents.readUInt32LE(o), hi = ents.readUInt32LE(o + 4);
      if (hi === 0x7fffff00) E.push({ dir: true, name: name(lo), start: ents.readUInt32LE(o + 8), n: ents.readUInt32LE(o + 12) });
      else E.push({ dir: false, name: name(lo & 0xffff), block: (hi & 0x80000000 ? (hi >>> 8) & 0x7fffff : (hi >>> 8) & 0xffffff) });
    }
    const walkToc = (i, path) => {
      const e = E[i];
      if (e.dir) { for (let j = e.start; j < e.start + e.n; j++) walkToc(j, i === 0 ? path : `${path}${e.name}/`); return; }
      out.push(prefix + path + e.name);
      if (depth < 4 && e.name.toLowerCase().endsWith('.rpf')) ls(base + e.block * 512, `${prefix}${path}${e.name}/`, depth + 1);
    };
    if (E.length) walkToc(0, '');
  };
  try { ls(0, '', 0); } finally { closeSync(fd); }
  return out;
}

// Every GTA file of an extracted mod: loose paths (relative to repo root) plus
// "<dlc.rpf path>::<inner path>" for files packed inside top-level RPF archives.
function inventory(dir) {
  const items = [];
  for (const f of walk(dir)) {
    const r = relative(ROOT, f);
    items.push(r);
    if (extname(f).toLowerCase() === '.rpf') {
      try { for (const inner of rpfList(f)) items.push(`${r}::${inner}`); } catch (e) { console.warn(`  ! rpf ${r}: ${e.message}`); }
    }
  }
  return items;
}

const COUNT_KEYS = ['.ydr', '.ydd', '.yft', '.ytd', '.ybn', '.ytyp', '.ymap', '.ynd', '.ynv', '.awc', '.rel', '.rpf', '.oiv'];

function summarize(entry, dir) {
  const items = inventory(dir);
  const ext = (p) => extname(p).toLowerCase();
  if (!VEHICLE.has(entry.category)) {
    // Maps/props/audio: prefer the loose (FiveM "stream") copy when it has most of the meshes,
    // else the dlc.rpf with the most entries. Counts are reported separately for both copies.
    const stats = (list) => {
      const count = {};
      for (const f of list) count[ext(f)] = (count[ext(f)] ?? 0) + 1;
      return COUNT_KEYS.filter((k) => count[k] && k !== '.rpf').map((k) => `${k.slice(1)}=${count[k]}`).join(' ') || '-';
    };
    const inRpf = items.filter((f) => f.includes('::'));
    const loose = items.filter((f) => !f.includes('::'));
    const topRpfs = loose.filter((f) => ext(f) === '.rpf');
    const inner = (r) => inRpf.filter((f) => f.startsWith(`${r}::`)).length;
    const mainRpf = [...topRpfs].sort((a, b) => inner(b) - inner(a))[0];
    const meshes = (list) => list.filter((f) => ['.ydr', '.ydd', '.yft', '.awc'].includes(ext(f))).length;
    // Common ancestor of the folders that together hold >= 90% of the loose meshes.
    const perDir = new Map();
    for (const f of loose) if (['.ydr', '.ydd', '.yft', '.awc'].includes(ext(f))) perDir.set(dirname(f), (perDir.get(dirname(f)) ?? 0) + 1);
    const ranked = [...perDir].sort((a, b) => b[1] - a[1]);
    const core = [];
    for (let acc = 0, total = meshes(loose); acc < 0.9 * total && core.length < ranked.length; ) { acc += ranked[core.length][1]; core.push(ranked[core.length][0]); }
    const looseRoot = core.length
      ? core.reduce((a, b) => { while (a && a !== '.' && !(`${b}/`).startsWith(`${a}/`)) a = dirname(a); return a; })
      : undefined;
    const main = looseRoot && meshes(loose) >= 0.8 * meshes(inRpf) ? looseRoot : (mainRpf ?? relative(ROOT, dir));
    const head = entry.category === 'map' ? `MAP\t${entry.id}` : `${entry.id}\t${entry.category}`;
    return [`${head}\t${main}\trpf[${stats(inRpf)}] (${topRpfs.length} rpf)\tloose[${stats(loose)}]`];
  }
  // Vehicles: <name>.yft with a sibling <name>.ytd or <name>_hi.yft. Loose FiveM/stream first,
  // then Replace folders, then models inside dlc.rpf ("path/dlc.rpf::x64/vehicles.rpf/x.yft").
  const pick = entry.files?.length ? entry.files.map((f) => relative(ROOT, join(dir, f))) : items;
  const lower = new Map(pick.map((f) => [f.toLowerCase(), f]));
  const mains = pick
    .filter((f) => ext(f) === '.yft' && !/_hi\.yft$/i.test(f))
    .filter((f) => lower.has(f.toLowerCase().replace(/\.yft$/, '.ytd')) || lower.has(f.toLowerCase().replace(/\.yft$/, '_hi.yft')))
    .sort((a, b) => rank(a) - rank(b) || a.length - b.length);
  const seen = new Set();
  const lines = [];
  for (const y of mains) {
    const name = basename(y).toLowerCase();
    if (seen.has(name)) continue;
    seen.add(name);
    const hi = lower.get(y.toLowerCase().replace(/\.yft$/, '_hi.yft'));
    const ytd = lower.get(y.toLowerCase().replace(/\.yft$/, '.ytd'));
    lines.push(`${entry.id}\t${entry.category}\t${y}\t${hi ?? '-'}\t${ytd ?? '-'}`);
  }
  if (lines.length) return lines;
  const rpf = items.filter((f) => ext(f) === '.rpf' && !f.includes('::'));
  return [`${entry.id}\t${entry.category}\tNO-MODEL-FOUND\t${rpf.join(' ') || '-'}`];
}

function writeReady(entries) {
  const lines = [
    '# Vehicles: id  category  main.yft  main_hi.yft  main.ytd',
    '# Maps:     MAP  id  main path (loose FiveM stream root if it holds the meshes, else biggest dlc.rpf)  rpf[counts inside RPFs]  loose[counts of loose files]',
    '# Others:   id  category  main path  rpf[counts]  loose[counts]',
    '# Paths are relative to the repo root; "a/dlc.rpf::x64/vehicles.rpf/car.yft" = file inside an unencrypted RPF7.',
  ];
  for (const e of entries) {
    const dir = join(MODS_DIR, e.id);
    if (existsSync(join(dir, '.extracted.json'))) lines.push(...summarize(e, join(dir, 'x')));
  }
  writeFileSync(`${READY}.tmp`, `${lines.join('\n')}\n`);
  renameSync(`${READY}.tmp`, READY);
}

async function main() {
  const all = JSON.parse(readFileSync(MODS_JSON, 'utf8'));
  const selected = all.filter((e) => (!ids.length || ids.includes(e.id)) && (!category || e.category === category) && e.fileUrl && !e.rejected);
  const planned = selected.reduce((s, e) => s + totalBytes(e), 0);
  console.log(`${selected.length} entries selected, ${mb(planned)} of archives (budget ${mb(BUDGET)})`);
  if (planned > BUDGET) throw new Error('selection exceeds MODS_BUDGET_GB');
  mkdirSync(MODS_DIR, { recursive: true });

  let first = true;
  const done = new Set();
  for (const e of selected) {
    const dir = join(MODS_DIR, e.id);
    const marker = join(dir, '.extracted.json');
    if (existsSync(marker)) { console.log(`= ${e.id} (already extracted)`); done.add(e.id); continue; }
    if (flag('--list')) { console.log(`- ${e.id} missing (${mb(totalBytes(e))})`); continue; }
    mkdirSync(dir, { recursive: true });
    try {
      const archives = [];
      for (const part of partsOf(e)) {
        const archive = join(dir, archiveName(part.url));
        if (!existsSync(archive)) {
          if (!first) await sleep(DELAY_MS);
          first = false;
          console.log(`v ${e.id}: downloading ${archiveName(part.url)} (${mb(part.bytes || 0)}) ...`);
          await download(part, e.pageUrl, archive);
        }
        archives.push(archive);
      }
      console.log(`x ${e.id}: extracting ${archives.map((a) => basename(a)).join(', ')}`);
      extractAll(archives, join(dir, 'x'));
      const files = walk(join(dir, 'x'));
      const bytes = archives.reduce((s, a) => s + statSync(a).size, 0);
      writeFileSync(marker, JSON.stringify({ archives: archives.map((a) => basename(a)), bytes, files: files.length, extractedAt: new Date().toISOString() }, null, 2));
      done.add(e.id);
      writeReady(all);
    } catch (err) {
      console.error(`! ${e.id}: ${err.message}`);
    }
  }

  // Verification: list the key model files per extracted entry.
  for (const e of selected) {
    if (!done.has(e.id)) continue;
    for (const line of summarize(e, join(MODS_DIR, e.id, 'x'))) console.log(`  ${line.replaceAll('\t', '  ')}`);
  }
  writeReady(all);

  if (flag('--mark')) {
    let changed = false;
    for (const e of all) if (done.has(e.id) && !e.downloaded) { e.downloaded = true; changed = true; }
    if (changed) writeFileSync(MODS_JSON, `${JSON.stringify(all, null, 2)}\n`);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
