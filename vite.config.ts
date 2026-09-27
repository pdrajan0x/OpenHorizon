import { defineConfig } from 'vite';

// TEST_WORLD=1 serves the synthetic stand-in assets from scripts/make-test-world.mjs instead of public/.
// LINK_MODS=1 (scripts/play.sh --build) leaves public/ out of the build: the mods are gigabytes, so the
// build links to them instead of copying them.
export default defineConfig({
  publicDir: process.env.TEST_WORLD ? '.build/test-public' : 'public',
  build: { copyPublicDir: !process.env.LINK_MODS },
});
