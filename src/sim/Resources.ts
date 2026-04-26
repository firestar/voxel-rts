/**
 * Player-side resource counters. Workers deposit into this via the deliver
 * step of `tickWorkers` in `Units.ts`. There's no spending logic yet — costs
 * for buildings / upgrades will key off `Resources` once those features land.
 */
export class Resources {
  wood = 0;
  metals = 0;
  food = 0;
}
