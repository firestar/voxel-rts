## Game Rules — voxel-rts AI-vs-AI loop

These are the rules the AI-vs-AI auto-game harness enforces and that
all sim/AI changes must respect. They consolidate every gameplay
constraint the user has stated across the loop.

### Match setup

- A match has **3 teams**: `player`, `enemy`, `enemy2`. None of them
  is human-controlled in this loop — the host browser is a Watcher;
  every team's HQ is driven by the same AI brain (`ai-server.cjs`),
  so it's a true **AI vs AI vs AI** match.
- The Watcher (host) sees the entire map (no fog of war).
- First team to **destroy any other team's HQ** wins (`HQ_WIN`,
  `+5 999 999 999 999` score).

### Movement / motion

- A unit's per-tick XZ displacement must be **≤ 1 voxel** (the
  forward step, lateral nudge, and post-move separation push are
  individually clamped to `VOXEL_SIZE`).  Anything past **4 voxels
  combined per tick** is treated as a teleport and the run fails.
- **Workers must walk voxel-by-voxel**. No teleports, no snaps.
- **Wheeled vehicles** (tank, dozer, supply_truck, rocket_truck,
  aa_vehicle, tunneler, worm) cannot move sideways. They must pivot
  to face their target and only translate along their forward axis.
- A wheeled unit may pop a waypoint up to 0.20 m away (foot units
  pop at 0.05 m); without that wider threshold the truck oscillates
  forever next to a sub-voxel waypoint.

### Stuck detection (harness)

- **Idle combat** = a combat unit within **40 voxels (5 m)** of any
  enemy unit or enemy building AND not firing for > **3 s**. Fails
  the run as `FAILURE_IDLE_COMBAT` (exit code 9). The trigger
  presumes the unit has line-of-sight and weapon range to fire; if
  it's holding fire near a viable target, the AI / target picker /
  weapon arm has a bug and needs a code fix.
- **Non-combat invulnerability** = a civilian or worker that stays
  within 5 m of a firing enemy combat unit for > **5 s** without
  losing any HP. Civilians and workers MUST be killable when an
  enemy is actively shooting at them; sustained zero-damage exposure
  indicates a broken damage pipeline. Fails the run as
  `FAILURE_NONCOMBAT_INVULN` (exit code 11).
- **Combat unit stuck** = `path.length > 0` AND no XZ movement for
  > **2 s**, *unless* it's firing OR within 3 m of its next waypoint
  ("at goal") OR in melee with an enemy combat unit (within 4 m).
- **Worker stuck** = no movement for > **10 s** AND not currently
  on a working task (chop / mine / farm / harvestFarm /
  storage_drop / deliver).
- **Truck stuck** = no movement for > **15 s** while having a path,
  OR < 5 voxels of XZ progress in any 3-second window, OR > **60 s**
  on the same task signature.
- The sim's per-truck watchdog also clears the path if the truck
  hasn't progressed 1 m in 4 s; never despawns trucks (despawn is
  visible to the player as a unit "randomly disappearing").

### Resource gathering — every team plays by the same economy

- AI factions cannot cheat their bank. Initial seed per base:
  **200 food, 100 metals, 100 wood**. Everything beyond that must
  come from worker gathering.
- **Only farm-focused workers can tend / harvest farms.** Auto /
  mine / chop workers walking through a farm plot do NOT count as
  the farmer; the crop will not advance past the next milestone.
  Each base must dedicate workers to `farm` focus.
- Food deposit (worker carry → team pool) and the farm `foodSink`
  both route through `Game.resourcesForTeam(team)` so each AI
  faction has its own `food/metals/wood` pool. No one team can
  drain another team's bank.
- Workers mine ore voxel-by-voxel at `MINE_SWING_INTERVAL = 1 s`.
  Each cluster has a per-slot reservation; the per-cluster max is
  enforced from the moment the worker is assigned, not just on
  arrival.
- Workers chopping a tree only count voxels that are actually wood
  (`M_WOOD`). Building walls do not yield wood.

### Scoring

- Match starts at **+10 000**.
- `+2` per soldier created, `+8` per tank, `+100` per AA vehicle.
- `+5` per soldier kill, `+90` per tank kill, `+40` per rocket kill.
- `−20` per soldier death, `−50` per tank death, `−10` per rocket
  death.
- `+1000` per AA-intercepted projectile.
- `+5` per **hit** on an enemy unit OR enemy building (per-sample
  HP delta on a non-player target). Sample interval is 500 ms, so
  a unit absorbing multiple shots in one window counts as one hit
  event.
- `−10/sec` per second after the **90 s startup grace** in which
  no unit was created (`no-unit-1s`).
- `−10/sec` per second after the 90 s grace in which no military
  unit was created (`no-military-1s`). Both can fire in the same
  second (= `−20/sec`). Originally `−50/sec` each; lowered because
  even a fully-engaged AI with three barracks + a vehicle depot
  only produces one combat unit every 7-10 s under realistic gather
  rates, and the original rule drained ~9 k score over a 150 s
  window of perfectly normal gameplay.
- A score below **0** ends the match (`FAILURE_NEGATIVE_SCORE`).

### Population

- Every team has its own population cap. The cap **only** comes from
  neighborhoods: each house in a neighborhood provides **5 population**,
  so a tier-3 neighborhood (3 houses) tops up at +15. No other building
  type contributes — barracks, vehicle depots, HQs, etc. do NOT raise
  the cap.
- The cap starts at **10** per team so a fresh base can field its
  starter units.
- **Used population may exceed the cap.** Losing housing (a destroyed
  neighborhood) drops the cap, but the soldiers / workers / vehicles that
  were occupying those slots stay alive and keep counting toward used pop —
  only the hood's resident **citizens** die with it. So the cap can fall
  **below** the used count and the available pop (cap − used) can go
  negative. The game does not retroactively kill units to fit a shrunken
  cap; production is simply blocked until used drops back under the cap.
- **HUD readout:** the population pill shows `used / cap`. When `used > cap`
  (available pop is negative) the number renders in **bright red** so the
  overdraw is unmistakable; it returns to the default colour once a slot is
  regained.

### Citizens (neighborhood residents)

- A neighborhood **creates one new citizen every 10 seconds** while it is
  below its housing quota (`tier × 5` = 5 per house). The lot shows a
  **progress bar** of the next citizen's creation, and the new citizen
  **animates growing in** (sprout → full size over ~1.5 s) as it is born.
- **Each citizen created adds +1 to the owner's max population; each
  citizen killed removes 1 from the max.** Net pop max therefore equals
  the live citizen count, capped at the lot's `tier × 5` housing. When
  the local civilian system isn't simulated (the AI-vs-AI debug testbed /
  authoritative zero-trust server, which don't spawn civilians for every
  team) the cap is read straight off the hood's housing capacity instead,
  so AI teams aren't hard-capped at 10.
- Citizens are **attackable and have low HP** (20) — an enemy shooting a
  citizen kills it quickly, and each death costs the owner a pop slot
  (which the lot then re-grows on the 10 s cadence).
- **Citizens are never silently deleted.** A citizen may leave the world for
  exactly two reasons: it is **killed** (HP → 0 from enemy fire), or its
  **home neighborhood is destroyed** (its residents are marked dead with it).
  No other path — an `expand` upgrade, a pop-cap/overflow trim, a wander
  glitch, or any watchdog — may remove a living citizen.

### Unit lifecycle — no silent deletion

- **No living unit is ever deleted except by death.** `UnitManager.despawn`
  is the only thing that removes a unit from the world, and for combat units,
  workers, and civilians it is only ever reached via death (HP → 0), plus the
  neighborhood-destroyed case for citizens above. Units that die linger
  inert at `hp <= 0` (every system skips them); they are not garbage-trimmed
  out from under the player.
- **Destroying a neighborhood kills only its resident citizens** — never any
  other unit. Soldiers, workers, and vehicles standing on or near the lot are
  untouched; they survive the loss of housing and continue to count toward
  used population (which is what can push used over the cap, see Population).
- **The one documented exception is the supply truck**, which is auto-spawned
  infrastructure: it despawns on **successful task completion** (after a
  delivery) or on HP → 0 — never from the watchdog for being slow (a truck
  must never "randomly disappear" mid-haul; see Supply trucks).
- Under the authoritative zero-trust server the server owns unit lifecycles;
  the client mirror removes a local unit only when the server's snapshot
  stops reporting it (i.e. the server already applied a death / destruction).
- `popHasRoom` gates production for **every** team, including the
  player slot in the AI-vs-AI loop. An AI faction without
  neighborhoods stalls at 10 population — it can't barracks-spam its
  way past the cap.
- When a building's production timer would complete a unit but the
  team is at pop cap, the timer **freezes at 99 %** of the production
  interval. The unit is visibly "almost done" and resumes the instant
  a slot opens — production is NOT restarted from zero.
- An AI brain that's within 2 slots of its cap drops everything else
  to build (or `expand_neighborhood`-upgrade) a hood. Pop-cap relief
  outranks the barracks → farm → depot order while the squeeze is on.
- Per team the live civilian count must NEVER exceed the sum of
  `tier × 5` over its live `enabled` neighborhoods (tier = 1 for a
  newly placed hood, +1 per `expand_neighborhood` upgrade, capped at
  3 → 15 civilians per fully-upgraded hood). Going over fires
  `FAILURE_CIVILIAN_OVERFLOW` (exit code 10) — the server's civilian
  spawner has bypassed its quota. The 10 s creation cadence never lets a
  lot exceed its quota; it only paces how fast the cap ramps up.

### Supply trucks

- Each HQ has at most **5 active supply trucks** (`spec.maxTrucks`,
  bumped only by the `trucks` upgrade track at +5/tier).
- The dispatcher reconciles `hq.activeTrucks` from the live truck
  fleet at the start of every dispatch tick. A stalled truck whose
  watchdog cleared its path still counts toward the cap until it
  finishes or dies — the counter cannot drift upward over a long
  run.
- The watchdog never despawns trucks (despawn is visible to the
  player as a unit "randomly disappearing"). Trucks die only from
  HP→0 from real damage or from successful task completion.

### Combat target priority

- The aggressive-stance picker fires on **units first, buildings
  last**. Only ACTIVE DEFENSIVE structures — silo, anti-ground
  turret, AA turret (when an air unit is on the map) — outrank a
  fresh enemy unit. HQ, barracks, vehicle depot, etc. drop below
  every unit threat so attackers clear screening soldiers + tanks
  before chipping at the structure.
- If an attacker is in range but the muzzle arc is obstructed
  (terrain or a building between muzzle and target), the auto-engage
  step picks a **tangent** around the target instead of pressing
  forward. A 3 m sidestep rotates the firing angle so the next
  trajectory sample has a chance at a clean line.

### Building rules

- HQ has **3000 HP**. Cannot be lowered to "speed up wins."
- The AI faction places buildings in this order per HQ:
  1. one barracks
  2. two farms (food economy must come online before scaling)
  3. one vehicle depot
  4. up to three barracks total
- The AI server's `place_building` action sets a per-HQ
  `placeCooldown` of 3 s (NOT `NaN`), so a failed footprint retry
  works.

### No game-rule bypass

- No teleport / snap / blink shortcuts in the sim to defeat
  detection. If a unit gets stuck, fix the underlying pathfinder
  / collision / economy bug — don't add a teleport recovery.
- Don't lower HQ HP, weaken stuck thresholds below the values
  above, or seed AI resources beyond what gathering would yield.
- Don't auto-loop games via a script (`auto-loop.cjs`). Run each
  iteration manually, observe the dump + outcome, make a real
  code change, build + redeploy, run the next game.

### What the AI is allowed to do

- Run multiple HQ brains in parallel (one per team) with shared
  request/action format.
- Place barracks → farms → vehicle depot → more barracks per the
  build order above.
- Queue infantry from barracks (round-robin across soldier /
  gunner / rocket_soldier / mortar_soldier) and tanks from
  vehicle depots.
- Hunt-and-attack: send idle armed units toward the nearest enemy
  HQ (HQ-priority over other building kinds), stopping at
  `0.45 × weapon range` from the target. A small per-unit jitter
  on the goal point prevents stacking.
- Combat units may **clip through any same-team peer and any
  worker** (regardless of team) to avoid spawn-cluster pile-ups
  and forward-firing-line walls. Combat-vs-enemy-combat
  collisions are unaffected.
