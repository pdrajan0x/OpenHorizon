// Burnout Paradise-style events: each waits at an intersection. Stop inside its ring and hold
// throttle + brake to start. Races run to a landmark against rivals on any route you like,
// Road Rage asks for takedowns against the clock, and Stunt Runs score dangerous driving.
import * as THREE from 'three';
import type { CarAudio } from './audio';
import type { Car } from './car';
import type { Hud } from './hud';
import type { Controls } from './input';
import { FINISH_RADIUS, type Rival, type RivalPack } from './rivals';
import { RaceField, type RoadGraph } from './map';
import { mulberry32 } from './random';
import type { Stunts } from './stunts';
import type { Traffic } from './traffic';

export type EventKind = 'race' | 'rage' | 'stunt';
export interface EventDef {
  id: string;
  kind: EventKind;
  title: string;
  at: number; // road node where it starts
  dest?: number; // race finish node
  destName?: string;
  target?: number; // takedowns (rage) or points (stunt)
  time?: number; // seconds (rage, stunt)
}

const RACE_TITLES = ['Midnight Run', 'Neon Sprint', 'Downtown Dash', 'Riverside Rush', 'Skyline Run'];
const RAGE_TITLES = ['Chrome Rampage', 'Neon Fury'];
const STUNT_TITLES = ['Showboat', 'Night Moves'];
const EVENT_SPACING = 260; // m between event starts
const RACE_LENGTH = [900, 1700]; // m of driving

/**
 * Events placed on the map's intersections: spread out, deterministic for a given map, with race
 * finishes a good drive away and named for where they are.
 */
export function makeEvents(roads: RoadGraph, near: THREE.Vector3): EventDef[] {
  const rng = mulberry32(7);
  let spots = roads.junctions();
  if (spots.length < 12) spots = roads.nodes.map((_, i) => i);
  // Start from the junction nearest the spawn, then keep adding the nearest one that's far enough from the rest
  const chosen: number[] = [];
  const byDistance = [...spots].sort((a, b) => roads.nodes[a].distanceTo(near) - roads.nodes[b].distanceTo(near));
  for (const n of byDistance) {
    if (chosen.every((c) => roads.nodes[c].distanceTo(roads.nodes[n]) > EVENT_SPACING)) chosen.push(n);
    if (chosen.length >= 9) break;
  }
  const kinds: EventKind[] = ['race', 'stunt', 'race', 'rage', 'race', 'race', 'stunt', 'rage', 'race'];
  const center = roads.nodes.reduce((c, p) => c.add(p), new THREE.Vector3()).divideScalar(roads.nodes.length);
  const places = (p: THREE.Vector3) => {
    const d = p.clone().sub(center);
    // Game frame: +x is north, +z is east
    const ns = d.x > 150 ? 'North' : d.x < -150 ? 'South' : '';
    const ew = d.z > 150 ? 'East' : d.z < -150 ? 'West' : '';
    return `${ns}${ns && ew ? '-' : ''}${ew}${ns || ew ? ' Side' : 'Downtown'}`;
  };
  const defs: EventDef[] = [];
  let race = 0, rage = 0, stunt = 0;
  chosen.forEach((at, i) => {
    const kind = kinds[i % kinds.length];
    if (kind === 'race') {
      const dist = roads.distancesTo(at);
      const far = spots.filter((n) => dist[n] > RACE_LENGTH[0] && dist[n] < RACE_LENGTH[1]);
      if (far.length === 0) return;
      const dest = far[Math.floor(rng() * far.length)];
      defs.push({ id: `race-${i}`, kind, title: RACE_TITLES[race++ % RACE_TITLES.length], at, dest, destName: places(roads.nodes[dest]) });
    } else if (kind === 'rage') {
      defs.push({ id: `rage-${i}`, kind, title: RAGE_TITLES[rage++ % RAGE_TITLES.length], at, target: 4 + (rage > 1 ? 1 : 0), time: 110 });
    } else {
      defs.push({ id: `stunt-${i}`, kind, title: STUNT_TITLES[stunt++ % STUNT_TITLES.length], at, target: 12000 + stunt * 3000, time: 60 });
    }
  });
  return defs;
}

const LABEL: Record<EventKind, string> = { race: 'RACE', rage: 'ROAD RAGE', stunt: 'STUNT RUN' };
const COLOR: Record<EventKind, number> = { race: 0x00e5ff, rage: 0xff2030, stunt: 0xffd166 };
const START_RADIUS = 8;
const START_SPEED = 4; // m/s, "stopped" enough to start
const HOLD_SECONDS = 0.7;
const COUNTDOWN = 3;
const RESULT_SECONDS = 4.5;
const LANE = 1.7; // m right of the road's centerline for the player's grid slot
const GRID = [
  { lane: -LANE, back: 9 },
  { lane: LANE, back: 19 },
  { lane: -LANE, back: 20 },
  { lane: LANE, back: 30 },
];
const RAGE_RIVALS = 4;
const STORAGE_KEY = 'neonrun.events';
const ORDINAL = ['1ST', '2ND', '3RD', '4TH', '5TH'];

interface Running {
  def: EventDef;
  phase: 'countdown' | 'live' | 'result';
  t: number; // seconds in this phase
  clock: number; // seconds since GO
  field: RaceField | null;
  finished: string[]; // names in finishing order
  takedowns: number;
  gps: THREE.Vector3[];
  gpsTimer: number;
  shown: number; // last countdown number shown
}

export interface EventContext {
  player: Car;
  controls: Controls;
  quit: boolean;
  stunts: Stunts;
  rivals: RivalPack;
  traffic: Traffic;
  /** Teleport the player (resets camera and skid trails too). */
  place: (position: THREE.Vector3, yaw: number) => void;
}

export interface MapMarker {
  x: number;
  z: number;
  color: string;
  done: boolean;
}

export class Events {
  running: Running | null = null;
  private readonly markers: THREE.Group[] = [];
  private readonly finish: THREE.Group;
  private readonly results: Record<string, number>;
  private hold = 0;

  constructor(
    scene: THREE.Scene,
    private readonly hud: Hud,
    private readonly audio: CarAudio,
    private readonly roads: RoadGraph,
    readonly defs: EventDef[],
  ) {
    this.results = loadResults();
    for (const def of defs) {
      const m = marker(COLOR[def.kind], `${LABEL[def.kind]}`, def.title);
      m.position.copy(roads.nodes[def.at]);
      scene.add(m);
      this.markers.push(m);
    }
    this.finish = marker(0xffffff, 'FINISH', '');
    this.finish.visible = false;
    scene.add(this.finish);
  }

  get completed(): number {
    return this.defs.filter((e) => this.results[e.id] === 1).length;
  }

  /** How far a rival is "ahead" for its catch-up: race distance ahead, or plain distance when roaming. */
  lead(r: Rival, player: Car): number {
    const run = this.running;
    const p = player.body.translation();
    if (run?.field) return run.field.remaining(p.x, p.z) - r.remaining;
    const q = r.car.body.translation();
    return Math.hypot(q.x - p.x, q.z - p.z);
  }

  /** Per frame. Returns true while the player must be held still (countdown). */
  update(dt: number, ctx: EventContext): boolean {
    const run = this.running;
    if (!run) {
      this.idle(dt, ctx);
      return false;
    }
    if (ctx.quit && run.phase !== 'result') {
      this.hud.banner('ABANDONED', run.def.title, 'info', 2);
      this.end(ctx);
      return false;
    }
    run.t += dt;
    if (run.phase === 'countdown') {
      const n = Math.ceil(COUNTDOWN - run.t);
      if (n !== run.shown && n > 0) {
        run.shown = n;
        this.hud.banner(String(n), `${LABEL[run.def.kind]} · ${run.def.title}`, 'info', 1.2);
        this.audio.beep(440);
      }
      if (run.t >= COUNTDOWN) {
        run.phase = 'live';
        run.t = 0;
        this.hud.banner('GO!', '', 'go', 0.8);
        this.audio.beep(880, 0.4);
        if (run.def.kind === 'stunt') ctx.stunts.resetScore();
      }
      this.panel(run, ctx);
      return true;
    }
    if (run.phase === 'live') {
      run.clock += dt;
      if (run.def.kind === 'race') this.race(run, ctx, dt);
      else if (run.def.kind === 'rage') this.rage(run, ctx);
      else this.stunt(run, ctx);
      if (this.running) this.panel(run, ctx);
      return false;
    }
    // Result screen, then back to free roam
    if (run.t > RESULT_SECONDS) this.end(ctx);
    return false;
  }

  onTakedown(): void {
    if (this.running?.phase === 'live') this.running.takedowns++;
  }

  mapMarkers(): MapMarker[] {
    if (this.running) return [];
    return this.defs.map((e) => {
      const p = this.roads.nodes[e.at].clone();
      return { x: p.x, z: p.z, color: `#${COLOR[e.kind].toString(16).padStart(6, '0')}`, done: this.results[e.id] === 1 };
    });
  }

  gps(): THREE.Vector3[] | null {
    return this.running?.phase === 'live' && this.running.field ? this.running.gps : null;
  }

  destination(): THREE.Vector3 | null {
    const d = this.running?.def.dest;
    return d && this.running?.phase !== 'result' ? this.roads.nodes[d].clone() : null;
  }

  private idle(dt: number, ctx: EventContext): void {
    const p = ctx.player.body.translation();
    const near = this.defs.find((e) => {
      const q = this.roads.nodes[e.at].clone();
      return Math.hypot(p.x - q.x, p.z - q.z) < START_RADIUS + 3;
    });
    if (!near) {
      this.hold = 0;
      this.hud.setPrompt(null);
      return;
    }
    const c = ctx.controls;
    const stopped = ctx.player.speed < START_SPEED;
    this.hold = stopped && c.throttle > 0.5 && c.brake > 0.5 ? this.hold + dt : 0;
    const detail = near.kind === 'race' ? ` to ${near.destName}`
      : near.kind === 'rage' ? ` · ${near.target} takedowns` : ` · ${near.target!.toLocaleString()} pts`;
    const best = this.results[near.id];
    const record = best === undefined ? '' : near.kind === 'race' ? ` · best ${ORDINAL[best - 1]}` : best === 1 ? ' · done' : '';
    this.hud.setPrompt(
      `<span class="kind">${LABEL[near.kind]}${record}</span><b>${near.title}</b>${detail} — ` +
        `${stopped ? 'hold' : 'stop and hold'} <b>W + S</b>` +
        `<i class="hold" style="width:${Math.min(100, (this.hold / HOLD_SECONDS) * 100)}%"></i>`,
    );
    if (this.hold >= HOLD_SECONDS) this.start(near, ctx);
  }

  private start(def: EventDef, ctx: EventContext): void {
    this.hold = 0;
    this.hud.setPrompt(null);
    const at = this.roads.nodes[def.at].clone();
    const run: Running = {
      def, phase: 'countdown', t: 0, clock: 0, field: null, finished: [], takedowns: 0, gps: [], gpsTimer: 0, shown: 0,
    };
    ctx.traffic.clearAround(at.x, at.z, 70);

    if (def.kind === 'race') {
      const field = new RaceField(this.roads, def.dest!);
      const nodes = field.route(def.at);
      const dir = new THREE.Vector3().subVectors(this.roads.nodes[nodes[1] ?? def.at], at).setY(0).normalize();
      const right = new THREE.Vector3(-dir.z, 0, dir.x);
      ctx.place(at.clone().addScaledVector(dir, -8).addScaledVector(right, LANE).setY(at.y + 0.5), -Math.atan2(dir.z, dir.x));
      ctx.rivals.mode = 'race';
      ctx.rivals.startRace(nodes, GRID);
      run.field = field;
      this.finish.position.copy(this.roads.nodes[def.dest!]);
      this.finish.visible = true;
    } else {
      // Face down whichever road from here best matches where the player was pointing
      const f = ctx.player.forward;
      const exits = this.roads.adjacent[def.at];
      const pick = exits.reduce((best, e) => {
        const d = new THREE.Vector3().subVectors(this.roads.nodes[e.other], at).setY(0).normalize();
        const score = d.x * f.x + d.z * f.z;
        return score > best.score ? { node: e.other, dir: d, score } : best;
      }, { node: exits[0]?.other ?? def.at, dir: new THREE.Vector3(1, 0, 0), score: -Infinity });
      const right = new THREE.Vector3(-pick.dir.z, 0, pick.dir.x);
      ctx.place(at.clone().addScaledVector(pick.dir, -6).addScaledVector(right, LANE).setY(at.y + 0.5), -Math.atan2(pick.dir.z, pick.dir.x));
      if (def.kind === 'rage') {
        ctx.rivals.mode = 'roam';
        ctx.rivals.startRoam(RAGE_RIVALS, pick.node);
      }
    }
    for (const m of this.markers) m.visible = false;
    this.running = run;
  }

  private race(run: Running, ctx: EventContext, dt: number): void {
    const field = run.field!;
    const p = ctx.player.body.translation();
    for (const r of ctx.rivals.rivals) {
      const q = r.car.body.translation();
      r.remaining = field.remaining(q.x, q.z);
      if (!r.finished && r.remaining < FINISH_RADIUS) {
        r.finished = true;
        run.finished.push(r.name);
      }
    }
    run.gpsTimer -= dt;
    if (run.gpsTimer <= 0) {
      run.gpsTimer = 0.4;
      const next = field.nextNode(p.x, p.z);
      run.gps = [new THREE.Vector3(p.x, 0, p.z), ...field.route(next).map((n) => this.roads.nodes[n].clone())];
    }
    if (field.remaining(p.x, p.z) < FINISH_RADIUS) {
      run.finished.push('YOU');
      const place = run.finished.length;
      this.record(run.def, place);
      this.hud.banner(ORDINAL[place - 1] ?? `${place}TH`, place === 1 ? `${run.def.title} · WON` : run.def.title, place === 1 ? 'win' : 'info', RESULT_SECONDS);
      this.audio.beep(place === 1 ? 1320 : 660, 0.5);
      this.toResult(run, ctx);
    }
  }

  private rage(run: Running, ctx: EventContext): void {
    const def = run.def;
    if (run.takedowns >= def.target!) {
      this.record(def, 1);
      this.hud.banner('RAMPAGE!', `${def.title} · ${run.takedowns} takedowns`, 'win', RESULT_SECONDS);
      this.audio.beep(1320, 0.5);
      this.toResult(run, ctx);
    } else if (run.clock >= def.time!) {
      this.hud.banner('TIME UP', `${run.takedowns} / ${def.target} takedowns`, 'crash', RESULT_SECONDS);
      this.toResult(run, ctx);
    }
  }

  private stunt(run: Running, ctx: EventContext): void {
    const def = run.def;
    const s = ctx.stunts;
    if (run.clock < def.time!) return;
    s.bank();
    const won = s.score >= def.target!;
    if (won) this.record(def, 1);
    this.hud.banner(won ? 'SHOWSTOPPER' : 'TIME UP', `${s.score.toLocaleString()} / ${def.target!.toLocaleString()} pts`, won ? 'win' : 'crash', RESULT_SECONDS);
    this.audio.beep(won ? 1320 : 330, 0.5);
    this.toResult(run, ctx);
  }

  private panel(run: Running, ctx: EventContext): void {
    const def = run.def;
    const title = `<div class="title">${LABEL[def.kind]} · ${def.title.toUpperCase()}</div>`;
    if (def.kind === 'race') {
      const p = ctx.player.body.translation();
      const mine = run.field!.remaining(p.x, p.z);
      const rivals = ctx.rivals.rivals;
      const place = 1 + rivals.filter((r) => r.finished || r.remaining < mine).length;
      this.hud.setEvent(
        `${title}<div class="big">${place}<small>/${rivals.length + 1}</small></div>` +
          `<div class="row"><span>${def.destName}</span><span>${Math.round(mine)} m</span></div>` +
          `<div class="row"><span>TIME</span><span>${clock(run.clock)}</span></div>`,
        'race',
      );
    } else if (def.kind === 'rage') {
      this.hud.setEvent(
        `${title}<div class="big">${run.takedowns}<small>/${def.target}</small></div>` +
          `<div class="row"><span>TAKEDOWNS</span><span>${clock(Math.max(0, def.time! - run.clock))}</span></div>`,
        'rage',
      );
    } else {
      const s = ctx.stunts;
      const chain = s.chain > 0 ? `+${Math.round(s.chain).toLocaleString()} ×${s.multiplier}` : '';
      this.hud.setEvent(
        `${title}<div class="big">${s.score.toLocaleString()}</div>` +
          `<div class="row"><span>of ${def.target!.toLocaleString()}</span><span>${chain}</span></div>` +
          `<div class="row"><span>TIME</span><span>${clock(Math.max(0, def.time! - run.clock))}</span></div>`,
        'stunt',
      );
    }
  }

  private toResult(run: Running, ctx: EventContext): void {
    run.phase = 'result';
    run.t = 0;
    this.finish.visible = false;
    for (const r of ctx.rivals.rivals) r.finished = true; // let them coast to a stop
  }

  private end(ctx: EventContext): void {
    ctx.rivals.clear();
    this.running = null;
    this.finish.visible = false;
    for (const m of this.markers) m.visible = true;
    this.hud.setEvent(null);
  }

  private record(def: EventDef, result: number): void {
    const prev = this.results[def.id];
    this.results[def.id] = prev === undefined ? result : Math.min(prev, result);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.results));
    } catch {
      // Storage can be unavailable (private mode); results just won't persist
    }
  }
}

function loadResults(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Record<string, number>;
  } catch {
    return {};
  }
}

function clock(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

/** Glowing ring on the road, a light beam visible across the city, and a floating label. */
function marker(color: number, label: string, title: string): THREE.Group {
  const g = new THREE.Group();
  const glow = { color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false, side: THREE.DoubleSide };
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(START_RADIUS - 0.7, START_RADIUS, 64).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ ...glow, opacity: 0.9 }),
  );
  ring.position.y = 0.07;
  const beam = new THREE.Mesh(
    new THREE.CylinderGeometry(1.1, 1.1, 120, 20, 1, true).translate(0, 60, 0),
    new THREE.MeshBasicMaterial({ ...glow, opacity: 0.55, alphaMap: beamFade() }),
  );
  g.add(ring, beam);

  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 160;
  const c = canvas.getContext('2d')!;
  const hex = `#${color.toString(16).padStart(6, '0')}`;
  c.textAlign = 'center';
  c.shadowColor = hex;
  c.shadowBlur = 18;
  c.fillStyle = hex;
  c.font = 'italic 900 64px system-ui, sans-serif';
  c.fillText(label, 256, 70);
  c.fillStyle = '#ffffff';
  c.font = 'italic 700 40px system-ui, sans-serif';
  c.fillText(title.toUpperCase(), 256, 128);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, fog: false }));
  sprite.scale.set(16, 5, 1);
  sprite.position.y = 9;
  g.add(sprite);
  return g;
}

let fadeTexture: THREE.Texture | null = null;
/** Vertical alpha ramp for the beams: solid at the street, gone at the top. */
function beamFade(): THREE.Texture {
  if (fadeTexture) return fadeTexture;
  const canvas = document.createElement('canvas');
  canvas.width = 4;
  canvas.height = 128;
  const c = canvas.getContext('2d')!;
  const grad = c.createLinearGradient(0, 0, 0, 128);
  grad.addColorStop(0, '#000');
  grad.addColorStop(0.7, '#555');
  grad.addColorStop(1, '#fff');
  c.fillStyle = grad;
  c.fillRect(0, 0, 4, 128);
  fadeTexture = new THREE.CanvasTexture(canvas);
  return fadeTexture;
}
