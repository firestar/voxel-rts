/**
 * Player-side resource counters. Workers deposit into this via the deliver
 * step of `tickWorkers` in `Units.ts`. There's no spending logic yet — costs
 * for buildings / upgrades will key off `Resources` once those features land.
 */
export class Resources {
  wood = 0;
  metals = 0;
  food = 0;
  /**
   * Maximum population the player can field. Each completed
   * `neighborhood` tier adds 5 here; tracked independently of the
   * current unit count so the HUD can show "current / cap". Defaults to
   * a small bootstrap so the player has somewhere to put their starting
   * units before the first neighborhood goes up.
   */
  popCap = 10;
}
