// The pause menu (Esc, or Menu on the controller): the world stops while it's open. For now it has what
// testing needs: resume, switch car, leave the current event, and the controls. Keyboard (arrows, Enter,
// Esc), mouse and controller (D-pad or left stick, A, B) all drive it.
import type { Nav } from './input';

export interface MenuHooks {
  cars: () => { name: string; make: string }[];
  currentCar: () => number;
  switchCar: (index: number) => void;
  inEvent: () => boolean;
  leaveEvent: () => void;
  /** What the connected controller reports, shown live on the controls page. */
  controllerInfo: () => string;
}

type Page = 'main' | 'cars' | 'controls';

interface Item {
  label: string;
  sub?: string;
  current?: boolean;
  act: () => void;
}

const CONTROLS: [string, string, string][] = [
  ['Throttle / brake · reverse', 'RT / LT', 'W / S'],
  ['Steer', 'Left stick', 'A / D'],
  ['Handbrake', 'A', 'Space'],
  ['Boost', 'X or RB', 'Shift'],
  ['Look around', 'Right stick', 'Drag the mouse'],
  ['Look behind', 'B or R3 (hold)', ''],
  ['Camera', 'Y', 'V / C'],
  ['Back on the road', 'D-pad up', 'R'],
  ['Map', 'View', 'M'],
  ['Mark this spot (shows and copies where you are)', 'D-pad down', 'P'],
  ['Pause menu', 'Menu', 'Esc'],
];

export class PauseMenu {
  open = false;
  private page: Page = 'main';
  private index = 0;
  private readonly root: HTMLDivElement;
  private items: Item[] = [];

  constructor(private readonly hooks: MenuHooks) {
    this.root = document.createElement('div');
    this.root.id = 'menu';
    this.root.className = 'hidden';
    document.body.appendChild(this.root);
  }

  toggle(): void {
    this.open = !this.open;
    this.page = 'main';
    this.index = 0;
    this.root.classList.toggle('hidden', !this.open);
    if (this.open) this.render();
  }

  /** Esc / Menu: one level back, or closed from the top. */
  escape(): void {
    if (this.open && this.page !== 'main') this.show('main');
    else this.toggle();
  }

  /** Menu steps from the input; call every frame while open. */
  update(nav: Nav): void {
    if (!this.open) return;
    if (nav.back) {
      if (this.page === 'main') this.toggle();
      else this.show('main');
      return;
    }
    if (this.page === 'controls') {
      const live = this.root.querySelector('.menu-pad');
      if (live) live.textContent = this.hooks.controllerInfo();
      if (nav.confirm) this.show('main');
      return;
    }
    const n = this.items.length;
    if (nav.up) this.select((this.index - 1 + n) % n);
    if (nav.down) this.select((this.index + 1) % n);
    if (nav.confirm) this.items[this.index]?.act();
  }

  private show(page: Page): void {
    this.page = page;
    this.index = page === 'cars' ? this.hooks.currentCar() : 0;
    this.render();
  }

  private select(i: number): void {
    this.index = i;
    this.root.querySelectorAll('.menu-item').forEach((el, k) => el.classList.toggle('selected', k === i));
    this.root.querySelector('.menu-item.selected')?.scrollIntoView({ block: 'nearest' });
  }

  private render(): void {
    const h = this.hooks;
    let title = 'PAUSED';
    if (this.page === 'main') {
      this.items = [
        { label: 'Resume', act: () => this.toggle() },
        { label: 'Switch car', sub: h.cars()[h.currentCar()]?.name, act: () => this.show('cars') },
        ...(h.inEvent() ? [{ label: 'Leave event', act: () => { h.leaveEvent(); this.toggle(); } }] : []),
        { label: 'Controls', act: () => this.show('controls') },
      ];
    } else if (this.page === 'cars') {
      title = 'SWITCH CAR';
      this.items = h.cars().map((c, i) => ({
        label: c.name, sub: c.make, current: i === h.currentCar(),
        act: () => { h.switchCar(i); this.toggle(); },
      }));
    } else {
      title = 'CONTROLS';
      this.items = [];
    }

    const body = this.page === 'controls'
      ? `<table class="menu-controls"><tr><th></th><th>Controller</th><th>Keyboard / mouse</th></tr>${
        CONTROLS.map(([what, pad, keys]) => `<tr><td>${what}</td><td><b>${pad}</b></td><td><b>${keys}</b></td></tr>`).join('')
      }</table><div class="menu-pad"></div><div class="menu-hint">B / Esc to go back</div>`
      : `<div class="menu-list">${this.items.map((it, i) => `<div class="menu-item${i === this.index ? ' selected' : ''}${it.current ? ' current' : ''}" data-i="${i}">
          <span>${it.label}</span>${it.sub ? `<small>${it.sub}</small>` : ''}</div>`).join('')}</div>
        <div class="menu-hint">${this.page === 'main' ? 'A / Enter to pick · Menu / Esc to resume' : 'A / Enter to pick · B / Esc to go back'}</div>`;
    this.root.innerHTML = `<div class="menu-panel"><div class="menu-title">${title}</div>${body}</div>`;
    this.root.querySelectorAll<HTMLDivElement>('.menu-item').forEach((el) => {
      const i = Number(el.dataset.i);
      el.onmouseenter = () => this.select(i);
      el.onclick = () => this.items[i]?.act();
    });
  }
}
