# Pathfinding

Two grids, one A* implementation per grid, plus a smoother that runs on the
surface result before the unit consumes it.

Source: `src/path/`.

## Surface pathing

For soldier and tank (and tunneler when not digging). Operates on the
`SurfaceNavBuffers` 1 m grid.

### Algorithm

**Bidirectional weighted A***:
- Two open sets — one expanding from the start, one from the goal.
- Heuristic is octile distance × `HEURISTIC_WEIGHT = 1.5` (gives a cone of
  preferred expansion, faster termination, slightly suboptimal paths).
- 4-ary heap (`AStarWorkspace.fOpen` / `bOpen`).
- First-meet termination: when an expanded cell is in the other side's closed
  set, we stitch the two halves and finish.
- 8-connected; diagonal corner-cut blocked when both cardinals are blocked.
  For vehicles the diagonal also fails the climb check if either cardinal
  fails. (Soldiers — `footprintRadius <= 1` — skip this so they can scramble
  into L-shaped corners.)

### Edge cost

Hash-symmetric (`min(a,b), max(a,b)` to keep cost bidirectional):
- Base: 1 (cardinal) or √2 (diagonal)
- Slope penalty: `slopePenalty * |topY_b - topY_a|` (in voxels)
- Road bonus: `1 - 0.6 * max(road_a, road_b) / 255`

### Cell rejection

A cell is rejected before it enters the open set if any of:
- `blocked` flag set
- `flatness < footprintRadius` (cell is on/near uneven terrain too narrow for the unit)
- `headroom < heightVoxels` (unit's head/turret would clip what's above)
- Body roughness fails: a least-squares plane fit over the
  `(2*bodyHalfCells+1)²` window has max residual > `bodyRoughnessVoxels`
- Climb step exceeds `maxStepVoxels` from any neighbor
- *Gap rejection* — a horizontal jump where neither end has terrain underneath

### Smoother (`Smooth.ts`)

The raw A* path is post-processed. We do a supercover-line walk between
non-adjacent cells (4× oversample so we don't miss any cell the line touches)
and validate each cell against the same gates above. If clean, we collapse
intermediate waypoints. This trims jaggy paths down to the few real corners.

## Volume pathing

For tunnelers. Operates on `VolumeNavBuffers` 1 m × 1 m × 1 m grid.
3D A* with **Chebyshev3D** heuristic, 26-connected.

Edge gates:
- Cell is empty *or* (`canDig` and `diggable`)
- `requiresGround` — cell directly below must be solid (tunnels leave a floor)
- Pitch between adjacent cells ≤ `maxPitchRad` — can't climb/dive steeper

If the straight-line shortcut succeeds (validates with the same gates),
A* skips the search. Capped at ~5000 expansions; partial results allowed.

## Path requests from `Game.ts`

```ts
findPathSurface(nav, ws, {
  startCx, startCz, goalCx, goalCz,
  footprintRadius: u.footprintRadius,
  maxStepVoxels:   u.maxStepVoxels,
  slopePenalty:    u.slopePenalty,
  bodyHalfCells:   u.bodyHalfCells,
  bodyRoughnessVoxels: u.bodyRoughnessVoxels,
  headroomVoxels:  u.heightVoxels,
  prefersRoads:    u.kind === 'soldier' || u.kind === 'tank', // tunneler doesn't bias to roads
});
```

The volume request is similar, plus `canDig`, `requiresGround`, `maxPitchRad`,
and an absolute pitch origin so the cone is anchored at the start.

## Tuning summary

| Knob | Soldier | Tank | Tunneler |
|---|---|---|---|
| footprintRadius | 1 | 2 | 2 |
| maxStepVoxels | 32 | 4 | 14 |
| slopePenalty | 0.08 | 0.25 | 0.15 |
| bodyHalfCells | 0 | 1 | 2 |
| bodyRoughnessVoxels | 999 (off) | 5 | 9 |
| headroomVoxels | 14 | 18 | 22 |
| maxPitchRad | π/2 | π/6 (30°) | 40° |
| prefersRoads | true | true | false |

## Movement runtime

`tickSurface` and `tickVolume` consume the path:
- The unit lerps toward the next waypoint at `u.speed * align * groundMult * dt`
  where `align` is the cosine of misalignment and `groundMult` comes from the
  current top voxel material.
- If the next step would clip into a solid voxel: pause this frame
  (`blockedFrames++`), but **don't drop the path** — gravity / terrain edits
  may resolve it.
- Surface follow: snap `u.y` to the highest live voxel under the footprint,
  with gravity for downward motion (acceleration 22 m/s², terminal velocity
  -28 m/s). On landing, set `u.y = targetY` and `u.vy = 0`.

## "Why bidirectional + cone?"

The user explicitly asked for "a cone that starts from both ends, the start
and the target, and try paths within both cones, then the first connection
use that as a route." Implemented as: bidirectional search + weighted (×1.5)
heuristic. The weight produces a forward-biased fan from each end; first meet
terminates.
