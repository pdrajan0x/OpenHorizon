// Tries world layouts without starting the game: places the cities the way src/islands.ts does, plans the
// bridges with the game's own planner (src/bridges.ts planLinks), and draws each world (land, the cities'
// roads, the bridges) with how well connected it is:
//   bridges per city, and how many separate places they leave from (all from one corner = a dead end)
//   single points of failure: bridges whose loss cuts part of the world off
//   drive distances: from each city's middle to every other's, through the cities and over the bridges,
//                    against the straight line
// A variant with `optimise` has its cities moved (100 m steps) until its links are short, straight bridges
// from each city's real exits (road near the shore), 500 m of sea at least between any two cities.
//
//   npx tsx scripts/layout-variants.mjs [variant …]     → test-results/layouts/<variant>.png, stats.json,
//                                                          and all.png (every variant) when none is named
//
// Bridges are drawn straight, gateway to gateway; in the game they leave each end along its road and
// swing in a gentle S, so they run a little longer.
globalThis.location = { search: '' }; // src/quality.ts reads it on import
const THREE = await import('three');
const { planLinks } = await import('../src/bridges.ts');
const { worldLayout, WORLD } = await import('../src/layout.ts');
const { execFileSync } = await import('node:child_process');
const fs = await import('node:fs');

const OUT = 'test-results/layouts';
const DIR = 'public/mods/maps';
const PACK_CELL = 100;

/** Each variant: the idea in a line, rough centres (km, x north, z east) and links [a, b, rank]. */
const T12 = 'carla-town12', T10 = 'carla-town10', CHI = 'chicago', LC = 'lordcity', UG = 'ugase-city';
const RIV = 'french-riviera', TSU = 'tsukuba', AK = 'akina', SHI = 'shibuya';
const VARIANTS = {
  current: { title: 'Now: three regions in a row', ...WORLD },
  hub: {
    title: 'Hub: Town 12 in the middle, every city around it', optimise: true,
    at: { [T12]: [0, 0], [LC]: [8.1, -4.5], [CHI]: [9.5, 2.0], [UG]: [-4.0, -8.9], [RIV]: [-7.7, -1.0], [SHI]: [-6.7, 3.6], [TSU]: [1.2, 8.2], [AK]: [5.0, 7.5], [T10]: [-8.5, -8.0] },
    links: [
      [T12, LC, 0], [T12, CHI, 0], [T12, UG, 0], [T12, RIV, 0], [T12, SHI, 0], [T12, TSU, 0],
      [LC, CHI, 1], [CHI, AK, 1], [AK, TSU, 1], [SHI, RIV, 1], [RIV, T10, 1], [T10, UG, 1],
    ],
  },
  ring: {
    title: 'Ring: a loop of cities round a bay, Town 10 an island in the middle', optimise: true,
    at: { [T12]: [0, -10], [LC]: [8.1, -14], [CHI]: [8.5, -7.4], [TSU]: [7.5, -0.8], [AK]: [11.5, -2], [SHI]: [3.5, 0.5], [UG]: [-5.8, 2.5], [RIV]: [-7.7, -4], [T10]: [0, -2] },
    links: [
      [T12, LC, 0], [LC, CHI, 0], [CHI, TSU, 0], [TSU, SHI, 0], [SHI, UG, 0], [UG, RIV, 0], [RIV, T12, 0],
      [TSU, AK, 1], [CHI, AK, 1], [T12, CHI, 1], [T10, T12, 2], [T10, CHI, 2], [T10, UG, 2],
    ],
  },
  ladder: {
    title: 'Ladder: Town 12 at one end, two rows of cities with bridges between them', optimise: true,
    at: { [T12]: [0, -8], [CHI]: [7.5, 0.3], [LC]: [5.2, 7.2], [AK]: [5.5, 12.0], [RIV]: [-5.0, -0.5], [UG]: [-5.2, 6.5], [TSU]: [-5.5, 12.8], [T10]: [0.5, 1.5], [SHI]: [0.2, 9.5] },
    links: [
      [T12, CHI, 0], [CHI, LC, 0], [LC, AK, 0], [T12, RIV, 0], [RIV, UG, 0], [UG, TSU, 0], [AK, TSU, 0],
      [T12, T10, 1], [CHI, T10, 1], [T10, RIV, 1], [LC, SHI, 1], [SHI, UG, 1],
    ],
  },
  regions: {
    title: 'Regions, fixed: Americas, Europe and Asia as now, Town 12 joined on three sides', optimise: true,
    at: { [T12]: [0, -16], [CHI]: [9.4, -13.5], [T10]: [0.5, -9.5], [RIV]: [-7.7, -17], [UG]: [-5.5, -8.0], [TSU]: [7.0, -5.0], [AK]: [11.0, -6.3], [LC]: [14.8, -9.0], [SHI]: [2.0, -3.5] },
    links: [
      [T12, CHI, 0], [T12, T10, 0], [T10, CHI, 0], [T12, RIV, 0],
      [RIV, UG, 1], [CHI, TSU, 1], [CHI, LC, 1], [T10, SHI, 1],
      [LC, AK, 0], [AK, TSU, 0], [TSU, SHI, 0], [SHI, UG, 0],
    ],
  },
};

// ── The cities, in their own frames ──
const area = (p) => Math.abs(p.reduce((s, [x1, z1], i) => { const [x2, z2] = p[(i + 1) % p.length]; return s + x1 * z2 - x2 * z1; }, 0) / 2);
const index = JSON.parse(fs.readFileSync(`${DIR}/index.json`, 'utf8'));
const cities = [];
for (const info of index) {
  const d = `${DIR}/${info.id}`;
  const stats = JSON.parse(fs.readFileSync(`${d}/island.json`, 'utf8'));
  const roads = JSON.parse(fs.readFileSync(`${d}/roads.json`, 'utf8'));
  const loops = stats.loops;
  const rect = [Infinity, Infinity, -Infinity, -Infinity];
  for (const l of loops) {
    if (!l.outer || area(l.points) < 50000) continue;
    for (const [x, z] of l.points) {
      rect[0] = Math.min(rect[0], x); rect[1] = Math.min(rect[1], z);
      rect[2] = Math.max(rect[2], x); rect[3] = Math.max(rect[3], z);
    }
  }
  cities.push({ id: info.id, name: info.name, roads, loops: loops.filter((l) => area(l.points) > 20000), rect, dy: stats.dy ?? 0, tops: stats.tops });
}

/** Land cells (PACK_CELL m) inside a city's loops (even-odd), as in src/islands.ts. */
function rasterize(loops) {
  const cells = [];
  let [minX, maxX] = [Infinity, -Infinity];
  for (const l of loops) for (const [x] of l.points) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); }
  for (let i = Math.floor(minX / PACK_CELL); i <= Math.ceil(maxX / PACK_CELL); i++) {
    const x = (i + 0.5) * PACK_CELL;
    const zs = [];
    for (const l of loops) {
      const p = l.points;
      for (let k = 0; k < p.length; k++) {
        const a = p[k];
        const b = p[(k + 1) % p.length];
        if ((a[0] <= x) !== (b[0] <= x)) zs.push(a[1] + ((x - a[0]) / (b[0] - a[0])) * (b[1] - a[1]));
      }
    }
    zs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < zs.length; k += 2) {
      for (let j = Math.floor(zs[k] / PACK_CELL); j <= Math.floor(zs[k + 1] / PACK_CELL); j++) cells.push([i, j]);
    }
  }
  return cells;
}
const masks = cities.map((c) => rasterize(c.loops));

function heightMap(tops, o) {
  if (!tops) return undefined;
  const h = new Int16Array(Uint8Array.from(Buffer.from(tops.h, 'base64')).buffer);
  return (x, z) => {
    const i = Math.floor((x - o.x - tops.x0) / tops.cell);
    const j = Math.floor((z - o.z - tops.z0) / tops.cell);
    if (i < 0 || j < 0 || i >= tops.nx || j >= tops.nz) return -Infinity;
    const v = h[i * tops.nz + j];
    return v === -32768 ? -Infinity : v + o.y;
  };
}

/** Undirected graph distances from one node (Dijkstra, binary heap). */
function dijkstra(adj, from) {
  const dist = new Float64Array(adj.length).fill(Infinity);
  dist[from] = 0;
  const heap = [[0, from]];
  const push = (e) => {
    heap.push(e);
    for (let i = heap.length - 1; i > 0;) {
      const p = (i - 1) >> 1;
      if (heap[p][0] <= heap[i][0]) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      for (let i = 0; ;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };
  while (heap.length) {
    const [d, n] = pop();
    if (d > dist[n]) continue;
    for (const [m, w] of adj[n]) {
      if (d + w < dist[m]) { dist[m] = d + w; push([d + w, m]); }
    }
  }
  return dist;
}

// ── Exits: where a bridge can leave each city (road nodes near its shore), for the placement search ──
const SEA_GAP = 500; // m of sea at least between two cities' land
const EXIT_SHORE = 800; // m: road nodes this near the shore can take a bridge
const EXIT_CELL = 250; // m: one exit (the one nearest the shore) per cell
for (const c of cities) {
  const shore = [];
  for (const l of c.loops) if (l.outer) for (let i = 0; i < l.points.length; i += 2) shore.push(l.points[i]);
  const G = 200;
  const grid = new Map();
  for (const p of shore) {
    const k = `${Math.floor(p[0] / G)},${Math.floor(p[1] / G)}`;
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(p);
  }
  const shoreDist = (x, z) => {
    const cx = Math.floor(x / G);
    const cz = Math.floor(z / G);
    let best = Infinity;
    for (let r = 0; r < 30; r++) {
      for (let i = -r; i <= r; i++) for (let j = -r; j <= r; j++) {
        if (Math.max(Math.abs(i), Math.abs(j)) !== r) continue;
        for (const p of grid.get(`${cx + i},${cz + j}`) ?? []) best = Math.min(best, Math.hypot(p[0] - x, p[1] - z));
      }
      if (best < r * G) break;
    }
    return best;
  };
  const lanes = c.roads.nodes.map(() => 0);
  for (const [a, b, ab, ba] of c.roads.links) { lanes[a] += ab + ba; lanes[b] += ab + ba; }
  const cells = new Map();
  c.roads.nodes.forEach(([x, y, z], i) => {
    if (!lanes[i] || y + c.dy < -1 || y + c.dy > 90) return;
    const sd = shoreDist(x, z);
    if (sd > EXIT_SHORE) return;
    const k = `${Math.floor(x / EXIT_CELL)},${Math.floor(z / EXIT_CELL)}`;
    const e = cells.get(k);
    if (!e || sd < e.sd) cells.set(k, { x, z, sd });
  });
  c.exits = [...cells.values()];
  // Land for the sea-gap test: the mask grown by SEA_GAP, and the mask's rim
  const R = Math.ceil(SEA_GAP / PACK_CELL);
  const mask = masks[cities.indexOf(c)];
  const own = new Set(mask.map(([i, j]) => `${i},${j}`));
  c.rim = mask.filter(([i, j]) => [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([a, b]) => !own.has(`${i + a},${j + b}`)));
  let [i0, j0, i1, j1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [i, j] of mask) { i0 = Math.min(i0, i); j0 = Math.min(j0, j); i1 = Math.max(i1, i); j1 = Math.max(j1, j); }
  c.grown = { i0: i0 - R, j0: j0 - R, ni: i1 - i0 + 2 * R + 1, nj: j1 - j0 + 2 * R + 1 };
  const g = new Uint8Array(c.grown.ni * c.grown.nj);
  const land = new Uint8Array(c.grown.ni * c.grown.nj);
  for (const [i, j] of c.rim) {
    for (let a = -R; a <= R; a++) for (let b = -R; b <= R; b++) {
      if (a * a + b * b > R * R) continue;
      g[(i + a - c.grown.i0) * c.grown.nj + (j + b - c.grown.j0)] = 1;
    }
  }
  for (const [i, j] of mask) { g[(i - c.grown.i0) * c.grown.nj + (j - c.grown.j0)] = 1; land[(i - c.grown.i0) * c.grown.nj + (j - c.grown.j0)] = 1; }
  c.grown.g = g;
  c.grown.land = land;
}

/** Is world point (x, z) on city c's land, with c's frame at offset (ox, oz)? */
const onLand = (c, ox, oz, x, z) => {
  const i = Math.floor((x - ox) / PACK_CELL) - c.grown.i0;
  const j = Math.floor((z - oz) / PACK_CELL) - c.grown.j0;
  return i >= 0 && j >= 0 && i < c.grown.ni && j < c.grown.nj && c.grown.land[i * c.grown.nj + j] === 1;
};

function segmentsCross(a, b, c, d) {
  const o = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0;
}

/**
 * Moves the cities (100 m steps) so the designed links are short, straight bridges from separate exits,
 * with SEA_GAP m of sea between any two cities and no bridge over a third city or across another bridge.
 * `off`: per city index, [x, z] of its frame (the anchor, the first placed city, stays put).
 */
function optimise(ks, off, links) {
  const cost = (o) => {
    let total = 0;
    const used = new Map(); // city → exits already taken, to spread a city's bridges out
    const segs = [];
    for (const [a, b] of links) {
      const A = cities[a];
      const B = cities[b];
      const [ax, az] = o.get(a);
      const [bx, bz] = o.get(b);
      // Straight across the channel between the two (as worldLayout picks the axis)
      const gx = Math.abs(ax + (A.rect[0] + A.rect[2]) / 2 - bx - (B.rect[0] + B.rect[2]) / 2) - (A.rect[2] - A.rect[0]) / 2 - (B.rect[2] - B.rect[0]) / 2;
      const gz = Math.abs(az + (A.rect[1] + A.rect[3]) / 2 - bz - (B.rect[1] + B.rect[3]) / 2) - (A.rect[3] - A.rect[1]) / 2 - (B.rect[3] - B.rect[1]) / 2;
      const alongX = gx > gz;
      const spreadA = Math.min(900, 0.3 * Math.min(A.rect[2] - A.rect[0], A.rect[3] - A.rect[1]));
      const spreadB = Math.min(900, 0.3 * Math.min(B.rect[2] - B.rect[0], B.rect[3] - B.rect[1]));
      const ua = used.get(a) ?? [];
      const ub = used.get(b) ?? [];
      let best = Infinity;
      let pick = null;
      for (const ea of A.exits) {
        const px = ea.x + ax;
        const pz = ea.z + az;
        let pa = 3 * ea.sd;
        if (ua.some((u) => Math.hypot(u[0] - px, u[1] - pz) < spreadA)) pa += 2500;
        if (pa > best) continue;
        for (const eb of B.exits) {
          const qx = eb.x + bx;
          const qz = eb.z + bz;
          const dx = qx - px;
          const dz = qz - pz;
          let c = Math.hypot(dx, dz) + pa + 3 * eb.sd + 2 * Math.abs(alongX ? dz : dx);
          if (c >= best) continue;
          if (ub.some((u) => Math.hypot(u[0] - qx, u[1] - qz) < spreadB)) c += 2500;
          if (c < best) { best = c; pick = [[px, pz], [qx, qz]]; }
        }
      }
      if (!pick) { total += 1e6; continue; }
      total += best;
      ua.push(pick[0]); used.set(a, ua);
      ub.push(pick[1]); used.set(b, ub);
      // Over a third city's land
      const len = Math.hypot(pick[1][0] - pick[0][0], pick[1][1] - pick[0][1]);
      for (let s = 0; s < len; s += 100) {
        const x = pick[0][0] + ((pick[1][0] - pick[0][0]) * s) / len;
        const z = pick[0][1] + ((pick[1][1] - pick[0][1]) * s) / len;
        for (const k of ks) {
          if (!onLand(cities[k], ...o.get(k), x, z)) continue;
          // A third city in the way: no; its own ends' land: a viaduct, costing as the planner counts it
          total += k !== a && k !== b ? 3000 : 300;
        }
      }
      for (const s of segs) if (segmentsCross(s[0], s[1], pick[0], pick[1])) total += 8000;
      segs.push(pick);
    }
    // Sea between every two cities: each rim cell of one inside the other's grown land
    for (let p = 0; p < ks.length; p++) {
      for (let q = p + 1; q < ks.length; q++) {
        const A = cities[ks[p]];
        const B = cities[ks[q]];
        const [ax, az] = o.get(ks[p]);
        const [bx, bz] = o.get(ks[q]);
        const di = Math.round((bx - ax) / PACK_CELL);
        const dj = Math.round((bz - az) / PACK_CELL);
        // Quick reject on the grown boxes
        if (B.grown.i0 + di > A.grown.i0 + A.grown.ni || A.grown.i0 > B.grown.i0 + di + B.grown.ni) continue;
        if (B.grown.j0 + dj > A.grown.j0 + A.grown.nj || A.grown.j0 > B.grown.j0 + dj + B.grown.nj) continue;
        let hits = 0;
        for (const [i, j] of B.rim) {
          const u = i + di - A.grown.i0;
          const v = j + dj - A.grown.j0;
          if (u >= 0 && v >= 0 && u < A.grown.ni && v < A.grown.nj && A.grown.g[u * A.grown.nj + v]) hits++;
        }
        total += hits * 4000;
      }
    }
    return total;
  };
  const o = new Map(ks.map((k) => [k, [...off[k]]]));
  let best = cost(o);
  const anchor = ks[0];
  const movers = ks.filter((k) => k !== anchor);
  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  const descend = () => {
    for (const step of [1600, 800, 400, 200, 100]) {
      for (let improved = true; improved;) {
        improved = false;
        for (const k of movers) {
          const [x, z] = o.get(k);
          let bestMove = null;
          for (const [dx, dz] of DIRS) {
            o.set(k, [x + dx * step, z + dz * step]);
            const c = cost(o);
            if (c < best - 1) { best = c; bestMove = [x + dx * step, z + dz * step]; }
          }
          o.set(k, bestMove ?? [x, z]);
          if (bestMove) improved = true;
        }
      }
    }
  };
  descend();
  // A few kicks out of local minima: shake two cities, settle, keep it if better
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let round = 0; round < 24; round++) {
    const saved = new Map([...o].map(([k, v]) => [k, [...v]]));
    const before = best;
    for (let n = 0; n < 2; n++) {
      const k = movers[Math.floor(rand() * movers.length)];
      const [x, z] = o.get(k);
      o.set(k, [x + Math.round((rand() - 0.5) * 30) * 100, z + Math.round((rand() - 0.5) * 30) * 100]);
    }
    best = cost(o);
    descend();
    if (best >= before) { for (const [k, v] of saved) o.set(k, v); best = before; }
  }
  return new Map([...o].map(([k, [x, z]]) => [k, [Math.round(x / PACK_CELL) * PACK_CELL, Math.round(z / PACK_CELL) * PACK_CELL]]));
}

/** The links for cities at these places, as worldLayout makes them: each along the axis the two face each
 * other across, and any two cities within NEAR_LINK m of sea linked too. */
function relink(ks, offsets, named, near = true) {
  const NEAR_LINK = 900;
  const box = (k) => {
    const r = cities[k].rect;
    const o = offsets[k];
    return { x: o.x + (r[0] + r[2]) / 2, z: o.z + (r[1] + r[3]) / 2, hx: (r[2] - r[0]) / 2, hz: (r[3] - r[1]) / 2 };
  };
  const gaps = (a, b) => [Math.abs(a.x - b.x) - a.hx - b.hx, Math.abs(a.z - b.z) - a.hz - b.hz];
  const kOf = new Map(ks.map((k) => [cities[k].id, k]));
  const out = [];
  const seen = new Set();
  for (const [ia, ib, rank] of named) {
    const a = kOf.get(ia);
    const b = kOf.get(ib);
    if (a === undefined || b === undefined) continue;
    const [gx, gz] = gaps(box(a), box(b));
    out.push({ a, b, axis: gx > gz ? 'x' : 'z', rank });
    seen.add(`${Math.min(a, b)},${Math.max(a, b)}`);
  }
  for (let i = 0; i < ks.length; i++) {
    for (let j = i + 1; j < ks.length; j++) {
      const [a, b] = [ks[i], ks[j]];
      if (seen.has(`${Math.min(a, b)},${Math.max(a, b)}`)) continue;
      const [gx, gz] = gaps(box(a), box(b));
      const g = gx > 0 && gz > 0 ? Math.hypot(gx, gz) : Math.max(gx, gz);
      if (near && g <= NEAR_LINK) out.push({ a, b, axis: gx > gz ? 'x' : 'z', rank: 3 });
    }
  }
  return out;
}

function run(key, v) {
  const layout = worldLayout(cities.map((c) => ({ id: c.id, rect: c.rect })), v);
  const { placed } = layout;
  let designed = layout.links;
  const k0 = cities.map((_, k) => k).filter((k) => placed[k]);
  const offsets = cities.map((c, k) => {
    const at = placed[k] ?? [0, 0];
    return new THREE.Vector3(Math.round(at[0] / PACK_CELL) * PACK_CELL, c.dy, Math.round(at[1] / PACK_CELL) * PACK_CELL);
  });
  if (v.optimise) {
    const t = Date.now();
    const off = offsets.map((o) => [o.x, o.z]);
    const better = optimise(k0, off, designed.filter((l) => l.rank < 3).map((l) => [l.a, l.b]));
    for (const [k, [x, z]] of better) { offsets[k].x = x; offsets[k].z = z; }
    // The links again for the settled places (the axis each runs along); only the designed ones
    designed = relink(k0, offsets, v.links, false);
    console.log(`${key}: placed in ${((Date.now() - t) / 1000).toFixed(1)} s`);
  }
  const owner = new Map();
  const cellKey = (i, j) => (i + 5000) * 10000 + (j + 5000);
  for (const k of k0) {
    const di = offsets[k].x / PACK_CELL;
    const dj = offsets[k].z / PACK_CELL;
    for (const [i, j] of masks[k]) owner.set(cellKey(i + di, j + dj), k);
  }
  const landAt = (x, z) => owner.get(cellKey(Math.floor(x / PACK_CELL), Math.floor(z / PACK_CELL))) ?? -1;

  // The islands as the planner sees them (cities the variant leaves out aren't in the world)
  const plans = [];
  const which = [];
  let base = 0;
  for (const k of k0) {
    const c = cities[k];
    const o = offsets[k];
    const adjacent = c.roads.nodes.map(() => []);
    for (const [a, b, ab, ba] of c.roads.links) {
      adjacent[a].push({ other: b, lanes: ab + ba });
      adjacent[b].push({ other: a, lanes: ab + ba });
    }
    const shore = [];
    for (const l of c.loops) {
      if (!l.outer) continue;
      for (let i = 0; i < l.points.length; i += 2) shore.push([l.points[i][0] + o.x, l.points[i][1] + o.z]);
    }
    plans.push({
      nodes: c.roads.nodes.map(([x, y, z]) => new THREE.Vector3(x + o.x, y + o.y, z + o.z)),
      adjacent, shore, base,
      rect: [c.rect[0] + o.x, c.rect[1] + o.z, c.rect[2] + o.x, c.rect[3] + o.z],
      top: heightMap(c.tops, o),
    });
    which.push(k);
    base += c.roads.nodes.length;
  }
  // worldLayout's links index the full list; the planner's, the islands in the world
  const slot = new Map(which.map((k, i) => [k, i]));
  const plannerLandAt = (x, z) => { const k = landAt(x, z); return k < 0 ? -1 : slot.get(k); };
  const t0 = Date.now();
  const links = planLinks(plans, plannerLandAt, 2, designed.map((l) => ({ ...l, a: slot.get(l.a), b: slot.get(l.b) })));
  const planMs = Date.now() - t0;

  // ── How well it's connected ──
  const n = plans.length;
  const bridges = links.map((l) => {
    const p = plans[l.a].nodes[l.na];
    const q = plans[l.b].nodes[l.nb];
    // Over land, not sea: viaduct through a city
    let land = 0;
    for (let s = 0; s < l.length; s += 20) {
      const t = s / l.length;
      if (plannerLandAt(p.x + (q.x - p.x) * t, p.z + (q.z - p.z) * t) >= 0) land += 20;
    }
    return { a: l.a, b: l.b, p, q, length: l.length, land };
  });
  const degree = new Array(n).fill(0);
  for (const b of bridges) { degree[b.a]++; degree[b.b]++; }
  // Separate places each city's bridges leave from (1 km apart, less in a small town)
  const exits = plans.map((pl, i) => {
    const apart = Math.min(1000, 0.3 * Math.min(pl.rect[2] - pl.rect[0], pl.rect[3] - pl.rect[1]));
    const at = [];
    for (const b of bridges) {
      for (const [c, p] of [[b.a, b.p], [b.b, b.q]]) {
        if (c === i && at.every((e) => Math.hypot(e.x - p.x, e.z - p.z) > apart)) at.push(p);
      }
    }
    return at.length;
  });
  const reach = (skip) => {
    const seen = new Set([0]);
    const stack = [0];
    while (stack.length) {
      const i = stack.pop();
      for (const [j, b] of bridges.entries()) {
        if (j === skip) continue;
        const o = b.a === i ? b.b : b.b === i ? b.a : -1;
        if (o >= 0 && !seen.has(o)) { seen.add(o); stack.push(o); }
      }
    }
    return seen.size;
  };
  const connected = reach(-1) === n;
  const cuts = bridges.filter((_, j) => reach(j) < n);

  // Drive distances, city middle to city middle: through each city from where you come in to where you
  // leave (straight line × CITY_WIND: streets aren't straight), and over the bridges. Not by the cities'
  // road graphs: some are in pieces (CARLA's junctions aren't joined), which a car drives straight across.
  const CITY_WIND = 1.3;
  const pts = []; // [city, x, z]
  const middles = plans.map((pl, i) => {
    const xs = pl.nodes.map((p) => p.x).sort((a, b) => a - b);
    const zs = pl.nodes.map((p) => p.z).sort((a, b) => a - b);
    pts.push([i, xs[xs.length >> 1], zs[zs.length >> 1]]);
    return pts.length - 1;
  });
  const ends = bridges.map((b) => {
    pts.push([b.a, b.p.x, b.p.z]);
    pts.push([b.b, b.q.x, b.q.z]);
    return [pts.length - 2, pts.length - 1];
  });
  const adj = pts.map(() => []);
  for (let u = 0; u < pts.length; u++) {
    for (let w = u + 1; w < pts.length; w++) {
      if (pts[u][0] !== pts[w][0]) continue;
      const d = Math.hypot(pts[u][1] - pts[w][1], pts[u][2] - pts[w][2]) * CITY_WIND;
      adj[u].push([w, d]);
      adj[w].push([u, d]);
    }
  }
  bridges.forEach((b, j) => {
    const [u, w] = ends[j];
    adj[u].push([w, b.length * 1.04]);
    adj[w].push([u, b.length * 1.04]);
  });
  const node = (u) => new THREE.Vector3(pts[u][1], 0, pts[u][2]);
  const drive = middles.map((m) => dijkstra(adj, m));
  const pairs = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const road = drive[i][middles[j]];
      const line = node(middles[i]).distanceTo(node(middles[j]));
      pairs.push({ i, j, road, line, detour: road / line });
    }
  }
  const finite = pairs.filter((p) => Number.isFinite(p.road));
  const avgKm = finite.reduce((s, p) => s + p.road, 0) / finite.length / 1000;
  const avgDetour = finite.reduce((s, p) => s + p.detour, 0) / finite.length;
  const worst = [...finite].sort((p, q) => q.detour - p.detour)[0];
  const perCity = plans.map((_, i) => {
    const ds = finite.filter((p) => p.i === i || p.j === i);
    return ds.reduce((s, p) => s + p.road, 0) / ds.length / 1000;
  });
  const name = (i) => cities[which[i]].name;
  const stats = {
    key, title: v.title, planMs, connected,
    bridges: bridges.map((b) => ({ a: name(b.a), b: name(b.b), km: +(b.length / 1000).toFixed(2), landKm: +(b.land / 1000).toFixed(2) })),
    bridgeKm: bridges.reduce((s, b) => s + b.length, 0) / 1000,
    longest: Math.max(...bridges.map((b) => b.length)) / 1000,
    cities: plans.map((_, i) => ({ name: name(i), bridges: degree[i], exits: exits[i], avgDriveKm: +perCity[i].toFixed(1) })),
    cuts: cuts.map((b) => `${name(b.a)}–${name(b.b)}`),
    avgDriveKm: avgKm, avgDetour,
    worst: worst && { from: name(worst.i), to: name(worst.j), roadKm: worst.road / 1000, lineKm: worst.line / 1000 },
  };
  draw(key, v, stats, which, offsets, plans, bridges);
  return stats;
}

// ── Drawing ──
function draw(key, v, stats, which, offsets, plans, bridges) {
  let [minX, minZ, maxX, maxZ] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const pl of plans) {
    minX = Math.min(minX, pl.rect[0]); minZ = Math.min(minZ, pl.rect[1]);
    maxX = Math.max(maxX, pl.rect[2]); maxZ = Math.max(maxZ, pl.rect[3]);
  }
  const pad = 1200;
  const panel = 330; // px on the right for the numbers
  const W = 1600;
  const scale = (W - panel) / (maxZ - minZ + 2 * pad);
  const H = Math.max(900, Math.round((maxX - minX + 2 * pad) * scale));
  const top = (H - (maxX - minX + 2 * pad) * scale) / 2;
  const px = (x, z) => [((z - minZ + pad) * scale).toFixed(1), (top + (maxX + pad - x) * scale).toFixed(1)];
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" font-family="DejaVu Sans, sans-serif">`;
  svg += `<rect width="100%" height="100%" fill="#0a1f2e"/>`;
  which.forEach((k, i) => {
    const c = cities[k];
    const o = offsets[k];
    const d = c.loops.map((l) => 'M' + l.points.map(([x, z]) => px(x + o.x, z + o.z).join(',')).join('L') + 'Z').join('');
    svg += `<path d="${d}" fill="#1f3a2f" fill-rule="evenodd" stroke="#4f7d66" stroke-width="1"/>`;
    const pl = plans[i];
    let r = '';
    for (const [a, b] of c.roads.links) {
      const p = pl.nodes[a];
      const q = pl.nodes[b];
      if (Math.hypot(p.x - q.x, p.z - q.z) * scale < 0.3 && (a + b) % 3) continue; // tiny links: a sample does
      r += `M${px(p.x, p.z).join(',')}L${px(q.x, q.z).join(',')}`;
    }
    svg += `<path d="${r}" stroke="#c9d6de" stroke-width="0.7" opacity="0.55" fill="none"/>`;
  });
  for (const b of bridges) {
    const [x1, y1] = px(b.p.x, b.p.z);
    const [x2, y2] = px(b.q.x, b.q.z);
    svg += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#0a1f2e" stroke-width="8" stroke-linecap="round"/>`;
    svg += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#ffb020" stroke-width="4" stroke-linecap="round"/>`;
    svg += `<circle cx="${x1}" cy="${y1}" r="4" fill="#fff"/><circle cx="${x2}" cy="${y2}" r="4" fill="#fff"/>`;
    const [mx, my] = px((b.p.x + b.q.x) / 2, (b.p.z + b.q.z) / 2);
    svg += `<text x="${mx}" y="${+my - 7}" fill="#ffd27a" font-size="13" font-weight="bold" text-anchor="middle" stroke="#0a1f2e" stroke-width="3" paint-order="stroke">${(b.length / 1000).toFixed(1)} km</text>`;
  }
  which.forEach((k, i) => {
    const pl = plans[i];
    const [x, y] = px((pl.rect[0] + pl.rect[2]) / 2, (pl.rect[1] + pl.rect[3]) / 2);
    const c = stats.cities[i];
    const bad = c.bridges < 2 || c.exits < 2;
    svg += `<text x="${x}" y="${y}" fill="#fff" font-size="17" font-weight="bold" text-anchor="middle" stroke="#0a1f2e" stroke-width="4" paint-order="stroke">${cities[k].name}</text>`;
    svg += `<text x="${x}" y="${+y + 18}" fill="${bad ? '#ff7b7b' : '#9fe0b0'}" font-size="13" text-anchor="middle" stroke="#0a1f2e" stroke-width="3" paint-order="stroke">${c.bridges} bridge${c.bridges === 1 ? '' : 's'} · ${c.exits} exit${c.exits === 1 ? '' : 's'}</text>`;
  });
  // 5 km bar
  svg += `<line x1="24" y1="${H - 28}" x2="${24 + 5000 * scale}" y2="${H - 28}" stroke="#fff" stroke-width="3"/><text x="24" y="${H - 38}" fill="#fff" font-size="13">5 km</text>`;
  // Numbers
  const X = W - panel + 18;
  let y = 40;
  const line = (t, size = 14, colour = '#dfe8ee', weight = 'normal') => { svg += `<text x="${X}" y="${y}" fill="${colour}" font-size="${size}" font-weight="${weight}">${t}</text>`; y += size + 8; };
  svg += `<rect x="${W - panel}" y="0" width="${panel}" height="${H}" fill="#07161f"/>`;
  line(key.toUpperCase(), 13, '#7fa3b8', 'bold');
  for (const part of wrap(stats.title, 30)) line(part, 18, '#fff', 'bold');
  y += 8;
  line(`${stats.bridges.length} bridges, ${stats.bridgeKm.toFixed(1)} km in all`);
  line(`longest ${stats.longest.toFixed(1)} km`);
  line(stats.connected ? 'every city reachable' : 'NOT every city reachable', 14, stats.connected ? '#9fe0b0' : '#ff7b7b');
  line(`${stats.cuts.length} single point${stats.cuts.length === 1 ? '' : 's'} of failure`, 14, stats.cuts.length ? '#ffb86b' : '#9fe0b0');
  for (const c of stats.cuts.slice(0, 6)) line(`   ${c}`, 12, '#ffb86b');
  line(`avg drive city to city ${stats.avgDriveKm.toFixed(1)} km`);
  line(`avg detour ×${stats.avgDetour.toFixed(2)} (1 = straight line)`);
  if (stats.worst) {
    line(`worst: ${stats.worst.from} → ${stats.worst.to}`, 12, '#b9c7cf');
    line(`   ${stats.worst.roadKm.toFixed(1)} km by road, ${stats.worst.lineKm.toFixed(1)} km apart`, 12, '#b9c7cf');
  }
  y += 10;
  line('City · bridges · exits · avg drive', 12, '#7fa3b8', 'bold');
  for (const c of [...stats.cities].sort((p, q) => q.bridges - p.bridges)) {
    const bad = c.bridges < 2 || c.exits < 2;
    line(`${c.name}: ${c.bridges} · ${c.exits} · ${c.avgDriveKm} km`, 13, bad ? '#ff7b7b' : '#dfe8ee');
  }
  svg += '</svg>';
  fs.writeFileSync(`${OUT}/${key}.svg`, svg);
  execFileSync('magick', [`${OUT}/${key}.svg`, `${OUT}/${key}.png`]);
  fs.unlinkSync(`${OUT}/${key}.svg`);
}

function wrap(text, width) {
  const out = [''];
  for (const w of text.split(' ')) {
    if ((out[out.length - 1] + ' ' + w).trim().length > width) out.push(w);
    else out[out.length - 1] = (out[out.length - 1] + ' ' + w).trim();
  }
  return out;
}

fs.mkdirSync(OUT, { recursive: true });
const pick = process.argv.slice(2);
const all = [];
for (const [key, v] of Object.entries(VARIANTS)) {
  if (pick.length && !pick.includes(key)) continue;
  const s = run(key, v);
  all.push(s);
  console.log(`${key}: ${s.bridges.length} bridges ${s.bridgeKm.toFixed(1)} km, longest ${s.longest.toFixed(1)}, cuts ${s.cuts.length}, `
    + `avg drive ${s.avgDriveKm.toFixed(1)} km ×${s.avgDetour.toFixed(2)}, single-bridge cities ${s.cities.filter((c) => c.bridges < 2).map((c) => c.name).join(', ') || 'none'}, `
    + `one-exit cities ${s.cities.filter((c) => c.exits < 2).map((c) => c.name).join(', ') || 'none'} (${s.planMs} ms)`);
  for (const b of s.bridges) console.log(`   ${b.a} ↔ ${b.b}: ${b.km} km (${b.landKm} over land)`);
}
fs.writeFileSync(`${OUT}/stats.json`, JSON.stringify(all, null, 1));
if (!pick.length) {
  execFileSync('magick', ['montage', ...all.map((s) => `${OUT}/${s.key}.png`), '-tile', '2x', '-geometry', '1200x+12+12', '-background', '#050d13', `${OUT}/all.png`]);
}
