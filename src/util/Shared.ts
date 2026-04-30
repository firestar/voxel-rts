/**
 * Single source of truth for "can we use SharedArrayBuffer in this context".
 *
 * SAB requires the page to be cross-origin-isolated (COOP/COEP headers, set
 * by the vite dev/preview plugin in `vite.config.ts`). When that's missing
 * — typically a static-host preview without the right headers — every grid
 * falls back to plain ArrayBuffer and the worker pathway runs synchronously
 * on the main thread (workers can't share buffers, so off-loading would mean
 * copying ~50–500 KB per request, which is a net loss).
 */
export function sharedBuffersAvailable(): boolean {
  return (
    typeof SharedArrayBuffer !== 'undefined' &&
    (globalThis as unknown as { crossOriginIsolated?: boolean }).crossOriginIsolated === true
  );
}
