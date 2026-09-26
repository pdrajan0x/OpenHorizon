// Car audio. The engine is a GTA V mod's granular engine (engineAudio.ts) and the tire squeal a mod's
// skid recording; synthesized stand-ins only fill in until they load. Crash thumps are still
// synthesized (no crash sound mod yet). Browsers only
// allow audio after a user gesture, so the graph is built on the first key or pointer press.
import { GranularEngine } from './engineAudio';

const DEFAULT_ENGINE = 'lambo-v12';
const SKID_SOUND = '/mods/audio/skid/tarmac.ogg'; // from a tire skid sound mod

// Fake gearbox: upper speed (m/s) of each gear, so pitch climbs and drops like shifts
const GEAR_TOPS = [0, 14, 24, 34, 45, 57, 80];
const IDLE_RPM = 1000;
const RPM_RANGE = 6000;

export class CarAudio {
  private ctx?: AudioContext;
  private low?: OscillatorNode;
  private high?: OscillatorNode;
  private engineGain?: GainNode;
  private tone?: BiquadFilterNode;
  private skidGain?: GainNode;
  private master?: GainNode;
  private noise?: AudioBuffer;
  private engine: GranularEngine | null = null;
  private engineSet = DEFAULT_ENGINE;

  constructor() {
    const start = () => {
      window.removeEventListener('keydown', start);
      window.removeEventListener('pointerdown', start);
      this.start();
    };
    window.addEventListener('keydown', start);
    window.addEventListener('pointerdown', start);
  }

  update(speed: number, throttle: number, skid: number, boosting: boolean): void {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;

    let gear = 1;
    while (gear < GEAR_TOPS.length - 1 && speed > GEAR_TOPS[gear]) gear++;
    const lo = GEAR_TOPS[gear - 1];
    const hi = GEAR_TOPS[gear];
    const inGear = Math.min(1, Math.max(0, (speed - lo) / (hi - lo)));
    if (this.engine) {
      // Revs climb through each gear; boost pins them near the top
      this.engine.update(0.12 + 0.85 * inGear + (boosting ? 0.05 : 0), Math.max(throttle, boosting ? 1 : 0));
      this.engineGain!.gain.setTargetAtTime(0, now, 0.1);
      this.skidGain!.gain.setTargetAtTime(skid * 0.35, now, 0.05);
      return;
    }
    const rpm = IDLE_RPM + RPM_RANGE * inGear;
    const firing = (rpm / 60) * 2; // four-cylinder firing frequency

    this.low!.frequency.setTargetAtTime(firing * 0.5, now, 0.05);
    this.high!.frequency.setTargetAtTime(firing, now, 0.05);
    this.engineGain!.gain.setTargetAtTime(0.25 + 0.5 * throttle, now, 0.1);
    this.tone!.frequency.setTargetAtTime(600 + 1400 * throttle + (boosting ? 1500 : 0), now, 0.1);
    this.skidGain!.gain.setTargetAtTime(skid * 0.35, now, 0.05);
  }

  /** Switch to another engine sound set (public/mods/audio/<set>). */
  setEngine(set: string): void {
    if (set === this.engineSet) return;
    this.engineSet = set;
    if (this.ctx) this.loadEngine();
  }

  private loadEngine(): void {
    const set = this.engineSet;
    GranularEngine.load(this.ctx!, this.master!, set)
      .then((e) => {
        if (set !== this.engineSet) return e?.stop();
        this.engine?.stop();
        this.engine = e;
      })
      .catch(() => {});
  }

  /** A crunch: filtered noise with a low thump; `strength` 0..1. */
  crash(strength: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.noise) return;
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
      })
      .catch(() => {});
  }
}
