import { defineConfig } from 'vite';

// TEST_WORLD=1 serves the synthetic stand-in assets from scripts/make-test-world.mjs instead of public/
export default defineConfig({
  publicDir: process.env.TEST_WORLD ? '.build/test-public' : 'public',
});
