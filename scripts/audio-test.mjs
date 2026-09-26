// Renders a few seconds of the mod engine sweeping from idle to redline and back into
// test-results/engine-sweep.wav (offline, so it's exact), and checks the grains decode.
// Usage: node scripts/audio-test.mjs [set]
import { writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

const set = process.argv[2] ?? 'ferrari';
const server = await createServer({ logLevel: 'error', server: { port: 5312 } });
await server.listen();
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR', String(e)));
try {
  await page.goto(server.resolvedUrls.local[0] + 'viewer.html');
  const result = await page.evaluate(async (set) => {
    const { GranularEngine } = await import('/src/engineAudio.ts');
    const seconds = 8;
    const ctx = new OfflineAudioContext(1, 48000 * seconds, 48000);
    const engine = await GranularEngine.load(ctx, ctx.destination, set);
    if (!engine) return { error: 'no engine' };
    // Drive the scheduler in small steps of offline time: rev up for 5 s on throttle, then lift off
    const steps = [];
    for (let t = 0; t < seconds - 0.1; t += 0.05) steps.push(t);
    for (const t of steps) {
      ctx.suspend(t).then(() => {
        const revs = t < 5 ? t / 5 : Math.max(0.1, 1 - (t - 5) / 2);
        engine.update(revs, t < 5 ? 1 : 0);
        ctx.resume();
      });
    }
    const out = await ctx.startRendering();
    const data = out.getChannelData(0);
    let peak = 0;
    for (const v of data) peak = Math.max(peak, Math.abs(v));
    return { peak, samples: Array.from(data) };
  }, set);
  if (result.error) throw new Error(result.error);
  // 16-bit mono WAV
  const n = result.samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(48000, 24);
  buf.writeUInt32LE(96000, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  const scale = result.peak > 0 ? 0.9 / result.peak : 1;
  result.samples.forEach((v, i) => buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v * scale)) * 32767), 44 + i * 2));
  writeFileSync('test-results/engine-sweep.wav', buf);
  console.log(`${result.peak > 0.01 ? 'PASS' : 'FAIL'}  engine renders — peak ${result.peak.toFixed(3)}, ${(n / 48000).toFixed(1)} s → test-results/engine-sweep.wav`);
} finally {
  await browser.close();
  await server.close();
}
