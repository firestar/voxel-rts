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
| 6 | `M_PATH` | path | 35 | (184, 160, 106) | Roads — speed bonus + low slopePenalty bias |
| 7 | `M_BEDROCK` | bedrock | 0 | (40, 40, 50) | Indestructible (`hp = 0` sentinel) |
| 8 | `M_MUD` | mud | 10 | (70, 52, 28) | Soft; tank tread marks chew through fast |

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
| path | 0.85 | Compacted dirt |
| wood | 0.55 | Medium |
| stone | 0.30 | Hard |
| bedrock | 0 | Uncuttable |
| (default) | 0.5 | Unknown |

### `groundSpeedMultiplier(m)` — surface units (per top voxel)

| Material | Multiplier | Notes |
|---|---|---|
| mud | 0.4 | Bog |
| grass | 1.0 | Baseline |
| dirt | 1.0 | Baseline |
| path | 1.15 | Fastest — beaten road |
| leaf | 0.9 | Soft canopy underfoot |
| stone | 0.95 | Slightly less grippy |
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
