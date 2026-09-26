# Neon Run

Burnout Paradise-style open-world racing through a real city at night, with a GTA 5 / Cyberpunk
look. Real supercars (Lamborghini, Ferrari, Bugatti), living traffic, events waiting at intersections,
rivals to take down, and crashes worth watching. Browser game: Three.js rendering, Rapier physics,
TypeScript, Vite.

All models, the city and the engine sound come from GTA V mods: cars and maps from gta5-mods.com
and similar sites, converted locally. The mod files are for local, personal play only: they're
downloaded into `.mods/`, converted into `public/mods/`, and never committed or redistributed. Sources
and authors are listed in `assets/mods.json` and `assets/CREDITS.md`.

## Set up the assets

Needs Node, the .NET 10 SDK, `bsdtar` and (for audio) `ffmpeg`.

```sh
npm install
git clone --depth 1 https://github.com/dexyfex/CodeWalker.git tools/vendor/CodeWalker
(cd tools/gta5conv && dotnet build -c Release)   # the GTA V converter, on CodeWalker.Core

node scripts/fetch-mods.mjs                      # download + unpack the mods listed in assets/mods.json
node scripts/convert-cars.mjs                    # cars → .build/cars/*.glb + handling data
node scripts/optimize-models.mjs                 # → public/mods/cars/<id>.glb (hero) and <id>_lod.glb
C="dotnet tools/gta5conv/bin/Release/net10.0/gta5conv.dll"
$C map .mods/map-windy-city-chicago public/mods/maps/chicago --cell 250
$C map .mods/map-shibuya public/mods/maps/shibuya
$C audio .mods/ferrari-sf90/rpf public/mods/audio/ferrari --id ferrari --kind engine
```

`gta5conv` also has `dump <file.yft>`, `rpf <dlc.rpf> <outdir>` (unpack an archive) and
`map <dir> --inspect` for looking inside mods.

## Run

```sh
npm run play        # dev server + a Chromium window on the NVIDIA GPU (see scripts/play.sh for why)
npm run play:build  # same, but a production build that doesn't reload while you edit
npm run dev         # dev server only, open http://localhost:5173 yourself
```

`?map=shibuya` loads the other converted map. `viewer.html?car=<id>&view=front|side|rear|top` shows
one converted car.

## Controls

| Action | Keyboard | Gamepad |
|---|---|---|
| Throttle / brake · reverse | W / S (or ↑ / ↓) | RT / LT |
| Steer | A / D (or ← / →) | Left stick |
| Handbrake (start a drift) | Space | A |
| Boost | Shift | X or RB |
| Start an event (stopped in its ring) | hold W + S | hold RT + LT |
| Quit an event | Backspace / Esc | |
| Switch car (free roam) | 1–9 | |
| Camera (chase / cockpit) | C | Y |
| Back to the road | R | Back |
| FPS counter / help | F / H | |

Dangerous driving fills the four-segment boost meter: drifting, near misses with traffic, driving
in the oncoming lanes, air time, and takedowns. Only full segments can be spent: tap boost for one
segment, hold to chain them, or bank them for later. A hard hit is a crash: slow-motion crash cam,
then you're back on the road in a fresh car, still rolling. Hits dent the bodywork.

Events wait at the city's intersections (colored dots on the minimap):

- **Race** (cyan): first to a district of the city against four rivals, by any route. The minimap shows a GPS route.
- **Road Rage** (red): take down enough rivals before the clock runs out. Shove them into walls and traffic.
- **Stunt Run** (yellow): chain drifts, near misses, oncoming and air into a score before time's up.

## Checks

```sh
npm run typecheck
npm run smoke    # headless: driving, drift, boost, reset, traffic, a race, Road Rage, a crash
npm run bench    # 1080p frame times on the GTX 1650 (BENCH_VSYNC=1 for capped 60 fps, BENCH_QUERY=?... for flags)
node scripts/ai-test.mjs     # rival AI: race finishing times, wrecks, takedowns
node scripts/audio-test.mjs  # renders an engine rev sweep to test-results/engine-sweep.wav
```

URL flags for testing: `?traffic=0` empties the streets, `?spawn=<event id>` starts inside an event's
ring, `?debug` exposes live game objects as `window.__debug`.

## Layout

- `tools/gta5conv/`: the converter (C#, CodeWalker.Core): cars → glTF, maps → streaming cells, collision and
  road graph, archives → loose files, engine sounds → Opus
- `src/map.ts`: streams the converted city (cells, textures, collision) and its road graph (routing, GPS, lanes)
- `src/modcar.ts`, `src/garage.ts`: converted cars as drivable visuals; GTA handling data → physics tuning
- `src/car.ts`: Rapier raycast vehicle with arcade assists (drift angle controller, air leveling)
- `src/traffic.ts`: lane-following traffic on the road graph, instanced; hard hits turn cars into physics wrecks
- `src/events.ts`: the events (race, Road Rage, Stunt Run), placed on the map's intersections
- `src/rivals.ts`: AI rival racers on full physics cars; takedowns
- `src/stunts.ts`: near misses, oncoming, air, drift chains, crash detection, stunt scoring
- `src/damage.ts`: dents and crumples car bodies at the point of impact
- `src/engineAudio.ts`, `src/audio.ts`: the mod's granular engine sound; tire and crash sounds
- `src/drift.ts`: drift detection and the segmented boost meter
- `src/atmosphere.ts`, `src/postfx.ts`: night sky, haze, rain, reflections, bloom
- `src/camera.ts`, `src/hud.ts`, `src/minimap.ts`, `src/effects.ts`: camera, HUD, map, skid marks, sparks
