// Bridges between the islands (HANDOFF plan B): highway viaducts from a street on one island to a street
// on another, laid out the way real ones are:
//   plan      each end leaves along its own road, then the deck sweeps out over the sea in a long bow or S
//             (a causeway drawn with a ruler is dull to drive and looks placed, not built): the widest swing
//             whose bends stay MIN_RADIUS m or wider, that keeps off every other island, BRIDGE_CLEARANCE m
//             from the bridges already laid, and no further along its own coasts than a straight one would
//   profile   up from each street at MAX_GRADE at most to DECK_CLEARANCE m over the sea, on long vertical
//             curves; a crossing with NAV_SPAN m of open water rises in its middle to a navigation span
//             NAV_CLEARANCE m up
//   deck      three lanes each way and a median on a concrete box girder (a slab cantilevered over a
//             trapezoid box), narrowing over TAPER m at each end to the street it joins
//   ground    from each end, while the deck is still low, a rock (riprap) embankment down to the seabed, its
//             end sloped round under the deck where the piers take over; then a pier every SPAN m: twin
//             columns under a hammerhead cap, standing on a footing at the waterline
// What the car drives on is exact: a trimesh following the curve (deck, barrier walls, median, the
// embankment slopes), and road-graph nodes every NODE_SPACING m joined to both gateways, so traffic, the
// GPS, rivals and races all cross.
//
// Barriers and lamps are real models (public/mods/bridges/kit.json, see Kit below: Poly Haven, CC0); a kit
// can bring deck and pier models too. What it doesn't have is built on the curve and textured with Poly
// Haven materials (asphalt, concrete, rocks).
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
const TAPER = 160; // m over which a deck widens from the street it leaves to the full highway
const END_DIP = 0.07; // m the deck sits under the city's road where they overlap, so they don't fight (flicker)
const DIP_LENGTH = 30; // m over which that dip eases out
// Plan
const SWINGS = [0.13, 0.1, 0.075, 0.05, 0.03]; // of a link's length: how far it swings off the straight line, widest first
const SWING_MAX = 480; // m
const MIN_RADIUS = 450; // m: the tightest bend on a deck (a highway at 100+ km/h)
const BRIDGE_CLEARANCE = 90; // m between two bridges' centrelines, away from their ends
// Profile
const DECK_CLEARANCE = 12; // m above the sea at least, away from the ends
const MAX_GRADE = 0.05;
const NAV_SPAN = 1700; // m of open water at least under a crossing for a navigation span over its middle
const NAV_CLEARANCE = 30; // m above the sea at the top of it
const NAV_CREST = 240; // m level at the top
const NAV_GRADE = 0.045; // the steepest grade on the way up to it
const FLOOR_REACH = 40; // m either side: over land the deck stays above the highest ground this near
const CLIMB_COST = 80; // route cost per m that the land along it rises above both its ends (per 40 m sample)
const OBSTACLE_COST = 500; // route cost per 20 m of its approach through something taller than the deck can clear
// Structure
const GIRDER_DEPTH = 2.6; // m from the road surface to the underside of the box girder
const SLAB_EDGE = 0.5; // m: the deck slab's edge (the fascia under the barrier)
const WING = 3.5; // m of slab cantilevered beyond the box on each side
const WING_ROOT = 0.9; // m down, where the wing meets the box
const EMBANK_TOP = 7.5; // m: the deck runs on an embankment from each end until it's this high…
const EMBANK_MAX = 260; // m …or this far out
const EMBANK_FOOT = -6; // m: where the embankment meets the seabed
const EMBANK_SLOPE = 1.5; // m out per m down
const HIGH_OVER_LAND = 8; // m: a deck higher than this over land stands on piers, lower on the ground
const FILL_FROM = 1.5; // m: a deck this high over land or more has rock slopes down to the ground
const SPAN = 50; // m between piers
const FOOTING_TOP = 1.2; // m: a pier's footing stands this far out of the water
const SEABED = -18; // m, where piers end
const BARRIER_HEIGHT = 1.1; // m, the collision wall along each edge
const BARRIER_GAP = 36; // m at each end with no barrier, so a street the bridge leaves from stays open
const NODE_SPACING = 25; // m between road-graph nodes on the deck
const STEP = 4; // m between cross-sections of the deck geometry
const UV_METRES = 4; // m of structure per repeat of its texture
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
  /** Armour stones along an embankment's waterline. */
  armour?: KitPart;
}
const DEFAULT_KIT: Kit = {
  barrier: { model: 'bridges/concrete_road_barrier_02.glb', stretch: 1.6 },
  lamp: { model: 'bridges/street_lamp_01.glb', spacing: 60 },
  armour: { model: 'coast/boulder_01.glb' },
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
  const ground = groundAt(islands, landAt);
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
      const top: (LinkPlan & { shore: number })[] = [];
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
            top.push({ a, b, na: ga.node, nb: gb.node, cost, length, shore: ga.shoreDist + gb.shoreDist });
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
        // What stands on each end's approach: every m² of hill or building above the deck counts. And the
        // land it really crosses (the gateways' distance to the shore only guessed it): a route over its own
        // island's hills is a road through them, not a bridge
        for (const l of top) {
          const pa = islands[a].nodes[l.na];
          const pb = islands[b].nodes[l.nb];
          l.cost += 0.5 * (blocked(islands[a], pa, pb, l.length) + blocked(islands[b], pb, pa, l.length));
          // …and above all how high that land rises over both ends: the deck would have to climb over it
          let land = 0;
          let climb = 0;
          let blocks = 0;
          const over = Math.max(pa.y, pb.y) + 3;
          for (let t = 0; t <= 1; t += 20 / l.length) {
            const x = pa.x + (pb.x - pa.x) * t;
            const z = pa.z + (pb.z - pa.z) * t;
            const k = landAt(x, z);
            if (k !== a && k !== b) continue;
            land += 20;
            climb += Math.max(0, ground(x, z) - over) / 2;
            // Anything standing above the most the deck could have climbed to here (a building, a hillside):
            // the approach would cut its lower storeys away and leave the rest standing on nothing
            const reach = Math.min(pa.y + MAX_GRADE * t * l.length, pb.y + MAX_GRADE * (1 - t) * l.length) + 3;
            const r = new THREE.Vector2(pb.z - pa.z, pa.x - pb.x).normalize().multiplyScalar(DECK_WIDTH / 2 + 3);
            if ([0, 1, -1].some((side) => (islands[k].top?.(x + r.x * side, z + r.y * side) ?? -Infinity) > reach)) blocks++;
          }
          l.cost += landCost * Math.max(0, land - l.shore) + CLIMB_COST * climb + OBSTACLE_COST * blocks;
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
  /** Where it meets each city's road (the gateways, on the road surface), A then B. */
  ends: [THREE.Vector3, THREE.Vector3];
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

const smooth = (x: number) => { const c = THREE.MathUtils.clamp(x, 0, 1); return c * c * (3 - 2 * c); };

/** How a deck swings off the straight line between its ends: a bow or an S, `amp` m at most (signed: the side). */
interface Bend {
  shape: 'bow' | 's';
  amp: number;
  /** Where along the link (0–1) it bends: over the water. */
  span?: [number, number];
}
const STRAIGHT: Bend = { shape: 'bow', amp: 0 };
const S_PEAK = 0.6495; // the most of sin(2πt)·sin²(πt), at t = 1/3

/**
 * The deck's plan from A to B, finely sampled: a Hermite curve leaving A along `da` and arriving at B along
 * `db`, plus the bend across the chord over `span` (the part of the curve over water, 0–1). The bend is zero,
 * with zero slope, where it starts and ends, so each end still leaves along its road.
 */
function planCurve(pa: THREE.Vector3, da: THREE.Vector2, pb: THREE.Vector3, db: THREE.Vector2, bend: Bend, span: [number, number] = [0, 1]): THREE.Vector2[] {
  const L = Math.hypot(pb.x - pa.x, pb.z - pa.z);
  const m = L * 0.75;
  const N = Math.max(60, Math.ceil(L / 3));
  const nx = -(pb.z - pa.z) / (L || 1);
  const nz = (pb.x - pa.x) / (L || 1);
  const out: THREE.Vector2[] = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const h00 = 2 * t ** 3 - 3 * t ** 2 + 1;
    const h10 = t ** 3 - 2 * t ** 2 + t;
    const h01 = -2 * t ** 3 + 3 * t ** 2;
    const h11 = t ** 3 - t ** 2;
    // Only over the water (`span`): on land the deck keeps to its street's line, not through the blocks beside it
    const u = THREE.MathUtils.clamp((t - span[0]) / Math.max(1e-6, span[1] - span[0]), 0, 1);
    const s2 = Math.sin(Math.PI * u) ** 2;
    const b = bend.amp * (bend.shape === 'bow' ? s2 : (Math.sin(2 * Math.PI * u) * s2) / S_PEAK);
    out.push(new THREE.Vector2(
      h00 * pa.x + h10 * m * da.x + h01 * pb.x + h11 * m * db.x + nx * b,
      h00 * pa.z + h10 * m * da.y + h01 * pb.z + h11 * m * db.y + nz * b,
    ));
  }
  return out;
}

/** Points evenly `step` m (or a little less) apart along a polyline, both ends included, and its length. */
function resample(line: THREE.Vector2[], step: number): { pts: THREE.Vector2[]; length: number } {
  const cum = [0];
  for (let i = 1; i < line.length; i++) cum.push(cum[i - 1] + line[i].distanceTo(line[i - 1]));
  const S = cum[cum.length - 1];
  const n = Math.max(2, Math.ceil(S / step));
  const pts: THREE.Vector2[] = [];
  let j = 0;
  for (let i = 0; i <= n; i++) {
    const s = (S * i) / n;
    while (j < cum.length - 2 && cum[j + 1] < s) j++;
    const f = (s - cum[j]) / Math.max(1e-6, cum[j + 1] - cum[j]);
    pts.push(line[j].clone().lerp(line[j + 1], f));
  }
  return { pts, length: S };
}

/** The tightest bend along evenly spaced points: the radius through each point and those ~20 m either side. */
function minRadius(pts: THREE.Vector2[], step: number): number {
  const k = Math.max(1, Math.round(20 / step));
  let best = Infinity;
  for (let i = k; i + k < pts.length; i++) {
    const a = pts[i - k];
    const b = pts[i];
    const c = pts[i + k];
    const cross = Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
    if (cross < 1e-6) continue;
    best = Math.min(best, (a.distanceTo(b) * b.distanceTo(c) * c.distanceTo(a)) / (2 * cross));
  }
  return best;
}

/** The centrelines of the bridges laid so far, bucketed, to keep the next ones clear of them. */
class Laid {
  private readonly cells = new Map<string, THREE.Vector2[]>();
  private static key(x: number, z: number): string {
    return `${Math.floor(x / BRIDGE_CLEARANCE)},${Math.floor(z / BRIDGE_CLEARANCE)}`;
  }

  add(line: THREE.Vector2[]): void {
    for (const p of line) {
      const k = Laid.key(p.x, p.y);
      let l = this.cells.get(k);
      if (!l) this.cells.set(k, (l = []));
      l.push(p);
    }
  }

  near(p: THREE.Vector2): boolean {
    const cx = Math.floor(p.x / BRIDGE_CLEARANCE);
    const cz = Math.floor(p.y / BRIDGE_CLEARANCE);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      for (const q of this.cells.get(`${cx + i},${cz + j}`) ?? []) if (p.distanceToSquared(q) < BRIDGE_CLEARANCE ** 2) return true;
    }
    return false;
  }
}

/**
 * The widest swing for a link (SWINGS, a bow or an S, either side) whose bends stay MIN_RADIUS or wider (or
 * no tighter than its straight version's, where the roads it leaves already turn it), that keeps off every
 * island but its own two, BRIDGE_CLEARANCE m from the bridges laid (bar near the ends, where two may leave
 * the same street), and doesn't run over its own islands' land more than the straight version. Which side
 * and shape it tries first varies from bridge to bridge (`seed`).
 */
function chooseBend(
  pa: THREE.Vector3, da: THREE.Vector2, pb: THREE.Vector3, db: THREE.Vector2,
  a: number, b: number, landAt: ((x: number, z: number) => number) | undefined, laid: Laid, seed: number,
): Bend {
  const L = Math.hypot(pb.x - pa.x, pb.z - pa.z);
  const STEP_M = 10;
  const span = waterSpan(pa, da, pb, db, a, b, landAt);
  const judge = (bend: Bend) => {
    const { pts, length } = resample(planCurve(pa, da, pb, db, bend, span), STEP_M);
    let own = 0;
    let third = false;
    if (landAt) {
      for (const p of pts) {
        const k = landAt(p.x, p.y);
        if (k === a || k === b) own += STEP_M;
        else if (k >= 0) third = true;
      }
    }
    const keep = Math.min(220, length / 4);
    const near = pts.some((p, i) => i * STEP_M > keep && (pts.length - 1 - i) * STEP_M > keep && laid.near(p));
    return { r: minRadius(pts, STEP_M), own, third, near };
  };
  const straight = judge(STRAIGHT);
  const shapes: [Bend['shape'], number][] = [['bow', 1], ['s', 1], ['bow', -1], ['s', -1]];
  for (const f of SWINGS) {
    const amp = Math.min(SWING_MAX, f * L);
    if (amp < 25) break;
    for (let j = 0; j < shapes.length; j++) {
      const [shape, side] = shapes[(seed + j) % shapes.length];
      const bend = { shape, amp: side * amp };
      const v = judge(bend);
      if (!v.third && !v.near && v.r >= Math.min(MIN_RADIUS, straight.r * 0.9) && v.own <= straight.own + 80) return { ...bend, span };
    }
  }
  return { ...STRAIGHT, span };
}

/** The part of a link's straight version (0–1 along it) between leaving its own island A and reaching B. */
function waterSpan(
  pa: THREE.Vector3, da: THREE.Vector2, pb: THREE.Vector3, db: THREE.Vector2,
  a: number, b: number, landAt: ((x: number, z: number) => number) | undefined,
): [number, number] {
  if (!landAt) return [0, 1];
  const line = planCurve(pa, da, pb, db, STRAIGHT);
  let i0 = 0;
  while (i0 < line.length - 1 && landAt(line[i0].x, line[i0].y) === a) i0++;
  let i1 = line.length - 1;
  while (i1 > i0 && landAt(line[i1].x, line[i1].y) === b) i1--;
  return [i0 / (line.length - 1), i1 / (line.length - 1)];
}

/**
 * The deck from A to B: its plan (planCurve with `bend`) sampled every STEP m, and its profile: up from each
 * street at MAX_GRADE at most to DECK_CLEARANCE m, over NAV_SPAN m or more of open water (`sea`) a
 * navigation span NAV_CLEARANCE m up in the middle of it, all eased into long vertical curves; and never
 * into the ground where it crosses land (`ground`): leaving a city on a plateau it stays up until it's out
 * over the water. The width tapers from each end's street (halfA, halfB) to the full highway.
 */
function centerline(
  pa: THREE.Vector3, da: THREE.Vector2, pb: THREE.Vector3, db: THREE.Vector2, halfA: number, halfB: number,
  bend: Bend, sea: (x: number, z: number) => boolean, ground: (x: number, z: number) => number,
): Frame[] {
  const { pts, length: S } = resample(planCurve(pa, da, pb, db, bend, bend.span), STEP);
  const n = pts.length - 1;
  const sAt = (i: number) => (S * i) / n;
  // The longest stretch of open water: the navigation span goes over its middle
  let best = { from: 0, to: -1 };
  let start = -1;
  pts.forEach((p, i) => {
    if (!sea(p.x, p.y)) { start = -1; return; }
    if (start < 0) start = i;
    if (i - start > best.to - best.from) best = { from: start, to: i };
  });
  const rise = NAV_CLEARANCE - DECK_CLEARANCE;
  const ramp = (rise * 1.5) / NAV_GRADE; // a smoothstep's steepest slope is 1.5× its average
  const nav = sAt(best.to - best.from) >= NAV_SPAN ? sAt((best.from + best.to) / 2) : null;
  const ha = pa.y;
  const hb = pb.y;
  // The floor: the ground under the deck (−∞ over water), its running maximum over ±FLOOR_REACH m so the
  // deck rides over the ground's bumps rather than dipping into each hollow and out again
  const raw = pts.map((p) => ground(p.x, p.y));
  const reach = Math.round(FLOOR_REACH / STEP);
  const floor = raw.map((_, i) => {
    let m = -Infinity;
    for (let d = Math.max(0, i - reach); d <= Math.min(n, i + reach); d++) m = Math.max(m, raw[d]);
    return m;
  });
  // …and ahead of rising ground the floor slopes down at MAX_GRADE, so the deck starts climbing early
  // enough to meet it at a grade a car can take, not a step where the land begins
  for (let i = 1; i <= n; i++) floor[i] = Math.max(floor[i], floor[i - 1] - MAX_GRADE * STEP);
  for (let i = n - 1; i >= 0; i--) floor[i] = Math.max(floor[i], floor[i + 1] - MAX_GRADE * STEP);
  // Never above what the deck can climb to from either end's road at MAX_GRADE: each end meets its street
  // level (ground higher than that beside the join is cut back; the cut slopes close it)
  for (let i = 0; i <= n; i++) floor[i] = Math.min(floor[i], ha + MAX_GRADE * sAt(i), hb + MAX_GRADE * (S - sAt(i)));
  let ys = pts.map((_, i) => {
    const s = sAt(i);
    let target = Math.max(DECK_CLEARANCE, ha + ((hb - ha) * s) / S);
    if (nav !== null) target += rise * smooth(1 - (Math.abs(s - nav) - NAV_CREST / 2) / ramp);
    const lo = Math.max(ha - MAX_GRADE * s, hb - MAX_GRADE * (S - s));
    const hi = Math.min(ha + MAX_GRADE * s, hb + MAX_GRADE * (S - s));
    const y = lo > hi ? ha + ((hb - ha) * s) / S : THREE.MathUtils.clamp(target, lo, hi);
    return i === 0 ? ha : i === n ? hb : Math.max(y, floor[i]);
  });
  // Vertical curves: a running mean over ±60 m, a few times (never past the ends, which stay on their
  // roads), each time lifted back off the floor
  const w = Math.max(1, Math.round(60 / STEP));
  for (let pass = 0; pass < 4; pass++) {
    ys = ys.map((y, i) => {
      if (i === 0 || i === ys.length - 1) return y;
      const k = Math.min(w, i, ys.length - 1 - i);
      let sum = 0;
      for (let d = -k; d <= k; d++) sum += ys[i + d];
      return Math.max(sum / (2 * k + 1), floor[i]);
    });
  }
  const full = DECK_WIDTH / 2;
  const frames: Frame[] = pts.map((p, i) => {
    const s = sAt(i);
    const hw = Math.min(halfA + (full - halfA) * smooth(s / TAPER), halfB + (full - halfB) * smooth((S - s) / TAPER));
    const dip = END_DIP * (1 - smooth(Math.min(s, S - s) / DIP_LENGTH));
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

/** Half width of the box under a deck `hw` m wide each side (the slab's wings overhang it). */
const boxHalf = (hw: number) => Math.max(1.6, 0.52 * hw);

/** The deck's concrete from the road surface down: slab edges, wings, the box. Left to right round the outside. */
function girderSection(f: Frame): [number, number][] {
  const bw = boxHalf(f.hw);
  const wing = Math.max(0.4, Math.min(WING, f.hw - bw - 0.6));
  return [
    [f.hw, -f.dip], [f.hw, -SLAB_EDGE], [f.hw - wing, -WING_ROOT], [bw, -GIRDER_DEPTH],
    [-bw, -GIRDER_DEPTH], [-f.hw + wing, -WING_ROOT], [-f.hw, -SLAB_EDGE], [-f.hw, -f.dip],
  ];
}

/** Solid pieces built as flat-shaded faces (piers, embankment ends, girder ends), with UVs in metres. */
class Solid {
  readonly pos: number[] = [];
  readonly uv: number[] = [];
  readonly idx: number[] = [];

  /** A convex polygon, turned to face `out`. */
  face(pts: THREE.Vector3[], out: THREE.Vector3): void {
    if (pts.length < 3) return;
    const n = new THREE.Vector3().subVectors(pts[1], pts[0]).cross(new THREE.Vector3().subVectors(pts[2], pts[0]));
    const list = n.dot(out) < 0 ? [...pts].reverse() : pts;
    // Texture across the face: along its first edge and up it, in metres
    const e1 = new THREE.Vector3().subVectors(list[1], list[0]).normalize();
    const normal = new THREE.Vector3().subVectors(list[1], list[0]).cross(new THREE.Vector3().subVectors(list[2], list[0])).normalize();
    const e2 = new THREE.Vector3().crossVectors(normal, e1);
    const base = this.pos.length / 3;
    for (const p of list) {
      this.pos.push(p.x, p.y, p.z);
      this.uv.push(p.dot(e1) / UV_METRES, p.dot(e2) / UV_METRES);
    }
    for (let k = 1; k + 1 < list.length; k++) this.idx.push(base, base + k, base + k + 1);
  }

  /** A convex cross-section (x across `r`, y up) extruded `half` m either way along `t` from `c`. */
  prism(c: THREE.Vector3, t: THREE.Vector3, r: THREE.Vector3, section: [number, number][], half: number): void {
    const at = (x: number, y: number, along: number) => new THREE.Vector3().copy(c).addScaledVector(r, x).addScaledVector(t, along).setY(c.y + y);
    const mx = section.reduce((s, p) => s + p[0], 0) / section.length;
    const my = section.reduce((s, p) => s + p[1], 0) / section.length;
    this.face(section.map(([x, y]) => at(x, y, half)), t);
    this.face(section.map(([x, y]) => at(x, y, -half)), t.clone().negate());
    section.forEach(([x, y], i) => {
      const [x2, y2] = section[(i + 1) % section.length];
      const out = new THREE.Vector3().addScaledVector(r, (x + x2) / 2 - mx).setY((y + y2) / 2 - my);
      this.face([at(x, y, half), at(x2, y2, half), at(x2, y2, -half), at(x, y, -half)], out);
    });
  }

  /** A vertical column from y0 to y1 with a convex plan section (a along `t`, x across `r`) about `c`. */
  column(c: THREE.Vector3, t: THREE.Vector3, r: THREE.Vector3, section: [number, number][], y0: number, y1: number): void {
    const at = (a: number, x: number, y: number) => new THREE.Vector3(c.x + t.x * a + r.x * x, y, c.z + t.z * a + r.z * x);
    const up = new THREE.Vector3(0, 1, 0);
    this.face(section.map(([a, x]) => at(a, x, y1)), up);
    this.face(section.map(([a, x]) => at(a, x, y0)), up.clone().negate());
    section.forEach(([a, x], i) => {
      const [a2, x2] = section[(i + 1) % section.length];
      const out = new THREE.Vector3().addScaledVector(t, (a + a2) / 2).addScaledVector(r, (x + x2) / 2).setY(0);
      this.face([at(a, x, y0), at(a2, x2, y0), at(a2, x2, y1), at(a, x, y1)], out);
    });
  }

  get empty(): boolean {
    return this.idx.length === 0;
  }

  mesh(material: THREE.Material): THREE.Mesh {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setIndex(this.idx);
    g.computeVertexNormals(); // every face has its own corners: flat-shaded, crisp edges
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, material);
    m.castShadow = true;
    m.receiveShadow = true;
    return m;
  }
}

/** An octagon: a rectangle `a` × `x` (half sizes) with its corners cut back `c` m. */
function octagon(a: number, x: number, c: number): [number, number][] {
  return [[a, x - c], [a - c, x], [-a + c, x], [-a, x - c], [-a, -x + c], [-a + c, -x], [a - c, -x], [a, -x + c]];
}

/**
 * The height of the ground at a point on an island (world m), −∞ over the sea or where it isn't known: the
 * lowest of the tallest-thing heights (IslandPlan.top) in the 20 m cells round it, so a lone building or
 * tree doesn't count as ground, and no higher than the streets nearby (in a city, roofs are everywhere).
 */
function groundAt(islands: IslandPlan[], landAt?: (x: number, z: number) => number): (x: number, z: number) => number {
  // In a city every 20 m cell has a roof in it: there the ground is the streets. The lowest road within
  // ROAD_CELL m either way, per island, bucketed
  const ROAD_CELL = 75;
  const streets = new Map<number, Map<string, number>>();
  const streetsOf = (k: number) => {
    let m = streets.get(k);
    if (m) return m;
    m = new Map();
    for (const p of islands[k].nodes) {
      const key = `${Math.floor(p.x / ROAD_CELL)},${Math.floor(p.z / ROAD_CELL)}`;
      m.set(key, Math.min(m.get(key) ?? Infinity, p.y));
    }
    streets.set(k, m);
    return m;
  };
  return (x, z) => {
    const k = landAt ? landAt(x, z) : -1;
    if (k < 0) return -Infinity;
    const m = streetsOf(k);
    const cx = Math.floor(x / ROAD_CELL);
    const cz = Math.floor(z / ROAD_CELL);
    let road = Infinity;
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) road = Math.min(road, m.get(`${cx + i},${cz + j}`) ?? Infinity);
    const top = islands[k].top;
    if (!top) return Number.isFinite(road) ? road : -Infinity;
    let low = Infinity;
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) low = Math.min(low, top(x + i * 20, z + j * 20));
    return Math.min(low, road);
  };
}

/**
 * Each link's deck, in the planner's order: where it leaves each street and in which direction, how wide
 * each end is, its bend (chooseBend: the later bridges keep clear of the earlier) and its frames. Pure
 * geometry, for the scripts too (scripts/layout-variants.mjs draws the curves).
 */
export function layBridges(
  islands: IslandPlan[], plans: LinkPlan[], landAt?: (x: number, z: number) => number,
): { plan: LinkPlan; frames: Frame[]; endHalf: [number, number]; bend: Bend }[] {
  const laid = new Laid();
  const sea = (x: number, z: number) => (landAt ? landAt(x, z) < 0 : true);
  const ground = groundAt(islands, landAt);
  return plans.map((plan, k) => {
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
    const bend = chooseBend(pa, da, pb, db, plan.a, plan.b, landAt, laid, k);
    const frames = centerline(pa, da, pb, db, endHalf[0], endHalf[1], bend, sea, ground);
    laid.add(resample(frames.map((f) => new THREE.Vector2(f.p.x, f.p.z)), 10).pts);
    return { plan, frames, endHalf, bend };
  });
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
    landAt?: (x: number, z: number) => number,
  ) {
    this.root.name = 'bridges';
    const sea = (x: number, z: number) => (landAt ? landAt(x, z) < 0 : true);
    const ground = groundAt(islands, landAt);
    for (const { plan, frames, endHalf } of layBridges(islands, plans, landAt)) {
      const length = frames[frames.length - 1].s;
      const nodes: THREE.Vector3[] = [];
      const halfWidths: number[] = [];
      const count = Math.max(1, Math.round(length / NODE_SPACING));
      for (let j = 1; j < count; j++) {
        const f = frameAt(frames, (length * j) / count);
        nodes.push(f.p.clone());
        halfWidths.push(f.hw);
      }
      const ends: [THREE.Vector3, THREE.Vector3] = [islands[plan.a].nodes[plan.na].clone(), islands[plan.b].nodes[plan.nb].clone()];
      this.bridges.push({ plan, nodes, halfWidths, endHalf, length, ends });
      this.build(world, frames, sea, ground);
    }
  }

  /** `landAt`: which island (index into `islands`) has land at a point, −1 for the sea. */
  static async load(world: RAPIER.World, islands: IslandPlan[], plans: LinkPlan[], landAt?: (x: number, z: number) => number): Promise<BridgeNetwork> {
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
    // Riprap: grey boulders, what real causeway embankments are armoured with
    const [asphalt, concrete, rock] = await Promise.all([pbr('asphalt_02', 0x3a3a3c), pbr('concrete_wall_008', 0x8e8c88), pbr('gray_rocks', 0x6f6d69)]);
    // Seen from behind (where a slope ends, from under the deck) rock is still rock, not a hole
    rock.side = THREE.DoubleSide;
    return new BridgeNetwork(world, islands, plans, kit, { asphalt, concrete, rock, paint: laneMarkings() }, landAt);
  }

  private build(world: RAPIER.World, frames: Frame[], sea: (x: number, z: number) => boolean, ground: (x: number, z: number) => number): void {
    const at = (f: Frame, x: number, y: number) =>
      new THREE.Vector3().copy(f.p).addScaledVector(f.r, x).setY(f.p.y + y);
    const last = frames.length - 1;
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
    const collide = (pos: number[], idx: number[]) => {
      if (!idx.length) return;
      world.createCollider(RAPIER.ColliderDesc.trimesh(new Float32Array(pos), new Uint32Array(idx))
        .setFriction(1).setCollisionGroups(STATIC_GROUPS));
    };
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
      collide(col, colIdx);
    };
    strip(frames, (f) => [[-f.hw, 0], [f.hw, 0]], true);
    // The edge walls as high as the barrier drawn there (no invisible band above a lower model)
    const wall = this.kit.barrier ? THREE.MathUtils.clamp(this.kit.barrier.height, 0.7, BARRIER_HEIGHT) : BARRIER_HEIGHT;
    if (inner.length) {
      strip(inner, (f) => [[-f.hw, wall], [-f.hw, 0]], false);
      strip(inner, (f) => [[f.hw, 0], [f.hw, wall]], false);
    }
    if (median.length > 2) strip(median, () => [[-0.35, 0], [-0.35, 0.9], [0.35, 0.9], [0.35, 0]], false);

    // --- What the deck stands on. Over land: the ground, rock slopes joining its edges to the ground (down
    // where the deck is above it, up where it cuts in, so what the approach cleared away is closed), or piers
    // where it's more than HIGH_OVER_LAND m up. Over water: from the shore, while the deck is still low, a
    // riprap embankment down to the seabed with its end sloped round under the deck; beyond it, piers ---
    const beside = (f: Frame, side: number) => {
      const o = at(f, side * (f.hw + 6), 0);
      return ground(o.x, o.z);
    };
    const wet = frames.map((f) => sea(f.p.x, f.p.z));
    type Kind = 'ground' | 'land' | 'embank' | 'piers';
    const kind: Kind[] = frames.map((f, i) => {
      if (wet[i]) return 'piers';
      const g = Math.min(ground(f.p.x, f.p.z), beside(f, -1), beside(f, 1));
      if (!Number.isFinite(g)) return 'ground';
      const above = f.p.y - g;
      return above > HIGH_OVER_LAND ? 'piers' : above > FILL_FROM ? 'land' : 'ground';
    });
    // Embankments: from where each end's land gives way to water
    for (const [from, dir] of [[0, 1], [last, -1]] as const) {
      let i = from;
      while (i >= 0 && i <= last && (kind[i] === 'land' || kind[i] === 'ground')) i += dir;
      const shore = i;
      while (i >= 0 && i <= last && wet[i] && kind[i] === 'piers' && frames[i].p.y <= EMBANK_TOP
        && Math.abs(frames[i].s - frames[Math.min(last, Math.max(0, shore))].s) <= EMBANK_MAX) {
        kind[i] = 'embank';
        i += dir;
      }
    }
    // Runs of one kind, each with the frames either side of it, so neighbouring pieces meet
    const runs: { kind: Kind; i0: number; i1: number }[] = [];
    kind.forEach((k, i) => {
      const r = runs[runs.length - 1];
      if (r && r.kind === k) r.i1 = i;
      else runs.push({ kind: k, i0: i, i1: i });
    });
    const slope = (f: Frame, side: number): [number, number][] => {
      const drop = f.p.y - EMBANK_FOOT;
      return [[side * f.hw, -0.05], [side * (f.hw + EMBANK_SLOPE * drop), -drop]];
    };
    const embank = (fs: Frame[], open: Frame | null, out: 1 | -1) => {
      if (fs.length < 2) return;
      for (const side of [-1, 1]) {
        strip(fs, (f) => slope(f, side), false);
        this.ribbon(fs, (f) => (side < 0 ? slope(f, side).reverse() : slope(f, side)), this.mats.rock, [0, 1], false, 6);
      }
      if (!open) return;
      // The end: sloped round under the deck at the same angle, its corners coned into the side slopes
      const solid = new Solid();
      const t = new THREE.Vector3(open.t.x, 0, open.t.z).normalize().multiplyScalar(out);
      const drop = open.p.y - EMBANK_FOOT;
      const reach = EMBANK_SLOPE * drop;
      const top = [at(open, -open.hw, -0.05), at(open, open.hw, -0.05)];
      const foot = (x: number) => at(open, x, -drop);
      const toe = (x: number) => foot(x).addScaledVector(t, reach);
      const upOut = t.clone().setY(1 / EMBANK_SLOPE);
      solid.face([top[0], top[1], toe(open.hw + reach), toe(-open.hw - reach)], upOut);
      for (const side of [-1, 1]) {
        const edge = side < 0 ? top[0] : top[1];
        solid.face([edge, foot(side * (open.hw + reach)), toe(side * (open.hw + reach))], upOut.clone().addScaledVector(open.r, side));
      }
      const m = solid.mesh(this.mats.rock);
      m.name = 'embankment-end';
      this.root.add(m);
      collide(solid.pos, solid.idx);
      // Armour stones where the embankment meets the water, along both sides and round its end
      const armour = this.kit.armour;
      if (!armour) return;
      const stones: THREE.Matrix4[] = [];
      const size = Math.max(armour.length, armour.width, armour.height) || 1;
      let seed = (Math.floor(Math.abs(open.p.x) * 13 + Math.abs(open.p.z) * 7) >>> 0) || 1;
      const rand = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
      const stone = (p: THREE.Vector3) => {
        const k = (1.6 + rand() * 1.8) / size;
        const q = new THREE.Quaternion().setFromEuler(new THREE.Euler((rand() - 0.5) * 0.5, rand() * Math.PI * 2, (rand() - 0.5) * 0.5));
        stones.push(new THREE.Matrix4().compose(p.setY(p.y - 0.4 - rand() * 0.6), q, new THREE.Vector3(k * (0.8 + rand() * 0.4), k * (0.6 + rand() * 0.3), k)));
      };
      for (let d = 0; d < fs[fs.length - 1].s - fs[0].s; d += 5.5) {
        const f = frameAt(fs, d);
        if (f.p.y < 1 || !sea(f.p.x, f.p.z)) continue; // on land the slope is under the ground
        for (const side of [-1, 1]) stone(at(f, side * (f.hw + EMBANK_SLOPE * f.p.y + (rand() - 0.4) * 1.5), -f.p.y));
      }
      if (open.p.y >= 1 && sea(open.p.x, open.p.z)) {
        const w = open.hw + EMBANK_SLOPE * open.p.y;
        for (let x = -w; x <= w; x += 5.5) stone(at(open, x, -open.p.y).addScaledVector(t, EMBANK_SLOPE * open.p.y));
      }
      this.instances(armour, stones, true);
    };
    // Where the deck stands clear of the ground: rock from its edge down into the ground at EMBANK_SLOPE,
    // 2 m past it so the two meet whatever the ground's bumps (where it's at ground level, the ground and
    // the city's own streets meet it: nothing is built over them)
    const shoulder = (f: Frame, side: number): [number, number][] => {
      const gnd = beside(f, side);
      const drop = Math.min(HIGH_OVER_LAND, Number.isFinite(gnd) ? f.p.y - gnd : FILL_FROM) + 2;
      return [[side * f.hw, -0.05], [side * (f.hw + EMBANK_SLOPE * drop), -drop]];
    };
    for (const r of runs) {
      // One frame into the next run where that's land too, so the two slopes meet (not into piers: an
      // embankment's slopes stop where its end slopes round)
      const i0 = r.i0 > 0 && (r.kind === 'land' || kind[r.i0 - 1] === 'land') ? r.i0 - 1 : r.i0;
      const i1 = r.i1 < last && (r.kind === 'land' || kind[r.i1 + 1] === 'land') ? r.i1 + 1 : r.i1;
      const fs = frames.slice(i0, i1 + 1);
      if (r.kind === 'land') {
        for (const side of [-1, 1]) {
          strip(fs, (f) => shoulder(f, side), false);
          this.ribbon(fs, (f) => (side < 0 ? shoulder(f, side).reverse() : shoulder(f, side)), this.mats.rock, [0, 1], false, 6);
        }
      } else if (r.kind === 'embank') {
        // Its open end: whichever side has piers next (the other is the shore, or the city's street)
        const next = kind[r.i1 + 1] === 'piers' ? frames[r.i1] : null;
        const prev = r.i0 > 0 && kind[r.i0 - 1] === 'piers' ? frames[r.i0] : null;
        embank(fs, next ?? prev, next ? 1 : -1);
      }
    }

    // --- Deck: kit pieces, else the road surface on a box girder ---
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
          const section: [number, number][] = [[x, 0], [x, BARRIER_HEIGHT], [x + side * 0.4, BARRIER_HEIGHT], [x + side * 0.4, -SLAB_EDGE]];
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
      for (let s = spacing / 2, k = 0; s < frames[last].s; s += spacing, k++) {
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

    // --- Piers along each stretch that stands on nothing else, evenly, one every SPAN m or so (its ends rest
    // on an embankment, the ground or a street) ---
    const piers: Frame[] = [];
    for (const r of runs) {
      if (r.kind !== 'piers') continue;
      const s0 = frames[Math.max(0, r.i0 - 1)].s;
      const s1 = frames[Math.min(last, r.i1 + 1)].s;
      const spans = Math.max(1, Math.round((s1 - s0) / SPAN));
      for (let k = 1; k < spans; k++) {
        const f = frameAt(frames, s0 + ((s1 - s0) * k) / spans);
        if (f.s < 20 || f.s > frames[last].s - 20) continue; // on the street there
        piers.push(f);
      }
    }
    const pillar = this.kit.pillar;
    if (pillar) {
      const mats = piers.map((f) => {
        const h = f.p.y - GIRDER_DEPTH - SEABED;
        const sy = h / pillar.height;
        const sxz = Math.min(3, Math.max(0.5, (f.hw * 2 * 0.8) / Math.max(pillar.width, pillar.length)));
        const p = new THREE.Vector3(f.p.x, SEABED - pillar.min.y * sy, f.p.z);
        return new THREE.Matrix4().compose(p, new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.atan2(-f.t.z, f.t.x) + Math.PI / 2, 0)), new THREE.Vector3(sxz, sy, sxz));
      });
      this.instances(pillar, mats, false);
    } else {
      this.piers(world, piers, sea);
    }
  }

  /**
   * Piers under the deck: under a full-width deck twin columns (beneath the box's webs), else one, from a
   * footing at the waterline (or from the ground, on land) up to a hammerhead cap the girder sits on.
   * Built in groups of a few hundred metres (culling); each column is solid to the car.
   */
  private piers(world: RAPIER.World, list: Frame[], sea: (x: number, z: number) => boolean): void {
    const CAP_HEIGHT = 1.8;
    const CAP_ALONG = 1.6; // m either side of the pier's line
    const COLUMN_ALONG = 1.1;
    const PER_MESH = 6;
    let solid = new Solid();
    const flush = () => {
      if (solid.empty) return;
      const m = solid.mesh(this.mats.concrete);
      m.name = 'bridge-piers';
      this.root.add(m);
      solid = new Solid();
    };
    list.forEach((f, k) => {
      const t = new THREE.Vector3(f.t.x, 0, f.t.z).normalize();
      const r = f.r;
      const bw = boxHalf(f.hw);
      const underside = f.p.y - GIRDER_DEPTH;
      const twin = f.hw > 9;
      const offset = twin ? bw * 0.62 : 0; // the columns' centres off the middle
      const water = sea(f.p.x, f.p.z);
      const base = water ? FOOTING_TOP : SEABED;
      const capBottom = underside - CAP_HEIGHT;
      // Taller piers are stouter, as real ones are (a 50 m pier twice the section of a 10 m one)
      const stout = 1 + Math.max(0, capBottom - FOOTING_TOP - 10) / 40;
      const across = (twin ? 1.4 : 1.8) * stout; // a column's half width across the deck
      const along = COLUMN_ALONG * stout;
      // Hammerhead cap: as wide as the box at the top, tapering in to the columns
      const capBase = new THREE.Vector3(f.p.x, 0, f.p.z);
      solid.prism(capBase, t, r, [
        [-(bw + 0.9), underside], [-(offset + across + 0.6), capBottom], [offset + across + 0.6, capBottom], [bw + 0.9, underside],
      ], Math.max(CAP_ALONG, along + 0.4));
      for (const x of twin ? [-offset, offset] : [0]) {
        const c = new THREE.Vector3(f.p.x, 0, f.p.z).addScaledVector(r, x);
        if (capBottom - base > 0.3) solid.column(c, t, r, octagon(along, across, 0.35 * stout), base, capBottom + 0.02);
        const hy = (capBottom - SEABED) / 2;
        world.createCollider(RAPIER.ColliderDesc.cuboid(along, hy, across)
          .setTranslation(c.x, SEABED + hy, c.z)
          .setRotation(new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.atan2(-t.z, t.x), 0)))
          .setCollisionGroups(STATIC_GROUPS));
      }
      // Footing: a block standing out of the water, down into the seabed
      if (water) {
        solid.column(capBase, t, r, octagon(along + 1.9, offset + across + 1.6, 0.9), -5, FOOTING_TOP);
      }
      if ((k + 1) % PER_MESH === 0) flush();
    });
    flush();
  }

  /** A strip along the curve through cross-section points (x across, y up) per frame, u across, v along. */
  private ribbon(frames: Frame[], section: (f: Frame) => [number, number][], material: THREE.Material, us: number[], collide: boolean, uScale = DECK_WIDTH / 8): void {
    void collide;
    const pos: number[] = [];
    const uv: number[] = [];
    const idx: number[] = [];
    const m = section(frames[0]).length;
    const vScale = material === this.mats.paint ? 1 / 12 : material === this.mats.rock ? 1 / 6 : 1 / 8;
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
    // The girder, textured across by distance round its outline (measured on a full-width deck)
    const ref = girderSection({ ...frames[0], hw: DECK_WIDTH / 2, dip: 0 });
    const lengths = [0];
    for (let i = 1; i < ref.length; i++) lengths.push(lengths[i - 1] + Math.hypot(ref[i][0] - ref[i - 1][0], ref[i][1] - ref[i - 1][1]));
    const us = lengths.map((l) => l / lengths[lengths.length - 1]);
    this.ribbon(frames, girderSection, this.mats.concrete, us, false, lengths[lengths.length - 1] / UV_METRES);
    // …closed at both ends: where the street it leaves drops away (a sea wall), you'd see into the box
    const ends = new Solid();
    for (const [f, dir] of [[frames[0], -1], [frames[frames.length - 1], 1]] as const) {
      const pts = girderSection(f).map(([x, y]) => new THREE.Vector3().copy(f.p).addScaledVector(f.r, x).setY(f.p.y + y));
      ends.face(pts, f.t.clone().multiplyScalar(dir));
    }
    const m = ends.mesh(this.mats.concrete);
    m.name = 'girder-ends';
    this.root.add(m);
  }

  /** Split a ribbon into chunks along its length (frustum culling), as meshes. */
  private addChunked(pos: number[], uv: number[], idx: number[], material: THREE.Material, frames: Frame[], m: number): void {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    // Normals from the whole ribbon, so there's no shading seam where one chunk meets the next
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const per = Math.max(1, Math.round(PIECE_CHUNK / STEP));
    const quads = (m - 1) * 6;
    for (let start = 0; start < frames.length - 1; start += per) {
      const end = Math.min(frames.length - 1, start + per);
      const g = geo.clone();
      g.setIndex(idx.slice(start * quads, end * quads));
      // The shared vertex buffer's bounding sphere would cover the whole bridge: use this chunk's
      const box = new THREE.Box3();
      for (let i = start; i <= end; i++) box.expandByPoint(frames[i].p);
      box.expandByScalar(DECK_WIDTH + 30);
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
