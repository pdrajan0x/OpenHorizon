// The world's design: three regions side by side, each a handful of the best-looking cities, packed so
// that every city's neighbours are about CHANNEL m of sea away and no drive from one city to the next is
// a long empty crossing:
//
//   the Americas (west)   the two big towns of the plains (CARLA's Town 12) and the Great Lakes (Chicago),
//                         with CARLA's Town 10 downtown as an island between them
//   Europe (middle)       the Mediterranean coast (the Riviera)
//   Asia (east)           China (LordCity) and Japan: the coast town of Ugase, the mountain passes (Akina,
//                         Tsukuba) and Tokyo (Shibuya)
//
// Links follow the real world: Chicago over the Atlantic to the Riviera and on across the Pacific to
// LordCity, the Riviera round to Japan's coast, and within each region a loop, so there are circuits
// rather than one long chain.
//
// DESIGN gives each city's rough place (km) and the links; a small relaxation then settles the real
// positions from the cities' sizes: linked cities pull to CHANNEL m apart, every pair pushes apart below
// MIN_GAP, and a weak pull back to the designed place keeps the arrangement. Cities that end up close
// without a designed link get one too. Pure (no three.js), so scripts/layout-preview.mjs can draw it.

/** A city's land rectangle in its own frame: [minX, minZ, maxX, maxZ], x north, z east. */
export type Rect = [number, number, number, number];

export interface LayoutLink {
  a: number;
  b: number;
  /** The axis the bridge should run along: straight across the channel between the two. */
  axis: 'x' | 'z';
  /** Built in this order (lower first), so a less important link gives way where two would cross. */
  rank: number;
}

/** A world design: rough centres in km (x north, z east) and the links, [a, b, rank]. */
export interface Design {
  at: Record<string, [number, number]>;
  links: [string, string, number][];
}

/** Rough centres in km, x north and z east. */
const DESIGN: Record<string, [number, number]> = {
  'carla-town12': [0, -20],
  'carla-town10': [-2, -13.6],
  chicago: [0, -6],
  'french-riviera': [-4.5, 4],
  lordcity: [3.2, 3.3],
  'ugase-city': [-4.5, 10.6],
  akina: [3.5, 7.3],
  tsukuba: [3.2, 11.3],
  shibuya: [-1.2, 11],
};
/** [a, b, rank]: 0 within a region, 1 between regions */
const LINKS: [string, string, number][] = [
  ['carla-town12', 'chicago', 0], ['carla-town12', 'carla-town10', 0], ['carla-town10', 'chicago', 0],
  ['chicago', 'french-riviera', 1], ['chicago', 'lordcity', 1], ['french-riviera', 'lordcity', 1], ['french-riviera', 'ugase-city', 1],
  ['lordcity', 'akina', 0], ['lordcity', 'ugase-city', 0], ['ugase-city', 'shibuya', 0], ['akina', 'tsukuba', 0], ['tsukuba', 'shibuya', 0],
];

/** The world the game builds. scripts/layout-variants.mjs tries others. */
export const WORLD: Design = { at: DESIGN, links: LINKS };

const CHANNEL = 550; // m of sea between linked cities' land
const MIN_GAP = 500; // m of sea at least between any two cities
const NEAR_LINK = 900; // m: cities this close without a designed link get one as well
const ITERATIONS = 2000;

interface Body {
  k: number; // index into the caller's list
  x: number; // centre, world
  z: number;
  hx: number; // half extents
  hz: number;
  hx0: number; // designed centre
  hz0: number;
}

/** Sea between two rectangles, edge to edge (negative when they overlap). */
function gap(a: Body, b: Body): number {
  const gx = Math.abs(a.x - b.x) - a.hx - b.hx;
  const gz = Math.abs(a.z - b.z) - a.hz - b.hz;
  if (gx > 0 && gz > 0) return Math.hypot(gx, gz);
  return Math.max(gx, gz);
}

/** Push two bodies apart to `want` m of sea along the axis that needs the least movement. */
function separate(a: Body, b: Body, want: number): void {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const ox = a.hx + b.hx + want - Math.abs(dx);
  const oz = a.hz + b.hz + want - Math.abs(dz);
  if (ox <= 0 || oz <= 0) return;
  if (ox < oz) {
    const s = (Math.sign(dx || 1) * ox) / 2;
    a.x -= s;
    b.x += s;
  } else {
    const s = (Math.sign(dz || 1) * oz) / 2;
    a.z -= s;
    b.z += s;
  }
}

/**
 * Where each city goes (the offset of its own frame, or null for a city the design doesn't name) and the
 * links to build.
 */
export function worldLayout(list: { id: string; rect: Rect }[], design: Design = WORLD): { placed: ([number, number] | null)[]; links: LayoutLink[] } {
  const bodies: Body[] = [];
  const byId = new Map<string, Body>();
  list.forEach((l, k) => {
    const at = design.at[l.id];
    if (!at) return;
    const b = { k, x: at[0] * 1000, z: at[1] * 1000, hx: (l.rect[2] - l.rect[0]) / 2, hz: (l.rect[3] - l.rect[1]) / 2, hx0: at[0] * 1000, hz0: at[1] * 1000 };
    bodies.push(b);
    byId.set(l.id, b);
  });
  const placed: ([number, number] | null)[] = list.map(() => null);
  const links: LayoutLink[] = [];
  const designed = design.links.map(([a, b, rank]) => [byId.get(a), byId.get(b), rank] as const)
    .filter((l): l is readonly [Body, Body, number] => !!l[0] && !!l[1]);
  const linked = new Set(designed.map(([a, b]) => `${Math.min(a.k, b.k)},${Math.max(a.k, b.k)}`));
  const isLinked = (a: Body, b: Body) => linked.has(`${Math.min(a.k, b.k)},${Math.max(a.k, b.k)}`);

  for (let it = 0; it < ITERATIONS; it++) {
    const pull = 0.25 * (1 - it / ITERATIONS) + 0.02;
    for (const [a, b] of designed) {
      const g = gap(a, b);
      const d = Math.hypot(b.x - a.x, b.z - a.z) || 1;
      const ux = (b.x - a.x) / d;
      const uz = (b.z - a.z) / d;
      const move = ((g - CHANNEL) * pull) / 2;
      a.x += ux * move;
      a.z += uz * move;
      b.x -= ux * move;
      b.z -= uz * move;
    }
    for (const b of bodies) {
      b.x += (b.hx0 - b.x) * 0.01;
      b.z += (b.hz0 - b.z) * 0.01;
    }
    for (let i = 0; i < bodies.length; i++) {
      for (let j = i + 1; j < bodies.length; j++) {
        separate(bodies[i], bodies[j], isLinked(bodies[i], bodies[j]) ? CHANNEL * 0.9 : MIN_GAP);
      }
    }
  }

  for (const b of bodies) {
    const r = list[b.k].rect;
    placed[b.k] = [b.x - (r[0] + r[2]) / 2, b.z - (r[1] + r[3]) / 2];
  }
  const axis = (a: Body, b: Body): 'x' | 'z' => {
    // Along whichever way the two face each other across the sea
    const gx = Math.abs(a.x - b.x) - a.hx - b.hx;
    const gz = Math.abs(a.z - b.z) - a.hz - b.hz;
    return gx > gz ? 'x' : 'z';
  };
  for (const [a, b, rank] of designed) links.push({ a: a.k, b: b.k, axis: axis(a, b), rank });
  for (let i = 0; i < bodies.length; i++) {
    for (let j = i + 1; j < bodies.length; j++) {
      const [a, b] = [bodies[i], bodies[j]];
      if (isLinked(a, b) || gap(a, b) > NEAR_LINK) continue;
      links.push({ a: a.k, b: b.k, axis: axis(a, b), rank: 3 });
    }
  }
  return { placed, links };
}
