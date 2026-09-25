// Synthesized engine and tire audio. Browsers only allow audio after a user gesture,
// so the graph is built on the first key or pointer press.

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
    const rpm = IDLE_RPM + RPM_RANGE * Math.min(1, Math.max(0, (speed - lo) / (hi - lo)));
    const firing = (rpm / 60) * 2; // four-cylinder firing frequency

    this.low!.frequency.setTargetAtTime(firing * 0.5, now, 0.05);
    this.high!.frequency.setTargetAtTime(firing, now, 0.05);
    this.engineGain!.gain.setTargetAtTime(0.25 + 0.5 * throttle, now, 0.1);
    this.tone!.frequency.setTargetAtTime(600 + 1400 * throttle + (boosting ? 1500 : 0), now, 0.1);
    this.skidGain!.gain.setTargetAtTime(skid * 0.35, now, 0.05);
  }

  private start(): void {
    const ctx = new AudioContext();
    this.ctx = ctx;
    const master = ctx.createGain();
    master.gain.value = 0.35;
    master.connect(ctx.destination);

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
    const source = ctx.createBufferSource();
    source.buffer = noise;
    source.loop = true;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 1400;
    band.Q.value = 3;
    this.skidGain = ctx.createGain();
    this.skidGain.gain.value = 0;
    source.connect(band).connect(this.skidGain).connect(master);
    source.start();
  }
}
