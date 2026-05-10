# Zero-Trust Migration Plan

The goal: move the authoritative game simulation off the browser. The
client becomes a renderer + input forwarder; the server is the source
of truth for every entity, voxel, projectile, and resource.

## Architecture target

```
Browser (renderer + input + UI)
        │  POST /game/input       (player commands)
        │  EventSource /game/stream (state snapshots)
        ▼
game-server.cjs (Node, authoritative)
        │  ticks the sim @ 20 Hz (or higher)
        │  owns all entities, voxels, AI, economy
        ▼
ai-server.cjs        — AI brain decisions
session-server.cjs   — lobby + matchmaking
```

Today (Phase 1) the game-server owns a small entity table with
position-only state. Phases below describe how to grow it into the
full authoritative engine.

## What's done — Phase 1 (this drop)

- `game-server.cjs` — Node process on `:3050`. Fixed-timestep tick
  (20 Hz). In-memory entity table with `{id, owner, kind, x, y, z,
  target, speed, hp}`. `/game/state` returns a one-shot JSON snapshot;
  `/game/stream` is SSE that broadcasts a snapshot every tick.
- `/game/input` accepts a single command or a batched array.
  Commands: `spawn_entity`, `move_entity`, `stop_entity`,
  `despawn_entity`. Owner check on every mutation.
- `src/net/GameClient.ts` — browser bridge. EventSource subscriber +
  POST batcher with 30 ms coalescing window.
- `nginx.conf` proxies `/game/stream` (with `proxy_buffering off` so
  SSE flushes promptly), `/game/*` for commands and `/game/state`,
  plus `/health/game`.
- Docker entrypoint launches the new server alongside `ai-server` and
  `session-server`.
- `main.ts` instantiates a `GameClient` after the lobby resolves and
  exposes it on `window.__gameClient` for inspection. The browser
  Game still runs the local sim; the GameClient subscribes to the
  server entity table in parallel.

The current server entity table is **not yet used to render the
in-game units**. It's a parallel authoritative store that proves the
transport, command/snapshot protocol, and ownership gates work
end-to-end.

## Phase 2 — Authoritative unit movement

Move just unit positions to the server.

1. On `Game.spawnInitialUnits` and any `units.spawn(...)` call, also
   issue a `spawn_entity` command via `GameClient`. Track the
   server-assigned id alongside the local one (`u.serverId = ...`).
2. When the player issues a move command, `routePath` runs a path
   query on the client, then sends a `move_entity` command per
   waypoint to the server.
3. The local `tickUnits` movement step stops mutating positions for
   units that have a `serverId`. Instead it copies position from the
   latest server snapshot. (`UnitRenderer` continues to draw `u.x/y/z`
   so no renderer change.)
4. `tickAggressiveStance` and friends keep producing `firingTarget`
   suggestions but cannot mutate `u.x/y/z` for server-owned units.

Outcome: the player's client cannot teleport units. Unit positions
match across all clients.

## Phase 3 — Authoritative buildings + economy

Move buildings, resources, train queues, and supply trucks.

1. Mirror `BuildingManager.place(...)` calls into a `place_building`
   command. The server owns the canonical `Building` table.
2. Extend the snapshot with `buildings`, `resources`, and the active
   construction stockpiles. Replace the client's `BuildingManager`
   array with a server-driven view.
3. Move `tickSupplyTrucks` server-side. Trucks are entities; the
   server-side tick handles fetch / deliver / resupply state machines.
4. Move `tickWorkers` (harvest loop). Worker positions become server
   entities; their state machine (mine / chop / deliver / idle) runs
   on the server.

Outcome: the player can't fake resources or skip construction
timers. Workers behave identically across clients.

## Phase 4 — Authoritative combat

Move projectiles + weapons.

1. Move `tickWeapons` and `Projectiles.tick` server-side. Projectiles
   become entities; impacts mutate authoritative HP / voxels.
2. Move voxel mutations server-side. Server holds the canonical voxel
   buffer; clients receive deltas (`voxel_set` events) and apply them
   to a local mirror for rendering.
3. Move `tickAggressiveStance`, `tickEvade`, `tickAAVehicles` to
   server. The client only emits "manual fire" commands; auto-engage
   is server-decided.

Outcome: player can't fake hits, dodges, or voxel destruction.

## Phase 5 — Authoritative AI + civilians + leaves

The remaining client-side ticks (`civilians.tick`, `leafDecay.tick`,
`saplings.tick`) move server-side. The `RemoteAIClient` becomes a
no-op (the AI brain in `ai-server.cjs` talks directly to
`game-server.cjs`).

## Phase 6 — Voxel world authority

Server holds the canonical voxel buffer. Clients store a local copy
for rendering and apply server-broadcast deltas. World generation
becomes server-side too — clients receive an initial snapshot stream
on join (chunks materialise as the player moves into them).

## Cross-cutting concerns

### Latency hiding

Once Phase 2 lands the player will feel input lag (move click → server
roundtrip → snapshot → render). Mitigations:

- *Client-side prediction*: client applies the move locally in the
  same frame and reconciles when the server snapshot arrives. Only
  works for single-player commands (your own units).
- *Interpolation*: render at t-100 ms so the snapshot stream's
  variance is hidden. Standard MMO trick.

### Bandwidth

A snapshot containing 200 entities at 20 Hz is ~80 KB/s — fine on
LAN, expensive on cellular. Plan: snapshot diffs (only changed
fields) once Phase 3 lands and the entity count grows.

### Cheat surface

Even at full server-authority, the client still controls camera /
fog-of-war / unit selection. Cheats that *read* state (maphack,
auto-aim) will need a separate "fog-of-war filter" on the snapshot —
the server omits entities the player shouldn't see. That's a Phase 4+
follow-up.

## How to verify Phase 1 today

```sh
# Inside the running container:
curl -s http://localhost:8080/health/game

# Spawn + move an entity:
curl -X POST http://localhost:8080/game/input \
  -H 'Content-Type: application/json' \
  -d '{"type":"spawn_entity","owner":"smoke","kind":"soldier","x":0,"z":0,"speed":4.5}'

curl -X POST http://localhost:8080/game/input \
  -H 'Content-Type: application/json' \
  -d '{"type":"move_entity","id":1,"owner":"smoke","x":10,"z":0}'

# Watch the SSE stream:
curl -N http://localhost:8080/game/stream
```

In the browser, after the lobby resolves: `window.__gameClient.send(...)`
and `window.__gameClient.latestSnapshot()`.
