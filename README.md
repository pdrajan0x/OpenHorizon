# Neon Run

Open-world driving in a rain-soaked neon city at night, with high-end cars, living traffic, and
street racing as one of the things to do. Browser game: Three.js rendering, Rapier physics,
TypeScript, Vite.

## Run

```sh
npm install
npm run play     # dev server + a Chromium window on the NVIDIA GPU (see scripts/play.sh for why)
npm run dev      # dev server only, open http://localhost:5173 yourself
```

`showroom.html` (on the dev server) shows one car design at a time: `?car=vesperNyx&view=front|side|rear|top`,
plus `&glow=<color>` for underglow, `&light` for a light backdrop and `&debug` to color-code paint, glass and trim.

## Controls

| Action | Keyboard | Gamepad |
|---|---|---|
| Throttle / brake · reverse | W / S (or ↑ / ↓) | RT / LT |
| Steer | A / D (or ← / →) | Left stick |
| Handbrake (start a drift) | Space | A |
| Boost | Shift | X or RB |
| Switch car | 1 / 2 / 3 | |
| Camera (chase / cockpit) | C | Y |
| Back to the road | R | Back |
| FPS counter / help | F / H | |

Drifting fills the four-segment boost meter. Only full segments can be spent: tap boost for one
segment, hold to chain them, or bank them for later. The open lot north-east of downtown (purple on
the minimap) has no traffic and is the place to practice.

## Checks

```sh
npm run typecheck
npm run smoke    # headless: drives in the lot (accelerate, steer, drift, boost, reset), then checks city traffic
npm run bench    # 1080p frame times on the GTX 1650 (BENCH_VSYNC=1 for capped 60 fps)
```

URL flags for testing: `?traffic=0` empties the streets, `?spawn=lot` starts in the lot.

## Layout

- `src/city.ts`: street grid layout, buildings, signs, street lights, traffic signals and their timing
- `src/traffic.ts`: lane-following traffic that spawns around the player; hard hits turn cars into physics wrecks
- `src/carModel.ts`: procedural car bodies and the designs (hero cars and traffic)
- `src/tuning.ts`: per-car handling data; `GARAGE` is the switchable hero cars
- `src/car.ts`: Rapier raycast vehicle with arcade assists (drift angle controller, air leveling)
- `src/drift.ts`: drift detection and the segmented boost meter
- `src/atmosphere.ts`, `src/postfx.ts`, `src/neon.ts`: night sky, haze, rain, reflections, bloom, sign and window textures
- `src/camera.ts`, `src/hud.ts`, `src/minimap.ts`, `src/audio.ts`, `src/effects.ts`: camera, HUD, map, sound, skid marks

All car makes and sign brands are invented.
