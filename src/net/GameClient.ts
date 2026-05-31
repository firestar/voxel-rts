// Browser-side bridge to the authoritative game-server. Phase 1 of the
// zero-trust migration — the client owns rendering only, the server
// owns the entity table.
//
// Receives state snapshots over Server-Sent Events (`/game/stream`)
// and ships commands via batched POST to `/game/input`. Snapshots are
// idempotent JSON; reconnects pick up from whatever the server has
// without a replay log because the snapshot itself is the full state.

export interface ServerEntity {
  id: number;
  /** Stable key the client picked at spawn time. Lets the client
   *  match snapshot rows back to local units without waiting for the
   *  spawn ack roundtrip. */
  clientTag: string | null;
  kind: string;
  owner: string;
  x: number;
  y: number;
  z: number;
  hp: number;
  target: { x: number; z: number } | null;
  pathLen: number;
}

export interface ServerProjectile {
  id: number;
  clientTag: string | null;
  kind: string;
  owner: string;
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  age: number;
  ownerId: number;
}

export interface ServerBuilding {
  id: number;
  clientTag: string | null;
  kind: string;
  owner: string;
  ox: number; oz: number; floorY: number;
  cellsW: number; cellsD: number;
  upgradeState: string;
  hp: number; maxHp: number;
  trainQueueLen: number;
  destroyed: boolean;
}

export interface ResourcePool {
  food: number; metals: number; wood: number; popCap: number;
}

export interface ServerSnapshot {
  tick: number;
  rev: number;
  voxelEditSeq?: number;
  entities: ServerEntity[];
  /** Phase 4.1: projectiles in flight, ticked server-side. Optional
   *  on the wire because pre-Phase-4.1 servers don't include the
   *  field — clients should treat absence as "no projectiles". */
  projectiles?: ServerProjectile[];
  buildings?: ServerBuilding[];
  resources?: Record<string, ResourcePool>;
}

/** Cross-cutting Phase: incremental snapshot delta. Server emits one
 *  per tick (between full-snapshot resyncs every 100 ticks); the
 *  GameClient merges them into its in-memory snapshot store and
 *  fires onSnapshot listeners with the merged state. Each `*Changed`
 *  array carries replacement rows (full record); `*Removed` arrays
 *  carry ids to drop. `resourcesChanged` is a per-owner replacement
 *  map. */
export interface SnapshotDelta {
  tick: number;
  rev: number;
  voxelEditSeq?: number;
  entitiesChanged?: ServerEntity[];
  entitiesRemoved?: number[];
  buildingsChanged?: ServerBuilding[];
  buildingsRemoved?: number[];
  projectilesChanged?: ServerProjectile[];
  projectilesRemoved?: number[];
  resourcesChanged?: Record<string, ResourcePool>;
}

/** Voxel-edit op shape on the wire — matches what the server logs and
 *  broadcasts. `kind:'sphere'` covers projectile splashes (centre
 *  point + radius + target material); `kind:'set'` covers explicit
 *  per-voxel writes. */
export type VoxelEditOp =
  | { kind: 'sphere'; x: number; y: number; z: number; radius: number; mat: number }
  | { kind: 'set'; ops: Array<{ x: number; y: number; z: number; mat: number }> };

export interface VoxelEditEvent {
  seq: number;
  tick: number;
  /** Sender's playerId. Receivers compare against their own playerId
   *  to suppress echo of locally-issued edits. */
  sender: string;
  op: VoxelEditOp;
}

/** Phase 4.1b: server-broadcast event when a projectile's per-tick
 *  raycast finds a non-AIR voxel along its flight path. Carries both
 *  the projectile metadata (kind, owner, world position) and the
 *  impacted voxel + material so the receiver can play impact
 *  effects without correlating against a separate voxel_edit. */
export interface ProjectileImpactEvent {
  seq: number;
  tick: number;
  projectileId: number;
  clientTag: string | null;
  kind: string;
  owner: string;
  ownerId: number;
  /** World-space position at the moment of impact (m). */
  x: number; y: number; z: number;
  /** Voxel coordinates of the first solid voxel along the segment.
   *  All -1 when the impact was a direct entity hit (no terrain). */
  voxelX: number; voxelY: number; voxelZ: number;
  /** Material id of the impacted voxel — useful for terrain-specific
   *  particle / sound choices (mud splash vs. stone spark). 0 when
   *  the projectile hit an entity, not terrain. */
  voxelMat: number;
  /** Phase 4.1d: id of the entity directly hit by the projectile, or
   *  -1 when the impact landed on terrain. The entity's HP was
   *  already deducted server-side by the time the event fires. */
  hitEntityId: number;
}

export type GameCommand =
  | { type: 'spawn_entity'; clientTag: string; owner?: string; kind?: string; x?: number; y?: number; z?: number; speed?: number; hp?: number }
  | { type: 'move_entity'; id?: number; clientTag?: string; owner?: string; x: number; z: number }
  | { type: 'set_path'; id?: number; clientTag?: string; owner?: string; waypoints: Array<{ x: number; y: number; z: number }> }
  | { type: 'stop_entity'; id?: number; clientTag?: string; owner?: string }
  | { type: 'despawn_entity'; id?: number; clientTag?: string; owner?: string }
  | { type: 'set_position'; id?: number; clientTag?: string; owner?: string; x: number; y: number; z: number }
  | { type: 'place_building'; clientTag: string; owner?: string; kind?: string; ox?: number; oz?: number; floorY?: number; cellsW?: number; cellsD?: number; upgradeState?: string; hp?: number; maxHp?: number; trainQueue?: string[]; civilianCap?: number }
  | { type: 'update_building'; id?: number; clientTag?: string; owner?: string; hp?: number; maxHp?: number; upgradeState?: string; trainQueue?: string[]; destroyed?: boolean; civilianCap?: number }
  | { type: 'despawn_building'; id?: number; clientTag?: string; owner?: string }
  | { type: 'set_resources'; owner: string; food?: number; metals?: number; wood?: number; popCap?: number }
  | { type: 'damage_entity'; id?: number; clientTag?: string; amount: number }
  | { type: 'damage_building'; id?: number; clientTag?: string; amount: number }
  | { type: 'voxel_edit'; owner?: string; x?: number; y?: number; z?: number; radius?: number; mat?: number; ops?: Array<{ x: number; y: number; z: number; mat: number }> }
  | { type: 'set_world_seed'; seed: number }
  | { type: 'spawn_projectile'; clientTag: string; owner?: string; kind?: string;
      x: number; y: number; z: number;
      vx: number; vy: number; vz: number;
      dragPerSecond?: number; gravityScale?: number;
      maxLifeSeconds?: number; ownerId?: number;
      hitRadiusMeters?: number; explosive?: boolean; explosionRadiusMeters?: number;
      hitDamage?: number; damagePeak?: number }
  | { type: 'despawn_projectile'; id?: number; clientTag?: string; owner?: string }
  | {
      type: 'arm_unit';
      id?: number; clientTag?: string; owner?: string;
      kind?: string;
      rangeMeters?: number;
      fireIntervalSec?: number;
      projectileSpeed?: number;
      projectileDrag?: number;
      projectileGravityScale?: number;
      projectileMaxLife?: number;
      projectileHitRadius?: number;
      projectileHitDamage?: number;
      projectileExplosive?: boolean;
      projectileExplosionRadius?: number;
      projectileDamagePeak?: number;
    }
  | { type: 'disarm_unit'; id?: number; clientTag?: string; owner?: string }
  | { type: 'plant_sapling'; owner?: string; wx: number; wz: number; seed: number }
  | { type: 'queue_train'; id?: number; clientTag?: string; owner?: string; unitKind: string };

/** Cross-cutting Phase: latency hiding. Linearly interpolate between
 *  two real snapshots for entity + projectile positions; everything
 *  else (buildings, resources, hp, target field, train queues) takes
 *  `b`'s value verbatim — those fields shouldn't smear visually.
 *  `alpha` is clamped to [0, 1]. */
export function interpolateSnapshots(
  a: ServerSnapshot,
  b: ServerSnapshot,
  alpha: number,
): ServerSnapshot {
  const t = alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;
  // Index `a` by id so we can pair entities/projectiles in O(1).
  const aEntities = new Map<number, ServerEntity>();
  for (const e of a.entities) aEntities.set(e.id, e);
  const entities = b.entities.map(eB => {
    const eA = aEntities.get(eB.id);
    if (!eA) return eB;
    return {
      ...eB,
      x: eA.x + (eB.x - eA.x) * t,
      y: eA.y + (eB.y - eA.y) * t,
      z: eA.z + (eB.z - eA.z) * t,
    };
  });
  const aProjectiles = new Map<number, ServerProjectile>();
  for (const p of a.projectiles ?? []) aProjectiles.set(p.id, p);
  const projectiles = (b.projectiles ?? []).map(pB => {
    const pA = aProjectiles.get(pB.id);
    if (!pA) return pB;
    return {
      ...pB,
      x: pA.x + (pB.x - pA.x) * t,
      y: pA.y + (pB.y - pA.y) * t,
      z: pA.z + (pB.z - pA.z) * t,
    };
  });
  return {
    tick: b.tick,
    rev: b.rev,
    voxelEditSeq: b.voxelEditSeq,
    entities,
    projectiles,
    buildings: b.buildings,
    resources: b.resources,
  };
}

export interface SnapshotBufferEntry {
  receivedAt: number;
  snap: ServerSnapshot;
}

/** Locate the two buffer entries bracketing `targetMs`. Returns
 *  `{a, b, alpha}` where `alpha` is the lerp factor in [0, 1]. When
 *  `targetMs` is outside the buffer, `a` and `b` are both the closest
 *  entry and `alpha === 0` (caller can use `b.snap` directly). When
 *  the buffer is empty, returns null. */
export function findBracket(
  buffer: ReadonlyArray<SnapshotBufferEntry>,
  targetMs: number,
): { a: SnapshotBufferEntry; b: SnapshotBufferEntry; alpha: number } | null {
  if (buffer.length === 0) return null;
  if (buffer.length === 1) return { a: buffer[0]!, b: buffer[0]!, alpha: 0 };
  if (targetMs <= buffer[0]!.receivedAt) {
    return { a: buffer[0]!, b: buffer[0]!, alpha: 0 };
  }
  if (targetMs >= buffer[buffer.length - 1]!.receivedAt) {
    const last = buffer[buffer.length - 1]!;
    return { a: last, b: last, alpha: 0 };
  }
  for (let i = 0; i < buffer.length - 1; i++) {
    const a = buffer[i]!, b = buffer[i + 1]!;
    if (a.receivedAt <= targetMs && b.receivedAt >= targetMs) {
      const span = b.receivedAt - a.receivedAt;
      const alpha = span > 0 ? (targetMs - a.receivedAt) / span : 0;
      return { a, b, alpha };
    }
  }
  // Fallback (shouldn't hit given the boundary checks above).
  const last = buffer[buffer.length - 1]!;
  return { a: last, b: last, alpha: 0 };
}

/** Merge a `SnapshotDelta` into a base `ServerSnapshot`, returning a
 *  fresh object (the input is not mutated). When `base` is null we
 *  start from an empty snapshot — useful when the first event is
 *  somehow a delta before a resync arrives. */
export function applySnapshotDelta(
  base: ServerSnapshot | null,
  delta: SnapshotDelta,
): ServerSnapshot {
  const out: ServerSnapshot = base
    ? {
        tick: delta.tick,
        rev: delta.rev,
        voxelEditSeq: delta.voxelEditSeq ?? base.voxelEditSeq,
        entities: base.entities.slice(),
        projectiles: base.projectiles ? base.projectiles.slice() : [],
        buildings: base.buildings ? base.buildings.slice() : [],
        resources: { ...(base.resources ?? {}) },
      }
    : {
        tick: delta.tick,
        rev: delta.rev,
        voxelEditSeq: delta.voxelEditSeq,
        entities: [],
        projectiles: [],
        buildings: [],
        resources: {},
      };
  mergeRows(out, 'entities', delta.entitiesChanged, delta.entitiesRemoved);
  mergeRows(out, 'projectiles', delta.projectilesChanged, delta.projectilesRemoved);
  mergeRows(out, 'buildings', delta.buildingsChanged, delta.buildingsRemoved);
  if (delta.resourcesChanged) {
    for (const owner of Object.keys(delta.resourcesChanged)) {
      out.resources![owner] = delta.resourcesChanged[owner]!;
    }
  }
  return out;
}

function mergeRows<K extends 'entities' | 'projectiles' | 'buildings'>(
  out: ServerSnapshot,
  key: K,
  changed: NonNullable<ServerSnapshot[K]>[number][] | undefined,
  removed: number[] | undefined,
): void {
  if (!changed && !removed) return;
  const arr = (out[key] ?? []) as NonNullable<ServerSnapshot[K]>;
  // Index by id for O(1) replace.
  const byId = new Map<number, number>();
  arr.forEach((r, i) => byId.set((r as { id: number }).id, i));
  if (changed) {
    for (const row of changed) {
      const id = (row as { id: number }).id;
      const idx = byId.get(id);
      if (idx === undefined) {
        byId.set(id, arr.length);
        (arr as Array<NonNullable<ServerSnapshot[K]>[number]>).push(row);
      } else {
        (arr as Array<NonNullable<ServerSnapshot[K]>[number]>)[idx] = row;
      }
    }
  }
  if (removed && removed.length > 0) {
    const remove = new Set(removed);
    const filtered = (arr as Array<NonNullable<ServerSnapshot[K]>[number]>)
      .filter(r => !remove.has((r as { id: number }).id));
    (out[key] as unknown) = filtered;
    return;
  }
  (out[key] as unknown) = arr;
}

const DEFAULT_STREAM_URL = '/game/stream';
const DEFAULT_INPUT_URL = '/game/input';
/** Coalesce commands fired in the same frame into a single POST. The
 *  server validates the batch atomically. */
const FLUSH_INTERVAL_MS = 30;

export class GameClient {
  private streamUrl: string;
  private inputUrl: string;
  private es: EventSource | null = null;
  private snapshot: ServerSnapshot | null = null;
  private listeners = new Set<(s: ServerSnapshot) => void>();
  private voxelEditListeners = new Set<(e: VoxelEditEvent) => void>();
  /** Cross-cutting Phase: ring of recent snapshots for the
   *  interpolation buffer. Capped at INTERP_BUFFER_SIZE so a long
   *  session can't grow it unbounded. Each entry carries the
   *  arrival timestamp (`Date.now()` when the SSE event landed). */
  private snapshotBuffer: SnapshotBufferEntry[] = [];
  private static readonly INTERP_BUFFER_SIZE = 20;
  /** Default render-clock offset: pull state from 100 ms in the
   *  past so a 50 ms server tick + a typical jitter envelope can
   *  always be interpolated rather than extrapolated. */
  static readonly DEFAULT_INTERP_DELAY_MS = 100;
  private projectileImpactListeners = new Set<(e: ProjectileImpactEvent) => void>();
  private outbox: GameCommand[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  /** Identifies this client to the server so commands can later be
   *  authorized. Today the server just echoes it. */
  readonly playerId: string;

  constructor(opts: { streamUrl?: string; inputUrl?: string; playerId?: string } = {}) {
    this.streamUrl = opts.streamUrl ?? DEFAULT_STREAM_URL;
    this.inputUrl = opts.inputUrl ?? DEFAULT_INPUT_URL;
    this.playerId = opts.playerId ?? `p-${Math.random().toString(36).slice(2, 8)}`;
  }

  connect(): void {
    if (this.es) return;
    try {
      // Cross-cutting Phase: identify ourselves so the server can
      // strip other players' resources from the snapshot. The query
      // is appended idempotently — passing a streamUrl that already
      // carries `?player=` skips the second append.
      const sep = this.streamUrl.includes('?') ? '&' : '?';
      const url = this.streamUrl.includes('player=')
        ? this.streamUrl
        : `${this.streamUrl}${sep}player=${encodeURIComponent(this.playerId)}`;
      this.es = new EventSource(url);
    } catch (_err) {
      // Transport not available — leave snapshot null. Game runs in
      // single-player mode without server-driven entities.
      return;
    }
    this.es.onmessage = (ev) => {
      try {
        const snap = JSON.parse(ev.data) as ServerSnapshot;
        // Server resyncs send the full snapshot via the default
        // event; treat that as the new ground truth.
        this.snapshot = snap;
        this.pushToBuffer(snap);
        for (const fn of this.listeners) fn(snap);
      } catch (_e) { /* ignore parse errors */ }
    };
    // Cross-cutting Phase: per-tick incremental deltas. Merge into the
    // existing snapshot, then fan out to onSnapshot listeners with the
    // merged state so existing reconcilers don't need to know whether
    // they're seeing a full snapshot or a delta-derived one.
    this.es.addEventListener('snapshot_delta', (ev: MessageEvent) => {
      try {
        const delta = JSON.parse(ev.data) as SnapshotDelta;
        const merged = applySnapshotDelta(this.snapshot, delta);
        this.snapshot = merged;
        this.pushToBuffer(merged);
        for (const fn of this.listeners) fn(merged);
      } catch (_e) { /* ignore parse errors */ }
    });
    // Phase 4.2: typed voxel-edit deltas. The server pushes these
    // immediately after applyCommand resolves a voxel_edit, so other
    // clients can mirror the destruction without polling.
    this.es.addEventListener('voxel_edit', (ev: MessageEvent) => {
      try {
        const evt = JSON.parse(ev.data) as VoxelEditEvent;
        for (const fn of this.voxelEditListeners) fn(evt);
      } catch (_e) { /* ignore parse errors */ }
    });
    // Phase 4.1b: typed projectile-impact events. Server emits one
    // per terrain hit along a per-tick projectile raycast. Useful for
    // impact effects + future server-side damage attribution.
    this.es.addEventListener('projectile_impact', (ev: MessageEvent) => {
      try {
        const evt = JSON.parse(ev.data) as ProjectileImpactEvent;
        for (const fn of this.projectileImpactListeners) fn(evt);
      } catch (_e) { /* ignore parse errors */ }
    });
    this.es.onerror = () => {
      // Browser auto-retries SSE; we don't tear the connection down.
    };
  }

  disconnect(): void {
    if (this.es) { this.es.close(); this.es = null; }
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
  }

  /** Subscribe to snapshot updates. Returns an unsubscribe fn. */
  onSnapshot(fn: (s: ServerSnapshot) => void): () => void {
    this.listeners.add(fn);
    if (this.snapshot) fn(this.snapshot);
    return () => { this.listeners.delete(fn); };
  }

  /** Subscribe to voxel_edit broadcasts (server pushes one per
   *  authoritative voxel mutation). Returns an unsubscribe fn. */
  onVoxelEdit(fn: (e: VoxelEditEvent) => void): () => void {
    this.voxelEditListeners.add(fn);
    return () => { this.voxelEditListeners.delete(fn); };
  }

  /** Subscribe to projectile_impact events (server pushes one per
   *  per-tick raycast hit). Returns an unsubscribe fn. */
  onProjectileImpact(fn: (e: ProjectileImpactEvent) => void): () => void {
    this.projectileImpactListeners.add(fn);
    return () => { this.projectileImpactListeners.delete(fn); };
  }

  latestSnapshot(): ServerSnapshot | null { return this.snapshot; }

  /** Cross-cutting Phase: push a snapshot into the interpolation
   *  buffer with the current wall-clock timestamp. Exposed as a
   *  test seam too — vitest can feed deterministic timestamps via
   *  `_pushSnapshotForTest`. */
  private pushToBuffer(snap: ServerSnapshot, receivedAt = Date.now()): void {
    this.snapshotBuffer.push({ receivedAt, snap });
    while (this.snapshotBuffer.length > GameClient.INTERP_BUFFER_SIZE) {
      this.snapshotBuffer.shift();
    }
  }

  /** Test-only: append a snapshot at a given timestamp. Production
   *  code goes through the SSE handlers above. */
  _pushSnapshotForTest(snap: ServerSnapshot, receivedAt: number): void {
    this.pushToBuffer(snap, receivedAt);
  }

  /** Returns the synthesized snapshot for `targetMs` on the same
   *  clock the buffer uses. Out-of-range targets clamp to the
   *  closest entry; empty buffer returns null. */
  interpolatedAt(targetMs: number): ServerSnapshot | null {
    const bracket = findBracket(this.snapshotBuffer, targetMs);
    if (!bracket) return null;
    if (bracket.a === bracket.b) return bracket.b.snap;
    return interpolateSnapshots(bracket.a.snap, bracket.b.snap, bracket.alpha);
  }

  /** Convenience wrapper at `Date.now() - DEFAULT_INTERP_DELAY_MS`. */
  interpolatedSnapshot(): ServerSnapshot | null {
    return this.interpolatedAt(Date.now() - GameClient.DEFAULT_INTERP_DELAY_MS);
  }

  /** Lookup a server entity by its client-stable tag. Cheaper than
   *  scanning the snapshot when the caller already knows the tag. */
  entityByTag(tag: string): ServerEntity | null {
    const s = this.snapshot;
    if (!s) return null;
    for (const e of s.entities) if (e.clientTag === tag) return e;
    return null;
  }

  /** Send a command. Auto-batched; the actual POST happens within
   *  FLUSH_INTERVAL_MS. */
  send(cmd: GameCommand): void {
    // Stamp the owner so the server can authorize.
    if (cmd.type === 'spawn_entity' && !cmd.owner) cmd.owner = this.playerId;
    if ('owner' in cmd && !cmd.owner) cmd.owner = this.playerId;
    this.outbox.push(cmd);
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => { void this.flush(); }, FLUSH_INTERVAL_MS);
  }

  private async flush(): Promise<void> {
    this.flushTimer = null;
    if (this.outbox.length === 0) return;
    const batch = this.outbox.splice(0);
    try {
      await fetch(this.inputUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(batch),
      });
    } catch (_err) {
      // Drop on the floor for now. A future iteration can retry.
    }
  }
}
