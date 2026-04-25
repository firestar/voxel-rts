/**
 * 4-ary min-heap of (key, priority) pairs.
 * Better cache behavior than a binary heap on modern CPUs since each node has
 * 4 children stored contiguously.
 *
 * Keys are 32-bit ints; priorities are floats. Both are stored in flat typed arrays.
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
    let i = this.size++;
    this.keys[i] = key;
    this.prio[i] = priority;
    // Sift up.
    while (i > 0) {
      const parent = (i - 1) >> 2;
      if (this.prio[parent]! <= this.prio[i]!) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  /** Returns -1 if empty, else removes and returns the min-priority key. */
  pop(): number {
    if (this.size === 0) return -1;
    const top = this.keys[0]!;
    this.size--;
    if (this.size > 0) {
      this.keys[0] = this.keys[this.size]!;
      this.prio[0] = this.prio[this.size]!;
      this.siftDown(0);
    }
    return top;
  }

  /** Peek at min priority. Caller should check length > 0 first. */
  topPriority(): number { return this.prio[0]!; }

  private siftDown(i: number): void {
    const n = this.size;
    while (true) {
      const c0 = (i << 2) + 1;
      if (c0 >= n) return;
      const c1 = c0 + 1;
      const c2 = c0 + 2;
      const c3 = c0 + 3;
      let best = c0;
      let bestP = this.prio[c0]!;
      if (c1 < n && this.prio[c1]! < bestP) { best = c1; bestP = this.prio[c1]!; }
      if (c2 < n && this.prio[c2]! < bestP) { best = c2; bestP = this.prio[c2]!; }
      if (c3 < n && this.prio[c3]! < bestP) { best = c3; bestP = this.prio[c3]!; }
      if (this.prio[i]! <= bestP) return;
      this.swap(i, best);
      i = best;
    }
  }

  private swap(a: number, b: number): void {
    const tk = this.keys[a]!; this.keys[a] = this.keys[b]!; this.keys[b] = tk;
    const tp = this.prio[a]!; this.prio[a] = this.prio[b]!; this.prio[b] = tp;
  }
}
