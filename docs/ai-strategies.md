# AI strategies

The brain has one hardcoded build order (`ai-server.cjs`) tuned through a long
sequence of `auto-fix.cjs` patches. The env-knob surface is wide enough that
much of the strategy space is reachable by tuning rather than re-coding, so
"add a new strategy" usually means picking a different point in that knob
space — and, when needed, gating new conditionals on `AI_STANCE_<team>` or a
new `AI_STRATEGY_<team>` env.

Source: `ai-server.cjs`. Brain reference: [ai-brain.md](ai-brain.md).
Operating manual: [ai-vs-ai-harness.md](ai-vs-ai-harness.md).

## Tunable surface

These knobs already exist and don't need a code change:

| Knob | Default | Effect |
|---|---|---|
| `AI_TRAIN_INTERVAL_S` | 0.50 | Slower training → fewer infantry per minute |
| `AI_ATTACK_STOP_FRACTION` | 0.30 | Higher = attackers hold further from targets |
| `AI_ATTACK_RETARGET_S` | 1.75 | How often the attack pass runs |
| `AI_WORKER_TARGET` | 12 | Worker cap per team |
| `AI_DEFENDER_QUOTA` | 4 | Base home-garrison count |
| `AI_DEFENDER_RADIUS_M` | 30 | Garrison perimeter |
| `AI_WAVE_SIZE` | 5 | Minimum attackers before a wave releases |
| `AI_STANCE_DEFAULT` | `aggressive` | Fallback stance |
| `AI_STANCE_<team>` | *(seed)* | Per-team override |
| `AI_ADAPTIVE_STANCE` | 1 | Toggle the in-game stance flip |

## Existing stances

| Stance | Garrison | First attack | Notes |
|---|---|---|---|
| `aggressive` | `min(2, DEFENDER_QUOTA)` | as soon as wave ≥ `WAVE_SIZE` | Default |
| `defensive` | `DEFENDER_QUOTA × 2` | as soon as wave ≥ `WAVE_SIZE` | Holds more units home |
| `economic` | `DEFENDER_QUOTA` | delayed until 2 farms + 1 hood | Skips all routing until buildout |

Adaptive override (when `AI_ADAPTIVE_STANCE = 1`):

- 3+ armed enemies within 40 m of own HQ → `defensive`.
- Team has < 2 farms or no hood → `economic`.
- Otherwise → seed.

## Design space for new strategies

The four points below are *not* implemented yet — they're the parameter sets
we'd pick if we wanted distinct AI personalities. Each is reachable by env
without a code change unless noted.

### `turtle`

Heavy economy, late attack, holds the front at long range.

```
AI_STANCE_<team>=economic
AI_DEFENDER_QUOTA=8
AI_DEFENDER_RADIUS_M=40
AI_WAVE_SIZE=10
AI_ATTACK_STOP_FRACTION=0.55
AI_TRAIN_INTERVAL_S=0.40
AI_WORKER_TARGET=16
```

Caveat: doesn't change the build order itself. The hardcoded sequence still
caps at 2 hoods + 2 farms + 3 barracks + 1 depot. Reaching `wantFarm = 3` or
`anyHoods < 3` requires a code change in the build-order chain.

### `tank_rush`

Skip extra hoods, race to depot, queue tanks only.

Reachable via env: lower `AI_TRAIN_INTERVAL_S` so the depot's `tank` queue
fires faster. **Not reachable via env**: skipping infantry entirely in favour
of tanks (the infantry pass runs unconditionally if a barracks exists).
Requires a new branch in `decideActions` gated on a new `AI_STRATEGY_<team>`
env.

```
AI_STANCE_<team>=aggressive
AI_ATTACK_STOP_FRACTION=0.20
AI_WAVE_SIZE=2
AI_TRAIN_INTERVAL_S=0.30
AI_WORKER_TARGET=14
# Plus: AI_STRATEGY_<team>=tank_rush gate in ai-server.cjs.
```

### `infantry_swarm`

Three barracks early, no depot, mass cheap infantry.

Not reachable purely via env — the build-order chain places a depot before a
third barracks. Needs an `AI_STRATEGY_<team>=infantry_swarm` branch that
either suppresses the depot priority or bumps `anyBarracks < 5` before the
depot check.

```
AI_STANCE_<team>=aggressive
AI_WAVE_SIZE=8
AI_TRAIN_INTERVAL_S=0.30
AI_ATTACK_STOP_FRACTION=0.20
# Plus: AI_STRATEGY_<team>=infantry_swarm gate in ai-server.cjs.
```

### `expand`

Maximise pop cap before any combat — 3 hoods, 3 farms, then attack.

Same shape: a code branch that raises the cap on `anyHoods < 3` and `anyFarms
< 3` for this strategy, paired with `economic` stance until the third hood
lands.

```
AI_STANCE_<team>=economic
AI_WORKER_TARGET=18
AI_TRAIN_INTERVAL_S=0.40
# Plus: AI_STRATEGY_<team>=expand gate in ai-server.cjs.
```

## Adding a strategy

When env tuning isn't enough — typically when the build order itself needs to
change — wire a new `AI_STRATEGY_<team>` env:

1. Add `const STRATEGY_DEFAULT = env.AI_STRATEGY_DEFAULT || 'balanced'`; and
   `function strategyForTeam(team) { return env['AI_STRATEGY_' + team] || STRATEGY_DEFAULT; }`.
2. Hoist the build-order targets into a per-strategy table:
   `{ balanced: { hoods: 2, farms: 2, barracks: 3, depot: 1 }, turtle: ..., ... }`.
3. Replace the hardcoded `< 2` / `< 3` counts in the priority chain with the
   lookup.
4. For attack-pass overrides (e.g. tank-only) gate the infantry training block
   on `strategy !== 'tank_rush'`.
5. Add scenarios in `tests/aiBuildOrders.spec.ts` that pin the new strategy's
   sequence (e.g. "turtle places 3 hoods before any combat unit").
6. Set the env on the run that exercises it. The startup log echoes the
   effective values so the dump shows which strategy played.

Keep the table small — every variant doubles the AI-vs-AI matrix the harness
has to cover.

## Per-match wiring

For a single match against the dev stack, set the env on the **ai-server**
process (it's the only sidecar that reads `AI_*`):

```powershell
$env:AI_STANCE_enemy   = "aggressive"
$env:AI_STANCE_enemy2  = "economic"
$env:AI_WAVE_SIZE      = "8"
$env:AI_TRAIN_INTERVAL_S = "0.35"
node ai-server.cjs
```

The startup line on stderr confirms what was picked up:

```
[ai-server] params train=0.35 attack=0.3 retarget=1.75 workers=12 defenders=4 stance=aggressive
```

(`stance` here is `AI_STANCE_DEFAULT`. Per-team overrides only show up in the
attack-pass console output once the match starts.)
