# Project rules

## Verifying changes

Always run these three checks after any code change:

1. `npx tsc --noEmit` — types must be clean.
2. `npx vitest run` — all tests in `tests/**/*.spec.ts` must pass.
3. `npx vite build` — production build must succeed.

If a behavior isn't covered by an existing test and you want to confirm
it works headlessly, **add a test in `tests/**/*.spec.ts`**.

## Running the dev server

`npm run dev` (or `npx vite`) is allowed when visual or browser
verification is needed — e.g. checking rendering, UI, or live
pathfinding behaviour. Start it, do the verification, then stop it.
Don't leave it running unnecessarily.

## Don't use sub agents

Don't delegate work to sub agents via the `Agent` tool (Explore,
general-purpose, Plan, etc.). Do the searching, reading, and editing
directly in the main session. Sub agents fragment context, hide what
actually got run, and make it harder to verify the work — which matters
more here than the parallelism they buy.
