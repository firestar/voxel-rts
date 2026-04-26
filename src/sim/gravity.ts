/**
 * Downward acceleration in m/s², shared by units and projectiles.
 *
 * Slightly snappier than real-world 9.81 — units feel "weighty" without dragging
 * out the fall arc, and projectiles drop at the same rate the rest of the sim
 * uses so a bullet's gravity drop matches the visual gravity of falling units.
 *
 * Lives in its own module to avoid an import cycle between `Units.ts` (which uses
 * it for falls) and `Projectiles.ts` (which uses it for ballistic drop).
 */
export const GRAVITY = 22;
