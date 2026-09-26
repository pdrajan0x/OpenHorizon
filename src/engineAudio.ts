// Engine sound from a GTA V engine mod (tools/gta5conv audio → public/mods/audio/<set>/): a granular
// engine, played the way GTA plays it. Each layer (engine/exhaust × accel/decel/idle) is a recorded rev
// sweep cut into grains of one engine cycle, each tagged with its frequency. For the current revs we
// pick the grain recorded nearest that frequency, nudge its pitch to match, and play grains back to
// back with short crossfades. Accel layers follow the throttle, decel layers take over off-throttle.
const LOOKAHEAD = 0.1; // s of grains scheduled ahead of the audio clock
const FADE = 0.35; // fraction of a grain spent crossfading into the next
const LAYERS = ['engineAccel', 'exhaustAccel', 'engineDecel', 'exhaustDecel', 'engineIdle', 'exhaustIdle'] as const;
type Layer = (typeof LAYERS)[number];

interface StreamInfo {
  id: string;
  file: string;
  grains?: { start: number[]; hz: number[]; end: number };
}
interface EngineInfo {
  player: boolean;
  layers: Partial<Record<Layer, string>>;
  layerDb: Partial<Record<Layer, number>>;
  clockHz: [number, number][]; // per layer clock group: Hz at revs 0 and 1
  layerClock: Partial<Record<Layer, number>>;
  mix: { engineDb: number; exhaustDb: number };
}
interface Manifest {
  streams: StreamInfo[];
  engines: EngineInfo[];
}

interface LoadedLayer {
  buffer: AudioBuffer;
  start: number[];
  hz: number[];
  end: number;
  gain: GainNode;
  clock: [number, number];
  next: number; // audio time the next grain starts
}

const db = (d: number) => 10 ** (d / 20);

export class GranularEngine {
  private readonly layers = new Map<Layer, LoadedLayer>();
  private revs = 0;
  private throttle = 0;

  private constructor(private readonly ctx: AudioContext) {}

  /** Load an engine set's player engine; null if the set has none. */
  static async load(ctx: AudioContext, out: AudioNode, set: string): Promise<GranularEngine | null> {
    const base = `/mods/audio/${set}`;
    const manifest = (await fetch(`${base}/manifest.json`).then((r) => r.json())) as Manifest;
    const engine = manifest.engines.find((e) => e.player) ?? manifest.engines[0];
    if (!engine) return null;
    const g = new GranularEngine(ctx);
    await Promise.all(LAYERS.map(async (layer) => {
      const stream = manifest.streams.find((s) => s.id === engine.layers[layer]);
      if (!stream?.grains) return;
      const data = await fetch(`${base}/${stream.file}`).then((r) => r.arrayBuffer());
      const buffer = await ctx.decodeAudioData(data);
      const gain = ctx.createGain();
      const group = layer.startsWith('engine') ? engine.mix.engineDb : engine.mix.exhaustDb;
      gain.gain.value = 0;
      gain.connect(out);
      g.layers.set(layer, {
        buffer, start: stream.grains.start, hz: stream.grains.hz, end: stream.grains.end, gain,
        clock: engine.clockHz[engine.layerClock[layer] ?? 0] ?? [10, 60],
        next: 0,
      });
      g.levels.set(layer, db((engine.layerDb[layer] ?? 0) + group - 12));
    }));
    return g;
  }

  private readonly levels = new Map<Layer, number>();

  /** revs 0..1 across the rev range, throttle 0..1. Call every frame. */
  update(revs: number, throttle: number): void {
    this.revs = Math.min(1, Math.max(0, revs));
    this.throttle = throttle;
    const now = this.ctx.currentTime;
    const idle = Math.max(0, 1 - this.revs * 6);
    const on = this.throttle;
    for (const [layer, l] of this.layers) {
      const role = layer.endsWith('Idle') ? idle : layer.endsWith('Accel') ? (1 - idle) * (0.25 + 0.75 * on) : (1 - idle) * (1 - on) * 0.8;
      l.gain.gain.setTargetAtTime(role * (this.levels.get(layer) ?? 1), now, 0.05);
      if (role > 0.01) this.schedule(l, now);
      else l.next = 0;
    }
  }

  stop(): void {
    for (const l of this.layers.values()) {
      l.gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.05);
      setTimeout(() => l.gain.disconnect(), 300);
    }
  }

  /** Queue grains up to LOOKAHEAD ahead: each the one recorded nearest the wanted engine frequency. */
  private schedule(l: LoadedLayer, now: number): void {
    if (l.next < now) l.next = now + 0.01;
    const hz = l.clock[0] + (l.clock[1] - l.clock[0]) * this.revs;
    while (l.next < now + LOOKAHEAD) {
      const i = nearest(l.hz, hz);
      const from = l.start[i];
      const to = i + 1 < l.start.length ? l.start[i + 1] : l.end;
      const rate = Math.min(2, Math.max(0.5, hz / l.hz[i]));
      const length = (to - from) / rate; // seconds this grain lasts when played at `rate`
      const src = this.ctx.createBufferSource();
      src.buffer = l.buffer;
      src.playbackRate.value = rate;
      const env = this.ctx.createGain();
      const fade = length * FADE;
      env.gain.setValueAtTime(0, l.next);
      env.gain.linearRampToValueAtTime(1, l.next + fade);
      env.gain.setValueAtTime(1, l.next + length);
      env.gain.linearRampToValueAtTime(0, l.next + length + fade);
      src.connect(env).connect(l.gain);
      // Play a little past the grain's end so its fade-out overlaps the next grain's fade-in
      src.start(l.next, from, (to - from) * (1 + FADE));
      l.next += length;
    }
  }
}

/** Index of the value closest to `x` in an ascending array. */
function nearest(values: number[], x: number): number {
  let lo = 0;
  let hi = values.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (values[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo > 0 && Math.abs(values[lo - 1] - x) < Math.abs(values[lo] - x) ? lo - 1 : lo;
}
