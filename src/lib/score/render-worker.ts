/*
 * Score render worker — runs the heavy Verovio MXL→MEI conversion +
 * SVG render off the main thread, so a first-time score load doesn't
 * freeze scrolling and other UI.
 *
 * Protocol (single message type):
 *   request:  { id: number; src: ScoreSource }
 *   response: { id: number; ok: true; rendered: Rendered }
 *           | { id: number; ok: false; error: string }
 *
 * The worker imports `renderScoreUncached` from render.ts. Vite
 * tree-shakes the main thread's DOM-touching helpers (cloneMeasureShell
 * etc.) out of the worker bundle since this module doesn't reference
 * them — only the pure pipeline (Verovio call + DOMParser metadata
 * extraction + SVG string strip) ends up in the worker chunk.
 */
/// <reference lib="webworker" />
import { renderScoreUncached, type ScoreSource } from './render';
import type { Rendered } from './types';

interface Req { id: number; src: ScoreSource }
type Res =
  | { id: number; ok: true; rendered: Rendered }
  | { id: number; ok: false; error: string };

const ctx = self as unknown as DedicatedWorkerGlobalScope;

// `DOMParser` was only added to DedicatedWorkerGlobalScope in Chrome
// 121 (Jan 2024) / Edge 121. On older browsers it's absent and our
// pipeline (trimEmptyStaves, MEI metadata walker, SVG strip) would
// throw. Surface this as a one-time error response per request so the
// main-thread dispatcher can permanently disable the worker and fall
// back to running renderScoreUncached on the main thread.
const HAS_DOMPARSER = typeof (ctx as unknown as { DOMParser?: unknown }).DOMParser === 'function';

ctx.addEventListener('message', async (e: MessageEvent<Req>) => {
  const { id, src } = e.data;
  if (!HAS_DOMPARSER) {
    const res: Res = { id, ok: false, error: 'DOMParser unavailable in worker' };
    ctx.postMessage(res);
    return;
  }
  try {
    const rendered = await renderScoreUncached(src);
    const res: Res = { id, ok: true, rendered };
    ctx.postMessage(res);
  } catch (err) {
    const res: Res = { id, ok: false, error: String((err as Error)?.message ?? err) };
    ctx.postMessage(res);
  }
});
