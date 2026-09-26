// Dangerous-driving detection for the player, Burnout style: near misses, oncoming lanes, air,
// drift chains and takedowns earn boost and stunt points; a hard impact is a crash.
// Stunt points build a chain with a multiplier that banks after a quiet spell and is lost in a crash.
import type { Car } from './car';
import type { Agent } from './traffic';

export type StuntKind = 'near' | 'oncoming' | 'air' | 'drift' | 'takedown' | 'crash';
export interface StuntNote {
  kind: StuntKind;
  text: string;
  points: number;
}

// Near miss: pass another car with little side clearance at a decent closing speed, without touching
const NEAR_ALONG = 3.5; // m, alongside window (center to center, along the player's heading)
const NEAR_SIDE = 3.3; // m, center to center across: two ~2 m wide cars with ~1.3 m clearance
const NEAR_REL_SPEED = 9;
const NEAR_BOOST = 0.3;
const NEAR_POINTS = 250;

const ONCOMING_SIDE = -1; // m past the centerline into the other direction's lanes
const ONCOMING_SPEED = 14;
const ONCOMING_BOOST = 0.15; // segments per second
const ONCOMING_POINTS = 150; // per second
const ONCOMING_MIN = 0.6; // seconds before it counts

const AIR_MIN = 0.45;
const BIG_AIR = 1.4;
const AIR_BOOST = 0.4; // segments per second airborne
const AIR_POINTS = 600;

const DRIFT_MIN_SCORE = 150;
const TAKEDOWN_BOOST = 1.5;
const TAKEDOWN_POINTS = 1500;
const BOOST_POINTS = 80; // per second of boosting

// Crash: this much horizontal velocity change in one physics step, from at least this speed
const CRASH_DV = 11;
const CRASH_DV_SHIELDED = 20; // while trading paint with a rival, only a massive hit crashes the player
const CRASH_MIN_SPEED = 11;
const TOUCH_DV = 2.5; // any bump above this spoils a near miss in progress

const COMBO_WINDOW = 3; // seconds without a stunt before the chain banks
const MAX_MULTIPLIER = 8;

/** Signed distance from the road's centerline, + on the correct side for travel (fx, fz); null off-road. */
export type LaneOffset = (x: number, z: number, fx: number, fz: number) => number | null;

export class Stunts {
  /** New notes for the HUD; the caller drains this. */
  readonly notes: StuntNote[] = [];
  score = 0; // banked stunt points
  chain = 0; // points in the current chain, before the multiplier
  multiplier = 1;
  oncomingTime = 0;
  airTime = 0;

  private sinceStunt = Infinity;
  private lastTouch = -Infinity;
  private readonly close = new Map<number, number>(); // agent id → time it came alongside
  private wasDrifting = false;
  private airFromX = 0;
  private airFromZ = 0;

  constructor(private readonly laneOffset: LaneOffset) {}

  /**
   * Per physics step, after world.step(). Returns true if the player crashed this step. `shielded`
   * is set while the player is in contact with a rival: shoving matches shouldn't wreck the player.
   */
  step(car: Car, time: number, speedBefore: number, dt: number, shielded: boolean): boolean {
    const dv = car.impact();
    if (dv > TOUCH_DV) this.lastTouch = time;
    if (dv > (shielded ? CRASH_DV_SHIELDED : CRASH_DV) && speedBefore > CRASH_MIN_SPEED) {
      this.crash();
      return true;
    }

    // Drift chains end in DriftBoost; pick up the banked score when a drift finishes
    const d = car.drift;
    if (this.wasDrifting && !d.drifting && d.lastChainScore >= DRIFT_MIN_SCORE) {
      this.add('drift', `DRIFT ${d.lastChainScore}`, d.lastChainScore);
    }
    this.wasDrifting = d.drifting;
    if (d.boosting) this.chain += BOOST_POINTS * dt;

    // Oncoming lanes
    const offset = this.laneOffset(car.body.translation().x, car.body.translation().z, car.forward.x, car.forward.z);
    if (offset !== null && offset < ONCOMING_SIDE && car.forwardSpeed > ONCOMING_SPEED) {
      this.oncomingTime += dt;
      if (this.oncomingTime > ONCOMING_MIN) {
        car.drift.award(ONCOMING_BOOST * dt);
        this.chain += ONCOMING_POINTS * dt;
        this.sinceStunt = 0;
      }
    } else if (this.oncomingTime > 0) {
      if (this.oncomingTime > ONCOMING_MIN) this.add('oncoming', `ONCOMING ${this.oncomingTime.toFixed(1)}s`, 0);
      this.oncomingTime = 0;
    }

    // Air time
    const p = car.body.translation();
    if (car.wheelsInContact === 0) {
      if (this.airTime === 0) {
        this.airFromX = p.x;
        this.airFromZ = p.z;
      }
      this.airTime += dt;
    } else if (car.wheelsInContact >= 2 && this.airTime > 0) {
      if (this.airTime > AIR_MIN) {
        const meters = Math.round(Math.hypot(p.x - this.airFromX, p.z - this.airFromZ));
        const big = this.airTime > BIG_AIR;
        car.drift.award(AIR_BOOST * this.airTime);
        this.add('air', `${big ? 'BIG AIR' : 'AIR'} ${meters} m`, Math.round(AIR_POINTS * this.airTime + meters * 10));
      }
      this.airTime = 0;
    }

    this.sinceStunt += dt;
    if (this.sinceStunt > COMBO_WINDOW) this.bank();
    return false;
  }

  /** Per frame: near misses against traffic and rivals around the player. */
  nearMisses(car: Car, others: Agent[], time: number): void {
    const p = car.body.translation();
    const f = car.forward;
    const seen = new Set<number>();
    for (const o of others) {
      if (o.wrecked) continue;
      const dx = o.x - p.x;
      const dz = o.z - p.z;
      const along = dx * f.x + dz * f.z;
      const side = -dx * f.z + dz * f.x;
      const rel = Math.hypot(car.velocity.x - o.vx, car.velocity.z - o.vz);
      if (Math.abs(along) < NEAR_ALONG && Math.abs(side) < NEAR_SIDE && rel > NEAR_REL_SPEED) {
        if (!this.close.has(o.id)) this.close.set(o.id, time);
        seen.add(o.id);
      }
    }
    // A car that was alongside and now isn't: a near miss, unless we touched anything meanwhile
    for (const [id, since] of this.close) {
      if (seen.has(id)) continue;
      this.close.delete(id);
      if (this.lastTouch < since) {
        car.drift.award(NEAR_BOOST);
        this.add('near', 'NEAR MISS', NEAR_POINTS);
      }
    }
  }

  takedown(car: Car, label = 'TAKEDOWN!'): void {
    car.drift.award(TAKEDOWN_BOOST);
    this.add('takedown', label, TAKEDOWN_POINTS);
  }

  /** Bank the current chain into the score. */
  bank(): void {
    this.score += Math.round(this.chain * this.multiplier);
    this.chain = 0;
    this.multiplier = 1;
  }

  /** Start a fresh stunt tally (Stunt Run events). */
  resetScore(): void {
    this.score = 0;
    this.chain = 0;
    this.multiplier = 1;
    this.sinceStunt = Infinity;
  }

  private crash(): void {
    this.chain = 0;
    this.multiplier = 1;
    this.oncomingTime = 0;
    this.airTime = 0;
    this.close.clear();
    this.notes.push({ kind: 'crash', text: 'CRASH', points: 0 });
  }

  private add(kind: StuntKind, text: string, points: number): void {
    this.chain += points;
    if (this.sinceStunt < COMBO_WINDOW) this.multiplier = Math.min(MAX_MULTIPLIER, this.multiplier + 1);
    this.sinceStunt = 0;
    this.notes.push({ kind, text, points });
  }
}
