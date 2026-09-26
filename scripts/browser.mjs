// The Chromium the test scripts drive: $CHROMIUM, the system one, or Playwright's bundled build (cloud
// sessions and CI boxes). On a laptop with an NVIDIA GPU it renders there (PRIME offload); elsewhere
// Chromium falls back to software WebGL, which is slow but draws the same frames.
import { existsSync, readdirSync } from 'node:fs';
import { chromium } from 'playwright-core';

export function chromiumPath() {
  if (process.env.CHROMIUM) return process.env.CHROMIUM;
  if (existsSync('/usr/bin/chromium')) return '/usr/bin/chromium';
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/opt/pw-browsers';
  for (const dir of existsSync(root) ? readdirSync(root).filter((d) => d.startsWith('chromium-')).sort().reverse() : []) {
    const exe = `${root}/${dir}/chrome-linux/chrome`;
    if (existsSync(exe)) return exe;
  }
  return undefined; // playwright-core's own lookup
}

export const PRIME_ENV = {
  __NV_PRIME_RENDER_OFFLOAD: '1',
  __VK_LAYER_NV_optimus: 'NVIDIA_only',
  __GLX_VENDOR_LIBRARY_NAME: 'nvidia',
};

export function launch(extraArgs = [], env = {}) {
  return chromium.launch({
    executablePath: chromiumPath(),
    args: ['--use-angle=gl-egl', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', ...extraArgs],
    env: { ...process.env, __NV_PRIME_RENDER_OFFLOAD: '1', ...env },
  });
}
