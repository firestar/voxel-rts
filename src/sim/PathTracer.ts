import { Unit } from './Units';

const SAMPLE_INTERVAL_S = 0.1;
const MAX_SAMPLES_PER_UNIT = 200_000;
const MAX_SPEED_MPS = 8;

interface Sample { x: number; z: number; t: number; }

interface UnitTrace {
  kind: string;
  entries: Sample[];
}

export class PathTracer {
  enabled = false;
  private traces = new Map<number, UnitTrace>();
  private simTime = 0;
  private nextSampleAt = 0;

  tick(dt: number, units: ReadonlyArray<Unit>): void {
    if (!this.enabled) return;
    this.simTime += dt;
    if (this.simTime < this.nextSampleAt) return;
    this.nextSampleAt = this.simTime + SAMPLE_INTERVAL_S;
    for (const u of units) {
      if (u.hp <= 0) continue;
      let trace = this.traces.get(u.id);
      if (!trace) {
        trace = { kind: u.kind, entries: [] };
        this.traces.set(u.id, trace);
      }
      if (trace.entries.length < MAX_SAMPLES_PER_UNIT) {
        trace.entries.push({ x: u.x, z: u.z, t: this.simTime });
      }
    }
  }

  sampleCount(): number {
    let n = 0;
    for (const t of this.traces.values()) n += t.entries.length;
    return n;
  }

  unitCount(): number { return this.traces.size; }

  /**
   * Render the trace map to a canvas. Each segment is colored by its
   * instantaneous speed (red = stuck, green = at MAX_SPEED_MPS or above).
   * Synchronous so the caller can use it during page-unload handlers.
   */
  renderCanvas(worldXMeters: number, worldZMeters: number): HTMLCanvasElement | null {
    if (this.traces.size === 0) return null;
    const SIZE = 2048;
    const sx = SIZE / worldXMeters;
    const sz = SIZE / worldZMeters;
    const canvas = document.createElement('canvas');
    canvas.width = SIZE;
    canvas.height = SIZE;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    ctx.fillStyle = '#0d0d12';
    ctx.fillRect(0, 0, SIZE, SIZE);

    ctx.strokeStyle = '#1a1a22';
    ctx.lineWidth = 1;
    for (let g = 16; g < worldXMeters; g += 16) {
      const px = g * sx;
      ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, SIZE); ctx.stroke();
    }
    for (let g = 16; g < worldZMeters; g += 16) {
      const pz = g * sz;
      ctx.beginPath(); ctx.moveTo(0, pz); ctx.lineTo(SIZE, pz); ctx.stroke();
    }

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const trace of this.traces.values()) {
      const e = trace.entries;
      if (e.length < 2) continue;
      const lw = trace.kind === 'supply_truck' || trace.kind === 'tank' || trace.kind === 'rocket_truck' || trace.kind === 'aa_vehicle' || trace.kind === 'tunneler' ? 4 : 2.5;
      ctx.lineWidth = lw;
      for (let i = 1; i < e.length; i++) {
        const a = e[i - 1]!;
        const b = e[i]!;
        const dt = Math.max(1e-3, b.t - a.t);
        const speed = Math.hypot(b.x - a.x, b.z - a.z) / dt;
        const t = Math.min(1, speed / MAX_SPEED_MPS);
        const hue = t * 120;
        ctx.strokeStyle = `hsl(${hue.toFixed(0)},90%,55%)`;
        ctx.beginPath();
        ctx.moveTo(a.x * sx, a.z * sz);
        ctx.lineTo(b.x * sx, b.z * sz);
        ctx.stroke();
      }
      const last = e[e.length - 1]!;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(last.x * sx, last.z * sz, 4, 0, Math.PI * 2);
      ctx.fill();
    }

    drawLegend(ctx, this.unitCount(), this.sampleCount());
    return canvas;
  }

  /** Build a PNG and trigger an `<a download>` click. Synchronous-friendly path. */
  saveAsDownload(worldXMeters: number, worldZMeters: number): boolean {
    const canvas = this.renderCanvas(worldXMeters, worldZMeters);
    if (!canvas) return false;
    const dataUrl = canvas.toDataURL('image/png');
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = `path-trace-${Date.now()}.png`;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    return true;
  }

  /**
   * Render and ship the PNG to the local log-server via `sendBeacon`. This is
   * the unload-safe path: browsers may suppress synthetic `<a download>` clicks
   * fired from `beforeunload`/`pagehide`, but `sendBeacon` is purpose-built for
   * the unload path. Returns false when the queue could not accept the blob.
   */
  saveViaBeacon(worldXMeters: number, worldZMeters: number, url = 'http://localhost:4444/trace'): boolean {
    const canvas = this.renderCanvas(worldXMeters, worldZMeters);
    if (!canvas) return false;
    const dataUrl = canvas.toDataURL('image/png');
    const comma = dataUrl.indexOf(',');
    if (comma < 0) return false;
    const bin = atob(dataUrl.slice(comma + 1));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const blob = new Blob([bytes], { type: 'image/png' });
    return navigator.sendBeacon(url, blob);
  }
}

function drawLegend(ctx: CanvasRenderingContext2D, units: number, samples: number): void {
  const x = 30, y = 30, w = 240, h = 18;
  const grad = ctx.createLinearGradient(x, 0, x + w, 0);
  for (let s = 0; s <= 10; s++) {
    grad.addColorStop(s / 10, `hsl(${(s / 10) * 120},90%,55%)`);
  }
  ctx.fillStyle = grad;
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 1;
  ctx.strokeRect(x, y, w, h);
  ctx.fillStyle = '#ffffff';
  ctx.font = '14px monospace';
  ctx.textBaseline = 'top';
  ctx.fillText('path trace — color = speed', x, y - 18);
  ctx.fillText('0 m/s', x, y + h + 4);
  ctx.fillText(`${MAX_SPEED_MPS}+ m/s`, x + w - 56, y + h + 4);
  ctx.fillText(`units=${units}  samples=${samples}`, x, y + h + 24);
}
