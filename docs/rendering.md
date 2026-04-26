# Rendering

Three.js + WebGL2. World is greedy-meshed per chunk; units are instanced by
part.

Source: `src/render/`, `src/workers/mesher.worker.ts`.

## World rendering

- One `THREE.Mesh` per chunk in `ChunkMeshRegistry`. Geometry is rebuilt by
  `mesher.worker.ts` on edits and swapped in place.
- Single `THREE.MeshLambertMaterial` with `vertexColors: true`. AO is in the
  alpha channel of vertex colors and multiplied into diffuse.
- One directional + hemisphere light. No shadow maps.
- `three-mesh-bvh` rebuilt on each chunk for picking, line-of-fire,
  explosion sphere queries.

## Camera

Tilted RTS orbit (~55° pitch). WASD + edge scroll, RMB yaw, wheel zoom (clamp
8–40 m above ground).

## Unit rendering (`UnitRenderer.ts`)

Per-kind, per-part `InstancedMesh`es. Capacity 256 each; `count` is updated
each frame to the number of live units of that kind.

### Per-frame flow (each unit)

1. Build the body matrix:
   - Translate to `(u.x, u.y + feetOffset + bodyBob, u.z)`.
   - Rotate by Euler `(bodyPitch, u.heading, u.roll)` order `'YXZ'`.
   - For tunneler, `bodyPitch = u.pitch * 0.2` (chassis stays mostly level).
     For soldier and tank, `bodyPitch = u.pitch`.
2. Set body part(s) at the body matrix.
3. Set animated parts at body × part-local matrix:
   - **Soldier legs**: hip-offset · X-rotation by ±`swing`.
   - **Tank turret**: translate by (0, `TANK_TURRET_PIVOT_Y`, `TANK_TURRET_PIVOT_Z`)
     premultiplied by body (turret currently locked to hull yaw).
   - **Tunneler drill**: translate to drill pivot · X-rotation by
     `-cutterExtraPitch` · Z-rotation by `spin`.
4. Selection ring follows the selected unit's `(u.x, u.y + 0.05, u.z)`.

### `feetOffset` (per kind)

Each model's lowest geometry sits at a slightly different body-local Y.
`feetOffset` shifts the whole body so that lowest point lines up with `u.y`
(the snapped voxel-top position).

| Kind | Offset | Why |
|---|---|---|
| soldier | +0.05 | Boot bottom at body-local y = -0.05 → lift |
| tank | -0.05 | Tread bottom at body-local y = +0.05 → drop |
| tunneler | 0 | Tread bottom at body-local y = 0 already |

### Walk bob (one-sided)

`bodyBob = isMoving ? max(0, sin(distanceWalked * freq + id)) * amp : 0`

Per-kind freq/amp:

| Kind | bobFreq | bobAmp |
|---|---|---|
| soldier | 6.0 | 0.08 |
| tank | 3.0 | 0.04 |
| tunneler | 4.0 | 0.05 |

The lift is **one-sided** so the model never dips below `u.y` (which is the
static feet position used by collision and pathing). The previous symmetric
±sin had the model descend below the snapped feet on the down-swing,
clipping into the voxel underneath. Amplitude is doubled vs. the symmetric
version to keep the same visual lift.

### Drill spin

```ts
const spin = isMoving ? now * 18
           : u.carveCooldown > 0 ? now * 12
           : 0;
```

Spin is around the unit's local Z (the drill's forward axis).

### Drill cutter pitch sign

The body uses YXZ Euler with positive X = nose-down. The drill is mounted at
+Z forward of the chassis pivot, which inverts the sign of the X rotation
needed at the pivot for the cutter to visually dip with the path. So the
drill's `cutterPitchM = makeRotationX(-cutterExtraPitch)`. Without the
negation, the cutter swings up while the path goes down.

### Selection rings

`THREE.LineSegments` ring per kind, depth-test off, render order 999. Hidden
when no unit of that kind is selected; positioned at the selected unit each
frame.

| Kind | Color | Radius |
|---|---|---|
| soldier | 0x00ff88 (green) | 0.6 m |
| tank | 0xffaa33 (orange) | 1.6 m |
| tunneler | 0xffe066 (yellow) | 0.7 m |

## Other render systems

- `BuildingGhost.ts` — semi-transparent placement preview, green/red tint.
- `PathPreview.ts` — debug visualization of found paths.
- `TargetMarker.ts` — click-target indicator (the cyan dashed line).
- `DebrisParticles.ts` — instanced cube pool for explosion debris.
