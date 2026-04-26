# Design decisions

Why things are the way they are. When you change one of these values or
behaviors, update this file.

## Pathfinding shape: bidirectional + cone (×1.5 weighted heuristic)

The user explicitly asked for a search "that branches out from the start
position and the target position", with the first connection becoming the
route. We implement this as a bidirectional A* with a weighted (×1.5)
heuristic. The weight gives each side a forward-biased fan; first meet
terminates. Slightly suboptimal vs. Dijkstra; much faster, and the bias
matches what the user asked to see.

## Path smoother does supercover line walks

A 4× oversample resolves a regression where 8-connected lines crossed cells
the line technically touched at corners but the simpler stepper missed,
producing paths that ran through narrow chokes a unit couldn't fit through.

## Don't cancel paths on collision; pause instead

Earlier, `tickVolume` dropped the path after `COLLISION_BLOCK_LIMIT = 6`
stalled frames. The user asked for a movement pause that resumes when the
block clears. Most blocks are now resolved by gravity (the unit was just
mid-air for a frame, and lands a frame later) or by terrain edits.
`blockedFrames` is still incremented for telemetry but no longer drops the
path.

## Real gravity (22 m/s², terminal -28 m/s)

Replaced the flat 4 m/s descent cap. Units now fall naturally off ledges and
out of mid-air, snap to `targetY` on landing, and `vy` resets. The constants
are slightly snappier than real-world gravity because RTS feel beats
physical accuracy.

## Surface scan skips wood + leaf

Both `findFootprintTopVoxel` (Units.ts) and `buildSurfaceNav`'s topY pass
(SurfaceNav.ts) skip `M_WOOD` and `M_LEAF`. Without this, units stood on
canopies or tree-tops. Symptoms before the fix: soldiers hovered above
forests; headroom probes returned a tree-top voxel with full sky above and
the forest looked walkable but pathing didn't work.

## Headroom uses centre-only sampling

A previous version sampled 5 columns per cell (4 corners + centre) and took
the min. That correctly flagged trunks at cell corners but locked down every
cell adjacent to a forest because canopies overhanging a single corner
dropped the cell's headroom to near zero. Centre-only loses some precision
on trunks at cell edges but keeps forest-adjacent cells walkable. The trees
are now spaced wide enough (24-voxel grid) that a trunk almost always
straddles the centre of *its own* nav cell, so the trade-off works out.

## Tree trunks are 18..25 voxels tall

Tall enough that the canopy bottom sits above the tank's head clearance
(`heightVoxels = 18`). Bumped from the original 8..15 because the canopy
otherwise dipped into walkable headroom and units couldn't path past trees.

## Cutter pitch — chassis stays level, drill articulates

`bodyPitchScale = 0.2` for the tunneler: the body only rotates 20% of
`u.pitch`; the remaining 80% is applied as an X rotation at the drill pivot.
Visually the chassis stays mostly level on slopes while the cutter follows
the dig angle.

The drill's pitch rotation uses **negative** sign (`makeRotationX(-cutterExtraPitch)`)
because the body's YXZ Euler convention puts positive X as nose-down, but
the drill is offset at +Z forward of the chassis pivot — that geometry
inverts the sign needed at the pivot to make the cutter dip with the path.

## Cutter has a floor clamp at `u.y`

`damageOrientedCylinder(... floorMeters: u.y)` ensures the disc-shaped carve
never reaches below the chassis bottom. Without this the cutter dug out the
floor of its own tunnel.

## Tunneler restricted to ≤40° dig pitch (down or up)

`maxPitchRad = 40 * π/180`. Volume A* rejects edges that would require
steeper pitch; `applyPathOrientation` clamps the rendered body pitch to the
same value. The user asked for "no digging over 40 degrees down" with
height relative to the tunneler's current Y, not the click point. Resolved
in `Game.ts` `resolveTarget` which respects `pitchCapRad` against a
`pitchOriginXZ` anchor at the unit's current position.

## Tunneler LMB target Y is relative to current Y

Click intent is "dig down by N metres from where I am", not "go to that
absolute Y". `resolveTarget` projects the cursor to a target offset from
`u.y`, capped by the 40° dig angle.

## Tunneler "forward only" cut box

4 cells in front, 3 cells to the sides. Per the user's request to keep the
cutter from chewing terrain to the rear or far side of the unit.

## Diagonal corner-cut: agile units (footprintRadius ≤ 1) are exempt

Soldiers can squeeze diagonally between two solid cardinals — vehicles
can't. Without the exemption, soldiers couldn't scramble onto a ledge from
the inside of an L-shaped corner.

## Tank is restricted to flat terrain

`maxStepVoxels = 4` (~27° slope), `bodyRoughnessVoxels = 5`,
`maxPitchRad = π/6`. Cliffs hard-block tank routes — the unit detours.
The user explicitly asked for the tank's climb angle to *not* allow steep
hills.

## Tank sinks into mud

`trackDamageFor(M_MUD)` returns peak 14, radius 0.4 m. Each tread pass
calls `damageSphere`; once a top voxel exceeds its 10 hp, it becomes air
and the tank's next surface follow drops `u.y` to the new top. The user
asked for "the tank can sink into the ground if the ground is soft."

## Soldier walk: legs counter-swing, body bobs one-sided

`Math.max(0, sin)` body bob means the model never dips below the snapped
feet position. The earlier symmetric ±sin clipped boots into the voxel
underneath. Amp doubled to keep the same visible lift.

## All animations use one-sided bob

After fixing it for the soldier the user asked us to "do this for all the
units" — same one-sided pattern with per-kind frequency and amplitude.

## No Vite dev server in our workflow

Per project rule (CLAUDE.md). Verify changes with `tsc --noEmit`,
`vitest run`, and `vite build` (one-shot). The user runs the dev server
themselves when they want to look visually.

## Test-driven for sim behaviour

If a behavior isn't covered by an existing test and we want to confirm it,
add a test in `tests/**/*.spec.ts`. Pathfinding, voxel edits, the cutter
carve, unit ticks — all run headless against the in-memory world.
