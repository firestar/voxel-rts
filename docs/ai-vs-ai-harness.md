# AI vs AI harness

How to run a single AI-vs-AI match against the dev stack, what the scoring
means, and how to triage a failure. The rules the harness enforces live in
[../GAME_RULES.md](../GAME_RULES.md); this file is the operating manual.

## Components

```
                ┌─────────────────┐
                │  auto-game.cjs  │  puppeteer driver
                │  (Node)         │  scores + samples + dump
                └────────┬────────┘
                         │ navigates to PROBE_URL
                         ▼
┌────────────────┐   ┌─────────────┐   ┌──────────────────┐
│  vite dev      │ ↔ │  ai-server  │ ↔ │ session-server   │
│  :5173         │   │  :3030      │   │  :3040           │
│  (or nginx     │   └─────────────┘   └──────────────────┘
│   :8080 in     │             │
│   container)   │             ▼
│                │   ┌─────────────────┐
│                │ ↔ │  game-server    │
│                │   │  :3050          │
└────────────────┘   └─────────────────┘
```

Vite's dev proxy (`vite.config.ts`) forwards `/ai`, `/lobby`, `/game`, and
`/world` to the matching sidecar. In the docker container nginx does the same
routing fronted by `:8080`.

## Starting the stack

Dev mode (recommended for iterating):

```powershell
node ai-server.cjs           # :3030
node session-server.cjs      # :3040
node game-server.cjs         # :3050
npm run dev                  # vite on :5173
```

Health-check each sidecar before running a match:

```powershell
Invoke-WebRequest http://localhost:3030/health
Invoke-WebRequest http://localhost:3040/health
Invoke-WebRequest http://localhost:3050/health
```

Container mode (matches production):

```powershell
docker build -t voxel-rts .
docker run --rm -p 8080:8080 voxel-rts
```

## Running one match

`auto-game.cjs` spawns puppeteer-headed Chromium, walks the lobby UI, sets the
AI count, starts the game, and samples the sim every 500 ms until a winner
is decided or a failure trips.

```powershell
$env:PROBE_URL    = "http://localhost:5173"  # or :8080 for container
$env:AUTO_AI      = "2"                       # 2 = enemy + enemy2; 1..7
$env:AUTO_SECONDS = "180"                     # wall-clock ceiling
$env:AUTO_ITER    = "smoke"                   # tag for log + dump filenames
$env:AUTO_SHOT    = "tmp/auto-smoke.png"
node auto-game.cjs
```

`PROBE_URL` defaults to `http://localhost:8080`. `AUTO_AI` defaults to `2`.
`AUTO_SECONDS` defaults to `480`. `AUTO_SAMPLE_MS` defaults to `500`.

Per [`../GAME_RULES.md`](../GAME_RULES.md) **don't** chain runs via
`auto-loop.cjs` — run one iteration, observe the dump, make a code change,
then run the next one.

## Outcomes

The script logs `OUTCOME <kind>` and exits with the matching code:

| Outcome | Exit | Meaning |
|---|---|---|
| `HQ_WIN` | 0 | A team destroyed an enemy HQ (counts toward the target) |
| `HARNESS` | 1 | Puppeteer / lobby / page-load error |
| `FAILURE_NO_COMBAT` | 2 | No combat unit fielded within 120 s |
| `FAILURE_STUCK` | 3 | Combat unit / worker / truck failed its stuck budget |
| `FAILURE_TRUCK` | 4 | Supply truck stalled in a `truck_*` task > 60 s or < 5 voxels in 3 s |
| `FAILURE_RUBBERBAND` | 5 | Single-sample displacement > 16 m/s (after 5 s warmup) |
| `TIMEOUT` | 6 | Wall-clock ceiling without an HQ destroyed |
| `FAILURE_TELEPORT` | 7 | Per-tick jump > 4 voxels caught by `UnitManager.lastTeleport` |
| `FAILURE_NEGATIVE_SCORE` | 8 | Score dropped below 0 |
| `FAILURE_IDLE_COMBAT` | 9 | Combat unit ≤ 5 m from an enemy not firing for > 3 s |
| `FAILURE_CIVILIAN_OVERFLOW` | 10 | Civilians > sum of `tier×5` over alive enabled neighborhoods |
| `FAILURE_NONCOMBAT_INVULN` | 11 | Civilian/worker under fire for > 5 s with no HP loss |

Each `FAILURE_*` is fully detailed in `GAME_RULES.md`.

## Score table

Match starts at `+10 000`. Every event mutates the running score; the harness
samples deltas every 500 ms.

| Event | Δ | Notes |
|---|---|---|
| Create soldier / gunner / sniper / mortar | +2 | Per spawn |
| Create rocket_soldier | +2 | |
| Create tank | +1000 | One-time |
| Create rocket_truck | +2000 | One-time |
| Create AA vehicle | +5000 | |
| Kill soldier | +5 | |
| Kill tank | +90 | |
| Kill rocket (soldier or truck) | +40 | |
| Die soldier | −20 | |
| Die tank | −50 | |
| Die rocket | −10 | |
| Hit landed on enemy unit / building | +5 | Per-sample HP delta on a non-`player` target |
| AA-intercepted projectile | +1000 | |
| HQ destroyed (winner) | +5 999 999 999 999 | One-shot |
| No-unit second after 90 s grace | −10/s | |
| No-military second after 90 s grace | −10/s | Stacks with no-unit |
| Score below 0 | match ends, `FAILURE_NEGATIVE_SCORE` | |

The 90 s grace covers the unavoidable opening (place barracks → 2 farms → 40 s
construction → first farm cycle → first units leaving barracks → first wave
walking across the map). The original `−50/s` drained ~9 k over a normal
opening; `−10/s` still flags genuinely idle AIs without making the rule the
dominant score sink.

## Diagnostic dump

Every run writes `/tmp/auto-dump-{AUTO_ITER}.json` containing the full sim
state at the moment of termination:

```ts
{
  outcome: <stuckFail object> | null,
  score: number,
  units: [{ id, kind, team, hp, x, z, path:[{x,z}], task, focus, heading,
            firingTarget, claimedClusterId }],
  buildings: [{ id, kind, team, ox, oz, cellsW, cellsD, hp, maxHp,
                stockpile, trainQueueLen,
                cropProgress, cropReady, harvestMilestone,
                suppliedUnits, inboundResupplyTrucks }],
  clusters: [{ id, x, z, rxz, maxWorkers, occupied }],
  worldExtent: 384,
  scoreEvents: [...],
  playerResources / enemyResources / enemy2Resources,
  storageStockpiles,
}
```

Render it with `node auto-svg.cjs /tmp/auto-dump-{iter}.json
/tmp/auto-dump-{iter}.svg` to spot stuck clusters + disconnected nav
components visually.

## Failure-mode triage cheat sheet

| Outcome | First look |
|---|---|
| `FAILURE_NO_COMBAT` | AI build order stalled. Check `ai-server` stderr for `[ai-attack]` log; check whether barracks ever reached `enabled` in the dump. |
| `FAILURE_STUCK` | Open the SVG. Look for combat units with non-empty `path` but stationary `x/z`. Common causes: HPA* routing through a freshly-placed building; `firingTarget` blocking a route from going out; collision deadlock with a same-team peer. |
| `FAILURE_IDLE_COMBAT` | Unit close to an enemy but not firing. Weapon arm bug or target picker bug — see `src/sim/WeaponTick.ts`, `src/sim/Weapons.ts`. |
| `FAILURE_TRUCK` | Supply-truck dispatcher. `src/sim/SupplyTrucks.ts`. Often a path budget issue — `auto-fix.cjs` bumps `maxExpansions`. |
| `FAILURE_NONCOMBAT_INVULN` | Damage pipeline. Civilian under direct fire isn't taking damage. Check `src/sim/Projectiles.ts` hit detection + civilian collision mask. |
| `FAILURE_CIVILIAN_OVERFLOW` | Civilian spawner ignored its quota. `game-server.cjs` neighborhood civilian spawn loop. |
| `FAILURE_RUBBERBAND` | Server-snap reconciler jumped a unit > 16 m/s. Check the `lastTeleport` field on the unit. |
| `FAILURE_TELEPORT` | Per-tick jump > 4 voxels. Sim-side teleport recovery is forbidden — fix the pathing / collision cause instead. |
| `FAILURE_NEGATIVE_SCORE` | Dominant negative event is logged. If `no-unit-1s` / `no-military-1s`, production stalled. If `die-*`, units are dying too fast — pull `ATTACK_STOP_FRACTION` up. |
| `TIMEOUT` | Stalemate. Both AIs survived but neither reached the other HQ in time. Bump aggression (`ATTACK_STOP_FRACTION` down, more attackers per wave). |
| `HQ_WIN` | Done. The `FINAL` line records the winning team. |

## Game rules the harness enforces

These are summarised — see `GAME_RULES.md` for the canonical wording.

- Per-tick XZ displacement ≤ 1 voxel. Combined > 4 voxels = teleport, run
  fails.
- Workers walk voxel-by-voxel. No teleport / blink shortcuts.
- Wheeled vehicles can only translate along their forward axis.
- AI factions start with 200 food / 100 metals / 100 wood per base. No bank
  cheating.
- Only `farm`-focus workers tend farms.
- HQ has 3000 HP. Cannot be lowered.
- 5 active supply trucks per HQ (`spec.maxTrucks`, +5/tier from `trucks`
  upgrade).
- Watchdog *never* despawns trucks; only HP→0 kills them.
- Combat target priority: units first, buildings last. Only silo / anti-ground
  turret / AA turret (when air on map) outrank a fresh enemy unit.

## Why not auto-loop?

`auto-loop.cjs` exists and works, but the project rule is one game per fix.
Auto-looping wastes container builds on knobs that don't address the real
bug, and the rotation of `auto-fix.cjs` heuristics has historically masked
genuine sim issues. Always:

1. Run one match. Read the log.
2. Open the dump + SVG.
3. Make a *code* change (sim, brain, or pathfinder) that targets the failure.
4. Rebuild + redeploy.
5. Run the next match.

See "No game-rule bypass" in `GAME_RULES.md` for the full prohibition list.
