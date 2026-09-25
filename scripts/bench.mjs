// GPU benchmark: runs the game headless at 1080p on the NVIDIA GPU (PRIME offload), drives laps of
// throttle + drift inputs, and reports frame times. Uncapped by default, so the numbers show headroom above 60 fps.
// Usage: npm run bench   (BENCH_SECONDS=20 to run longer, BENCH_VSYNC=1 to cap at the display rate)
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

const SECONDS = Number(process.env.BENCH_SECONDS ?? 15);
const VSYNC = process.env.BENCH_VSYNC === '1';
const PRIME_ENV = {
  __NV_PRIME_RENDER_OFFLOAD: '1',
  __VK_LAYER_NV_optimus: 'NVIDIA_only',
  __GLX_VENDOR_LIBRARY_NAME: 'nvidia',
  __EGL_VENDOR_LIBRARY_FILENAMES: '/usr/share/glvnd/egl_vendor.d/10_nvidia.json',
};

const server = await createServer({ logLevel: 'error', server: { port: 5197 } });
await server.listen();
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium',
  args: ['--use-angle=gl-egl', '--ignore-gpu-blocklist', ...(VSYNC ? [] : ['--disable-frame-rate-limit', '--disable-gpu-vsync'])],
  env: { ...process.env, ...PRIME_ENV },
});
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });

try {
  await page.goto(server.resolvedUrls.local[0]);
  await page.waitForFunction(() => (window.__game?.simTime ?? 0) > 1, null, { timeout: 60_000 });
  const gpu = await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2');
    const ext = gl?.getExtension('WEBGL_debug_renderer_info');
    return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unknown';
  });

  // Drive: throttle throughout, periodic handbrake drifts left and right
  const driving = (async () => {
    await page.keyboard.down('KeyW');
    for (let t = 0; t < SECONDS; t += 3) {
      await page.waitForTimeout(1500);
      const dir = (t / 3) % 2 ? 'KeyA' : 'KeyD';
      await page.keyboard.down(dir);
      await page.keyboard.down('Space');
      await page.waitForTimeout(400);
      await page.keyboard.up('Space');
      await page.waitForTimeout(1100);
      await page.keyboard.up(dir);
      if ((t / 3) % 3 === 2) await page.keyboard.press('KeyR');
    }
    await page.keyboard.up('KeyW');
  })();

  const frames = await page.evaluate((seconds) => new Promise((resolve) => {
    const times = [];
    let last = performance.now();
    const end = last + seconds * 1000;
    const tick = (now) => {
      times.push(now - last);
      last = now;
      if (now < end) requestAnimationFrame(tick);
      else resolve(times);
    };
    requestAnimationFrame(tick);
  }), SECONDS);
  await driving;

  frames.sort((a, b) => a - b);
  const pct = (p) => frames[Math.min(frames.length - 1, Math.floor(frames.length * p))];
  const avg = frames.reduce((s, x) => s + x, 0) / frames.length;
  console.log(`GPU:        ${gpu}`);
  console.log(`Resolution: 1920x1080, ${frames.length} frames over ${SECONDS}s`);
  console.log(`Average:    ${(1000 / avg).toFixed(0)} fps (${avg.toFixed(2)} ms)`);
  if (VSYNC) console.log(`Over 20 ms: ${frames.filter((f) => f > 20).length} frames`);
  console.log(`p95 frame:  ${pct(0.95).toFixed(2)} ms   p99: ${pct(0.99).toFixed(2)} ms   worst: ${frames.at(-1).toFixed(2)} ms`);
} finally {
  await browser.close();
  await server.close();
}
