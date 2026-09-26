// Keyboard + gamepad → analog driving controls and one-shot actions.

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
}

const KEYS = {
  throttle: ['KeyW', 'ArrowUp'],
  brake: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  handbrake: ['Space'],
  boost: ['ShiftLeft', 'ShiftRight'],
  reset: ['KeyR'],
  camera: ['KeyC'],
  fps: ['KeyF'],
  help: ['KeyH'],
  quit: ['Backspace', 'Escape'],
  cars: ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9'],
};

// Standard gamepad mapping
const PAD = { handbrake: 0, boostX: 2, camera: 3, boostRB: 5, brake: 6, throttle: 7, reset: 8 };
const STICK_DEADZONE = 0.12;

// Keyboard steering ramps like a stick instead of snapping to full lock
const STEER_RATE = 4;
const STEER_RETURN_RATE = 7;

export class Input {
  private down = new Set<string>();
  private pressed = new Set<string>();
  private padWasDown: boolean[] = [];
  private keySteer = 0;

  constructor() {
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
      if (!e.repeat) this.pressed.add(e.code);
      this.down.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.down.delete(e.code));
    window.addEventListener('blur', () => this.down.clear());
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
    };
    if (actions.car === -1) actions.car = null;
    this.pressed.clear();

    const pad = navigator.getGamepads?.().find((p) => p && p.connected);
    if (pad) {
      const button = (i: number) => pad.buttons[i]?.value ?? 0;
      const tappedButton = (i: number) => {
        const isDown = button(i) > 0.5;
        const wasDown = this.padWasDown[i] ?? false;
        this.padWasDown[i] = isDown;
        return isDown && !wasDown;
      };
      const stick = pad.axes[0] ?? 0;
      if (Math.abs(stick) > STICK_DEADZONE) {
        controls.steer = Math.sign(stick) * (Math.abs(stick) - STICK_DEADZONE) / (1 - STICK_DEADZONE);
      }
      controls.throttle = Math.max(controls.throttle, button(PAD.throttle));
      controls.brake = Math.max(controls.brake, button(PAD.brake));
      controls.handbrake ||= button(PAD.handbrake) > 0.5;
      controls.boost ||= button(PAD.boostX) > 0.5 || button(PAD.boostRB) > 0.5;
      actions.camera ||= tappedButton(PAD.camera);
      actions.reset ||= tappedButton(PAD.reset);
    }

    return { controls, actions };
  }
}
