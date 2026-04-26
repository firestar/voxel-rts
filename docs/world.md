# World geometry

Sizes, coordinate systems, and the relationships between voxels, chunks, and
nav cells.

Source of truth: `src/voxel/types.ts`, `src/voxel/VoxelWorld.ts`,
`src/path/SurfaceNav.ts`, `src/path/VolumeNav.ts`.

## Voxel grid

| Constant | Value | Notes |
|---|---|---|
| `VOXEL_SIZE` | 0.125 m | 8 voxels per metre |
| `WORLD_X` | 768 voxels | 96 m |
| `WORLD_Y` | 192 voxels | 24 m |
| `WORLD_Z` | 768 voxels | 96 m |
| Total voxels | ~113 M | |
| `AIR` | 0 | Material id sentinel |

`worldIndex(x, y, z) = (y * WORLD_Z + z) * WORLD_X + x` — Y-major so
horizontal slabs are contiguous (good for the column-walk worldgen and the
top-down surface scans).

## Chunks

| Constant | Value |
|---|---|
| `CHUNK` | 32 voxels |
| `CHUNK_VOL` | 32 768 |
| `CHUNKS_X` | 24 |
| `CHUNKS_Y` | 6 |
| `CHUNKS_Z` | 24 |
| `CHUNK_COUNT` | 3456 |

Within a chunk: `localIndex(lx, ly, lz) = (ly * CHUNK + lz) * CHUNK + lx` —
Y-major within the chunk too (matches the global ordering).

## Surface nav grid

1 m cells = 8 voxels. Single 2D grid over the map; per-cell summary of the
column beneath it.

| Constant | Value |
|---|---|
| `NAV_CELL_VOXELS` | 8 |
| `NAV_W` | 96 |
| `NAV_H` | 96 |
| `NAV_COUNT` | 9216 |
| `NAV_CELL_METERS` | 1.0 |
| `FLAT_TOLERANCE_VOXELS` | 4 (0.5 m) — Chamfer threshold |
| `MAX_FLATNESS_RADIUS` | 16 cells |

`navIndex(cx, cz) = cz * NAV_W + cx`.

Per-cell fields (`SurfaceNavBuffers`, all backed by SAB or AB):
- `topY: Int16Array` — highest **walkable** voxel y (skips wood + leaf)
- `material: Uint8Array` — material id of `topY`
- `slope: Uint8Array` — max |dY| over 3×3 neighborhood, in voxels
- `flatness: Uint8Array` — Chamfer (3,4) distance to nearest uneven cell, in cells
- `road: Uint8Array` — 0..255 road weight (200 if top voxel is `M_PATH`, else 0)
- `blocked: Uint8Array` — 0/1
- `headroom: Uint8Array` — contiguous air voxels above topY at cell centre, capped 255

## Volume nav grid

1 m cells = 8 voxels. 3D grid for tunneler pathing.

| Constant | Value |
|---|---|
| `VNAV_X` | 96 |
| `VNAV_Y` | 24 |
| `VNAV_Z` | 96 |
| `VNAV_COUNT` | 221 184 |
| `VNAV_CELL_METERS` | 1.0 |

Bit-packed `solid` plus a per-cell `diggable` byte.

`vnavIndex(x, y, z) = (y * VNAV_Z + z) * VNAV_X + x`.

`worldToVolumeCell(wx, wy, wz)` and `volumeCellCenter(cx, cy, cz)` convert
between world meters and cell coords.

## Coordinate conventions

- Right-handed three.js coordinates. **+Y is up.**
- Unit `(x, y, z)` is world meters. `y` is the unit's *feet on the ground*
  (top of the highest walkable voxel + 1 voxel).
- Forward in unit-local geometry is **−Z**. Renderer applies `heading`
  (yaw around Y) so the unit faces its forward path direction.
- Pitch (`u.pitch`) follows path slope: positive = nose down. Computed in
  `applyPathOrientation` as `clamp(atan2(-dy, horiz), -maxPitch, +maxPitch)`.

## Memory budget (rough)

| Buffer | Size |
|---|---|
| Voxel grid (`Uint8Array`) | ~113 MiB |
| Surface nav (7 fields, 9 216 cells) | ~75 KiB |
| Volume nav (1 bit + 1 byte × 221 184) | ~250 KiB |
| Chunk meshes (post-greedy) | varies; ~50 MiB target |

Total well under the 250 MiB target after worldgen.
