# Materials

Voxel material table. Each material has an integer id; ids are stored directly
in the world voxel buffer (`Uint8Array`). 0 is air; everything else is solid.

Source: `src/voxel/Materials.ts`.

## Table

| id | const | name | hp | rgb (0..255) | notes |
|----|-------|------|----|--------------|-------|
| 0 | `M_AIR` | air | — | (0, 0, 0) | Empty / passable |
| 1 | `M_GRASS` | grass | 30 | (74, 138, 58) | Top surface; trees only seed on grass |
| 2 | `M_DIRT` | dirt | 25 | (107, 74, 42) | Subsoil layer |
| 3 | `M_STONE` | stone | 120 | (138, 138, 138) | Hard; deep layer |
| 4 | `M_WOOD` | wood | 60 | (106, 74, 42) | Tree trunks; skipped by surface topY scan |
| 5 | `M_LEAF` | leaf | 15 | (47, 106, 42) | Tree canopy; soft; skipped by surface topY scan |
| 6 | `M_PATH` | path | 35 | (184, 160, 106) | Paved trunk roads — speed bonus + strong A* discount |
| 7 | `M_BEDROCK` | bedrock | 0 | (40, 40, 50) | Indestructible (`hp = 0` sentinel) |
| 8 | `M_MUD` | mud | 10 | (70, 52, 28) | Soft; tank tread marks chew through fast |
| 9 | `M_DIRT_ROAD` | dirt_road | 28 | (126, 92, 56) | Dirt branches off paved roads — milder A* discount |
| 10 | `M_METAL` | metal | 80 | (140, 152, 178) | Underground ore patches; harvesters mine exposed voxels |
| 11 | `M_FARM` | farm | 15 | (212, 182, 90) | Cropland tiles stamped by farms; cosmetic |

`hp = 0` means **indestructible** for non-air ids (bedrock). Air uses 0 hp
as a sentinel because it isn't damageable anyway.

## Speed multipliers

### `digSpeedMultiplier(m)` — tunneler cutter

| Material | Multiplier | Notes |
|---|---|---|
| air | 1.0 | Cutter spins through it |
| leaf | 1.4 | Very soft |
| mud | 1.3 | Soft, sloppy |
| dirt | 1.0 | Baseline |
| grass | 0.95 | Topsoil |
| dirt_road | 0.9 | Graded, compacted |
| path | 0.85 | Compacted dirt |
| wood | 0.55 | Medium |
| stone | 0.30 | Hard |
| metal | 0.35 | Hard ore — slightly easier than raw stone |
| farm | 1.0 | Cropland; behaves like soft soil if a cutter passes through |
| bedrock | 0 | Uncuttable |
| (default) | 0.5 | Unknown |

### `groundSpeedMultiplier(m)` — surface units (per top voxel)

| Material | Multiplier | Notes |
|---|---|---|
| mud | 0.4 | Bog |
| grass | 1.0 | Baseline |
| dirt | 1.0 | Baseline |
| dirt_road | 1.05 | Graded — minor speed bonus |
| path | 1.15 | Fastest — beaten road |
| leaf | 0.9 | Soft canopy underfoot |
| stone | 0.95 | Slightly less grippy |
| metal | 0.9 | Ore boulders — uneven footing |
| farm | 1.0 | Tilled soil; walks like grass |
| (default) | 1.0 | |

## Tread damage — `trackDamageFor(m)`

Each tank tick, `paintTankTracks` calls `damageSphere` at the tread footprint.
Voxels accumulate damage; once HP is exceeded, the voxel becomes air, so a
tank actually sinks into mud as it rolls.

| Material | peak | radiusMeters | Notes |
|---|---|---|---|
| mud | 14 | 0.4 | Sinks fast |
| grass | 6 | 0.3 | Light grooves; ~6 passes to expose dirt |
| dirt | 3 | 0.25 | Faint grooves |
| dirt_road | 2 | 0.22 | Graded but loose — slight wear |
| path | 1 | 0.2 | Almost no marks |
| (default) | 0 | 0 | Stone, bedrock, wood, leaf — no marks |

## Notes for future work

- New materials: append to `MATERIALS` (id == array index), add a `M_*` const,
  and update each helper function that switches on the id.
- The `hp = 0` indestructible sentinel only applies to non-air ids. Don't try
  to give air a positive hp.
- `M_LEAF` and `M_WOOD` are deliberately skipped in `findFootprintTopVoxel`
  and in `buildSurfaceNav`'s topY scan so units stand on the ground beneath
  trees, not on canopies. Don't accidentally re-enable them.
- `M_METAL` is placed by `placeMetals` (`src/voxel/Metals.ts`) as large
  ellipsoidal patches inside stone/dirt — most patches are deep enough that
  exposing them requires a tunneler, but ~25% spawn shallow so a fresh map
  always has surface ore for early-game harvesters.
- `M_FARM` is purely visual — stamped by `stampFarm` inside the building
  footprint and never written elsewhere. Don't gate logic on it.
