# Units

Five unit kinds. Each is a distinct entity type with its own config, model,
and movement rules. The string name in code is
`UnitKind = 'soldier' | 'tank' | 'tunneler' | 'worm' | 'worker'`.

Source of truth:
- Sim configs and `Unit` shape — `src/sim/Units.ts`
- Geometry / parts — `src/render/UnitModels.ts`
- Renderer (instanced meshes, animation, pivots) — `src/render/UnitRenderer.ts`

---

## Naming conventions

- **Unit kind** — the `UnitKind` string. Always lowercase, single word: `soldier`, `tank`, `tunneler`.
- **Part** — a piece of the unit's geometry that moves independently. Each is its
  own `THREE.InstancedMesh` so we can transform parts separately (e.g. legs
  swing, drill spins). Names below match the field names on `UnitRenderer`.
- **Pivot** — a body-local point a part rotates around (e.g. the hip, the turret
  ring, the drill collar). Pivot Y/Z constants are exported from `UnitModels.ts`.
- **Feet** — the model's lowest geometry; we align this with `u.y` (the
  snapped-to-ground voxel-top position). Per-kind `feetOffset` in the renderer
  bumps the body up/down so feet match exactly.

---

## Soldier

Infantry. Single voxel-cell footprint, agile, climbs nearly anything, no carve.

### Geometry parts

| Part | Builder | InstancedMesh field | Notes |
|---|---|---|---|
| Body | `buildSoldierBodyGeometry()` | `soldierBody` | Torso, vest plate, neck, head, helmet, two arms, rifle (barrel, stock, mag, scope) |
| Left leg | `buildSoldierLegGeometry()` | `soldierLegL` | Single-leg geometry; pivot at top |
| Right leg | `buildSoldierLegGeometry()` | `soldierLegR` | Same geometry, mirrored hip X |

The rifle is part of the body geometry (right arm holds it forward); it doesn't
animate independently.

### Pivots / model constants

| Constant | Value | Meaning |
|---|---|---|
| `SOLDIER_HIP_Y` | `0.55` m | Hip joint height in body-local coords; legs rotate about this Y |
| `SOLDIER_LEG_X` | `0.10` m | Half-width between left and right hip — `±SOLDIER_LEG_X` in body-local X |

Boot bottom sits at body-local `y = -0.05` (hip 0.55 − leg 0.60). The
renderer applies `feetOffset = +0.05` so boots land on `u.y` exactly.

### Animation

- Legs counter-swing: `Math.sin(distanceWalked * 4.5 + id) * 0.6` rad about hip X.
- Body bob: one-sided sine (`Math.max(0, sin)`), freq 6, amplitude 0.08, only when moving.

### Sim config

| Field | Value | Why |
|---|---|---|
| `footprintRadius` | 1 | Single nav cell; can squeeze through 1 m gaps |
| `widthMeters` | 0.75 | For collision + carve sizing |
| `maxStepVoxels` | 32 (4 m) | Soldiers scale anything that isn't a wall |
| `slopePenalty` | 0.08 | Mild — they don't avoid hills |
| `bodyHalfCells` | 0 | No body-roughness check (single-cell unit) |
| `bodyRoughnessVoxels` | 999 | Disabled |
| `turnRateRadPerSec` | 6.0 | ~340°/s — snappy infantry |
| `maxPitchRad` | π/2 | No real cap; soldiers are flexible |
| `heightVoxels` | 14 (~1.75 m) | Head clearance for path search |
| `canDig` | false | |
| `requiresGround` | true | |
| `speed` | 4.5 m/s | |
| `hp` | 80 | |

### Selection ring

Green (`0x00ff88`), radius 0.6 m.

---

## Tank

Vehicle. Wide footprint, restricted to flat-ish terrain, fastest medium hp.

### Geometry parts

| Part | Builder | InstancedMesh field | Notes |
|---|---|---|---|
| Hull | `buildTankHullGeometry()` | `tankHull` | Two treads with tooth bumps, four drive sprockets, lower hull skirt, upper deck, glacis (sloped front), side fender ridges |
| Turret | `buildTankTurretGeometry()` | `tankTurret` | Turret base, mantlet, roof, commander hatch, periscope, antenna, cannon barrel, muzzle brake, bore evacuator |

### Pivots / model constants

| Constant | Value | Meaning |
|---|---|---|
| `TANK_TURRET_PIVOT_Y` | `1.20` m | Turret rotates about this Y in hull-local coords |
| `TANK_TURRET_PIVOT_Z` | `0.05` m | Slight Z offset (turret ring is slightly aft of hull center) |

Tread bottom at body-local `y = 0.05`; renderer uses `feetOffset = -0.05` so
treads sit on `u.y` (was 5 cm ground clearance that read as floating).

### Animation

- Turret currently locked to hull yaw (no AI yet).
- Body bob: freq 3, amplitude 0.04, one-sided.
- Track marks: paints `damageSphere` along its path using
  `trackDamageFor(material).peak` per tick — see `materials.md`.

### Sim config

| Field | Value | Why |
|---|---|---|
| `footprintRadius` | 2 | 2 m radius — needs a 4 m strip |
| `widthMeters` | 2.4 | |
| `maxStepVoxels` | 4 (0.5 m) | ~27° slope cap; cliffs hard-block tank routes |
| `slopePenalty` | 0.25 | A* prefers flat routes even when steeper ones pass |
| `bodyHalfCells` | 1 | 3×3-cell plane fit |
| `bodyRoughnessVoxels` | 5 (0.625 m) | Uniform slopes pass; rocky bumps fail |
| `turnRateRadPerSec` | 1.4 | ~80°/s — slow tank pivot |
| `maxPitchRad` | π/6 | 30° — matches climb cap |
| `heightVoxels` | 18 (~2.25 m) | Turret + antenna clearance |
| `canDig` | false | |
| `requiresGround` | true | |
| `speed` | 3.5 m/s | |
| `hp` | 220 | |

### Selection ring

Orange (`0xffaa33`), radius 1.6 m.

---

## Tunneler (TBM — Tunnel Boring Machine)

Heavy carving vehicle. Drills through soil/stone, leaves walkable tunnels.

### Geometry parts

| Part | Builder | InstancedMesh field | Notes |
|---|---|---|---|
| Hull | `buildTunnelerHullGeometry()` | `tunnelerHull` | Heavy treads, drive sprockets, lower hull skirt, main armored "can", side ribs, top deck, raised operator cab (teal glass), two exhaust stacks, rear spoil chute, front mounting collar |
| Drill (cutter head) | `buildTunnelerDrillGeometry()` | `tunnelerDrill` | Stepped rings (outer disc → mid disc → inner disc → hub → center tip), 14 outer cutter teeth, 8 inner teeth |

### Pivots / model constants

| Constant | Value | Meaning |
|---|---|---|
| `TUNNELER_DRILL_PIVOT_Y` | `1.10` m | Drill rotates / pitches about this Y in hull-local coords |
| `TUNNELER_DRILL_PIVOT_Z` | `-1.42` m | Drill is mounted forward of the chassis pivot (-Z = forward) |
| `TUNNELER_CUTTER_RADIUS` | `1.7` m | Outer carve radius; used by `damageOrientedCylinder` |
| `TUNNELER_CUTTER_FORWARD` | `1.65` m | How far ahead of `u.x/y/z` the cutter face sits |
| `TUNNELER_CUTTER_HEIGHT` | `1.10` m | Cutter center above feet in unit-local coords |

Tread bottom is at body-local `y = 0`, so `feetOffset = 0`.

### Animation

- Drill spins around its forward (Z) axis. Speed `now * 18` while moving;
  `now * 12` when carving but stopped; 0 otherwise.
- **Body pitches only 20% of `u.pitch`**; the remaining 80% is applied as an X
  rotation at the drill pivot so the cutter articulates while the chassis
  stays mostly level. Rotation sign is `-cutterExtraPitch` (drill is at +Z
  offset, so the visual sign is opposite of the body's YXZ pitch).
- Body bob: freq 4, amplitude 0.05, one-sided.

### Sim config

| Field | Value | Why |
|---|---|---|
| `footprintRadius` | 2 | 2 m radius |
| `widthMeters` | 3.6 | Wider than tank |
| `maxStepVoxels` | 14 (1.75 m) | ~60° — cutter pulls it up steep grades |
| `slopePenalty` | 0.15 | Less averse than tank |
| `bodyHalfCells` | 2 | 5×5-cell plane fit |
| `bodyRoughnessVoxels` | 9 (~1.1 m) | Generous — cutter levels its own bench |
| `turnRateRadPerSec` | 0.7 | ~40°/s — heavy pivot |
| `maxPitchRad` | 40° (`40 * π/180`) | Capped dig angle in either direction |
| `heightVoxels` | 22 (~2.75 m) | Cab + exhaust stack clearance |
| `canDig` | true | Can route through diggable solid in volume nav |
| `requiresGround` | true | Won't levitate through air; tunnels leave a floor |
| `speed` | 1.6 m/s | Surface speed |
| `speedDigging` | 1.2 m/s | Reduced when carving (modulated by material) |
| `hp` | 320 | |

### Carve mechanics

- Carve volume is an oriented cylinder: radius `TUNNELER_CUTTER_RADIUS`,
  axis = unit forward, half-length matches the carve cell or step distance.
- `damageOrientedCylinder(... floorMeters: u.y)` clamps the cutter so it can't
  carve below the chassis bottom — without this the disc dug out the floor.
- Per-material dig speed multiplier from `digSpeedMultiplier()` in
  `Materials.ts`; bedrock returns 0 (uncuttable).
- "Forward only" cut box: 4 cells in front, 3 cells to each side.

### Selection ring

Yellow (`0xffe066`), radius 0.7 m.

---

## Common `Unit` runtime fields

Beyond config copies, the live `Unit` carries:

| Field | Type | Notes |
|---|---|---|
| `id` | number | Monotonic per-manager spawn id |
| `kind` | `UnitKind` | |
| `x, y, z` | number | World meters; `y` is **feet on ground** (snapped to topY +1 voxel) |
| `heading` | number rad | Yaw around Y |
| `pitch` | number rad | Smoothed body pitch (path-derived) |
| `roll` | number rad | Currently 0 |
| `path` | `{x,y,z}[]` | Remaining waypoints; empty = idle |
| `selected` | boolean | UI selection state |
| `hp` | number | Current hit points |
| `carveCooldown` | number | Throttles cuts so the mesher keeps up |
| `distanceWalked` | number | Drives the gait/bob phase |
| `lastTrackDistance` | number | When the tank last painted a tread mark |
| `blockedFrames` | number | Frames stalled by collision (telemetry only — no longer drops the path) |
| `vy` | number | Vertical velocity in m/s. Negative = falling. Reset to 0 on landing. |

Gravity (in `sampleSurfaceFollow`): `GRAVITY = 22 m/s²`, `TERMINAL_VY = -28 m/s`.
Falls accelerate naturally; landing snaps to `targetY` and zeros `vy`.

---

## Worker

Civilian unit. Two roles share one `UnitKind`: harvester and transporter,
discriminated by the runtime `workerRole` field on the `Unit`. No combat,
no carve. Drives the resource economy via `tickWorkers` in `src/sim/Workers.ts`.

### Geometry parts

| Part | Builder | InstancedMesh field | Notes |
|---|---|---|---|
| Body | `buildWorkerBodyGeometry()` | `workerBody` | Torso (hi-vis vest), tool belt, head, hard hat, two arms, pickaxe |
| Left leg | `buildWorkerLegGeometry()` | `workerLegL` | Same shape as soldier, in jeans + boot colours |
| Right leg | `buildWorkerLegGeometry()` | `workerLegR` | Mirrored hip X |
| Carry crate | `buildWorkerCrateGeometry(metal)` | `workerCrateWood` / `workerCrateMetal` | Floats above the back when carrying anything; colour-coded by payload majority |

### Pivots / model constants

| Constant | Value | Meaning |
|---|---|---|
| `WORKER_HIP_Y` | `0.55` m | Same hip pivot as the soldier — leg swing matches |
| `WORKER_LEG_X` | `0.10` m | ±half-width between hips |

### Animation

- Legs counter-swing: `Math.sin(distanceWalked * 4.5 + id) * 0.55` rad about hip X.
- Body bob: one-sided sine, freq 6, amplitude 0.07 (slightly less than the soldier).
- Carry crate is rendered at body-local `(0, 0.95, 0.18)` whenever
  `carrying.wood + carrying.metals > 0`. Wood vs metal variant chosen by
  whichever payload is larger.

### Sim config

| Field | Value | Why |
|---|---|---|
| `footprintRadius` | 1 | Single nav cell — squeezes through 1 m gaps |
| `widthMeters` | 0.65 | |
| `maxStepVoxels` | 24 (3 m) | Less agile than a soldier, but climbs ledges easily |
| `slopePenalty` | 0.10 | Mild |
| `bodyHalfCells` | 0 | No roughness check |
| `bodyRoughnessVoxels` | 999 | Disabled |
| `turnRateRadPerSec` | 5.0 | ~290°/s |
| `maxPitchRad` | π/2 | No real cap |
| `heightVoxels` | 14 | ~1.75 m head clearance |
| `canDig` | false | Workers mine via direct `damageSphere` calls in `tickWorkers`, not by pathing through solid |
| `requiresGround` | true | |
| `speed` | 3.2 m/s | Slower than a soldier — they're hauling tools |
| `hp` | 60 | |

### Selection ring

Cyan (`0x33ccff`), radius 0.55 m.

### Roles

- `harvester` — auto-picks the nearest exposed wood / metal voxel within
  `SCAN_RADIUS_M` (60 m) and walks there to chop / mine. Once
  `carrying.wood + carrying.metals >= WORKER_CARRY_CAP` (5), drops a Pile
  at the current location and returns to idle. Player can override with
  LMB on a specific voxel (`chop` / `mine` task) or via plant mode.
- `transporter` — empty-handed: scans for the nearest unclaimed Pile, claims
  it, walks there, picks up. Carrying anything: walks to the nearest
  Storage building and drops the load into `Resources`.

The two roles share geometry and config; only `tickWorkers` cares.

---

## Buildings

| Spec | cells | Wall | Production |
|---|---|---|---|
| `BARRACKS` | 4×4 | wood | Cycles through `'soldier' \| 'tank' \| 'tunneler' \| 'worm' \| 'worker'` every 6 s |
| `FARM` | 3×3 | dirt_road fence | `+5 food` to `Resources` every 5 s while alive (no roof) |
| `STORAGE` | 3×3 | wood | None — drop-off target for transporter workers |

`BuildingManager` exposes `nearestStorage(x, z)` for the worker tick to
locate a depot. `foodSink` is a callback set by `Game` that funnels farm
ticks into `Resources.food`.
