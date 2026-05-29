# AI brain

The AI brain is a Node sidecar (`ai-server.cjs`) that the browser POSTs an
enemy-side world snapshot to every `tickIntervalSeconds`. The brain returns a
list of *actions* the client validates and applies. No decision logic runs in
the browser; the sidecar can be iterated without touching the sim.

Source: `ai-server.cjs`, `src/sim/RemoteAIClient.ts` (browser side).

## Lifecycle

```
browser tick → RemoteAIClient.tick(dt)
            → POST /ai/tick { sessionId, state }
            → decideActions(state, sessionId) → { actions }
            → applyAction(a, deps) for each
```

`RemoteAIClient.tickIntervalSeconds` defaults to `1.0`; the debug page lowers it
to `0.25` (4 Hz). The brain also keeps its own per-session timers
(`attackRetargetCooldown`, per-HQ `placeCooldown` / `trainCooldown` /
`workerCooldown`) so action frequency doesn't track tick rate 1:1.

## Snapshot shape

The client publishes one snapshot per pulse. See
`RemoteAIClient.snapshot` for the source of truth; the fields the brain reads:

| Field | Shape | Used for |
|---|---|---|
| `enemyHqs` | `[{ id, team, alive, x, z }]` | Outer loop — one brain pass per HQ |
| `enemyBuildings` | `[{ id, kind, team, upgradeState, trainQueueLen, anchorHqId, x, z }]` | Per-HQ build-state filter |
| `enemyUnits` | `[{ id, kind, team, hp, x, z, armed, hasFiringTarget, pathLen }]` | Influence map + attack pass |
| `targetBuildings` | `[{ id, kind, team, alive, x, z }]` | Multi-team attack targets |
| `teamResources` | `{ [team]: { food, metals, wood, popCap } }` | Per-team budget |
| `teamPopUsed` | `{ [team]: number }` | Pop-pressure gate |
| `workers` | `[{ id, team, focus, taskKind }]` | Focus reassignment |
| `enemyUnitCount` | number | `MAX_FIELDED` ceiling |

Per-team pools matter: each AI faction spends from its own bank, so two AIs
can't drain a shared resource pool.

## Per-HQ build order

One pass per HQ per tick; **only one `place_building` action fires per HQ per
tick**, by priority:

| # | Condition | Action |
|---|---|---|
| 1 | `popPressure AND anyHoods < 2` | `place neighborhood` (jumps queue) |
| 2 | `wantMoreBarracks` | `place barracks` |
| 3 | `anyFarms < 2 AND anyBarracks > 0` | `place farm` |
| 4 | `anyHoods < 2 AND anyFarms >= 2` | `place neighborhood` |
| 5 | `anyDepots == 0 AND anyHoods >= 1` | `place vehicle_depot` |

`popPressure := teamPop >= teamPopCap - 2`.
`wantMoreBarracks := (anyBarracks==0 AND anyFarms==0) OR (anyBarracks<3 AND anyFarms>=2 AND anyHoods>=1)`.

`placeCooldown` reset to `3 s` after every successful placement.

### Nominal sequence (fresh HQ, no pop pressure)

```
barracks → farm → farm → neighborhood → vehicle_depot
       → barracks → neighborhood → barracks
```

Saturated state: 3 barracks, 2 farms, 2 hoods, 1 depot.

## Training

Three independent paths per HQ, all gated on `!trainBlocked` where
`trainBlocked := teamPop >= teamPopCap`:

| Path | Cooldown | Picks | Notes |
|---|---|---|---|
| Tank | none (per-call) | first `liveDepot` with `trainQueueLen < 2` | Cheapest force-multiplier; spent before infantry |
| Worker | `workerCooldown = 2 s` after | barracks with fewest queued | Capped at `WORKER_TARGET` workers/team |
| Infantry | `trainCooldown = TRAIN_INTERVAL_S` after | barracks with `trainQueueLen < 4` | Round-robin across `BARRACKS_PRODUCES = ['soldier','gunner','rocket_soldier','mortar_soldier']`; picks first affordable |

## Worker focus

Pulls the per-HQ team's workers and reassigns focus to match the current
shortfall:

```
totalMetals/totalWood = sum of remaining costs for farms+hoods+depot+barracks
needMetals = max(0, totalMetals - budget.metals)
needWood   = max(0, totalWood   - budget.wood)

wantFarm   = budget.food > 800 ? 1 : 2
otherWorkers = 6 - wantFarm
  // ⚠ hardcoded 6; ignores WORKER_TARGET. See "Known smells" below.

wantChop / wantMine split otherWorkers based on which deficit is bigger.
```

Reassignment pulls from `['auto', 'mine', 'chop', 'farm']` (excluding the
target focus), skipping any worker mid-`storage_drop` or `deliver` so an
in-flight load isn't wasted.

## Attack pass

Session-throttled by `attackRetargetCooldown` (reset to `ATTACK_RETARGET_S`
each cycle). Per-unit skip ladder:

1. `dead / unarmed / hasFiringTarget / pathLen > 0` → skip.
2. **Stance quota gate**: garrison size per team is
   `defensive: DEFENDER_QUOTA*2 | economic: DEFENDER_QUOTA | aggressive: min(2, DEFENDER_QUOTA)`.
   Units within `DEFENDER_RADIUS_M` of own HQ that fit under the quota count
   as defenders and only sortie if an armed enemy is inside `INTERCEPT_R = 60 m`
   of the HQ (then `route_unit` + `set_focus_fire`).
3. `stance == 'economic' AND !buildoutByTeam[team]` → skip until 2 farms + 1 hood.
4. **Wave gate** — per-team state machine; hold until `readyAttackers >=
   WAVE_SIZE`, then release until count drops below `WAVE_SIZE/2`.
5. **Escort gate** — tanks and rocket trucks hold until ≥2 non-vehicle
   infantry are within 30 m.
6. **Target selection** — HQ-first, scored by
   `1 / (1 + localThreat × 0.02) / (1 + distM × 0.003)` (influence-map +
   distance combined). Falls back to nearest HQ, then nearest any building.
7. **Stop-short** — `stopRange = APPROX_WEAPON_RANGE_M[kind] × ATTACK_STOP_FRACTION`.
   If already inside, skip.
8. Emit `route_unit` to a goal jittered ±1.5 m per unit so attackers don't
   pile on one cell, plus `set_focus_fire` on the highest-DPS enemy unit
   within 25 m.

## Stances

| Stance | Defender quota | Attacks immediately? | Wave-gated? |
|---|---|---|---|
| `aggressive` | `min(2, DEFENDER_QUOTA)` = 2 | Yes | Yes |
| `defensive` | `DEFENDER_QUOTA × 2` = 8 | Yes (more held home) | Yes |
| `economic` | `DEFENDER_QUOTA` = 4 | No — waits for buildout | Yes |

Seed stance is per-team via `AI_STANCE_<team>` env (falls back to
`AI_STANCE_DEFAULT`). When `AI_ADAPTIVE_STANCE = 1` (default) the effective
stance can override the seed:

- 3+ armed enemies within 40 m of own HQ → `defensive`.
- `!buildoutByTeam[team]` (< 2 farms or no hood yet) → `economic`.
- Otherwise → seed.

## Influence maps

256 m × 256 m grid, 4 m cells (`IM_W × IM_H = 64 × 64`). Two layers per team:

- `threat[team]` — every other team's units stamp a linear-falloff disc using
  `UNIT_DPS[kind]` as peak and `UNIT_THREAT_RADIUS_M[kind] / IM_CELL_M` as
  radius. Sampled during attack-target scoring to discount well-defended HQs.
- `value[team]` — own buildings + own units stamp onto own value layer.
  **Currently dead weight**: built every tick but no code reads it. Comment
  says "future defender pass".

Rebuilt from scratch every tick; not cached.

## Per-HQ and session state

Session (`s = ensureSession(id)`):

| Field | Purpose |
|---|---|
| `lastTickAt` | Wall-clock ms; source for per-call `dt` |
| `attackRetargetCooldown` | Throttles the global attack pass |
| `perHq` | `Map<hqId, PerHqState>` |
| `waveByTeam` | `Map<team, { releasing }>` lazily created in attack pass |

Per-HQ (`h = ensurePerHq(s, hqId)`):

| Field | Init | Purpose |
|---|---|---|
| `placeCooldown` | `0.50` | Building placement |
| `trainCooldown` | `TRAIN_INTERVAL_S` | Combat infantry |
| `pickIndex` | `0` | Round-robin into `BARRACKS_PRODUCES` |
| `workerCooldown` | *not set* (lazily `?? 0`) | Worker training |

`sessions` map never expires — disconnected games leave orphaned state.

## Actions

The brain emits five action types; `RemoteAIClient.applyAction` validates each
against the canonical sim rules:

| Type | Fields | Validation |
|---|---|---|
| `place_building` | `kind, anchorHqId?` | Cost affordability, footprint check (ring of offsets from HQ), nav rebuild |
| `queue_train` | `buildingId, unitKind` | Building enabled + `produces` includes kind |
| `route_unit` | `unitId, x, z` | Unit alive, **silently skipped if `firingTarget != null`** |
| `set_worker_focus` | `workerId, focus` | Unit is a live worker; resets current task to `idle` |
| `upgrade_building` | `buildingId, upgradeId` | Brain never emits this |
| `set_focus_fire` | `unitId, targetId` | Unit alive |

## Env knobs

| Name | Default | Controls |
|---|---|---|
| `AI_PORT` | 3030 | HTTP listen port |
| `AI_TRAIN_INTERVAL_S` | 0.50 | Seconds between combat-infantry queues per HQ |
| `AI_MAX_FIELDED` | 200 | `enemyUnitCount` ceiling |
| `AI_ATTACK_STOP_FRACTION` | 0.30 | Fraction of weapon range used as stop-short distance |
| `AI_ATTACK_RETARGET_S` | 1.75 | Seconds between attack-pass cycles |
| `AI_WORKER_TARGET` | 12 | Per-team worker count ceiling |
| `AI_DEFENDER_QUOTA` | 4 | Base home-garrison size (multiplied per stance) |
| `AI_DEFENDER_RADIUS_M` | 30 | Distance from own HQ that counts as "home" |
| `AI_STANCE_DEFAULT` | `aggressive` | Fallback stance |
| `AI_STANCE_<team>` | *(none)* | Per-team override; `AI_STANCE_enemy`, `AI_STANCE_enemy2`, `AI_STANCE_player` |
| `AI_ADAPTIVE_STANCE` | 1 | When 0, the adaptive override is disabled |
| `AI_WAVE_SIZE` | 5 | Minimum ready attackers before a wave releases |
| `AI_AUTO_REBUILD` | 1 | **Read but never used.** No-op. |
| `AI_DIRECT_URL` | *(none)* | When set, bridge polls `/game/state` every 1 s and POSTs commands |

The startup line on stderr prints the live values:

```
[ai-server] params train=0.5 attack=0.3 retarget=1.75 workers=12 defenders=4 stance=aggressive
```

## Engine bridge (`AI_DIRECT_URL`)

When `AI_DIRECT_URL=http://localhost:3050` is set, the brain runs without a
browser: `setInterval(bridgeTick, 1000)` polls `/game/state`, converts the
snapshot with `snapshotToEnemyState` (limited to a single owner), runs
`decideActions`, and POSTs the result back as `/game/input` commands.

Caveats:

- `snapshotToEnemyState` does **not** populate `teamResources`, `teamPopUsed`,
  or `workers`, so worker focus and pop-pressure logic silently no-op when
  driving via the bridge.
- Only `route_unit`, `queue_train`, and `place_building` translate. Worker
  focus and focus-fire are dropped on the floor.

## Known smells

These are documented in case you trip over them. Not all are bugs.

1. **`AUTO_REBUILD` is a no-op.** Constant is declared but no code path
   references it. The build order does implicitly rebuild lost farms / hoods
   because the count check re-fires when they drop out of `anyFarms` /
   `anyHoods`, but the env flag itself has no effect.
2. **`liveFarms` / `liveDepots` filters with `void` at the end** —
   `liveFarms` is never read; `liveDepots` is. The `void liveFarms` line is a
   "yes I know it's unused" silencer.
3. **`otherWorkers = 6 - wantFarm`** hardcodes 6 workers; ignores
   `AI_WORKER_TARGET` (default 12). Teams with more workers undercount their
   reassignment targets.
4. **`h.workerCooldown` not initialised** in `ensurePerHq`. Read as
   `h.workerCooldown ?? 0`. Clean up by adding it to the initialiser.
5. **`trainBlocked` is redundant**. `popPressure && teamPop >= teamPopCap`
   is equivalent to the inner clause; simplify to just `teamPop >= teamPopCap`.
6. **Value influence layer is never read.** Computed every tick.
7. **`set_focus_fire` is bound to `route_unit`.** A unit that already has
   `firingTarget` set is skipped by the route pass before focus-fire fires, so
   the focus-fire pick is paired with — and only happens alongside — a fresh
   route.
8. **`upgrade_building` is never emitted.** Comment mentions
   `expand_neighborhood` as a strategy but the action is unwritten.
9. **`console.log('[ai-attack] enemyUnits=...')`** fires every 1.75 s with no
   filter and floods stdout on long runs.
