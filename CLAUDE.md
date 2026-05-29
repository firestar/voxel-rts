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

## Sub agents

Sub agents (via the `Agent` / `Task` tool: Explore, general-purpose,
Plan, etc.) are allowed when the user explicitly asks for them or when
the work is genuinely parallelisable across independent surfaces
(e.g. running several AI-vs-AI matches with different strategies and
collecting logs).

Default behaviour is still to do searching, reading, and editing in the
main session — sub agents fragment context, hide what actually got run,
and make it harder to verify the work. When you do use them:

- Give each sub agent a narrow, well-defined task and ask it to report
  back concrete artifacts (file paths, log excerpts, test names).
- Always re-verify their claims in the main session by reading the
  files / running the same commands before reporting "done".
- Still gate everything on the three checks in "Verifying changes"
  below, run from the main session.
