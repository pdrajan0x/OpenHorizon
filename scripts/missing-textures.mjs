// Surfaces drawn without a texture, per city: materials with none (blank), or naming a texture whose file
// is missing or unreadable. Weighted by the area they cover. node scripts/missing-textures.mjs [map…]
//   → test-results/missing-textures.json (per map, per material: area m², where: a sample position)
import fs from 'node:fs';
const ids = process.argv.slice(2).length ? process.argv.slice(2) : JSON.parse(fs.readFileSync('public/mods/maps/index.json')).map((m) => m.id);
const out = {};
for (const id of ids) {
  const d = `public/mods/maps/${id}`;
  const m = JSON.parse(fs.readFileSync(`${d}/manifest.json`));
  const ok = (n) => { try { const b = Buffer.alloc(4); const h = fs.openSync(`${d}/tex/${n}.gtx`, 'r'); fs.readSync(h, b, 0, 4, 0); fs.closeSync(h); return b.toString() === 'GTX1'; } catch { return false; } };
  const bad = m.materials.map((x) => (/water|shadow_proxy/.test(x.shader) ? null : !x.diffuse ? 'no texture' : ok(x.diffuse) ? null : 'texture file missing'));
  const acc = new Map();
  for (const c of m.cells) {
    if (!c.render) continue;
    const b = fs.readFileSync(`${d}/cells/${c.id}.bin`); const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    const dv = new DataView(ab); const jl = dv.getUint32(0, true); const h = JSON.parse(new TextDecoder().decode(new Uint8Array(ab, 4, jl)));
    let off = 4 + jl; off += (4 - off % 4) % 4;
    for (const x of h.batches) {
      const st = x.colors ? 9 : 8; const v = new Float32Array(ab, off, x.vertices * st); off += x.vertices * st * 4; const ix = new Uint32Array(ab, off, x.indices); off += x.indices * 4;
      if (!bad[x.material]) continue;
      let a = 0;
      for (let t = 0; t < ix.length; t += 3) { const p = ix[t] * st, q = ix[t + 1] * st, r = ix[t + 2] * st; const ux = v[q] - v[p], uy = v[q + 1] - v[p + 1], uz = v[q + 2] - v[p + 2], wx = v[r] - v[p], wy = v[r + 1] - v[p + 1], wz = v[r + 2] - v[p + 2]; a += Math.hypot(uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx) / 2; }
      const k = x.material; const e = acc.get(k) ?? { area: 0, cells: 0, at: [v[0], v[1], v[2]] };
      e.area += a; e.cells++; acc.set(k, e);
    }
  }
  const list = [...acc].map(([k, e]) => ({ material: k, shader: m.materials[k].shader, texture: m.materials[k].diffuse ?? null, why: bad[k], area: Math.round(e.area), cells: e.cells, at: e.at.map((n) => Math.round(n)) })).sort((a, b) => b.area - a.area);
  out[id] = list;
  const tot = list.reduce((s, x) => s + x.area, 0);
  console.log(`${id.padEnd(15)} ${list.length} materials, ${(tot / 1e6).toFixed(2)} km²`);
  for (const x of list.slice(0, 5)) console.log(`   ${(x.area / 1e3).toFixed(0).padStart(6)}k m²  ${x.why.padEnd(20)} ${x.shader}${x.texture ? ' / ' + x.texture : ''}  (${x.cells} cells, e.g. map ${x.at.join(', ')})`);
}
fs.mkdirSync('test-results', { recursive: true });
fs.writeFileSync('test-results/missing-textures.json', JSON.stringify(out, null, 1));
