/**
 * 4-ary min-heap of (key, priority) pairs.
 * Better cache behavior than a binary heap on modern CPUs since each node has
 * 4 children stored contiguously.
 *
 * Keys are 32-bit ints; priorities are floats. Both are stored in flat typed arrays.
 *
 * Push and pop use the "hole" pattern — the entry being moved is held in a
 * register and only written to its final slot once, instead of swapping pairs
 * at every level of the sift. That halves the typed-array writes in the hot
 * A* inner loop.
 */
export class FourAryHeap {
  private keys: Int32Array;
  private prio: Float32Array;
  private size = 0;

  constructor(capacity: number) {
    this.keys = new Int32Array(capacity);
    this.prio = new Float32Array(capacity);
  }

  get length(): number { return this.size; }

  clear(): void { this.size = 0; }

  push(key: number, priority: number): void {
    if (this.size >= this.keys.length) {
      const newCap = this.keys.length * 2;
      const nk = new Int32Array(newCap);
      const np = new Float32Array(newCap);
      nk.set(this.keys);
      np.set(this.prio);
      this.keys = nk;
      this.prio = np;
    }
    const keys = this.keys;
    const prio = this.prio;
    let i = this.size++;
    // Sift up using the hole pattern: walk parents downward into the hole,
    // then drop the new entry at the final position.
    while (i > 0) {
      const parent = (i - 1) >> 2;
      const pp = prio[parent]!;
      if (pp <= priority) break;
      keys[i] = keys[parent]!;
      prio[i] = pp;
      i = parent;
    }
    keys[i] = key;
    prio[i] = priority;
  }

  /** Returns -1 if empty, else removes and returns the min-priority key. */
  pop(): number {
    if (this.size === 0) return -1;
    const keys = this.keys;
    const prio = this.prio;
    const top = keys[0]!;
    const n = --this.size;
    if (n > 0) {
      const movedK = keys[n]!;
      const movedP = prio[n]!;
      let i = 0;
      while (true) {
        const c0 = (i << 2) + 1;
        if (c0 >= n) break;
        const c1 = c0 + 1;
        const c2 = c0 + 2;
        const c3 = c0 + 3;
        let best = c0;
        let bestP = prio[c0]!;
        if (c1 < n) { const p = prio[c1]!; if (p < bestP) { best = c1; bestP = p; } }
        if (c2 < n) { const p = prio[c2]!; if (p < bestP) { best = c2; bestP = p; } }
        if (c3 < n) { const p = prio[c3]!; if (p < bestP) { best = c3; bestP = p; } }
        if (movedP <= bestP) break;
        keys[i] = keys[best]!;
        prio[i] = bestP;
        i = best;
      }
      keys[i] = movedK;
      prio[i] = movedP;
    }
    return top;
  }

  /** Peek at min priority. Caller should check length > 0 first. */
  topPriority(): number { return this.prio[0]!; }
}
