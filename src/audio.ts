// Car audio. The engine is a GTA V mod's granular engine (engineAudio.ts) for each car's own engine, the
// tire squeal a mod's skid recording, and crashes real crash-test and glass recordings from BeamNG crash
// sound mods; synthesized stand-ins only fill in until they load. Browsers only allow audio after a user
// gesture, so the graph is built on the first key or pointer press.
//
// The revs come from a small drivetrain model rather than the speed alone: a seven-speed automatic that
// shifts at the top of each gear (with a throttle cut, and a blip on the way down), clutch slip off the
// line, wheelspin in a drift, free revving at a standstill, the limiter bouncing, and idle when stopped.
// Lifting off at high revs pops the exhaust (and blows off the turbos on the cars that have them).
import { type Extra, GranularEngine } from './engineAudio';

const DEFAULT_ENGINE = 'lambo-v12';
const SKID_SOUND = '/mods/audio/skid/tarmac.ogg'; // from a tire skid sound mod
const CRASH_SOUNDS = ['crash-1', 'crash-2'].map((n) => `/mods/audio/crash/${n}.ogg`);
const GLASS_SOUNDS = ['glass-01', 'glass-02', 'glass-03', 'glass-05', 'glass-06', 'glass-07', 'glass-alpha'].map((n) => `/mods/audio/crash/${n}.ogg`);
/** Engine sets whose own bank has no pops or blow-off borrow GTA's generic ones from this one. */
const SHARED_EXTRAS = 'bugatti-w16';
/** Turbocharged engines: blow-off on lift. */
const TURBO = new Set(['bugatti-w16', 'ferrari-v8', 'hyper-v8']);

// The gearbox: each gear's share of top speed at the redline (a close-ratio seven-speed)
const GEARS = [0.24, 0.37, 0.5, 0.62, 0.74, 0.87, 1.0];
const UPSHIFT = 0.93; // revs (0 idle .. 1 redline)
const DOWNSHIFT = 0.42;
const SHIFT_TIME = 0.13; // s of throttle cut on an upshift
const LAUNCH_REVS = 0.55; // clutch slip off the line at full throttle
const DRIFT_SPIN = 0.16; // extra revs from the rear wheels spinning in a drift

/** What the audio needs from the car each frame. */
export interface EngineState {
  speed: number;
  forwardSpeed: number;
  topSpeed: number;
  throttle: number;
  brake: number;
  handbrake: boolean;
  skid: number; // 0..1
  slip: number; // rad
  drifting: boolean;
  boosting: boolean;
  grounded: boolean;
  dead: boolean;
}

export class CarAudio {
  private ctx?: AudioContext;
  private low?: OscillatorNode;
  private high?: OscillatorNode;
  private engineGain?: GainNode;
  private tone?: BiquadFilterNode;
  private skidGain?: GainNode;
  private skidSource?: AudioBufferSourceNode;
  private windGain?: GainNode;
  private windFilter?: BiquadFilterNode;
  private master?: GainNode;
  private noise?: AudioBuffer;
  private engine: GranularEngine | null = null;
  private shared: GranularEngine | null = null;
  private engineSet = DEFAULT_ENGINE;
  private crashes: AudioBuffer[] = [];
  private glass: AudioBuffer[] = [];
  private nextBump = 0;

  // Drivetrain
  private revs = 0;
  private gear = 1;
  private shiftCut = 0; // s left of an upshift's throttle cut
  private blip = 0; // s left of a downshift's throttle blip
  private lastThrottle = 0;
  private popsUntil = 0; // audio time the current burst of pops ends
  private nextPop = 0;
  private nextLimiterPop = 0;
  private limiterPhase = 0;

  constructor() {
    const start = () => {
      window.removeEventListener('keydown', start);
      window.removeEventListener('pointerdown', start);
      this.start();
    };
    window.addEventListener('keydown', start);
    window.addEventListener('pointerdown', start);
  }

  /** The simulated gearbox, for the HUD and tests. */
  get gearbox(): { gear: number; revs: number } {
    return { gear: this.gear, revs: this.revs };
  }

  /** Everything quiet (pause menu, map); the next update() brings the car back. */
  pause(): void {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    this.engine?.silence();
    this.engineGain?.gain.setTargetAtTime(0, now, 0.05);
    this.skidGain?.gain.setTargetAtTime(0, now, 0.05);
    this.windGain?.gain.setTargetAtTime(0, now, 0.05);
  }

  update(dt: number, car: EngineState): void {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const throttle = car.dead ? 0 : Math.max(car.throttle, car.boosting ? 1 : 0);
    const load = this.drivetrain(dt, car, throttle);

    // Lifting off hard at high revs: a burst of pops (and the turbos blowing off)
    if (this.lastThrottle > 0.7 && throttle < 0.15 && this.revs > 0.55) {
      this.popsUntil = now + 0.35 + Math.random() * 0.5;
      if (TURBO.has(this.engineSet)) this.playExtra('dumpValve', 0.55, 0.95 + Math.random() * 0.1);
    }
    this.lastThrottle = throttle;
    if (now < this.popsUntil && now >= this.nextPop) {
      this.playExtra('exhaustPop', 0.35 + 0.35 * this.revs, 0.9 + Math.random() * 0.25);
      this.nextPop = now + 0.05 + Math.random() * 0.14;
    }

    if (this.engine) {
      this.engine.update(this.revs, load);
      this.engineGain!.gain.setTargetAtTime(0, now, 0.1);
    } else {
      // Stand-in until the recording loads: two oscillators at the firing frequency
      const rpm = 1000 + 6500 * this.revs;
      const firing = (rpm / 60) * 2;
      this.low!.frequency.setTargetAtTime(firing * 0.5, now, 0.05);
      this.high!.frequency.setTargetAtTime(firing, now, 0.05);
      this.engineGain!.gain.setTargetAtTime(car.dead ? 0 : 0.25 + 0.5 * load, now, 0.1);
      this.tone!.frequency.setTargetAtTime(600 + 1400 * load, now, 0.1);
    }

    // Tires: louder and higher the harder they slide
    const slide = car.grounded ? car.skid : 0;
    this.skidGain!.gain.setTargetAtTime(slide * 0.38, now, 0.05);
    if (this.skidSource) this.skidSource.playbackRate.setTargetAtTime(0.85 + 0.3 * Math.min(1, Math.abs(car.slip) / 0.7), now, 0.1);
    // Wind: from nothing in town to a roar at top speed
    const wind = Math.min(1, car.speed / 85);
    this.windGain!.gain.setTargetAtTime(wind * wind * 0.2, now, 0.2);
    this.windFilter!.frequency.setTargetAtTime(250 + 1600 * wind, now, 0.2);
  }

  /** Advance the gearbox and engine; sets this.revs, returns the engine load (0..1) for the recordings. */
  private drivetrain(dt: number, car: EngineState, throttle: number): number {
    const v = Math.abs(car.forwardSpeed);
    const top = Math.max(20, car.topSpeed);
    const reversing = car.forwardSpeed < -0.5;
    let load = throttle;

    // Shifts: up at the top of the gear, down when the revs sag; never while standing still
    this.shiftCut = Math.max(0, this.shiftCut - dt);
    this.blip = Math.max(0, this.blip - dt);
    const inGear = (g: number) => v / (top * GEARS[g - 1]);
    if (!reversing && this.shiftCut === 0) {
      if (this.gear < GEARS.length && inGear(this.gear) > UPSHIFT && throttle > 0.1) {
        this.gear++;
        this.shiftCut = SHIFT_TIME;
        if (throttle > 0.8 && Math.random() < 0.35) this.popsUntil = (this.ctx?.currentTime ?? 0) + 0.08;
      } else if (this.gear > 1 && inGear(this.gear - 1) < UPSHIFT * 0.85 && (inGear(this.gear) < DOWNSHIFT || (car.brake > 0.3 && inGear(this.gear) < 0.6))) {
        this.gear--;
        this.blip = 0.12;
      }
    }
    if (v < 1) this.gear = 1;

    let target = reversing ? Math.min(1, v / (top * GEARS[0] * 0.8)) : Math.min(1.02, inGear(this.gear));
    if (!car.grounded) {
      // In the air the wheels spin free: the revs chase the throttle
      target = Math.max(target * 0.9, throttle * 0.95);
    } else if (v < top * GEARS[0] * 0.45 && !reversing) {
      // Off the line the clutch slips (or, held on the brake, the engine just revs)
      const free = car.brake > 0.3 || car.handbrake ? 0.95 : LAUNCH_REVS;
      target = Math.max(target, throttle * free);
    }
    if (car.drifting && throttle > 0.2) target = Math.min(1.02, target + DRIFT_SPIN * throttle);
    if (car.boosting) target = Math.max(target, 0.9);
    if (throttle < 0.05 && v < 1.5) target = 0; // idle
    if (this.shiftCut > 0) load = 0;
    if (this.blip > 0) {
      load = 0.7;
      target = Math.min(1, target + 0.08);
    }

    // The engine's inertia: quick to rev up under load, slower to fall
    const rate = target > this.revs ? (load > 0.3 ? 8 : 4) : 3.5;
    this.revs += (target - this.revs) * (1 - Math.exp(-dt * rate));

    // On the limiter: the revs bounce off it and it crackles
    if (this.revs > 0.985 && throttle > 0.5) {
      this.limiterPhase = (this.limiterPhase + dt * 14) % 1;
      this.revs = 0.97 + 0.03 * (1 - this.limiterPhase);
      const now = this.ctx?.currentTime ?? 0;
      if (now >= this.nextLimiterPop) {
        this.playExtra('limiterPop', 0.3, 0.95 + Math.random() * 0.1);
        this.nextLimiterPop = now + 0.12 + Math.random() * 0.2;
      }
    }
    this.revs = Math.min(1, Math.max(0, this.revs));
    return car.dead ? 0 : load;
  }

  /** A one-shot from the car's engine bank, else the shared one. */
  private playExtra(kind: Extra, volume: number, rate: number): void {
    const list = this.engine?.extras.get(kind)?.length ? this.engine.extras.get(kind)! : this.shared?.extras.get(kind);
    if (!list?.length || !this.ctx) return;
    this.play(pick(list), volume, rate);
  }

  /** Switch to another engine sound set (public/mods/audio/<set>). */
  setEngine(set: string): void {
    if (set === this.engineSet) return;
    this.engineSet = set;
    this.gear = 1;
    if (this.ctx) this.loadEngine();
  }

  private loadEngine(): void {
    const set = this.engineSet;
    GranularEngine.load(this.ctx!, this.master!, set)
      .then((e) => {
        if (set !== this.engineSet) return e?.stop();
        this.engine?.stop();
        this.engine = e;
        // Turn the key
        const start = e?.extras.get('startUp');
        if (start?.length) this.play(start[0], 0.6, 1);
      })
      .catch(() => {});
  }

  /** A crash; `strength` 0..1. Hard ones shatter glass too. */
  crash(strength: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    if (this.crashes.length) {
      this.play(pick(this.crashes), 0.5 + 0.9 * strength, 0.92 + Math.random() * 0.16);
      if (strength > 0.45 && this.glass.length) this.play(pick(this.glass), 0.35 + 0.5 * strength, 0.95 + Math.random() * 0.1, 0.03);
      return;
    }
    this.synthCrash(strength);
  }

  /** A knock off a wall or car that only dents: the crash recording, quiet and muffled. `strength` 0..1. */
  bump(strength: number): void {
    if (!this.ctx || !this.crashes.length || this.ctx.currentTime < this.nextBump) return;
    this.nextBump = this.ctx.currentTime + 0.3; // a scrape along a wall dents every step; one knock is enough
    this.play(pick(this.crashes), 0.12 + 0.4 * strength, 1.05 + Math.random() * 0.2, 0, 600 + 3000 * strength);
  }

  private play(buffer: AudioBuffer, volume: number, rate: number, delay = 0, lowpass = 0): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = rate;
    const gain = ctx.createGain();
    gain.gain.value = volume;
    let out: AudioNode = src;
    if (lowpass) {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = lowpass;
      out = src.connect(f);
    }
    out.connect(gain).connect(this.master!);
    src.start(ctx.currentTime + delay);
  }

  /** Stand-in until the recordings load: filtered noise with a low thump. */
  private synthCrash(strength: number): void {
    const ctx = this.ctx!;
    if (!this.master || !this.noise) return;
    const now = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(3500, now);
    filter.frequency.exponentialRampToValueAtTime(300, now + 0.6);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.9 * strength + 0.2, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.8);
    src.connect(filter).connect(gain).connect(this.master);
    src.start(now, Math.random());
    src.stop(now + 0.9);

    const thump = ctx.createOscillator();
    thump.frequency.setValueAtTime(90, now);
    thump.frequency.exponentialRampToValueAtTime(35, now + 0.3);
    const tg = ctx.createGain();
    tg.gain.setValueAtTime(0.8 * strength, now);
    tg.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
    thump.connect(tg).connect(this.master);
    thump.start(now);
    thump.stop(now + 0.4);
  }

  /** Countdown and UI blip. */
  beep(frequency: number, seconds = 0.15): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.value = frequency;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.25, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + seconds);
    osc.connect(gain).connect(this.master);
    osc.start(now);
    osc.stop(now + seconds + 0.02);
  }

  private start(): void {
    const ctx = new AudioContext();
    this.ctx = ctx;
    const master = ctx.createGain();
    master.gain.value = 0.35;
    master.connect(ctx.destination);
    this.master = master;
    this.loadEngine();
    if (this.engineSet !== SHARED_EXTRAS) {
      GranularEngine.load(ctx, ctx.createGain(), SHARED_EXTRAS).then((e) => { this.shared = e; }).catch(() => {});
    }

    this.tone = ctx.createBiquadFilter();
    this.tone.type = 'lowpass';
    this.tone.connect(master);
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0;
    this.engineGain.connect(this.tone);

    this.high = ctx.createOscillator();
    this.high.type = 'sawtooth';
    this.high.connect(this.engineGain);
    this.low = ctx.createOscillator();
    this.low.type = 'square';
    const lowGain = ctx.createGain();
    lowGain.gain.value = 0.4;
    this.low.connect(lowGain).connect(this.engineGain);
    this.high.start();
    this.low.start();

    // Tire squeal: looped noise through a band-pass
    const noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    this.noise = noise;
    const source = ctx.createBufferSource();
    source.buffer = noise;
    source.loop = true;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 1400;
    band.Q.value = 3;
    this.skidGain = ctx.createGain();
    this.skidGain.gain.value = 0;
    this.skidGain.connect(master);
    source.connect(band).connect(this.skidGain);
    source.start();
    // Wind: the same noise, low-passed, louder with speed
    const windSource = ctx.createBufferSource();
    windSource.buffer = noise;
    windSource.loop = true;
    windSource.playbackRate.value = 0.5;
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'lowpass';
    this.windFilter.frequency.value = 300;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    windSource.connect(this.windFilter).connect(this.windGain).connect(master);
    windSource.start();
    const load = (url: string) => fetch(url).then((r) => r.arrayBuffer()).then((d) => ctx.decodeAudioData(d));
    for (const url of CRASH_SOUNDS) load(url).then((b) => this.crashes.push(b)).catch(() => {});
    for (const url of GLASS_SOUNDS) load(url).then((b) => this.glass.push(b)).catch(() => {});
    // Swap the synthesized squeal for the mod's recorded tire skid once it loads
    fetch(SKID_SOUND)
      .then((r) => r.arrayBuffer())
      .then((data) => ctx.decodeAudioData(data))
      .then((buffer) => {
        const skid = ctx.createBufferSource();
        skid.buffer = buffer;
        skid.loop = true;
        skid.connect(this.skidGain!);
        skid.start();
        source.stop();
        this.skidSource = skid;
      })
      .catch(() => {});
  }
}

const pick = <T>(list: T[]): T => list[Math.floor(Math.random() * list.length)];
