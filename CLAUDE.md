# Project rules

## Never run the Vite dev server

`npx vite`, `npm run dev`, `vite preview`, anything that boots the live
browser server — **don't**. Booting it, hitting it with `curl`, then
killing it just slows the loop down without telling us anything that
isn't already covered by typecheck + tests.

To verify a change:

1. `npx tsc --noEmit` — types must be clean.
2. `npx vitest run` — all tests in `tests/**/*.spec.ts` must pass.
3. `npx vite build` — production build must succeed (this is a
   one-shot compile, not the dev server, and is fine).

If a behavior isn't covered by an existing test and you want to confirm
it works, **add a test in `tests/**/*.spec.ts`**. Pathfinding, voxel
edits, the cutter carve, unit ticks — all run headless against the
in-memory world. Don't ask the user to load the page in their browser
to confirm something we could have asserted programmatically.

The user can run the dev server themselves when they want to look at
things visually. Our job is to keep typecheck + tests + build green.

## Don't use sub agents

Don't delegate work to sub agents via the `Agent` tool (Explore,
general-purpose, Plan, etc.). Do the searching, reading, and editing
directly in the main session. Sub agents fragment context, hide what
actually got run, and make it harder to verify the work — which matters
more here than the parallelism they buy.
