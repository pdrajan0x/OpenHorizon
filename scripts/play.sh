#!/usr/bin/env bash
# Start the dev server and open the game in its own Chromium window on the NVIDIA GPU.
# With --build it plays a production build instead: a stable snapshot that doesn't reload while
# source files are being edited.
# On this hybrid laptop a Wayland Chromium window always renders on the AMD iGPU (EGL follows the
# compositor), so the game window runs under XWayland with NVIDIA's GLX render offload instead.
# A separate profile forces a fresh Chromium process so these settings apply.
set -euo pipefail
cd "$(dirname "$0")/.."

PORT=5173
if [[ "${1:-}" == "--build" ]]; then
  LINK_MODS=1 npx vite build --outDir dist-play --emptyOutDir >/dev/null
  ln -sfn "$PWD/public/mods" dist-play/mods
  npx vite preview --outDir dist-play --port "$PORT" --strictPort >/dev/null &
else
  npx vite --port "$PORT" --strictPort >/dev/null &
fi
server=$!
trap 'kill "$server" 2>/dev/null' EXIT
until curl -sf "http://localhost:$PORT" >/dev/null; do sleep 0.3; done

__NV_PRIME_RENDER_OFFLOAD=1 __GLX_VENDOR_LIBRARY_NAME=nvidia \
  chromium --user-data-dir="$HOME/.cache/racing-chromium" \
  --ozone-platform=x11 --use-angle=gl --ignore-gpu-blocklist \
  --app="http://localhost:$PORT"
