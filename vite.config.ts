import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { defineConfig, type Plugin } from 'vite';

// TEST_WORLD=1 serves the synthetic stand-in assets from scripts/make-test-world.mjs instead of public/.
// LINK_MODS=1 (scripts/play.sh --build) leaves public/ out of the build: the mods are gigabytes, so the
// build links to them instead of copying them.
const publicDir = process.env.TEST_WORLD ? '.build/test-public' : 'public';

/**
 * The in-game fix mode (src/editor.ts) saves a city's fixes: POST /__edits/<city> with the list writes
 * <public>/mods/maps/<city>/edits.json. Only on the local dev and play servers; only a city that exists, and
 * only a list of edits.
 */
function mapEdits(): Plugin {
  const handler = (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const m = /^\/__edits\/([a-z0-9-]+)$/.exec(req.url ?? '');
    if (!m || req.method !== 'POST') return next();
    const dir = path.join(publicDir, 'mods', 'maps', m[1]);
    let body = '';
    req.on('data', (chunk) => { body += chunk; if (body.length > 20e6) req.destroy(); });
    req.on('end', () => {
      try {
        const list = JSON.parse(body);
        const ok = Array.isArray(list) && list.every((e) => ['delete', 'passable', 'solid'].includes(e?.op)
          && Number.isInteger(e.cell) && typeof e.mesh === 'string' && Array.isArray(e.box) && e.box.length === 6 && e.box.every(Number.isFinite));
        if (!ok || !fs.existsSync(path.join(dir, 'manifest.json'))) throw new Error('not a list of edits for a map');
        fs.writeFileSync(path.join(dir, 'edits.json'), JSON.stringify(list, null, 1));
        res.statusCode = 200;
        res.end('saved');
      } catch (e) {
        res.statusCode = 400;
        res.end(String(e));
      }
    });
  };
  return {
    name: 'map-edits',
    configureServer: (server) => { server.middlewares.use(handler); },
    configurePreviewServer: (server) => { server.middlewares.use(handler); },
  };
}

export default defineConfig({
  publicDir,
  build: { copyPublicDir: !process.env.LINK_MODS },
  plugins: [mapEdits()],
});
