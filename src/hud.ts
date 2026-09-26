import type { Car } from './car';
import { BOOST_SEGMENTS } from './drift';

const HELP_SECONDS = 14;
const BANKED_SECONDS = 1.5;
const CAR_NAME_SECONDS = 2.5;
const FEED_SECONDS = 1.8;
const FEED_MAX = 5;

const $ = (id: string) => document.getElementById(id)!;

export class Hud {
  private readonly speed = $('speed-value');
  private readonly boost = $('boost');
  private readonly drift = $('drift');
  private readonly driftScore = $('drift-score');
  private readonly carName = $('carname');
  private readonly fps = $('fps');
  private readonly help = $('help');
  private readonly feed = $('feed');
  private readonly bannerEl = $('banner');
  private readonly bannerMain = $('banner-main');
  private readonly bannerSub = $('banner-sub');
  private readonly eventEl = $('event');
  private readonly promptEl = $('prompt');
  private readonly progress = $('progress');
  private bannerTimer = 0;
  private eventHtml = '';
  private promptHtml = '';
  private readonly fills: HTMLElement[] = [];
  private helpTimer = HELP_SECONDS;
  private carNameTimer = 0;

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

  /** Stunt popup on the right: NEAR MISS, AIR, TAKEDOWN… */
  note(text: string, kind: string): void {
    const el = document.createElement('div');
    el.className = kind;
    el.textContent = text;
    this.feed.prepend(el);
    while (this.feed.children.length > FEED_MAX) this.feed.lastElementChild!.remove();
    setTimeout(() => el.classList.add('fade'), FEED_SECONDS * 1000);
    setTimeout(() => el.remove(), FEED_SECONDS * 1000 + 600);
  }

  /** Big center text for `seconds` (Infinity until replaced). `kind` picks the color. */
  banner(main: string, sub = '', kind = 'info', seconds = 2): void {
    this.bannerMain.textContent = main;
    this.bannerSub.textContent = sub;
    this.bannerEl.className = `show ${kind}`;
    this.bannerTimer = seconds;
  }

  /** Event panel (top left); null hides it. The HTML is built by the game, never from user input. */
  setEvent(html: string | null, kind = ''): void {
    const key = `${kind}|${html}`;
    if (key === this.eventHtml) return;
    this.eventHtml = key;
    this.eventEl.className = html === null ? 'hidden' : kind;
    if (html !== null) this.eventEl.innerHTML = html;
  }

  /** Career line under the minimap, e.g. "EVENTS 2/9". */
  setProgress(text: string): void {
    setText(this.progress, text);
  }

  /** Event start prompt (bottom center); null hides it. */
  setPrompt(html: string | null): void {
    if (html === this.promptHtml) return;
    this.promptHtml = html ?? '';
    this.promptEl.classList.toggle('hidden', html === null);
    if (html !== null) this.promptEl.innerHTML = html;
  }

  showCar(car: Car): void {
    this.carName.innerHTML = `<small>${car.tuning.className}</small>${car.tuning.name}`;
    this.carNameTimer = CAR_NAME_SECONDS;
  }

  update(dt: number, car: Car, fpsText: string): void {
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
    setText(this.fps, fpsText);

    this.bannerTimer -= dt;
    if (this.bannerTimer <= 0) this.bannerEl.classList.remove('show');

    this.carNameTimer -= dt;
    this.carName.classList.toggle('show', this.carNameTimer > 0);
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
