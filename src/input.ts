// Keyboard, mouse and gamepad (Xbox layout) → analog driving controls, where the player is looking, and
// one-shot actions. Browsers report a known controller in the "standard" layout (triggers as buttons 6
// and 7); on Linux an Xbox pad often comes through raw instead, in the kernel's order, with the triggers
// as axes resting at -1. Both are read here, from whichever connected controller was used last.
//
//   Xbox controller                     Keyboard / mouse
//   RT / LT        throttle / brake     W S (arrows)
//   left stick     steer                A D
//   A              handbrake            Space
//   X or RB        boost                Shift
//   right stick    look around          drag with the mouse (either button)
//   B or R3 (hold) look behind
//   Y              camera               V / C
//   D-pad up       back on the road     R
//   View (Back)    map                  M
//   Menu (Start)   pause menu           Esc
//   D-pad, A / B   move, pick, back in the menu (arrows, Enter, Esc)
import type { Look } from './camera';

export interface Controls {
  throttle: number; // 0..1
  brake: number; // 0..1, also reverse when stopped
  steer: number; // -1 left .. 1 right
  handbrake: boolean;
  boost: boolean;
}

export interface Actions {
  reset: boolean;
  camera: boolean;
  fps: boolean;
  help: boolean;
  quit: boolean; // leave the current event
  car: number | null; // garage slot picked with the number keys
  menu: boolean; // open or close the pause menu
  map: boolean; // the big map (the M key is handled by the map itself)
}

/** Menu navigation, one step per press. */
export interface Nav {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
  confirm: boolean;
  back: boolean;
}

const KEYS = {
  throttle: ['KeyW', 'ArrowUp'],
  brake: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  handbrake: ['Space'],
  boost: ['ShiftLeft', 'ShiftRight'],
  reset: ['KeyR'],
  camera: ['KeyV', 'KeyC'],
  fps: ['KeyF'],
  help: ['KeyH'],
  quit: ['Backspace'],
  menu: ['Escape'],
  cars: ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9'],
};

// Standard gamepad mapping (Xbox names)
const PAD = {
  a: 0, b: 1, x: 2, y: 3, lb: 4, rb: 5, lt: 6, rt: 7, view: 8, menu: 9, l3: 10, r3: 11,
  up: 12, down: 13, left: 14, right: 15,
};
// Raw (non-standard) layout of the Linux xpad / xpadneo drivers: buttons in this order, axes left stick,
// triggers (found by resting at -1), right stick, D-pad as the last two axes
const RAW = { a: 0, b: 1, x: 2, y: 3, lb: 4, rb: 5, view: 6, menu: 7, l3: 9, r3: 10 };
type Button = keyof typeof PAD;

/** A controller's state in Xbox terms, whatever layout it arrived in. */
interface PadState {
  lx: number;
  ly: number;
  rx: number;
  ry: number;
  lt: number; // 0..1
  rt: number;
  button: (b: Button) => number; // 0..1
  info: string;
}
const STICK_DEADZONE = 0.12;
const TRIGGER_DEADZONE = 0.04;
const LOOK_DEADZONE = 0.18;
const STEER_CURVE = 1.6; // stick → steering: gentle near the middle for small corrections, full lock at the edge
const MENU_STICK = 0.6; // stick deflection that counts as a menu step
const MOUSE_YAW = 0.006; // rad per pixel dragged
const MOUSE_PITCH = 0.004;

// Keyboard steering ramps like a stick instead of snapping to full lock
const STEER_RATE = 4;
const STEER_RETURN_RATE = 7;

export class Input {
  private down = new Set<string>();
  private pressed = new Set<string>();
  private padWasDown: boolean[] = [];
  private stickWas = { x: 0, y: 0 };
  private keySteer = 0;
  /** Each raw controller's axes as first seen: the ones resting at -1 are its triggers. */
  private readonly rest = new Map<string, number[]>();
  private lastPad = '';
  private drag: { id: number; x: number; y: number } | null = null;
  private mouseYaw = 0;
  private mousePitch = 0;
  /** Where the player is looking this frame (camera.look()). */
  readonly look: Look = { yaw: 0, pitch: 0, active: false };
  /** Menu steps this frame (only meaningful while a menu is open). */
  readonly nav: Nav = { up: false, down: false, left: false, right: false, confirm: false, back: false };

  constructor(canvas: HTMLCanvasElement, onPad?: (name: string) => void) {
    window.addEventListener('gamepadconnected', (e) => onPad?.(`CONTROLLER CONNECTED: ${shortName(e.gamepad.id)}`));
    window.addEventListener('gamepaddisconnected', (e) => onPad?.(`CONTROLLER DISCONNECTED: ${shortName(e.gamepad.id)}`));
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
      if (!e.repeat) this.pressed.add(e.code);
      this.down.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.down.delete(e.code));
    window.addEventListener('blur', () => {
      this.down.clear();
      this.drag = null;
    });

    // Drag on the game view to look around; let go and the camera settles back behind the car
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('pointerdown', (e) => {
      this.drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!this.drag || e.pointerId !== this.drag.id) return;
      this.mouseYaw += (e.clientX - this.drag.x) * MOUSE_YAW;
      // Drag up to raise the camera over the car, down to bring it low
      this.mousePitch -= (e.clientY - this.drag.y) * MOUSE_PITCH;
      this.mouseYaw = Math.max(-Math.PI, Math.min(Math.PI, this.mouseYaw));
      this.mousePitch = Math.max(-0.15, Math.min(1.1, this.mousePitch));
      this.drag.x = e.clientX;
      this.drag.y = e.clientY;
    });
    const release = (e: PointerEvent) => {
      if (!this.drag || e.pointerId !== this.drag.id) return;
      this.drag = null;
      this.mouseYaw = 0;
      this.mousePitch = 0;
    };
    canvas.addEventListener('pointerup', release);
    canvas.addEventListener('pointercancel', release);
  }

  /**
   * The controller in use: of those connected, the one with the latest input (some systems list extra
   * devices as gamepads, e.g. a motion sensor or a virtual pad, and the first listed isn't always yours).
   */
  private pad(): Gamepad | null {
    const pads = [...(navigator.getGamepads?.() ?? [])].filter((p): p is Gamepad => !!p && p.connected && p.axes.length >= 2);
    if (!pads.length) return null;
    for (const p of pads) if (!this.rest.has(p.id)) this.rest.set(p.id, [...p.axes]);
    const used = pads.filter((p) => p.buttons.some((b) => b.value > 0.1) || p.axes.some((a, i) => Math.abs(a - (this.rest.get(p.id)?.[i] ?? 0)) > 0.3));
    const pick = (list: Gamepad[]) => list.reduce((a, b) => (b.timestamp > a.timestamp ? b : a));
    const chosen = used.length ? pick(used) : pads.find((p) => p.id === this.lastPad) ?? pick(pads);
    this.lastPad = chosen.id;
    return chosen;
  }

  /** The controller in Xbox terms. */
  private read(pad: Gamepad): PadState {
    const axis = (i: number) => (i >= 0 ? pad.axes[i] ?? 0 : 0);
    const value = (i: number) => pad.buttons[i]?.value ?? 0;
    if (pad.mapping === 'standard') {
      return {
        lx: axis(0), ly: axis(1), rx: axis(2), ry: axis(3), lt: value(PAD.lt), rt: value(PAD.rt),
        button: (b) => value(PAD[b]), info: `${shortName(pad.id)} · standard layout`,
      };
    }
    // Raw: the triggers are the axes that rested at -1 when first seen
    const rest = this.rest.get(pad.id) ?? [...pad.axes];
    const triggers = rest.map((v, i) => (v < -0.9 ? i : -1)).filter((i) => i >= 0);
    const others = pad.axes.map((_, i) => i).filter((i) => !triggers.includes(i));
    const [lt, rt] = triggers.length >= 2 ? triggers : [-1, -1];
    const trigger = (i: number, button: number) => Math.max(i >= 0 ? (axis(i) + 1) / 2 : 0, value(button));
    const hatX = pad.axes.length >= 8 ? axis(others[others.length - 2]) : 0;
    const hatY = pad.axes.length >= 8 ? axis(others[others.length - 1]) : 0;
    const raw: Record<Button, number> = {
      a: value(RAW.a), b: value(RAW.b), x: value(RAW.x), y: value(RAW.y), lb: value(RAW.lb), rb: value(RAW.rb),
      lt: 0, rt: 0, view: value(RAW.view), menu: value(RAW.menu), l3: value(RAW.l3), r3: value(RAW.r3),
      up: hatY < -0.5 ? 1 : 0, down: hatY > 0.5 ? 1 : 0, left: hatX < -0.5 ? 1 : 0, right: hatX > 0.5 ? 1 : 0,
    };
    return {
      lx: axis(others[0]), ly: axis(others[1]), rx: axis(others[2] ?? -1), ry: axis(others[3] ?? -1),
      // No axis resting at -1: the triggers may be buttons 6 and 7 after all
      lt: triggers.length >= 2 ? trigger(lt, -1) : value(6), rt: triggers.length >= 2 ? trigger(rt, -1) : value(7),
      button: (b) => raw[b],
      info: `${shortName(pad.id)} · raw layout, triggers on axes ${triggers.join(' + ') || 'none found'}`,
    };
  }

  /** What the controller reports right now, for the menu's controls page. */
  padInfo(): string {
    const pad = this.pad();
    if (!pad) return 'No controller found. Connect it, then press any button on it.';
    const p = this.read(pad);
    const f = (v: number) => v.toFixed(2);
    const held = (Object.keys(PAD) as Button[]).filter((b) => p.button(b) > 0.5).join(' ') || '—';
    return `${p.info}\nRT ${f(p.rt)}  LT ${f(p.lt)}  left stick ${f(p.lx)}, ${f(p.ly)}  right stick ${f(p.rx)}, ${f(p.ry)}  held: ${held}`;
  }

  /**
   * Rumble the controller: `strong` (low-frequency motor) and `weak` (high-frequency) 0..1 for `ms`.
   * Silently nothing without a controller or where the browser has no vibration.
   */
  rumble(strong: number, weak: number, ms: number): void {
    const pad = this.pad() as (Gamepad & { vibrationActuator?: { playEffect?: (type: string, p: object) => Promise<unknown> } }) | null;
    pad?.vibrationActuator?.playEffect?.('dual-rumble', {
      duration: ms, strongMagnitude: Math.min(1, strong), weakMagnitude: Math.min(1, weak),
    }).catch(() => {});
  }

  update(dt: number): { controls: Controls; actions: Actions } {
    const held = (codes: string[]) => codes.some((c) => this.down.has(c));
    const tapped = (codes: string[]) => codes.some((c) => this.pressed.has(c));

    const target = (held(KEYS.right) ? 1 : 0) - (held(KEYS.left) ? 1 : 0);
    const returning = target === 0 || Math.sign(target) !== Math.sign(this.keySteer);
    const rate = (returning ? STEER_RETURN_RATE : STEER_RATE) * dt;
    this.keySteer += Math.max(-rate, Math.min(rate, target - this.keySteer));

    const controls: Controls = {
      throttle: held(KEYS.throttle) ? 1 : 0,
      brake: held(KEYS.brake) ? 1 : 0,
      steer: this.keySteer,
      handbrake: held(KEYS.handbrake),
      boost: held(KEYS.boost),
    };
    const actions: Actions = {
      reset: tapped(KEYS.reset),
      camera: tapped(KEYS.camera),
      fps: tapped(KEYS.fps),
      help: tapped(KEYS.help),
      quit: tapped(KEYS.quit),
      car: KEYS.cars.findIndex((code) => this.pressed.has(code)),
      menu: tapped(KEYS.menu),
      map: false,
    };
    if (actions.car === -1) actions.car = null;
    const nav = this.nav;
    nav.up = tapped(['ArrowUp', 'KeyW']);
    nav.down = tapped(['ArrowDown', 'KeyS']);
    nav.left = tapped(['ArrowLeft', 'KeyA']);
    nav.right = tapped(['ArrowRight', 'KeyD']);
    nav.confirm = tapped(['Enter', 'NumpadEnter', 'Space']);
    nav.back = tapped(['Backspace']);
    this.pressed.clear();

    // Mouse drag look (the gamepad's right stick takes over while it's pushed)
    this.look.yaw = this.mouseYaw;
    this.look.pitch = this.mousePitch;
    this.look.active = this.drag !== null;

    const pad = this.pad();
    if (pad) {
      const p = this.read(pad);
      const button = (b: Button) => p.button(b);
      // Presses this frame, worked out once (a button can mean one thing driving and another in the menu)
      const taps = new Map<Button, boolean>();
      for (const b of Object.keys(PAD) as Button[]) {
        const isDown = p.button(b) > 0.5;
        taps.set(b, isDown && !(this.padWasDown[PAD[b]] ?? false));
        this.padWasDown[PAD[b]] = isDown;
      }
      const tappedButton = (b: Button) => taps.get(b) ?? false;
      if (Math.abs(p.lx) > STICK_DEADZONE) {
        const t = (Math.abs(p.lx) - STICK_DEADZONE) / (1 - STICK_DEADZONE);
        controls.steer = Math.sign(p.lx) * t ** STEER_CURVE;
      }
      const trigger = (v: number) => (v > TRIGGER_DEADZONE ? (v - TRIGGER_DEADZONE) / (1 - TRIGGER_DEADZONE) : 0);
      controls.throttle = Math.max(controls.throttle, trigger(p.rt));
      controls.brake = Math.max(controls.brake, trigger(p.lt));
      controls.handbrake ||= button('a') > 0.5;
      controls.boost ||= button('x') > 0.5 || button('rb') > 0.5;
      actions.camera ||= tappedButton('y');
      actions.reset ||= tappedButton('up');
      actions.map ||= tappedButton('view');
      actions.menu ||= tappedButton('menu');

      // Right stick: look where it points, as far round as it's pushed; B or R3 held looks behind
      const mag = Math.hypot(p.rx, p.ry);
      if (button('b') > 0.5 || button('r3') > 0.5) {
        this.look.yaw = Math.PI;
        this.look.pitch = 0.05;
        this.look.active = true;
      } else if (mag > LOOK_DEADZONE) {
        const t = Math.min(1, (mag - LOOK_DEADZONE) / (1 - LOOK_DEADZONE));
        this.look.yaw = (p.rx / mag) * t * Math.PI * 0.95;
        this.look.pitch = Math.max(-0.15, -(p.ry / mag) * t * 0.6);
        this.look.active = true;
      }

      // Menu steps: D-pad, or the left stick flicked past MENU_STICK; A picks, B goes back
      const flick = (v: number, was: number, sign: number) => v * sign > MENU_STICK && was * sign <= MENU_STICK;
      nav.up ||= tappedButton('up') || flick(p.ly, this.stickWas.y, -1);
      nav.down ||= tappedButton('down') || flick(p.ly, this.stickWas.y, 1);
      nav.left ||= tappedButton('left') || flick(p.lx, this.stickWas.x, -1);
      nav.right ||= tappedButton('right') || flick(p.lx, this.stickWas.x, 1);
      nav.confirm ||= tappedButton('a');
      nav.back ||= tappedButton('b');
      this.stickWas = { x: p.lx, y: p.ly };
    }

    return { controls, actions };
  }
}

/** "Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)" → "Xbox Wireless Controller". */
function shortName(id: string): string {
  return id.replace(/\s*\(.*\)\s*$/, '').replace(/^[0-9a-f]{4}-[0-9a-f]{4}-/i, '').trim() || id;
}
