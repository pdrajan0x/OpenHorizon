// Screenshot a dev page on the NVIDIA GPU: node scripts/shot.mjs '<path?query>' out.png
import { launch } from './browser.mjs';
import { createServer } from 'vite';

const [path, out] = process.argv.slice(2);
const server = await createServer({ logLevel: 'error', server: { port: 5310 } });
await server.listen();
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log('PAGEERROR', String(e)));
page.on('console', (m) => m.type() === 'error' && console.log('CONSOLE', m.text()));
try {
  await page.goto(server.resolvedUrls.local[0] + path.replace(/^\//, ''));
  await page.waitForFunction(() => window.__ready || (window.__game?.simTime ?? 0) > 3, null, { timeout: 180_000 });
  const info = await page.evaluate(() => window.__info);
  if (info) console.log(JSON.stringify(info));
  await page.screenshot({ path: out });
} finally {
  await browser.close();
  await server.close();
}
