#!/usr/bin/env bash
# Every city's low-res colour textures (64–512 px; normal and spec maps are left as they are) upscaled at once, using the whole machine: the cities run side by side (their
# decoding, DXT compression and mip building spread over the CPU cores while Real-ESRGAN keeps the GPU busy),
# and Chicago is first downloaded and converted again (its layered terrain textures) before it joins in.
# Progress: tail -f the log this writes (LOG, default /tmp/upscale-everything.log). Re-running skips what's done.
cd "$(dirname "$0")/.."
LOG=${LOG:-/tmp/upscale-everything.log}
C="dotnet tools/gta5conv/bin/Release/net10.0/gta5conv.dll"
export ESRGAN_THREADS=${ESRGAN_THREADS:-4:4:4}
up() { local s=$(date +%s); node scripts/upscale-textures.mjs "$1" 2>&1 | tail -1 | sed "s/^/[$1] /"; echo "[$1] took $(( $(date +%s) - s )) s"; }
chicago() {
  local d=.mods/map-windy-city-chicago T=public/mods/maps/.chicago.tmp O=public/mods/maps/chicago
  node scripts/fetch-mods.mjs map-windy-city-chicago 2>&1 | grep -E "^v |^x |rror" | sed 's/^/[chicago] /'
  [ -d $d/rpf ] || find $d/x -iname '*.rpf' -not -path '*/rpf/*' -print0 | while IFS= read -r -d '' f; do $C rpf "$f" "$d/rpf/$(basename "$f" .rpf)-$(echo "$f" | md5sum | cut -c1-6)" >/dev/null 2>&1; done
  rm -rf $T
  $C map $d $T --cell 250 --road-tex '^(chi_inf_01_d|chi_bas_01_d|chi_bas_05_d|chi_bas_07_d|chi_bas_11_d|chi_inf_04_d)$' --all-col \
    --props .mods/props-traffic-nyc --props .mods/props-lights-festive --props .mods/props-trees-cherry \
    --props .mods/veg-oldgen-palms --props .mods/veg-vanilla-overhaul --props .mods/road-real-california 2>&1 | tail -1 | sed 's/^/[chicago] /'
  local n; n=$(ls $T/cells 2>/dev/null | wc -l)
  [ "$n" -gt 400 ] || { echo "[chicago] only $n cells converted: not swapped"; return; }
  rm -rf $O/cells $O/col $O/tex $O/upscaled.json; mv $T/cells $T/col $T/tex $O/; cp $T/manifest.json $T/missing.json $T/props.json $O/; rm -rf $T
  echo "[chicago] converted and swapped in ($n cells)"
  up chicago
}
{
  echo "started $(date)"
  # Every city in the world side by side (each skips what it has done), Chicago after its rebuild
  for id in $(node -e "console.log(require('./public/mods/maps/index.json').map((m) => m.id).filter((i) => i !== 'chicago').join(' '))"); do up "$id" & done
  chicago &
  wait
  echo "ALL DONE $(date)"
} > "$LOG" 2>&1
