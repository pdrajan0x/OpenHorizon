# Open Horizon: notes for Claude

- Work in progress and the owner's open request list: **read `docs/HANDOFF.md` first**. It has the
  diagnoses, the designs not yet written, and the mods still wanted.
- Mod assets live in `.mods/` and `public/mods/` (gitignored) and must never be committed: the repo is public.
- No mods downloaded? `node scripts/make-test-world.mjs` then `TEST_WORLD=1 npm run dev|smoke`.
- Checks: `npm run typecheck`, `npm run smoke`, `npm run bench` (GTX 1650 target: 60 fps at 1080p).
- Owner's standing rules: don't model 3D assets ourselves, source high-quality ones from game mod sites
  (any game); aim for an AAA look.
