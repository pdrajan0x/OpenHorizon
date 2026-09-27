// The world's design: a hub. CARLA's Town 12, the biggest city, is in the middle and every other city is
// round it, a short bridge away, so no city is at the end of a long chain:
//
//   north   LordCity and Chicago, side by side, each bridged to Town 12's north shore and to each other
//   east    Mt. Tsukuba off Town 12's east side, Mt. Akina between it and Chicago
//   south   Shibuya and the French Riviera off Town 12's south shore, bridged to each other
//   west    Ugase off Town 12's south-west, Town 10 an island between Ugase and the Riviera
//
// Town 12 has six bridges, on all four sides; every other city has two or three, from different parts of
// its shore; losing any one bridge leaves every city reachable.
//
// WORLD gives each city's rough place (km) and the links. `fixed` pins a city's frame exactly: the places
// scripts/layout-variants.mjs settled on, moving the cities until each link is a short bridge between
// roads that reach the shore (a city's streets often stop well inland of its coast). A city not pinned
// (one added later) is placed by a small relaxation from the rough place and its size: linked cities pull
// to CHANNEL m apart, every pair pushes apart below MIN_GAP, a weak pull keeps the arrangement. Pure (no
// three.js), so the preview scripts can use it.

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
  /** Exact frame offsets (m, x and z) for cities placed ahead of time; these don't move. */
  fixed?: Record<string, [number, number]>;
  /** Link cities that end up within NEAR_LINK m without a designed link (default: yes). */
  nearLinks?: boolean;
}

const T12 = 'carla-town12';
const T10 = 'carla-town10';
const CHI = 'chicago';
const LC = 'lordcity';
const UG = 'ugase-city';
const RIV = 'french-riviera';
const TSU = 'tsukuba';
const AK = 'akina';
const SHI = 'shibuya';

/** The world the game builds (scripts/layout-variants.mjs tries others). */
export const WORLD: Design = {
  at: {
    [T12]: [0, 0], [LC]: [8.1, -4.5], [CHI]: [9.5, 2.0], [UG]: [-4.0, -8.9], [RIV]: [-7.7, -1.0], [SHI]: [-8.2, -3.0],
    [TSU]: [1.2, 8.2], [AK]: [5.0, 7.5], [T10]: [-8.5, -8.0],
  },
  // rank: 0 the spokes to Town 12, 1 round the rim (a lower rank is built first where two would cross)
  links: [
    [T12, LC, 0], [T12, CHI, 0], [T12, UG, 0], [T12, RIV, 0], [T12, TSU, 0],
    [LC, CHI, 1], [CHI, AK, 1], [AK, TSU, 1], [UG, T10, 1], [T10, SHI, 1], [SHI, RIV, 1],
  ],
  fixed: {
    [T12]: [-600, 500], [LC]: [41200, -3000], [CHI]: [6300, 1100], [UG]: [-5800, -5700], [RIV]: [-7600, 1000],
    [SHI]: [-8200, -3000], [TSU]: [1300, 8500], [AK]: [7000, 6800], [T10]: [-8200, -4900],
  },
  nearLinks: false,
};

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
  pinned: boolean; // placed ahead of time (Design.fixed): doesn't move
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
    const pin = design.fixed?.[l.id];
    // A pinned city's centre: its frame offset plus its rectangle's middle
    const x = pin ? pin[0] + (l.rect[0] + l.rect[2]) / 2 : at[0] * 1000;
    const z = pin ? pin[1] + (l.rect[1] + l.rect[3]) / 2 : at[1] * 1000;
    const b = { k, x, z, hx: (l.rect[2] - l.rect[0]) / 2, hz: (l.rect[3] - l.rect[1]) / 2, hx0: x, hz0: z, pinned: !!pin };
    bodies.push(b);
    byId.set(l.id, b);
  });
  const placed: ([number, number] | null)[] = list.map(() => null);
  const links: LayoutLink[] = [];
  const designed = design.links.map(([a, b, rank]) => [byId.get(a), byId.get(b), rank] as const)
    .filter((l): l is readonly [Body, Body, number] => !!l[0] && !!l[1]);
  const linked = new Set(designed.map(([a, b]) => `${Math.min(a.k, b.k)},${Math.max(a.k, b.k)}`));
  const isLinked = (a: Body, b: Body) => linked.has(`${Math.min(a.k, b.k)},${Math.max(a.k, b.k)}`);

  const settled = bodies.every((b) => b.pinned);
  for (let it = 0; it < (settled ? 0 : ITERATIONS); it++) {
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
    for (const b of bodies) if (b.pinned) { b.x = b.hx0; b.z = b.hz0; }
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
  for (let i = 0; i < (design.nearLinks === false ? 0 : bodies.length); i++) {
    for (let j = i + 1; j < bodies.length; j++) {
      const [a, b] = [bodies[i], bodies[j]];
      if (isLinked(a, b) || gap(a, b) > NEAR_LINK) continue;
      links.push({ a: a.k, b: b.k, axis: axis(a, b), rank: 3 });
    }
  }
  return { placed, links };
}
