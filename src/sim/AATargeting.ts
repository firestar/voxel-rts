/**
 * Pure anti-air interceptor assignment.
 *
 * Extracted from `Game.tickAAVehicles` so the target-selection rules — which
 * carried two bugs before iter80 — are unit-testable:
 *   1. AA must run for EVERY team (was player-only, so AI anti-air never fired).
 *   2. AA must never intercept its OWN team's rounds (friendly-fire), and must
 *      engage enemy rounds within range, nearest first, one projectile per
 *      vehicle (no two vehicles wasting shots on the same threat).
 *
 * The geometry/lead solving stays in Game; this module only decides WHICH
 * projectile (if any) each AA vehicle should engage.
 */

export interface AAVehicleInput {
  id: number;
  team: string;
  /** Muzzle position (world metres). */
  x: number;
  y: number;
  z: number;
  /** Effective engagement range (metres). */
  rangeMeters: number;
}

export interface AAProjectileInput {
  id: number;
  /** Team that fired the round, or null when unknown (building / un-owned). */
  ownerTeam: string | null;
  dead: boolean;
  /** Projectile kind — `aa_missile` interceptors are skipped to avoid loops. */
  kind: string;
  x: number;
  y: number;
  z: number;
}

/**
 * Assign each AA vehicle at most one incoming enemy projectile to intercept.
 * Returns a map of vehicle id → projectile id. A projectile is eligible for a
 * vehicle only when its owner team differs from the vehicle's team and it sits
 * within the vehicle's range; each projectile picks its nearest eligible
 * vehicle, and each vehicle keeps only its single closest assigned projectile.
 */
export function assignAAInterceptors(
  vehicles: AAVehicleInput[],
  projectiles: AAProjectileInput[],
): Map<number, number> {
  const result = new Map<number, number>();
  if (vehicles.length === 0) return result;
  const best = new Map<number, { projId: number; d2: number }>();

  for (const p of projectiles) {
    if (p.dead) continue;
    if (p.kind === 'aa_missile') continue;
    if (p.ownerTeam === null) continue; // no team info → can't prove it's hostile
    let bestId = -1;
    let bestD2 = Infinity;
    for (const v of vehicles) {
      if (v.team === p.ownerTeam) continue; // never intercept own-team rounds
      const dx = p.x - v.x;
      const dy = p.y - (v.y + 1.6);
      const dz = p.z - v.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > v.rangeMeters * v.rangeMeters) continue;
      if (d2 < bestD2) { bestD2 = d2; bestId = v.id; }
    }
    if (bestId < 0) continue;
    const prev = best.get(bestId);
    if (!prev || bestD2 < prev.d2) best.set(bestId, { projId: p.id, d2: bestD2 });
  }

  for (const [vehId, { projId }] of best) result.set(vehId, projId);
  return result;
}
