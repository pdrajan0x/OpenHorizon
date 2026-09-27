#!/usr/bin/env bash
# One-command setup: toolchain, converter, every mod in assets/mods.json, the skies, and every car and
# city converted into public/mods/. Safe to re-run: each step skips work that's already done
# (FORCE=1 re-converts cars and maps). Mods are for local play only and are never committed.
#
#   bash scripts/setup.sh            # everything
#   STEPS="maps" bash scripts/setup.sh   # only some steps: tools deps mods env cars audio props maps upscale index
#   STEPS="maps" MAPS="miami monaco-gp" FORCE=1 bash scripts/setup.sh   # re-convert only these cities
set -euo pipefail
cd "$(dirname "$0")/.."
STEPS="${STEPS:-tools deps mods env cars audio props maps upscale index}"
has() { [[ " $STEPS " == *" $1 "* ]]; }
C="${C:-dotnet tools/gta5conv/bin/Release/net10.0/gta5conv.dll}" # C=... to use another build
# Packs that ship models the city maps place but lack (vanilla names); earlier ones win where two overlap
PROPS=(--props .mods/props-traffic-nyc --props .mods/props-lights-festive --props .mods/props-trees-cherry
  --props .mods/veg-oldgen-palms --props .mods/veg-vanilla-overhaul --props .mods/road-real-california)

# 1. System packages: Node, the .NET 10 SDK, bsdtar, ffmpeg, ImageMagick; then the converter and Real-ESRGAN
if has tools; then
  need=()
  command -v dotnet >/dev/null || need+=(dotnet)
  command -v bsdtar >/dev/null || need+=(bsdtar)
  command -v ffmpeg >/dev/null || need+=(ffmpeg)
  command -v node >/dev/null || need+=(node)
  command -v magick >/dev/null || command -v convert >/dev/null || need+=(imagemagick)
  if ((${#need[@]})); then
    echo "installing: ${need[*]}"
    if command -v apt-get >/dev/null; then
      sudo apt-get install -y dotnet-sdk-10.0 libarchive-tools ffmpeg nodejs npm imagemagick
    elif command -v pacman >/dev/null; then
      sudo pacman -S --needed --noconfirm dotnet-sdk libarchive ffmpeg nodejs npm imagemagick
    else
      echo "install Node, the .NET 10 SDK, bsdtar, ffmpeg and ImageMagick, then re-run" >&2; exit 1
    fi
  fi
  [[ -d tools/vendor/CodeWalker ]] || git clone --depth 1 https://github.com/dexyfex/CodeWalker.git tools/vendor/CodeWalker
  (cd tools/gta5conv && dotnet build -c Release -v q -nologo)
  if [[ ! -x tools/vendor/realesrgan/realesrgan-ncnn-vulkan ]]; then
    mkdir -p tools/vendor/realesrgan
    curl -fL -o tools/vendor/realesrgan.zip https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesrgan-ncnn-vulkan-20220424-ubuntu.zip
    bsdtar -xf tools/vendor/realesrgan.zip -C tools/vendor/realesrgan && rm tools/vendor/realesrgan.zip
    chmod +x tools/vendor/realesrgan/realesrgan-ncnn-vulkan
  fi
fi

has deps && npm ci
has mods && node scripts/fetch-mods.mjs
has env && node scripts/fetch-environment.mjs

# Unpack every .rpf archive a mod ships (inside its extracted x/) into <mod>/rpf/, where the converter
# finds the loose GTA files
unpack() {
  local dir=$1
  [[ -d $dir/rpf ]] && return
  find "$dir/x" -iname '*.rpf' -not -path '*/rpf/*' -print0 | while IFS= read -r -d '' f; do
    $C rpf "$f" "$dir/rpf/$(basename "$f" .rpf)-$(echo "$f" | md5sum | cut -c1-6)" >/dev/null || echo "  ! $f"
  done
}

# 2. Cars: hero and traffic mods → glTF, then optimised (hero + LOD)
if has cars; then
  node scripts/convert-cars.mjs
  node scripts/optimize-models.mjs
fi

# 3. Sounds: engines (granular GTA engines), tire skid, crash recordings
if has audio; then
  RS=".mods/audio-real-sounds/x"
  engine() { [[ -d public/mods/audio/$1 && -z ${FORCE:-} ]] || $C audio "$2" "public/mods/audio/$1" --id "$1" --kind engine --title "$3"; }
  engine lambo-v12 "$RS/Aventador Real Sound Mod 1.0 by PeaceOne.rar.x/Aventador Real Sound Mod 1.0 by PeaceOne" "Lamborghini V12"
  engine ferrari-v12 "$RS/Laferrari Real Sound Mod by PeaceOne.rar.x/Laferrari Real Sound Mod by PeaceOne" "Ferrari V12"
  engine ferrari-v8 "$RS/(New 2.0) 488 GTB Real Sound Mod.rar.x/488 GTB Real Sound Mod" "Ferrari V8"
  engine hyper-v8 "$RS/Mclaren P1 Sound Mod by PeaceOne.rar.x/Mclaren P1 Sound Mod by PeaceOne" "Hypercar V8"
  mkdir -p public/mods/audio/skid public/mods/audio/crash
  ffmpeg -loglevel error -y -i ".mods/audio-tire-skid/x/Realistic Tire Skids SOUND MOD/MAIN_TARMAC_SKID_A.wav" -c:a libopus public/mods/audio/skid/tarmac.ogg
  cp .mods/audio-crash-better/x/art/sound/crash.ogg public/mods/audio/crash/crash-1.ogg
  cp .mods/audio-crash-alpha/x/art/sound/crash.ogg public/mods/audio/crash/crash-2.ogg
  for i in 01 02 03 05 06 07; do cp .mods/audio-crash-better/x/art/sound/glass_shatter_$i.ogg public/mods/audio/crash/glass-$i.ogg; done
  cp .mods/audio-crash-alpha/x/art/sound/glass_shatter_01.ogg public/mods/audio/crash/glass-alpha.ogg
fi

# 4. Street props and trees the map mods place but don't ship
if has props; then
  for d in .mods/props-*/; do [[ -d $d/x ]] && unpack "${d%/}"; done
fi

# 5. Cities: every map in assets/maps.json, with its own flags (found with `gta5conv map <dir> --inspect`).
#    --clip gives a square map an organic coastline; the shapes in assets/coast-shapes/ come from
#    scripts/shape-coast.mjs, run once on the unclipped conversion
if has maps; then
  while IFS=$'\t' read -r id mod args; do
    [[ -n ${MAPS:-} && " $MAPS " != *" $id "* ]] && continue
    [[ -d .mods/$mod ]] || { echo "- $id: .mods/$mod missing"; continue; }
    [[ -f public/mods/maps/$id/manifest.json && -z ${FORCE:-} ]] && { echo "= $id"; continue; }
    unpack ".mods/$mod"
    echo "> $id"
    tmp="public/mods/maps/.$id.tmp"
    rm -rf "$tmp"
    # shellcheck disable=SC2086
    eval "$C map .mods/$mod $tmp $args --all-col ${PROPS[*]}" | tail -2
    rm -rf "public/mods/maps/$id" && mv "$tmp" "public/mods/maps/$id"
  done < <(node -e 'for (const m of require("./assets/maps.json")) console.log([m.id, m.mod, m.args.map((a) => `'"'"'${a}'"'"'`).join(" ")].join("\t"))')
fi

# 6. The cities' small textures remastered (Real-ESRGAN on the GPU, a few minutes a city): sharp facades up close
if has upscale; then
  # shellcheck disable=SC2046
  node scripts/upscale-textures.mjs $(node -e 'for (const m of require("./assets/maps.json")) if (!process.env.MAPS || ` ${process.env.MAPS} `.includes(` ${m.id} `)) console.log(m.id)')
fi

# Island outlines and height maps (src/islands.ts lays the cities out and plans the bridges with them), then the index
has index && node scripts/island-stats.mjs && node scripts/map-index.mjs
echo "setup done: npm run play"
