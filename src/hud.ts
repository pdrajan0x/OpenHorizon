import type { Car } from './car';
import { BOOST_SEGMENTS } from './drift';
import type { LapTimer } from './laps';

const HELP_SECONDS = 12;
const BANKED_SECONDS = 1.5;

const $ = (id: string) => document.getElementById(id)!;

export class Hud {
  private readonly speed = $('speed-value');
  private readonly boost = $('boost');
  private readonly drift = $('drift');
  private readonly driftScore = $('drift-score');
  private readonly offroad = $('offroad');
  private readonly lapCurrent = $('lap-current');
  private readonly lapLast = $('lap-last');
  private readonly lapBest = $('lap-best');
  private readonly fps = $('fps');
  private readonly help = $('help');
  private readonly fills: HTMLElement[] = [];
  private helpTimer = HELP_SECONDS;

  constructor() {
    for (let i = 0; i < BOOST_SEGMENTS; i++) {
      const seg = document.createElement('div');
      seg.className = 'seg';
      const fill = document.createElement('i');
      seg.append(fill);
      this.boost.append(seg);
      this.fills.push(fill);
    }
  }

  toggleFps(): void {
    this.fps.classList.toggle('hidden');
  }

  toggleHelp(): void {
    this.help.classList.toggle('hidden');
    this.helpTimer = Infinity;
  }

  update(dt: number, car: Car, laps: LapTimer, offroad: boolean, fpsText: string): void {
    setText(this.speed, String(Math.round(car.speed * 3.6)));

    const d = car.drift;
    this.fills.forEach((fill, i) => {
      const amount = Math.min(1, Math.max(0, d.meter - i));
      fill.style.width = `${amount * 100}%`;
      fill.parentElement!.classList.toggle('full', amount >= 1);
    });
    this.boost.classList.toggle('active', d.boosting);

    const banked = !d.drifting && d.lastChainAge < BANKED_SECONDS && d.lastChainScore > 0;
    this.drift.classList.toggle('show', d.drifting || banked);
    this.drift.classList.toggle('banked', banked);
    setText(this.driftScore, d.drifting ? String(Math.round(d.chainScore)) : `+${d.lastChainScore}`);

    this.offroad.classList.toggle('show', offroad);
    setText(this.lapCurrent, formatTime(laps.current));
    setText(this.lapLast, formatTime(laps.last));
    setText(this.lapBest, formatTime(laps.best));
    setText(this.fps, fpsText);

    this.helpTimer -= dt;
    if (this.helpTimer <= 0) {
      this.help.classList.add('hidden');
      this.helpTimer = Infinity;
    }
  }
}

function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

function formatTime(seconds: number | null): string {
  if (seconds === null) return '--';
  const m = Math.floor(seconds / 60);
  return `${m}:${(seconds - m * 60).toFixed(3).padStart(6, '0')}`;
}
