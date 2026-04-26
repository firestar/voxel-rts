# Weapons & projectiles

Soldier-held guns and vehicle-mounted rockets, with real ballistics — gravity
drop, mass, and per-caliber muzzle velocities.

Source of truth:
- Weapon table — `src/sim/Weapons.ts`
- Projectile table & physics — `src/sim/Projectiles.ts`
- Shared gravity constant — `src/sim/gravity.ts` (also imported by `Units.ts`)
- Renderer — `src/render/ProjectileRenderer.ts`
- Wire-up (firing, impacts, nav rebuild) — `src/app/Game.ts`

---

## Naming conventions

- **Projectile kind** — the round itself (`bullet_762`, `rocket_rpg`, …).
- **Weapon kind** — the launcher (`rifle`, `cluster_rocket`, …); a weapon
  picks one projectile and supplies its muzzle speed and fire rate.
- **Caliber** — the bore in millimeters. Used for naming and the projectile
  spec; doesn't directly drive damage.
- **Muzzle offset** — the unit-local point the round leaves from. Soldier
  weapons sit at the rifle muzzle (`forward 0.5 m, up 0.85 m`); vehicle
  weapons fire from the turret roof.

---

## Projectile catalog

| Kind             | Caliber  | Mass (kg) | Muzzle (m/s) | Family       | Impact peak | Impact radius |
|------------------|----------|-----------|--------------|--------------|-------------|---------------|
| `bullet_9mm`     | 9 mm     | 0.0075    | 370          | bullet       | 35          | 0.18 m        |
| `bullet_762`     | 7.62 mm  | 0.0095    | 830          | bullet       | 60          | 0.25 m        |
| `bullet_127`     | 12.7 mm  | 0.042     | 890          | bullet       | 140         | 0.45 m        |
| `rocket_rpg`     | 85 mm    | 2.25      | 250          | explosive    | 90          | 3.0 m         |
| `rocket_cluster` | 152 mm   | 18.0      | 150          | cluster (×6) | 40          | 1.5 m         |
| `rocket_heavy`   | 220 mm   | 60.0      | 180          | explosive    | 150         | 5.0 m         |
| `submunition`    | 40 mm    | 0.5       | (cluster spawn) | submunition | 55       | 1.2 m         |

---

## Weapon catalog

| Weapon            | Projectile     | Muzzle (m/s) | Fire interval | Max range | Held by   |
|-------------------|----------------|--------------|---------------|-----------|-----------|
| `pistol`          | `bullet_9mm`   | 370          | 0.40 s        | 40 m      | soldier   |
| `rifle`           | `bullet_762`   | 830          | 0.35 s        | 200 m     | soldier   |
| `sniper`          | `bullet_127`   | 890          | 1.50 s        | 350 m     | soldier   |
| `machinegun`      | `bullet_762`   | 830          | 0.08 s        | 220 m     | soldier   |
| `rpg`             | `rocket_rpg`   | 250          | 3.0 s         | 250 m     | soldier   |
| `cluster_rocket`  | `rocket_cluster` | 150        | 6.0 s         | 220 m     | tank      |
| `heavy_rocket`    | `rocket_heavy` | 180          | 8.0 s         | 300 m     | tank      |

`rifle` and `machinegun` share the 7.62 round at the same muzzle speed; the
machinegun just cycles much faster (0.08 s vs 0.35 s).

---

## Ballistics

All projectiles use the same `GRAVITY = 22 m/s²` the units use for falling.
Drop is `½·g·t²` over the flight time, mass-independent. A 7.62 round fired
flat at 830 m/s drops about 16 cm over 100 m of horizontal travel.

The launch solver (`computeLaunchVelocity`) is the closed-form ballistic
arc:

> `tan θ = (v² ± √(v⁴ − g(g·d² + 2·dy·v²))) / (g·d)`

where `d` is horizontal distance and `dy` is target Y minus shooter Y. The
`±` gives two solutions; we return the **lower angle** (flat trajectory) by
default. The high-angle (lobbed / indirect) solution is also exposed but
not wired to a UI.

When the muzzle speed is too low to reach the target even at 45°, the
solver returns `null` and `fireAt` declines the shot.

Drag is exponential: `v ← v · exp(-k·dt)`. The coefficient `dragPerSec` per
projectile is intentionally small for bullets (real air drag is much
higher, but at RTS ranges the gravity term dominates) and larger for
rockets so cluster submunitions slow into a satisfying rain.

---

## Per-unit defaults

| Unit kind  | Default weapon    | Notes                                           |
|------------|-------------------|-------------------------------------------------|
| `soldier`  | `rifle`           | Overridable on spawn (barracks rotates loadouts). |
| `tank`     | `cluster_rocket`  | Turret-mounted launcher.                        |
| `tunneler` | `null`            | Unarmed digger.                                 |
| `worm`     | `null`            | Unarmed digger.                                 |

The barracks cycles soldier loadouts on production:
`rifle → tank → tunneler → worm → sniper → machinegun → rpg → pistol`. The
weapon column for vehicle slots is `undefined` — they get the kind's
default (cluster_rocket for the tank, none for the diggers).

---

## Firing flow

1. Game receives a shift+click while a unit with a non-null `weapon` is
   selected.
2. `fireSelectedAt(unit, tx, ty, tz)` checks `weaponCooldown`. Bail if not
   ready.
3. `fireAt(unit, weapon, tx, ty, tz, projectiles)` computes the muzzle
   position from the unit's heading, runs the launch solver, and spawns a
   projectile via `ProjectileManager.spawn`.
4. Each frame, `ProjectileManager.tick` integrates every live projectile
   (drag → gravity → segment raycast). On a voxel hit it calls back into
   `Game.handleProjectileImpact`, which:
   - applies a `damageSphere` sized by the projectile spec,
   - spawns a debris burst,
   - for `cluster` family, fans out the configured number of submunitions
     with a randomized outward kick,
   - asks for a nav rebuild for any rocket-class detonation (bullets skip
     it).

---

## Impact behavior

| Family       | Behavior                                                                 |
|--------------|--------------------------------------------------------------------------|
| `bullet`     | Small `damageSphere` (~0.2 m). Tiny dust burst.                          |
| `explosive`  | Big `damageSphere` (3–5 m). Big debris burst. Triggers nav rebuild.      |
| `cluster`    | Small main blast, then spawns N submunitions outward + upward.           |
| `submunition` | Like a small explosive; arms after `armDelaySec` so it doesn't blow up at separation. |
