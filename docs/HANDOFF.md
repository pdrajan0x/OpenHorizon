# Handoff: world fixes, AAA look, new mods

State of the work on the owner's latest request list, written so the next session (with internet
access) can pick it up directly. The cloud session that wrote this couldn't download any mod: its
network policy blocked gta5-mods.com, mediafire, beamng.com, polyhaven.com and sketchfab.com.

## The request (from the owner, in their words, condensed)

Hold off on game mechanics. First do these:

1. Fix the environment.
2. Some buildings hover over the ground.
3. You can drive through some buildings and then drop into the void (3D models/collision not set up properly).
4. The map isn't drawn properly from the city's roads: map the city properly, every small road, every alley, every building.
5. The cities aren't merged properly: merge all 10–11 cities in a way that makes sense, all reachable **by road**.
6. Give every city a better boundary: a small wall, coast, beach or rocky area running into the sea.
7. **Don't make 3D models ourselves.** Always get them from the internet, preferring game mod sites over
   Sketchfab. The main priority is **high quality**. Mods from **any game** are fine (not only GTA V
   and Cyberpunk).
8. Buildings look bad from far and near: they look flat and need more 3D definition. Replace some
   buildings with new ones, replace the trees with high-quality trees, and replace the NPC traffic cars
   (they look like cardboard boxes).
9. When the car crashes it respawns. Don't respawn: a crash wrecks the car, and after enough crashes
   the car is destroyed.

Follow-ups: "make it like a AAA open world game, not a boxy low-res game"; "fix everything however
you want"; **Miami is wanted** (it's in the city list but nobody knows where it came from, see below).

## Done (this commit)

- **Item 9, crashes wreck the car** (`src/main.ts`, `src/car.ts`, `src/damage.ts`, `src/hud.ts`):
  - There's no respawn after a crash. The crash cam plays, then you drive on from wherever the car stopped.
  - `Car.health` goes from 1 to 0. A crash costs `0.1 + 0.004 × speed (m/s)` and a dent costs a little.
    Wear costs power (up to −55 %) and top speed (−35 %), and the car pulls to one side.
  - At 0 health the car is **wrecked**: the engine is dead, it smokes (`WreckSmoke`, which existed but
    was never used), and after 2.5 s "Press R for a new car" appears.
  - Driving into the sea sinks the car, which also counts as a wreck.
  - A rolled car is put back on its wheels where it lies (`Car.rightUp()`) instead of being teleported.
  - Events start with a fresh car.
  - There's a health bar under the boost meter.
  - The smoke test now checks that the car stays put and is damaged.
- **Test world** (`scripts/make-test-world.mjs`, `vite.config.ts`, `TEST_WORLD=1`): synthetic box
  cities, cars, sky and sounds in the real formats, so the game runs without mods. Verified headless:
  it loads, traffic drives, and a crash leaves the car smoking in place at 68 %.
- `scripts/browser.mjs` finds a Chromium (system or Playwright's) for probe, shot and smoke.
- Removed `public/models/trees/oak_small.glb`: it was a saved 404 JSON page, not a model.
- The environment toolchain installs cleanly on Ubuntu 24.04 with
  `apt-get install dotnet-sdk-10.0 libarchive-tools ffmpeg`, and `gta5conv` builds with .NET 10 against
  a fresh `git clone --depth 1 https://github.com/dexyfex/CodeWalker.git tools/vendor/CodeWalker`.

## Diagnoses (read the code, couldn't see the real data)

**Hovering buildings (item 2)**, most likely causes, in order:
1. `GameMap.cull()` in `src/map.ts` hides every render batch (one material in one cell) whose bounding
   sphere is small for its distance (`MIN_DRAW_DISTANCE = 120`, `DRAW_DISTANCE_PER_METER = 18`).
   Ground-floor shop fronts, doors and awnings often have a material of their own. From about 120 m
   they vanish while the tower above stays, so the building appears to float.
   - **Fix:** the converter should tag batches as structure (from entities with a bounding radius of
     8 m or more), which are never culled inside the render radius, or detail (distance-culled).
   - For already-converted data: cull much less aggressively (min 300 m, 40× radius).
2. `MapWriter.ModelsFor` ignores bone transforms, so fragments (`.yft`) place multi-part models at the
   wrong height. Apply the skeleton's bone matrices as `CarExport` does (`BoneMatrices` in `Program.cs`).
3. LOD entities whose HD children aren't linked through `CMapData.parent` get drawn alongside the HD
   ones.
4. **Hong Kong** (v1.1) sits at GTA Z = 500, and the converter keeps Z (`origin.Z = 0`), so the whole
   city floats 500 m above the sea. Islands need a vertical offset; see the layout plan below.

**Driving through buildings, then into the void (item 3):**
1. `MapWriter` **skips every `.ybn` whose bounding box contains three or more other `.ybn` boxes**,
   assuming it's a combined copy. A big ground or building collision file contains many small prop
   boxes, so it gets dropped, and you fall through.
   - **Fix:** always keep all files and drop exact duplicate triangles (that's what `--all-col` does),
     i.e. make that the default.
2. Some entities have no collision at all.
   - **Fix:** for every placed non-prop entity bigger than about 3 m, check the collision triangles
     inside its bounding box. If fewer than half of its 8 m footprint cells are covered, add its render
     mesh (lowest LOD with enough triangles; skip blend, decal, glass, emissive and foliage materials)
     as collision. This generalises `--render-col`.
3. MLO interiors (`CMloInstanceDef`) are placed, but their room entities (in the `.ytyp`) never are.
   Custom maps often build shells as MLOs.
4. Runtime: `fellThrough` only resets when you're 25 m below the nearest road node, and only down to
   sea level now.

**Cities not merged (item 5):**
- `src/islands.ts` lays the islands out in rows with 900 m of sea between them.
- `src/bridges.ts` builds flat boxes at y = 8 between the nearest sampled nodes. They don't match the
  road heights at either end (you can't drive up onto them), and they link to the nearest node
  anywhere, often mid-city.

**Map (item 4):**
- The minimap and the M map draw only the GTA vehicle path links, which skip alleys and service roads.
- The M map fakes land by drawing 140 m wide strokes along the roads.

**Cardboard traffic (item 8):**
- `traffic.ts` `Fleet` throws away every texture and bakes each material to one average colour. It
  merges the car into 4 batches and simplifies to 25 %.
- That's on top of `optimize-models.mjs` already cutting traffic cars to 12k triangles with 256 px
  textures.
- **Fix:** instance per unique material and keep the textures; use roughly 30–40k triangles and 1024 px
  textures; no runtime simplify.

## Plan for the rest (designed, not written yet)

### A. `scripts/map-extras.mjs`: post-process each converted map (works on existing data, no re-conversion)

Reads `manifest.json`, `cells/*.bin`, `col/*.bin`, `roads.json` and `tex/*.gtx`. It writes:

- **`map/tiles/<cx>_<cz>.webp`**: top-down map at 1 m/px, one tile per cell, plus a
  **`map/overview.webp`** at 8 m/px.
  - Rasterize the up-facing triangles and keep the top and the lowest surface per pixel.
  - Buildings are pixels where top − ground > 3.5 m. Draw them lighter the taller they are, with a
    dark outline and a drop shadow.
  - Classify ground by material. Name regexes first (road/asphalt/tarmac, pave/sidewalk/concrete,
    grass/park, sand, water). Otherwise use the texture's average colour: decode the smallest DXT mip.
  - Pixels within half a road width of a path link, at a similar height, are road.
  - Leave out foliage, glass and decals.
  - Palette: dark HUD theme, water `#0e2b3d`, ground `#26303b`, park `#1e3a2b`, road `#525d6c`,
    buildings `#394656` and lighter.
  - The minimap and the M map draw these tiles instead of stroked links; the GPS route stays on top.
- **`coast.json`**: land outline loops, with the ground height at each vertex.
  - Build a 4 m land mask from collision and render up-facing surfaces above −2 m (not water).
  - Close it (dilate/erode by 1), fill holes under 2500 m², and drop specks under 5000 m².
  - Run marching squares, then Douglas-Peucker at 3 m.
  - Orient every loop with land on the left.
- **`far/<cellId>.bin`** (same format as `cells/`): each cell's batches through
  `MeshoptSimplifier.simplifySloppy` (stride 8 floats) at about 6 %. Drop blend, mask and emissive
  batches and anything under 30 triangles. The game loads these beyond the render radius (650 m) out
  to about 3 km, so the skyline exists from afar.
- **`extras.json`**: version, tile list, overview bounds, and flags for what exists. The game treats
  every file as optional.

### B. Islands and roads (items 5 and 6)

- **Layout:** skyline packing of the land bounds (from `coast.json`, else the render cells), about
  300 m of sea between neighbours, first island at the origin.
- **Vertical offset per island:**
  - If the map has its own sea plane (`stats.water`), align it to 0 and hide the map's water materials,
    so there's no z-fighting with the ocean.
  - Otherwise, if the 2nd percentile of ground height is above 8 m, shift the island so it sits at +3 m
    (this fixes Hong Kong).
- **Connections:** a minimum spanning tree over candidate pairs by gap length, plus a couple of extra
  links for loops, so every city is reachable.
- **Gateway node per side:** prefer a dead end (degree 1) near the coast facing the other island, on a
  real road (lanes > 0), with little land between it and the shore.
- **Road link between gateways:**
  - A Hermite curve leaving along each road's own direction, 18 m wide.
  - Height eases from each end's road height up to a deck at ≥ 12 m above the sea, with a grade of 6 %
    or less.
  - Ribbon mesh with lane markings (canvas texture), concrete barriers, and pillars down to the seabed.
  - Rapier **trimesh** collision.
  - Road-graph nodes every 25 m (2 lanes each way) joined to both gateways, so traffic, GPS and races
    use it.
- **Coast from each loop:** a skirt from about 2 m inside the edge (just under the map's ground) out
  and down to below the sea.
  - Profile by edge height:
    - Under 4 m: **beach**, sand sloping to −3 m over about 40 m.
    - 4–15 m: **sea wall**, a concrete face to −1 m with riprap rocks at its foot.
    - Above 15 m: **rocky cliff**, a noisy rock slope.
  - Rivers and lakes inside a map (interior loops) get the wall profile.
  - Collision is a trimesh.
  - Textures and rock models from Poly Haven (CC0, see the mods list), falling back to the maps' own
    sand, rock and concrete textures.

### C. Renderer (item 8, "AAA not boxy")

- **Ambient occlusion:** add N8AO (`npm i n8ao`) to the composer, the biggest single win for flat-looking
  buildings.
- **Sun shadows:** cascaded shadow maps (`three/addons/csm/CSM.js`), two cascades to about 250 m,
  PCF soft. Call `csm.setupMaterial` on the map materials in `GameMap.material()`.
  Check the fps with `npm run bench` on the GTX 1650; offer `?quality=low` to turn them off.
- **Converter: GTA vertex colours:** `colour0` carries baked ambient occlusion and lighting. Add an
  RGBA8 attribute to the cell format (batch header `"colors": true`) and multiply it into the lighting.
  The mods.json note on Shinjuku ("vertex-shading shadow artifacts") shows the data is there.
- **Converter: specular maps:** `SpecSampler` → roughness. Also blend terrain layers
  (`terrain_cb_*` shaders use vertex colours to mix 4 layers; only layer 1 is used now).
- Culling changes and far LODs as above. Tone mapping and exposure per time of day are in `atmosphere.ts`.
- Traffic: the Fleet rework above, plus new traffic car mods.

### D. Converter changes (`tools/gta5conv/MapWriter.cs`)

Needs a re-conversion of every map afterwards:

- Keep all collision and dedupe it.
- Render-mesh fallback collision.
- Fragment bone transforms.
- Place MLO room entities.
- Tag batches as structure or detail.
- Vertex colours.
- Spec maps.
- Also write `hover.json`: entities whose lowest point is more than 1.5 m above any surface below them
  (for finding the remaining floaters).
- Also write an LOD layer (`lod/<cellId>.bin` from LOD-level entities) as a better far view than the
  simplified HD, where the mod ships LODs.

### E. Environment script

`scripts/setup.sh` (not written yet) should run the whole pipeline end to end:

1. apt packages, then the CodeWalker clone and the gta5conv build.
2. `npm ci`.
3. `fetch-environment`, `fetch-mods`.
4. `convert-cars`, `optimize-models`.
5. Unpack the prop RPFs.
6. `gta5conv map` for **every** map (the README only records the Chicago and Shibuya commands; the
   flags for the other maps have to be found with `gta5conv map <dir> --inspect`), then `map-index`
   and `map-extras`.

## Mods wanted (item 7): what, and what counts as good enough

Priority is visual quality, "AAA". Prefer game mod sites (gta5-mods.com, beamng.com/resources,
overtake.gg / RaceDepartment for Assetto Corsa, Nexus Mods, ModDB, Steam Workshop). Then use CC0
libraries (Poly Haven, ambientCG, Quixel/Fab free assets), and Sketchfab last. Add every download to
`assets/mods.json` (id, category, page URL, file URL, author, notes) and credit it in
`assets/CREDITS.md`. Mods stay local (`.mods/`, `public/mods/`, both gitignored) and are never
committed, because the repo is public.

The pipeline reads GTA V formats natively (`gta5conv`: ydr/yft/ytd/ybn/ymap/ytyp). For other games:
- glTF/GLB goes straight in via gltf-transform.
- FBX: FBX2glTF or Blender.
- Assetto Corsa `.kn5`: export to FBX with Content Manager or a kn5 converter.
- BeamNG `.dae` or `.dts`: Collada via Blender or assimp.

Add a converter step for each format as it's needed.

| Need | What to look for | Where |
|---|---|---|
| **Miami map** | A full drivable Miami / Miami Beach / Vice City-style city with collision, its own textures, ideally path nodes (`.ynd`). Rating ≥ 4.5. | gta5-mods.com Maps: search "Miami", "Vice City", "Florida". Record it in mods.json as `map-miami`; `map-index.mjs` already names it "Miami". |
| **Trees and vegetation** | High-poly trees with proper LODs and alpha-tested leaves; palms for Miami, Dubai and Monaco; broadleaf for Chicago; cherry and zelkova for Tokyo. Must ship the actual `.ydr` models, not just `.ymap` placements. | gta5-mods.com Misc/Maps: vegetation or tree overhaul packs. Or CC0 or free game-ready trees (Quixel/Fab, Poly Haven) in glTF/FBX. |
| **Traffic cars** (about 10–15) | Everyday cars matching the cities: Toyota Corolla/Camry, Honda Accord/Civic, Tesla Model 3, BMW 3/5, Mercedes C/E, VW Golf, Ford Explorer/F-150, Chevy Tahoe, Nissan Altima, Japanese kei cars and taxis (Toyota JPN Taxi, Crown Comfort), London-style black cab, buses, delivery vans. **Must have LODs** (L0–L2), a rating ≥ 4.7 and a sane size (under ~80 MB). Add-on format with `handling.meta`. | gta5-mods.com Vehicles (filter by rating); BeamNG vehicle mods also work once there's a converter. |
| **Buildings** | Higher-detail building replacements for the flattest cities, with better facades, normal and spec maps, emissive windows at night. Or whole higher-quality city maps to swap in. | gta5-mods.com Maps (city retexture or building packs that ship `.ydr`); Assetto Corsa city tracks (e.g. the free Shutoko Revival Project for Tokyo expressways) via kn5 export; BeamNG city maps. |
| **Coast** | Rock and cliff models, a sea-wall or breakwater piece, sand, rock and concrete PBR textures (diffuse, normal, roughness, 2k). | Poly Haven (CC0): rock sets, "coast"/"beach"/"cliff" textures. Extend `scripts/fetch-environment.mjs` to pull them through the Poly Haven API as it does the HDRIs. |
| **Bridges** | A modular highway bridge or causeway piece, to replace the procedural deck later. | GTA V or BeamNG road and bridge prop packs. |
| **Street furniture** | Already covered (Festive Streetlights V, NYC signals). Add benches, bins and bus stops only if cheap. | gta5-mods.com Misc. |
| **Sky** | Already: Poly Haven HDRIs via `fetch-environment.mjs`. Add a night city HDRI if the night looks thin. | Poly Haven. |

Quality bar for anything added: look at it in `viewer.html` (cars) or in the game, check the fps
with `npm run bench`, and reject it if it reads as low-poly or its textures are under 1k up close.

## How to test

```sh
node scripts/make-test-world.mjs && TEST_WORLD=1 npm run smoke     # no mods needed
npm run smoke && npm run bench                                      # with the real mods
TEST_WORLD=1 PROBE_SIZE=640x360 KEYS="KeyW:9" node scripts/probe.mjs '/?traffic=0&at=0,300' '__game' 2 test-results/probe.png
```
