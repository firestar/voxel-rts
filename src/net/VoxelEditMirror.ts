// Apply server-broadcast voxel-edit deltas to the local VoxelWorld.
//
// Phase 4.2 of the zero-trust migration: when client A fires a
// projectile that pits voxels, A sends a voxel_edit to the server,
// the server applies it to the authoritative override map and pushes
// a typed `voxel_edit` SSE event to every connected client. This
// mirror picks the event up on clients B, C, D… and replays the same
// sphere/set op against their VoxelWorld so they see the destruction
// without polling /world/edits.
//
// Echo suppression — when the originating client receives the
// broadcast back, the `sender` field matches its own playerId, so we
// skip the apply (the local sim already mutated the buffer in the
// same frame the command was issued).

import { AIR, MaterialId, VOXEL_SIZE } from '../voxel/types';
import { VoxelWorld } from '../voxel/VoxelWorld';
import { M_BEDROCK } from '../voxel/Materials';
import { GameClient, VoxelEditEvent, VoxelEditOp } from './GameClient';

export class VoxelEditMirror {
  /** Highest seq we've applied. Lets a future re-subscribe / catch-up
   *  fetch from /world/edits skip what we've already mirrored. */
  private appliedSeq = 0;
  private unsub: (() => void) | null = null;

  constructor(
    private world: VoxelWorld,
    private ownPlayerId: string,
  ) {}

  /** Hook into a connected GameClient's voxel-edit stream. Idempotent
   *  — calling twice doesn't double-subscribe. */
  attach(client: GameClient): void {
    if (this.unsub) return;
    this.unsub = client.onVoxelEdit(evt => this.onEvent(evt));
  }

  detach(): void {
    if (this.unsub) { this.unsub(); this.unsub = null; }
  }

  highestAppliedSeq(): number { return this.appliedSeq; }

  /** Process one event. Public so a snapshot-based catch-up path can
   *  feed historical entries through the same code. */
  onEvent(evt: VoxelEditEvent): void {
    if (evt.sender === this.ownPlayerId) {
      // Echo of our own write — local sim already applied it.
      this.appliedSeq = Math.max(this.appliedSeq, evt.seq);
      return;
    }
    if (evt.seq <= this.appliedSeq) return;
    this.applyOp(evt.op);
    this.appliedSeq = evt.seq;
  }

  private applyOp(op: VoxelEditOp): void {
    if (op.kind === 'sphere') {
      // Server stamps every voxel in the sphere with `mat`, skipping
      // bedrock. Match that semantics exactly so the client mirror
      // and the canonical override map stay byte-identical.
      stampVoxelSphere(
        this.world,
        op.x, op.y, op.z,
        op.radius,
        op.mat as MaterialId,
      );
      return;
    }
    if (op.kind === 'set') {
      for (const w of op.ops) {
        if (!this.world.inBounds(w.x, w.y, w.z)) continue;
        const cur = this.world.get(w.x, w.y, w.z);
        if (cur === M_BEDROCK) continue;
        this.world.set(w.x, w.y, w.z, w.mat as MaterialId);
      }
    }
  }
}

/** Write `mat` to every voxel inside the (centre, radius) sphere,
 *  skipping bedrock. Centre + radius are in metres; the server's
 *  `applyVoxelOpToOverrides` walks the same AABB at voxel resolution,
 *  so this routine has to match that loop body. */
function stampVoxelSphere(
  world: VoxelWorld,
  wx: number, wy: number, wz: number,
  radiusMeters: number,
  mat: MaterialId,
): void {
  const cx = Math.floor(wx / VOXEL_SIZE);
  const cy = Math.floor(wy / VOXEL_SIZE);
  const cz = Math.floor(wz / VOXEL_SIZE);
  const r = Math.ceil(radiusMeters / VOXEL_SIZE);
  if (r <= 0) return;
  const r2 = r * r;
  for (let dz = -r; dz <= r; dz++) {
    const z = cz + dz;
    const dz2 = dz * dz;
    for (let dy = -r; dy <= r; dy++) {
      const y = cy + dy;
      const dyz2 = dz2 + dy * dy;
      if (dyz2 > r2) continue;
      const remaining = r2 - dyz2;
      const dxMax = Math.floor(Math.sqrt(remaining));
      for (let dx = -dxMax; dx <= dxMax; dx++) {
        const x = cx + dx;
        if (!world.inBounds(x, y, z)) continue;
        const cur = world.get(x, y, z);
        if (cur === M_BEDROCK) continue;
        // Skip air→air noops so the renderer's dirty bookkeeping
        // doesn't churn on an empty crater.
        if (mat === AIR && cur === AIR) continue;
        world.set(x, y, z, mat);
      }
    }
  }
}
