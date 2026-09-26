# Neon Run

Burnout Paradise-style open-world racing through a real city at night, with a GTA 5 / Cyberpunk
look. Real supercars (Lamborghini, Ferrari, Bugatti), living traffic, events waiting at intersections,
rivals to take down, and crashes worth watching. Browser game: Three.js rendering, Rapier physics,
TypeScript, Vite.

All models, the city, its street props and trees, and the sounds come from mods: cars, maps, props
and engine sounds from GTA V mods on gta5-mods.com and similar sites, crash sounds from BeamNG.drive
mods, converted locally. The mod files are for local, personal play only: they're
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
# Street props and trees: map mods place GTA's own lamp posts, traffic lights and trees without
# shipping them, so they come from prop mods that do (the archives inside are unpacked first)
$C rpf ".mods/props-lights-festive/x/Festive Streetlights V (free)/Festive-Streetlights-V_Yash-Kanojia.oiv.x/content/v_traffic_lights.rpf" .mods/props-lights-festive/rpf
$C rpf .mods/props-traffic-nyc/x/LCUPDATE/Extra/props.rpf .mods/props-traffic-nyc/rpf
$C rpf .mods/props-trees-cherry/x/cherry/v_trees.rpf .mods/props-trees-cherry/rpf
PROPS="--props .mods/props-traffic-nyc --props .mods/props-lights-festive --props .mods/props-trees-cherry"
$C map .mods/map-windy-city-chicago public/mods/maps/chicago --cell 250 $PROPS
$C map .mods/map-shibuya public/mods/maps/shibuya $PROPS
$C audio .mods/ferrari-sf90/rpf public/mods/audio/ferrari --id ferrari --kind engine
mkdir -p public/mods/audio/crash                 # crash + glass recordings (BeamNG crash sound mods)
cp .mods/audio-crash-better/x/art/sound/crash.ogg public/mods/audio/crash/crash-1.ogg
cp .mods/audio-crash-alpha/x/art/sound/crash.ogg public/mods/audio/crash/crash-2.ogg
for i in 01 02 03 05 06 07; do cp .mods/audio-crash-better/x/art/sound/glass_shatter_$i.ogg public/mods/audio/crash/glass-$i.ogg; done
cp .mods/audio-crash-alpha/x/art/sound/glass_shatter_01.ogg public/mods/audio/crash/glass-alpha.ogg
```

`gta5conv` also has `dump <file.yft>`, `rpf <dlc.rpf> <outdir>` (unpack an archive) and
`map <dir> --inspect` for looking inside mods. A map conversion writes `missing.json` (archetypes the
map places that no mod supplies, by name hash) and `props.json` (triangle cost per prop) next to it.

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
ring, `?at=x,z` on the road nearest a map point, `?debug` exposes live game objects as `window.__debug`.

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
- `src/engineAudio.ts`, `src/audio.ts`: the mod's granular engine sound; tire, crash and glass sounds
- `src/drift.ts`: drift detection and the segmented boost meter
- `src/atmosphere.ts`, `src/postfx.ts`: night sky, haze, rain, reflections, bloom
- `src/camera.ts`, `src/hud.ts`, `src/minimap.ts`, `src/effects.ts`: camera, HUD, map, skid marks, sparks
