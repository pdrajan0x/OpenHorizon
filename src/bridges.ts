// Causeways between the islands (HANDOFF plan B). Each link joins a gateway road node on one island to
// one on another along a Hermite curve that leaves each end along its road's own direction. The deck
// eases from each end's road height up to at least DECK_CLEARANCE over the sea, with a grade of
// MAX_GRADE or less. What the car drives on is exact: a trimesh following the curve (deck + barrier
// walls), and road-graph nodes every NODE_SPACING m joined to both gateways, so traffic, the GPS,
// rivals and races all cross.
//
// What you see comes from real models where we have them (public/mods/bridges/kit.json, see Kit below):
// deck pieces repeated along the curve, pillars down to the seabed, barriers along both edges, lamps.
// Parts the kit lacks fall back to a textured ribbon (Poly Haven asphalt, concrete) built on the curve.
import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { STATIC_GROUPS } from './map';

// A highway: three 3.6 m lanes each way, a 2.5 m hard shoulder outside, 1 m inside, a 1.2 m median with a
// concrete barrier, 29.8 m across. At each end it narrows over TAPER m to the street it joins.
const LANE = 3.6;
export const LANES = 3; // each way
const SHOULDER = 2.5;
const INNER_SHOULDER = 1.0;
const MEDIAN = 1.2;
export const DECK_WIDTH = 2 * (LANES * LANE + SHOULDER + INNER_SHOULDER) + MEDIAN;
const TAPER = 120; // m over which a deck widens from the street it leaves to the full highway
const END_DIP = 0.07; // m the deck sits under the city's road where they overlap, so they don't fight (flicker)
const DIP_LENGTH = 30; // m over which that dip eases out
const EMBANKMENT = 170; // m from each end with an embankment either side down to the seabed, no void under the road
const EMBANK_FOOT = -6; // m: where the embankment meets the seabed
const EMBANK_SLOPE = 1.5; // m out per m down
const S_CURVE = 0.05; // of a link's length: how far its S-bend swings either way (at most S_CURVE_MAX m)
const S_CURVE_MAX = 70;
const DECK_CLEARANCE = 12; // m above the sea at least, away from the ends
const MAX_GRADE = 0.06;
const DECK_DEPTH = 1.6; // m of girder under the road surface
const BARRIER_HEIGHT = 1.1; // m, the collision wall along each edge
const BARRIER_GAP = 36; // m at each end with no barrier, so a street the bridge leaves from stays open
const NODE_SPACING = 25; // m between road-graph nodes on the deck
const STEP = 4; // m between cross-sections of the deck geometry
const PILLAR_SPACING = 48; // m
const SEABED = -18; // m, where pillars end
const MAX_LINK = 3600; // m: longer links only when nothing shorter reaches an island
const MAX_ANY_LINK = 9000;
const PIECE_CHUNK = 160; // m of bridge per instanced chunk, so frustum culling works
const DETAIL_DISTANCE = 900; // m: barriers and lamps beyond this aren't drawn

/**
 * Optional kit of real models: public/mods/bridges/kit.json. Every part is optional; `model` is a
 * path under /mods/. Sizes are measured from the model; `axis` is the model's length axis (default:
 * its longest horizontal one). Deck pieces are scaled to DECK_WIDTH and their top put at the road.
 */
interface KitPart {
  model: string;
  axis?: 'x' | 'z';
  /** Deck: the top of the road surface in model units, if not the bounding box top. */
  top?: number;
  /** Stretch along the length (barriers: fewer instances). */
  stretch?: number;
  /** Lamps: metres between them. */
  spacing?: number;
}
interface Kit {
  deck?: KitPart;
  pillar?: KitPart;
  barrier?: KitPart;
  lamp?: KitPart;
}
const DEFAULT_KIT: Kit = {
  barrier: { model: 'bridges/concrete_road_barrier_02.glb', stretch: 1.6 },
  lamp: { model: 'bridges/street_lamp_01.glb', spacing: 60 },
};

interface LoadedPart {
  meshes: { geometry: THREE.BufferGeometry; material: THREE.Material }[];
  /** Length along the model's travel axis, width across, height, and its local min corner. */
  length: number;
  width: number;
  height: number;
  min: THREE.Vector3;
  max: THREE.Vector3;
  part: KitPart;
}

export interface IslandPlan {
  /** Road nodes in world space and each node's links (other node, lanes out, lanes in). */
  nodes: THREE.Vector3[];
  adjacent: { other: number; lanes: number }[][];
  /** Shore points in world space (outer loops). */
  shore: [number, number][];
  /** Land rectangle in world space [minX, minZ, maxX, maxZ]. */
  rect: [number, number, number, number];
  /** Index of this island's node 0 in the merged road graph. */
  base: number;
  /** World height of the tallest thing (ground, hill, roof) under a point, if known. */
  top?: (x: number, z: number) => number;
}

export interface LinkPlan {
  a: number; // island indices
  b: number;
  na: number; // node indices within each island
  nb: number;
  cost: number;
  length: number;
}

interface Gateway {
  node: number;
  shoreDist: number;
  deadEnd: boolean;
  dir: THREE.Vector2 | null; // the road's direction out of a dead end
}

/** Road nodes near an island's shore that a causeway could leave from. */
function gateways(island: IslandPlan): Gateway[] {
  const grid = new Map<string, [number, number][]>();
  const G = 200;
  for (const p of island.shore) {
    const k = `${Math.floor(p[0] / G)},${Math.floor(p[1] / G)}`;
    let l = grid.get(k);
    if (!l) grid.set(k, (l = []));
    l.push(p);
  }
  const shoreDist = (x: number, z: number) => {
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
  const all: Gateway[] = [];
  island.nodes.forEach((n, i) => {
    const adj = island.adjacent[i];
    if (!adj.length || !adj.some((a) => a.lanes > 0)) return;
    if (n.y < -1 || n.y > 90) return; // tunnels, and roads far above the sea (an elevated expressway will do)
    const deadEnd = adj.length === 1;
    let dir: THREE.Vector2 | null = null;
    if (deadEnd) {
      const o = island.nodes[adj[0].other];
      dir = new THREE.Vector2(n.x - o.x, n.z - o.z);
      if (dir.lengthSq() < 1e-4) dir = null;
      else dir.normalize();
    }
    all.push({ node: i, shoreDist: shoreDist(n.x, n.z), deadEnd, dir });
  });
  all.sort((p, q) => p.shoreDist - q.shoreDist);
  // Roads near any shore: the link planner weighs which side faces the other island
  const limit = (all[0]?.shoreDist ?? 0) + 1200;
  const near = all.filter((g) => g.shoreDist <= Math.max(limit, 250));
  // Keep the count bounded, spread over the whole shore
  const step = Math.max(1, Math.floor(near.length / 800));
  return near.filter((_, k) => k % step === 0);
}

function segmentsCross(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3): boolean {
  const o = (p: THREE.Vector3, q: THREE.Vector3, r: THREE.Vector3) => (q.x - p.x) * (r.z - p.z) - (q.z - p.z) * (r.x - p.x);
  return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0;
}

/** A link the world's design asks for, and the axis it should run along: straight across the channel. */
export interface DesignedLink {
  a: number;
  b: number;
  axis: 'x' | 'z';
  /** Built in this order (lower first), so a less important link gives way where two would cross. */
  rank: number;
}

/**
 * Which islands to join, and where. With `designed` links, exactly those, each leaving from roads near
 * the facing shores and running as straight along its axis as the roads allow; then whatever else it
 * takes for every city to be reachable. Otherwise a minimum spanning tree over the cheapest gateway pair
 * of every two islands, plus a couple of extra links for loops.
 */
export function planLinks(
  islands: IslandPlan[], landAt: (x: number, z: number) => number, extra = 2, designed?: DesignedLink[],
): LinkPlan[] {
  const gates = islands.map(gateways);
  const pairs: LinkPlan[] = [];
  const key = (a: number, b: number) => (a < b ? `${a},${b}` : `${b},${a}`);
  const axes = new Map((designed ?? []).map((d) => [key(d.a, d.b), d.axis]));
  // Over land a bridge is a viaduct through the city: in a designed world it costs twice as much again
  const landCost = designed ? 3 : 1.5;
  // A designed link keeps its CANDIDATES cheapest routes, so one crossing another island or bridge can
  // give way to the next best. The SHORTLIST cheapest by distance are first checked for what stands in
  // the way of each end's approach: a bridge should leave over open ground, not cut through a hill or
  // a block of buildings.
  const CANDIDATES = 40;
  const SHORTLIST = 300;
  const blocked = (isl: IslandPlan, from: THREE.Vector3, to: THREE.Vector3, length: number) => {
    if (!isl.top) return 0;
    const dx = (to.x - from.x) / length;
    const dz = (to.z - from.z) / length;
    let sum = 0;
    // From 30 m out (the corridor clears kerbs and walls by the road) to where the deck is high and far
    for (let s = 30; s < Math.min(900, length / 2); s += 20) {
      const deck = from.y + Math.min(s * MAX_GRADE, Math.max(0, DECK_CLEARANCE - from.y));
      sum += Math.max(0, isl.top(from.x + dx * s, from.z + dz * s) - deck - 1.5);
    }
    return sum * 20; // m of height above the deck × m along it
  };
  const options = new Map<string, LinkPlan[]>();
  for (let a = 0; a < islands.length; a++) {
    for (let b = a + 1; b < islands.length; b++) {
      const axis = axes.get(`${a},${b}`);
      const top: LinkPlan[] = [];
      let best: LinkPlan | null = null;
      for (const ga of gates[a]) {
        const pa = islands[a].nodes[ga.node];
        for (const gb of gates[b]) {
          const pb = islands[b].nodes[gb.node];
          const dx = pb.x - pa.x;
          const dz = pb.z - pa.z;
          const length = Math.hypot(dx, dz);
          if (length > MAX_ANY_LINK || length < 60) continue;
          // Land to cross at each end costs more than sea; a dead end already pointing across is best
          let cost = length + landCost * (ga.shoreDist + gb.shoreDist) + 8 * Math.abs(pa.y - pb.y);
          // Straight across the channel, not slanting along it
          if (axis) cost += 2 * Math.abs(axis === 'z' ? dx : dz);
          const align = (g: Gateway, x: number, z: number) => (g.dir ? (g.dir.x * x + g.dir.y * z) / length : -0.2);
          const alA = align(ga, dx, dz);
          const alB = align(gb, -dx, -dz);
          cost -= (Math.max(alA, 0) + Math.max(alB, 0)) * 120;
          cost += (Math.max(-alA, 0) + Math.max(-alB, 0)) * 400; // a road pointing away would loop back
          if (axis) {
            if (top.length === SHORTLIST && cost >= top[SHORTLIST - 1].cost) continue;
            // One route per gateway node on each side, so the options are different places
            if (top.some((t) => (t.na === ga.node || t.nb === gb.node) && t.cost <= cost)) continue;
            top.push({ a, b, na: ga.node, nb: gb.node, cost, length });
            top.sort((p, q) => p.cost - q.cost);
            if (top.length > SHORTLIST) top.pop();
            continue;
          }
          if (best && cost >= best.cost) continue;
          best = { a, b, na: ga.node, nb: gb.node, cost, length };
        }
      }
      // Not straight across a third island
      const clear = (l: LinkPlan) => {
        const pa = islands[a].nodes[l.na];
        const pb = islands[b].nodes[l.nb];
        for (let t = 0; t <= 1; t += 40 / l.length) {
          const k = landAt(pa.x + (pb.x - pa.x) * t, pa.z + (pb.z - pa.z) * t);
          if (k >= 0 && k !== a && k !== b) return false;
        }
        return true;
      };
      if (axis) {
        // What stands on each end's approach: every m² of hill or building above the deck counts
        for (const l of top) {
          const pa = islands[a].nodes[l.na];
          const pb = islands[b].nodes[l.nb];
          l.cost += 0.5 * (blocked(islands[a], pa, pb, l.length) + blocked(islands[b], pb, pa, l.length));
        }
        top.sort((p, q) => p.cost - q.cost);
        top.length = Math.min(top.length, CANDIDATES);
        const ok = top.filter(clear);
        if (ok.length) {
          options.set(`${a},${b}`, ok);
          pairs.push(ok[0]);
        }
      } else if (best && clear(best)) pairs.push(best);
    }
  }
  pairs.sort((p, q) => p.cost - q.cost);
  const parent = islands.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const chosen: LinkPlan[] = [];
  const ends = (l: LinkPlan) => [islands[l.a].nodes[l.na], islands[l.b].nodes[l.nb]];
  const crosses = (l: LinkPlan) => chosen.some((c) => {
    const [p, q] = ends(l);
    const [r, s] = ends(c);
    return segmentsCross(p, q, r, s);
  });
  if (designed) {
    // By rank, then cheapest; each takes its best route that doesn't cross one already built
    const order = designed
      .map((d) => ({ d, opts: options.get(key(d.a, d.b)) }))
      .filter((x): x is { d: DesignedLink; opts: LinkPlan[] } => !!x.opts)
      .sort((p, q) => p.d.rank - q.d.rank || p.opts[0].cost - q.opts[0].cost);
    for (const { opts } of order) {
      const route = opts.find((o) => !crosses(o));
      if (!route) continue;
      chosen.push(route);
      parent[find(route.a)] = find(route.b);
    }
    // Anything the design left cut off (a city it doesn't know) joins by its cheapest link
    for (const p of pairs) {
      const ra = find(p.a);
      const rb = find(p.b);
      if (ra !== rb && !crosses(p)) { parent[ra] = rb; chosen.push(p); }
    }
    return chosen;
  }
  const rest: LinkPlan[] = [];
  for (const p of pairs) {
    const ra = find(p.a);
    const rb = find(p.b);
    if (ra === rb) { rest.push(p); continue; }
    if (crosses(p)) { rest.push(p); continue; }
    parent[ra] = rb;
    chosen.push(p);
  }
  // Anything still cut off takes its cheapest link even if it crosses another
  for (const p of rest) {
    const ra = find(p.a);
    const rb = find(p.b);
    if (ra !== rb) { parent[ra] = rb; chosen.push(p); }
  }
  const longest = Math.max(...chosen.map((c) => c.length), 0);
  let added = 0;
  for (const p of rest) {
    if (added >= extra) break;
    if (chosen.includes(p) || p.length > Math.min(MAX_LINK, Math.max(longest, 1500)) || crosses(p)) continue;
    // Loops are only worth it between islands with no direct link yet
    if (chosen.some((c) => (c.a === p.a && c.b === p.b))) continue;
    chosen.push(p);
    added++;
  }
  return chosen;
}

/** A built link: its centerline and what the road graph needs. */
export interface Bridge {
  plan: LinkPlan;
  /** Road-graph nodes on the deck, from end A to end B (not including the gateways). */
  nodes: THREE.Vector3[];
  /** Half width of the deck at each node, and at the two ends (A, B). */
  halfWidths: number[];
  endHalf: [number, number];
  length: number;
}

interface Frame {
  p: THREE.Vector3; // deck centerline, road surface
  t: THREE.Vector3; // unit tangent (with grade)
  r: THREE.Vector3; // unit right, horizontal
  s: number; // arc length
  hw: number; // half width of the deck here
  dip: number; // how far the drawn deck sits under its line here (ends only)
}

/** The frame `s` m along a run of frames (from its first), between the two either side. */
function frameAt(frames: Frame[], s: number): Frame {
  const s0 = frames[0].s;
  let lo = 0;
  let hi = frames.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (frames[mid].s - s0 <= s) lo = mid; else hi = mid;
  }
  const a = frames[lo];
  const b = frames[hi];
  const k = THREE.MathUtils.clamp((s + s0 - a.s) / (b.s - a.s || 1), 0, 1);
  return {
    p: a.p.clone().lerp(b.p, k), t: a.t.clone().lerp(b.t, k).normalize(), r: a.r.clone().lerp(b.r, k).normalize(),
    s: s + s0, hw: a.hw + (b.hw - a.hw) * k, dip: a.dip + (b.dip - a.dip) * k,
  };
}

/**
 * The deck centerline from A to B: a Hermite curve in plan with a gentle S-bend (a straight causeway is dull
 * to drive), an eased height profile, sampled every STEP m; its width tapers from each end's street
 * (halfA, halfB) to the full highway.
 */
function centerline(pa: THREE.Vector3, da: THREE.Vector2, pb: THREE.Vector3, db: THREE.Vector2, halfA: number, halfB: number): Frame[] {
  const L = Math.hypot(pb.x - pa.x, pb.z - pa.z);
  const m = L * 0.75;
  const plan: THREE.Vector2[] = [];
  const N = Math.max(40, Math.ceil(L / 1.5));
  // The bend: across the chord, zero with zero slope at both ends so each end still leaves along its road
  const swing = L > 500 ? Math.min(S_CURVE_MAX, S_CURVE * L) : 0;
  const nx = -(pb.z - pa.z) / (L || 1);
  const nz = (pb.x - pa.x) / (L || 1);
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const h00 = 2 * t ** 3 - 3 * t ** 2 + 1;
    const h10 = t ** 3 - 2 * t ** 2 + t;
    const h01 = -2 * t ** 3 + 3 * t ** 2;
    const h11 = t ** 3 - t ** 2;
    const bend = swing * Math.sin(2 * Math.PI * t) * Math.sin(Math.PI * t) ** 2;
    plan.push(new THREE.Vector2(
      h00 * pa.x + h10 * m * da.x + h01 * pb.x + h11 * m * db.x + nx * bend,
      h00 * pa.z + h10 * m * da.y + h01 * pb.z + h11 * m * db.y + nz * bend,
    ));
  }
  // Resample at even arc length
  const cum = [0];
  for (let i = 1; i < plan.length; i++) cum.push(cum[i - 1] + plan[i].distanceTo(plan[i - 1]));
  const S = cum[cum.length - 1];
  const n = Math.max(2, Math.ceil(S / STEP));
  const pts: THREE.Vector2[] = [];
  let j = 0;
  for (let i = 0; i <= n; i++) {
    const s = (S * i) / n;
    while (j < cum.length - 2 && cum[j + 1] < s) j++;
    const f = (s - cum[j]) / Math.max(1e-6, cum[j + 1] - cum[j]);
    pts.push(plan[j].clone().lerp(plan[j + 1], f));
  }
  // Heights: aim for the deck clearance (or the straight line between ends if that's higher), within
  // MAX_GRADE of both ends, then smooth
  const ha = pa.y;
  const hb = pb.y;
  let ys = pts.map((_, i) => {
    const s = (S * i) / n;
    const target = Math.max(DECK_CLEARANCE, ha + ((hb - ha) * s) / S);
    const lo = Math.max(ha - MAX_GRADE * s, hb - MAX_GRADE * (S - s));
    const hi = Math.min(ha + MAX_GRADE * s, hb + MAX_GRADE * (S - s));
    return lo > hi ? ha + ((hb - ha) * s) / S : THREE.MathUtils.clamp(target, lo, hi);
  });
  const w = Math.max(1, Math.round(40 / STEP));
  for (let pass = 0; pass < 2; pass++) {
    ys = ys.map((y, i) => {
      if (i === 0 || i === ys.length - 1) return y;
      const k = Math.min(w, i, ys.length - 1 - i);
      let s = 0;
      for (let d = -k; d <= k; d++) s += ys[i + d];
      return s / (2 * k + 1);
    });
  }
  const ease = (x: number) => { const c = THREE.MathUtils.clamp(x, 0, 1); return c * c * (3 - 2 * c); };
  const full = DECK_WIDTH / 2;
  const frames: Frame[] = pts.map((p, i) => {
    const s = (S * i) / n;
    const hw = Math.min(halfA + (full - halfA) * ease(s / TAPER), halfB + (full - halfB) * ease((S - s) / TAPER));
    const dip = END_DIP * (1 - ease(Math.min(s, S - s) / DIP_LENGTH));
    return { p: new THREE.Vector3(p.x, ys[i], p.y), t: new THREE.Vector3(), r: new THREE.Vector3(), s, hw, dip };
  });
  frames.forEach((f, i) => {
    const a = frames[Math.max(0, i - 1)].p;
    const b = frames[Math.min(frames.length - 1, i + 1)].p;
    f.t.subVectors(b, a).normalize();
    f.r.set(-f.t.z, 0, f.t.x).normalize(); // right of travel: (-dz, dx)
  });
  return frames;
}

export class BridgeNetwork {
  readonly root = new THREE.Group();
  readonly bridges: Bridge[] = [];
  private readonly detail: { mesh: THREE.Object3D; center: THREE.Vector3; radius: number }[] = [];

  private constructor(
    world: RAPIER.World,
    islands: IslandPlan[],
    plans: LinkPlan[],
    private readonly kit: Partial<Record<keyof Kit, LoadedPart>>,
    private readonly mats: { asphalt: THREE.Material; concrete: THREE.Material; rock: THREE.Material; paint: THREE.Material },
  ) {
    this.root.name = 'bridges';
    for (const plan of plans) {
      const A = islands[plan.a];
      const B = islands[plan.b];
      const pa = A.nodes[plan.na];
      const pb = B.nodes[plan.nb];
      const toward = new THREE.Vector2(pb.x - pa.x, pb.z - pa.z).normalize();
      const dirOut = (isl: IslandPlan, node: number, fallback: THREE.Vector2) => {
        const adj = isl.adjacent[node];
        if (adj.length === 1) {
          const o = isl.nodes[adj[0].other];
          const n = isl.nodes[node];
          const d = new THREE.Vector2(n.x - o.x, n.z - o.z).normalize();
          // Follow the road out only if it roughly faces the other island
          if (d.dot(fallback) > 0) return d.lerp(fallback, 0.25).normalize();
        }
        return fallback.clone();
      };
      const da = dirOut(A, plan.na, toward);
      const db = dirOut(B, plan.nb, toward.clone().negate()).negate(); // arriving at B
      // Each end as wide as the street it joins (its lanes both ways), up to the full highway
      const streetHalf = (isl: IslandPlan, node: number) => {
        const lanes = Math.max(2, ...isl.adjacent[node].map((a) => a.lanes));
        return THREE.MathUtils.clamp((lanes * 3.5 + 3) / 2, 5.5, DECK_WIDTH / 2);
      };
      const endHalf: [number, number] = [streetHalf(A, plan.na), streetHalf(B, plan.nb)];
      const frames = centerline(pa, da, pb, db, endHalf[0], endHalf[1]);
      const length = frames[frames.length - 1].s;
      const nodes: THREE.Vector3[] = [];
      const halfWidths: number[] = [];
      const count = Math.max(1, Math.round(length / NODE_SPACING));
      for (let k = 1; k < count; k++) {
        const s = (length * k) / count;
        const i = Math.min(frames.length - 1, Math.round((s / length) * (frames.length - 1)));
        nodes.push(frames[i].p.clone());
        halfWidths.push(frames[i].hw);
      }
      this.bridges.push({ plan, nodes, halfWidths, endHalf, length });
      this.build(world, frames);
    }
  }

  static async load(world: RAPIER.World, islands: IslandPlan[], plans: LinkPlan[]): Promise<BridgeNetwork> {
    const kitJson = await fetch('/mods/bridges/kit.json').then((r) => (r.ok ? (r.json() as Promise<Kit>) : DEFAULT_KIT)).catch(() => DEFAULT_KIT);
    const kitDef: Kit = { ...DEFAULT_KIT, ...kitJson };
    const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
    const kit: Partial<Record<keyof Kit, LoadedPart>> = {};
    await Promise.all((Object.keys(kitDef) as (keyof Kit)[]).map(async (k) => {
      const part = kitDef[k];
      if (!part) return;
      try {
        const g = await loader.loadAsync(`/mods/${part.model}`);
        g.scene.updateMatrixWorld(true);
        const meshes: LoadedPart['meshes'] = [];
        const box = new THREE.Box3();
        g.scene.traverse((o) => {
          const m = o as THREE.Mesh;
          if (!m.isMesh) return;
          // Compressed models store positions as normalized integers: to floats first, or moving and
          // scaling them clamps every coordinate to ±1 and mangles the shape
          const geometry = toFloat(m.geometry.clone()).applyMatrix4(m.matrixWorld);
          // Lay the length along +X
          if ((part.axis ?? '') === 'z') geometry.rotateY(Math.PI / 2);
          geometry.computeBoundingBox();
          box.union(geometry.boundingBox!);
          const mats = Array.isArray(m.material) ? m.material : [m.material];
          meshes.push({ geometry, material: mats[0] });
        });
        if (!meshes.length) return;
        const size = box.getSize(new THREE.Vector3());
        if (!part.axis && size.z > size.x) {
          for (const mm of meshes) mm.geometry.rotateY(Math.PI / 2);
          box.makeEmpty();
          for (const mm of meshes) { mm.geometry.computeBoundingBox(); box.union(mm.geometry.boundingBox!); }
          box.getSize(size);
        }
        kit[k] = { meshes, length: size.x, width: size.z, height: size.y, min: box.min.clone(), max: box.max.clone(), part };
      } catch (e) {
        console.warn(`bridge kit: ${part.model} not loaded`, e);
      }
    }));
    const tex = new THREE.TextureLoader();
    const load = (name: string, kind: string, color: boolean) =>
      tex.loadAsync(`/mods/coast/${name}/${name}_${kind}_2k.jpg`).then((t) => {
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.anisotropy = 8;
        if (color) t.colorSpace = THREE.SRGBColorSpace;
        return t;
      }).catch(() => null);
    const pbr = async (name: string, fallback: number) => {
      const [map, normalMap, roughnessMap] = await Promise.all([load(name, 'Diffuse', true), load(name, 'nor_gl', false), load(name, 'Rough', false)]);
      return new THREE.MeshStandardMaterial({ map, normalMap, roughnessMap, color: map ? 0xffffff : fallback, roughness: 1 });
    };
    const [asphalt, concrete, rock] = await Promise.all([pbr('asphalt_02', 0x3a3a3c), pbr('concrete_wall_008', 0x8e8c88), pbr('coast_land_rocks_01', 0x6b6358)]);
    return new BridgeNetwork(world, islands, plans, kit, { asphalt, concrete, rock, paint: laneMarkings() });
  }

  private build(world: RAPIER.World, frames: Frame[]): void {
    const at = (f: Frame, x: number, y: number) =>
      new THREE.Vector3().copy(f.p).addScaledVector(f.r, x).setY(f.p.y + y);
    // The barriers stop BARRIER_GAP m short of each end: a bridge often leaves from the side of a street,
    // and a wall end standing in that street would be the thing you hit
    const g = Math.round(BARRIER_GAP / STEP);
    const inner = frames.length > 2 * g + 4
      ? frames.slice(g, frames.length - g).map((f) => ({ ...f, s: f.s - frames[g].s }))
      : [];
    // The median runs where the deck is full width
    const full = DECK_WIDTH / 2 - 0.2;
    const median = inner.filter((f) => f.hw >= full);
    // --- Collision: the road surface, a wall along each edge and down the middle, the embankments ---
    const strip = (fs: Frame[], section: (f: Frame) => [number, number][], dipEnds: boolean) => {
      if (fs.length < 2) return;
      const col: number[] = [];
      const colIdx: number[] = [];
      const m = section(fs[0]).length;
      fs.forEach((f, i) => {
        // The first and last metres dip a hair under the city's road so there's no lip to hit
        const dip = dipEnds && (i === 0 || i === fs.length - 1) ? -0.12 : 0;
        for (const [x, y] of section(f)) {
          const v = at(f, x, y + dip);
          col.push(v.x, v.y, v.z);
        }
        if (i === 0) return;
        const a = (i - 1) * m;
        const b = i * m;
        for (let k = 0; k < m - 1; k++) colIdx.push(a + k, a + k + 1, b + k, b + k, a + k + 1, b + k + 1);
      });
      world.createCollider(RAPIER.ColliderDesc.trimesh(new Float32Array(col), new Uint32Array(colIdx))
        .setFriction(1).setCollisionGroups(STATIC_GROUPS));
    };
    strip(frames, (f) => [[-f.hw, 0], [f.hw, 0]], true);
    if (inner.length) {
      strip(inner, (f) => [[-f.hw, BARRIER_HEIGHT], [-f.hw, 0]], false);
      strip(inner, (f) => [[f.hw, 0], [f.hw, BARRIER_HEIGHT]], false);
    }
    if (median.length > 2) strip(median, () => [[-0.35, 0], [-0.35, 0.9], [0.35, 0.9], [0.35, 0]], false);
    // Embankments: near each end, rock slopes from the deck's edges down to the seabed, so nothing
    // under or beside the road is open (no void to see into or drop through)
    const ends = [frames.filter((f) => f.s <= EMBANKMENT), frames.filter((f) => f.s >= frames[frames.length - 1].s - EMBANKMENT)];
    const slope = (f: Frame, side: number): [number, number][] => {
      const drop = f.p.y - EMBANK_FOOT;
      return [[side * f.hw, -0.05], [side * (f.hw + EMBANK_SLOPE * drop), -drop]];
    };
    for (const e of ends) {
      if (e.length < 2) continue;
      for (const side of [-1, 1]) {
        strip(e, (f) => slope(f, side), false);
        this.ribbon(e, (f) => (side < 0 ? slope(f, side).reverse() : slope(f, side)), this.mats.rock, [0, 1], false, 12);
      }
    }

    // --- Deck: kit pieces, else a ribbon ---
    const deck = this.kit.deck;
    if (deck) this.instanceAlong(frames, deck, () => {
      const top = deck.part.top ?? deck.max.y;
      const sw = DECK_WIDTH / deck.width;
      return { x: 0, y: -top * sw, sx: 1, sy: sw, sz: sw };
    }, deck.length * (DECK_WIDTH / deck.width), false);
    else this.ribbonDeck(frames);

    // Lane markings are paint on whatever deck there is
    this.ribbon(frames, (f) => [[-f.hw + 0.3, 0.03 - f.dip], [f.hw - 0.3, 0.03 - f.dip]], this.mats.paint, [0, 1], false);

    // --- Barriers along both edges and down the median ---
    const barrier = this.kit.barrier;
    if (!inner.length) {
      // A short link: no barriers at all
    } else if (barrier) {
      const stretch = barrier.part.stretch ?? 1;
      for (const side of [-1, 1]) {
        this.instanceAlong(inner, barrier, (f) => ({
          x: side * (f.hw - barrier.width / 2), y: -barrier.min.y, sx: stretch, sy: 1, sz: 1,
        }), barrier.length * stretch, true);
      }
      if (median.length > 2) {
        this.instanceAlong(median, barrier, () => ({ x: 0, y: -barrier.min.y, sx: stretch, sy: 1, sz: 1 }), barrier.length * stretch, true);
      }
    } else {
      for (const side of [-1, 1]) {
        this.ribbon(inner, (f) => {
          const x = side * f.hw;
          const section: [number, number][] = [[x, 0], [x, BARRIER_HEIGHT], [x + side * 0.4, BARRIER_HEIGHT], [x + side * 0.4, -DECK_DEPTH]];
          return side < 0 ? section.reverse() : section; // the road face towards the road on both sides
        }, this.mats.concrete, side < 0 ? [1, 0.4, 0.3, 0] : [0, 0.3, 0.4, 1], false);
      }
      if (median.length > 2) this.ribbon(median, () => [[-0.35, 0], [-0.3, 0.9], [0.3, 0.9], [0.35, 0]], this.mats.concrete, [0, 0.3, 0.7, 1], false);
    }

    // --- Lamps: down the median on the highway, along the edges where it narrows ---
    const lamp = this.kit.lamp;
    if (lamp) {
      const spacing = lamp.part.spacing ?? 60;
      const list: THREE.Matrix4[] = [];
      for (let s = spacing / 2, k = 0; s < frames[frames.length - 1].s; s += spacing, k++) {
        const f = frameAt(frames, s);
        const inMedian = f.hw >= full;
        for (const side of inMedian ? [-1, 1] : [k % 2 ? 1 : -1]) {
          // In the median: a lamp either side of the barrier, each arm over its own carriageway
          const x = inMedian ? side * 0.7 : side * (f.hw - 0.2);
          const facing = inMedian ? -side : side;
          const p = at(f, x, -lamp.min.y);
          const yaw = Math.atan2(-f.r.z * facing, f.r.x * facing);
          list.push(new THREE.Matrix4().compose(p, new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, 0)), new THREE.Vector3(1.6, 1.6, 1.6)));
        }
      }
      this.instances(lamp, list, true);
    }

    // --- Pillars down to the seabed, where the deck is high enough to need them ---
    const pillar = this.kit.pillar;
    const list: { f: Frame; h: number }[] = [];
    for (let s = PILLAR_SPACING; s < frames[frames.length - 1].s - PILLAR_SPACING / 2; s += PILLAR_SPACING) {
      const f = frameAt(frames, s);
      if (f.p.y < 6 || f.s < EMBANKMENT || f.s > frames[frames.length - 1].s - EMBANKMENT) continue;
      list.push({ f, h: f.p.y - DECK_DEPTH - SEABED });
      const hy = (f.p.y - DECK_DEPTH - SEABED) / 2;
      world.createCollider(RAPIER.ColliderDesc.cuboid(1.4, hy, f.hw * 0.7)
        .setTranslation(f.p.x, SEABED + hy, f.p.z)
        .setRotation(new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.atan2(-f.t.z, f.t.x), 0)))
        .setCollisionGroups(STATIC_GROUPS));
    }
    if (pillar) {
      const mats = list.map(({ f, h }) => {
        const sy = h / pillar.height;
        const sxz = Math.min(3, Math.max(0.5, (f.hw * 2 * 0.8) / Math.max(pillar.width, pillar.length)));
        const p = new THREE.Vector3(f.p.x, SEABED - pillar.min.y * sy, f.p.z);
        return new THREE.Matrix4().compose(p, new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.atan2(-f.t.z, f.t.x) + Math.PI / 2, 0)), new THREE.Vector3(sxz, sy, sxz));
      });
      this.instances(pillar, mats, false);
    } else {
      this.fallbackPillars(list);
    }
  }

  /** A strip along the curve through cross-section points (x across, y up) per frame, u across, v along. */
  private ribbon(frames: Frame[], section: (f: Frame) => [number, number][], material: THREE.Material, us: number[], collide: boolean, uScale = DECK_WIDTH / 8): void {
    void collide;
    const pos: number[] = [];
    const uv: number[] = [];
    const idx: number[] = [];
    const m = section(frames[0]).length;
    const vScale = material === this.mats.paint ? 1 / 12 : 1 / 8;
    frames.forEach((f, i) => {
      section(f).forEach(([x, y], j) => {
        const v = new THREE.Vector3().copy(f.p).addScaledVector(f.r, x).setY(f.p.y + y);
        pos.push(v.x, v.y, v.z);
        uv.push(material === this.mats.paint ? us[j] : us[j] * uScale, f.s * vScale);
      });
      if (i === 0) return;
      const a = (i - 1) * m;
      const b = i * m;
      // Wound so a section running left to right faces up (three.js draws counter-clockwise as the front):
      // each face's front is to the left of its section's direction, looking down the road
      for (let k = 0; k < m - 1; k++) idx.push(a + k, a + k + 1, b + k, a + k + 1, b + k + 1, b + k);
    });
    this.addChunked(pos, uv, idx, material, frames, m);
  }

  private ribbonDeck(frames: Frame[]): void {
    // Under the city's road where they overlap (f.dip), so the two surfaces don't flicker
    this.ribbon(frames, (f) => [[-f.hw, -f.dip], [f.hw, -f.dip]], this.mats.asphalt, [0, 1], true);
    // Girder: sides and underside
    this.ribbon(frames, (f) => [[f.hw, -f.dip], [f.hw, -DECK_DEPTH], [f.hw - 3, -DECK_DEPTH], [-f.hw + 3, -DECK_DEPTH], [-f.hw, -DECK_DEPTH], [-f.hw, -f.dip]], this.mats.concrete, [0, 0.1, 0.25, 0.75, 0.9, 1], false);
  }

  /** Split a ribbon into chunks along its length (frustum culling), as meshes. */
  private addChunked(pos: number[], uv: number[], idx: number[], material: THREE.Material, frames: Frame[], m: number): void {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    const per = Math.max(1, Math.round(PIECE_CHUNK / STEP));
    const quads = (m - 1) * 6;
    for (let start = 0; start < frames.length - 1; start += per) {
      const end = Math.min(frames.length - 1, start + per);
      const g = geo.clone();
      g.setIndex(idx.slice(start * quads, end * quads));
      g.computeVertexNormals();
      g.computeBoundingSphere();
      // The shared vertex buffer's bounding sphere would cover the whole bridge: use this chunk's
      const box = new THREE.Box3();
      for (let i = start; i <= end; i++) box.expandByPoint(frames[i].p);
      box.expandByScalar(DECK_WIDTH);
      g.boundingSphere = box.getBoundingSphere(new THREE.Sphere());
      const mesh = new THREE.Mesh(g, material);
      mesh.receiveShadow = true;
      mesh.castShadow = material !== this.mats.paint;
      this.root.add(mesh);
    }
  }

  /** Repeat a straight kit piece along the curve, each copy set on the curve's tangent. */
  private instanceAlong(
    frames: Frame[], part: LoadedPart, place: (f: Frame) => { x: number; y: number; sx: number; sy: number; sz: number },
    pieceLength: number, detail: boolean,
  ): void {
    const S = frames[frames.length - 1].s - frames[0].s;
    const count = Math.max(1, Math.round(S / pieceLength));
    const len = S / count;
    const list: THREE.Matrix4[] = [];
    const q = new THREE.Quaternion();
    const basis = new THREE.Matrix4();
    for (let k = 0; k < count; k++) {
      // Each piece exactly where it belongs along the curve (not snapped to a cross-section: that left gaps)
      const f = frameAt(frames, (k + 0.5) * len);
      const o = place(f);
      // Piece axes: length along the tangent, up, across to the right
      const up = new THREE.Vector3().crossVectors(f.r, f.t).normalize();
      basis.makeBasis(f.t, up, f.r);
      q.setFromRotationMatrix(basis);
      const p = new THREE.Vector3().copy(f.p).addScaledVector(f.r, o.x).addScaledVector(up, o.y);
      // Each copy covers `len` m (a hair more, closing the gaps on curves), centred on its point
      const sx = (len * 1.02) / part.length;
      p.addScaledVector(f.t, -((part.min.x + part.max.x) / 2) * sx);
      p.addScaledVector(f.r, -((part.min.z + part.max.z) / 2) * o.sz);
      list.push(new THREE.Matrix4().compose(p, q, new THREE.Vector3(sx, o.sy, o.sz)));
    }
    this.instances(part, list, detail);
  }

  /** Instanced copies of a kit part, chunked for culling. */
  private instances(part: LoadedPart, list: THREE.Matrix4[], detail: boolean): void {
    const per = Math.max(1, Math.round(PIECE_CHUNK / Math.max(1, part.length)));
    for (let start = 0; start < list.length; start += per) {
      const chunk = list.slice(start, start + per);
      for (const { geometry, material } of part.meshes) {
        const mesh = new THREE.InstancedMesh(geometry, material, chunk.length);
        chunk.forEach((m, k) => mesh.setMatrixAt(k, m));
        mesh.computeBoundingSphere();
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        this.root.add(mesh);
        if (detail) this.detail.push({ mesh, center: mesh.boundingSphere!.center.clone(), radius: mesh.boundingSphere!.radius });
      }
    }
  }

  private fallbackPillars(list: { f: Frame; h: number }[]): void {
    if (!list.length) return;
    const geo = new THREE.BoxGeometry(2.8, 1, DECK_WIDTH * 0.7);
    geo.translate(0, 0.5, 0);
    // Texture repeats in metres whatever the scale
    const mesh = new THREE.InstancedMesh(geo, this.mats.concrete, list.length);
    list.forEach(({ f, h }, k) => {
      mesh.setMatrixAt(k, new THREE.Matrix4().compose(
        new THREE.Vector3(f.p.x, SEABED, f.p.z),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.atan2(-f.t.z, f.t.x), 0)),
        new THREE.Vector3(1, h, 1),
      ));
    });
    mesh.computeBoundingSphere();
    mesh.receiveShadow = true;
    this.root.add(mesh);
  }

  /** Hide small parts (barriers, lamps) far from the camera. */
  update(camera: THREE.Vector3): void {
    for (const d of this.detail) d.mesh.visible = d.center.distanceTo(camera) - d.radius < DETAIL_DISTANCE;
  }
}

/** A geometry's attributes as plain floats (quantized glTF stores normalized integers). */
export function toFloat(g: THREE.BufferGeometry): THREE.BufferGeometry {
  for (const name of Object.keys(g.attributes)) {
    const a = g.getAttribute(name) as THREE.BufferAttribute | THREE.InterleavedBufferAttribute;
    if (!(a as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute && a.array instanceof Float32Array && !a.normalized) continue;
    const n = a.itemSize;
    const f = new Float32Array(a.count * n);
    for (let i = 0; i < a.count; i++) {
      f[i * n] = a.getX(i);
      if (n > 1) f[i * n + 1] = a.getY(i);
      if (n > 2) f[i * n + 2] = a.getZ(i);
      if (n > 3) f[i * n + 3] = a.getW(i);
    }
    g.setAttribute(name, new THREE.BufferAttribute(f, n));
  }
  return g;
}

/** Lane markings as a texture across the deck: solid edge lines, dashed lane lines, a double centre line. */
function laneMarkings(): THREE.Material {
  const W = 256;
  const H = 256;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, W, H);
  const usable = DECK_WIDTH - 0.6;
  const px = (m: number) => ((m + usable / 2) / usable) * W;
  const line = (m: number, width: number, dashed: boolean, color: string) => {
    g.fillStyle = color;
    const w = Math.max(1.5, (width / usable) * W);
    if (dashed) g.fillRect(px(m) - w / 2, 0, w, H * 0.4);
    else g.fillRect(px(m) - w / 2, 0, w, H);
  };
  // Each carriageway: a yellow line by the median, dashed white between its lanes, a solid white edge
  const inside = MEDIAN / 2 + INNER_SHOULDER;
  for (const side of [-1, 1]) {
    line(side * inside, 0.15, false, '#e0b43a');
    for (let k = 1; k < LANES; k++) line(side * (inside + k * LANE), 0.12, true, '#e8e6df');
    line(side * (inside + LANES * LANE), 0.15, false, '#e8e6df');
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return new THREE.MeshStandardMaterial({
    map: t, transparent: true, depthWrite: false, roughness: 0.6,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
}
