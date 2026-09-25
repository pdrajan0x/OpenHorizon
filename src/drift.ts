// Drift-to-boost loop: holding a drift fills a segmented boost meter; the player spends
// full segments whenever they like (tap = one segment, hold = chain segments) or banks them.

export const BOOST_SEGMENTS = 4;
const FILL_RATE = 0.6; // segments per second at a strong, fast drift
const BURN_TIME = 1.3; // seconds of boost per segment

// Drift state thresholds (slip angle in radians, speed in m/s)
const KICK_MIN_SPEED = 9;
const KICK_MIN_STEER = 0.25;
const SLIDE_ENTER_ANGLE = 0.3;
const SLIDE_ENTER_SPEED = 12;
const EXIT_ANGLE = 0.14;
const EXIT_CALM_TIME = 0.25;
const EXIT_SPEED = 6;

export interface DriftInput {
  speed: number;
  slip: number;
  steer: number;
  handbrake: boolean;
  boostHeld: boolean;
}

export class DriftBoost {
  drifting = false;
  meter = 0; // 0..BOOST_SEGMENTS; the fractional part is the segment still filling
  boosting = false;
  chainScore = 0;
  lastChainScore = 0;
  lastChainAge = Infinity;
  private burnFloor = 0;
  private calmTime = 0;

  update(dt: number, s: DriftInput): void {
    const absSlip = Math.abs(s.slip);

    if (!this.drifting) {
      const kicked = s.handbrake && s.speed > KICK_MIN_SPEED && Math.abs(s.steer) > KICK_MIN_STEER;
      const sliding = absSlip > SLIDE_ENTER_ANGLE && s.speed > SLIDE_ENTER_SPEED;
      if (kicked || sliding) {
        this.drifting = true;
        this.calmTime = 0;
        this.chainScore = 0;
      }
    } else {
      this.calmTime = absSlip < EXIT_ANGLE && !s.handbrake ? this.calmTime + dt : 0;
      if (this.calmTime > EXIT_CALM_TIME || s.speed < EXIT_SPEED) {
        this.drifting = false;
        this.lastChainScore = Math.round(this.chainScore);
        this.lastChainAge = 0;
      }
    }
    this.lastChainAge += dt;

    if (this.drifting) {
      const angleFactor = clamp01((absSlip - 0.12) / 0.5);
      const speedFactor = Math.min(1.2, Math.max(0.3, s.speed / 30));
      this.meter = Math.min(BOOST_SEGMENTS, this.meter + FILL_RATE * angleFactor * speedFactor * dt);
      this.chainScore += absSlip * s.speed * dt * 10;
    }

    // Only full segments can be spent; the one still filling is kept
    if (!this.boosting && s.boostHeld && this.meter >= 1) {
      this.boosting = true;
      this.burnFloor = this.meter - 1;
    }
    if (this.boosting) {
      this.meter -= dt / BURN_TIME;
      if (this.meter <= this.burnFloor) {
        if (s.boostHeld && this.burnFloor >= 1) {
          this.burnFloor -= 1;
        } else {
          this.meter = Math.max(0, this.burnFloor);
          this.boosting = false;
        }
      }
    }
  }

  reset(): void {
    this.drifting = false;
    this.boosting = false;
    this.chainScore = 0;
    this.calmTime = 0;
  }
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}
