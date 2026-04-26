/**
 * Resource piles. A harvester worker drops a Pile on the ground when their
 * carrying buffer hits cap; a transporter worker later picks the pile up and
 * ferries it to a Storage building. Piles are world-space entities — they
 * don't write voxels, just appear in the renderer as a small visual marker.
 */
export interface Pile {
  id: number;
  /** World-space position in meters. Y is the unit feet-on-ground value at drop time. */
  x: number; y: number; z: number;
  wood: number;
  metals: number;
  /**
   * If non-zero, the id of the transporter unit that's currently committed to
   * collecting this pile. Used so multiple transporters don't dogpile a
   * single pile. Cleared if the transporter dies / its task resets.
   */
  claimedBy: number;
}

export class PileManager {
  piles: Pile[] = [];
  private nextId = 1;

  /** Drop a new pile. Returns the created Pile so callers can wire it up. */
  drop(x: number, y: number, z: number, wood: number, metals: number): Pile {
    const p: Pile = { id: this.nextId++, x, y, z, wood, metals, claimedBy: 0 };
    this.piles.push(p);
    return p;
  }

  /**
   * Find the nearest unclaimed (or claimed-by-this-unit) pile to (x, z).
   * Returns null if there are no candidate piles. We restrict to XZ distance
   * so a transporter chasing a pile downstairs / on a hill isn't confused by
   * Y differences that don't actually affect routing time.
   */
  nearest(x: number, z: number, byUnitId: number): Pile | null {
    let best: Pile | null = null;
    let bestD2 = Infinity;
    for (const p of this.piles) {
      if (p.claimedBy !== 0 && p.claimedBy !== byUnitId) continue;
      const dx = p.x - x, dz = p.z - z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD2) { bestD2 = d2; best = p; }
    }
    return best;
  }

  /** Remove a pile by id. Used after a transporter picks it up. */
  remove(id: number): void {
    for (let i = 0; i < this.piles.length; i++) {
      if (this.piles[i]!.id === id) {
        const last = this.piles[this.piles.length - 1]!;
        this.piles[i] = last;
        this.piles.pop();
        return;
      }
    }
  }

  /** Drop any claim a unit had on a pile (call when the transporter dies / is reassigned). */
  releaseClaimsBy(unitId: number): void {
    for (const p of this.piles) {
      if (p.claimedBy === unitId) p.claimedBy = 0;
    }
  }
}
