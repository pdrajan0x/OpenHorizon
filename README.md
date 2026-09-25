# Racing

Open-world arcade racer for the browser (Three.js rendering, Rapier physics, TypeScript, Vite).
Built phase by phase: this is Phase 1, one arcade-tuned car on a test circuit with the drift-to-boost loop.

## Run

```sh
npm install
npm run play     # dev server + a Chromium window on the NVIDIA GPU (see scripts/play.sh for why)
npm run dev      # dev server only, open http://localhost:5173 yourself
```

## Controls

| Action | Keyboard | Gamepad |
|---|---|---|
| Throttle / brake · reverse | W / S (or ↑ / ↓) | RT / LT |
| Steer | A / D (or ← / →) | Left stick |
| Handbrake (start a drift) | Space | A |
| Boost | Shift | X or RB |
| Camera (chase / hood) | C | Y |
| Reset to road | R | Back |
| FPS counter / help | F / H | |

Drifting fills the four-segment boost meter. Only full segments can be spent: tap boost for one
segment, hold to chain them, or bank them for later.

## Checks

```sh
npm run typecheck
npm run smoke    # headless: drives the car and checks acceleration, steering, drift, boost, reset
npm run bench    # 1080p frame times on the GTX 1650 (BENCH_VSYNC=1 for capped 60 fps)
```

## Layout

- `src/tuning.ts`: per-car handling data. New cars are new `CarTuning` values.
- `src/car.ts`: Rapier raycast vehicle, arcade assists (drift angle controller, air leveling)
- `src/drift.ts`: drift detection and the segmented boost meter
- `src/track.ts`, `src/environment.ts`: circuit spline and road mesh, ground, trees, cones, ramps
- `src/camera.ts`: chase and hood cameras, with speed-based FOV and shake
- `src/hud.ts`, `src/audio.ts`, `src/effects.ts`: HUD, synthesized engine and tire audio, skid marks
