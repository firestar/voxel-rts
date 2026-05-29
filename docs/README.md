# Voxel RTS — reference docs

These files are reference material for future work on the codebase. They're
written for readers (humans or AI assistants) who need to know what something
is called, what its dimensions are, and *why* it was set that way — without
having to reverse-engineer from the source.

| File | Covers |
|---|---|
| [units.md](units.md) | Unit kinds, model parts, per-kind configs, the names used in the code |
| [materials.md](materials.md) | Voxel material table, dig speed, tread damage |
| [world.md](world.md) | World dimensions, chunks, voxel size, coordinates |
| [pathfinding.md](pathfinding.md) | Surface nav, volume nav, A*, smoother, headroom |
| [rendering.md](rendering.md) | Renderer, mesher, instanced unit rendering, animation |
| [ai-brain.md](ai-brain.md) | `ai-server.cjs` decision logic — build order, training, attack pass, stances, influence maps |
| [ai-vs-ai-harness.md](ai-vs-ai-harness.md) | Running `auto-game.cjs`, the score table, exit codes, failure-mode triage |
| [ai-strategies.md](ai-strategies.md) | Env knob reference and design space for build-order strategies |
| [decisions.md](decisions.md) | Design decisions and the reasons behind them |
| [glossary.md](glossary.md) | Short definitions of terms used throughout the code |

If a doc gets out of sync with reality, fix it — these are the source of
truth for *why* values are what they are. The values themselves live in
the source.
