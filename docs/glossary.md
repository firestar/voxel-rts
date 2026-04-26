# Glossary

Quick definitions for terms that come up in code or PRs.

## Units & geometry

- **Unit** — a controllable entity (soldier, tank, tunneler).
- **Kind** — one of `'soldier' | 'tank' | 'tunneler'`. Used as the
  `Unit.kind` discriminator and to pick a config in `unitConfig()`.
- **Part** — a piece of a unit's geometry rendered as its own
  `InstancedMesh` so it can animate independently (legs, turret, drill).
- **Pivot** — body-local point a part rotates around. Pivot Y/Z constants
  are exported from `UnitModels.ts`.
- **Feet** — model's lowest geometry. We align this with `u.y`.
- **`u.y`** — unit's feet position in world meters. Always sits on top of
  the highest walkable voxel under the footprint.
- **`u.pitch`** — smoothed body pitch in radians (positive = nose-down).
- **`u.heading`** — yaw in radians around Y.
- **`u.vy`** — vertical velocity in m/s (negative = falling).
- **`feetOffset`** — per-kind body translation that aligns the model's
  lowest geometry with `u.y`.
- **`heightVoxels`** — vertical extent of a unit in voxels. Surface path
  rejects cells with `headroom < heightVoxels`.

## World

- **Voxel** — single 0.125 m cube of one material.
- **Material id** — integer 0..N indexing `MATERIALS[]`. 0 = air.
- **Chunk** — 32³ voxel block, mesh unit. 24×6×24 chunks fill the map.
- **`worldIndex(x, y, z)`** — Y-major flat index into the voxel buffer.

## Pathfinding

- **Surface nav** — 1 m × 1 m 2D grid summarising the column under each
  cell (topY, slope, flatness, headroom, road).
- **Volume nav** — 1 m × 1 m × 1 m 3D grid (solid bit + diggable byte).
- **`topY`** — highest *walkable* voxel y in a column. Wood + leaf are
  skipped, so trees don't count as walkable surface.
- **`slope`** — max |dY| over the 3×3 neighborhood, in voxels.
- **`flatness`** — Chamfer (3,4) distance to the nearest uneven cell, in
  cells. Zero = uneven cell. Larger = bigger flat plateau.
- **`flatnessRadius`** — used as a synonym for the unit's
  `footprintRadius` requirement against `flatness`.
- **`headroom`** — contiguous air voxels above topY at cell centre,
  capped at 255.
- **`bodyHalfCells` / `bodyRoughnessVoxels`** — the per-unit "is this
  patch even enough under me" gate. Plane-fit residual must stay under
  the threshold.
- **`maxStepVoxels`** — max climb between adjacent cells (1 m apart).
  Soldier 32, tank 4, tunneler 14.
- **`maxPitchRad`** — angle cap on path edges and rendered body pitch.
- **Supercover line walk** — 4×-oversampled line traversal that doesn't
  miss any cell the line touches; used by the smoother.
- **Bidirectional A*** — search from both ends with a weighted heuristic
  (×1.5); first meet terminates.

## Carving

- **Cutter / drill** — the rotating disc on the front of the tunneler.
- **`damageOrientedCylinder`** — voxel damage primitive for a disc/cyl
  carve. `floorMeters` clamps the bottom Y so the disc can't dig below
  the chassis bottom.
- **`carveCooldown`** — throttle on per-frame carves so meshing keeps up.
- **`digSpeedMultiplier`** — per-material multiplier on the tunneler's
  base digging speed.

## Ground & tracks

- **`groundSpeedMultiplier`** — per-material multiplier on a surface
  unit's movement speed (mud 0.4, path 1.15).
- **`trackDamageFor`** — per-material recipe for a tank tread mark.
  `peak` feeds `damageSphere`, voxels accumulate damage, top voxels
  vanish — tank sinks into mud.

## Other

- **`AStarWorkspace`** — the per-frame open/closed/heap buffers; reused
  to avoid allocation churn.
- **Bidirectional first-meet** — when the forward and backward closed
  sets touch, the route stitches and the search ends.
- **`HEURISTIC_WEIGHT`** — 1.5; the cone-bias multiplier on octile h.
- **`u.blockedFrames`** — telemetry counter for how long the unit has
  been stalled. No longer drops the path; gravity / edits resolve.
