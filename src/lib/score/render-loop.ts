/*
 * render-loop — per-frame rAF loop that scrolls the score pan.
 *
 * Translates .score-pan based on the player's current ms, handles
 * loop wrapping, and drives chrome/tempo overlay updates.
 */
import type { ScorePlayer } from './player';
import type { TempoEvent } from './types';
import type { ChromeOverlay, TempoOverlay } from './chrome-overlay';

/**
 * Last event in `events` whose startMs ≤ ms. Used to pick the active
 * header (clef/keysig) and tempo each frame. `events` is sorted by
 * startMs with a guaranteed entry at startMs=0, so the result is
 * always defined. Cheap enough to call each frame given typical
 * event counts.
 */
function eventAtMs<T extends { startMs: number }>(
  events: ReadonlyArray<T>, ms: number,
): T {
  let e = events[0];
  for (const cand of events) {
    if (cand.startMs <= ms) e = cand;
    else break;
  }
  return e;
}

/** Set up the rAF render loop that translates the pan. For loop scores,
 *  tracks a `wrapOffset` so the translate stays in (-musicWidth, 0] via
 *  invisible ±musicWidth teleports. Returns a cancel fn. */
export function setupRenderLoop(args: {
  host: HTMLElement;
  pan: HTMLElement;
  player: ScorePlayer;
  loop: boolean;
  musicWidth: number;
  /** Absolute playhead x (stage-px from left). Fixed across stage resizes
   *  so the playhead position is independent of both key signature and
   *  viewport width changes. */
  playheadPx: number;
  xAtMs: (ms: number) => number;
  /** Chrome overlay (clef + keysig + meter tracks). Each frame we call
   *  `setMs(ms)` and per-axis per-staff tracks each binary-search their
   *  own layers — independent crossfades, no global fingerprint. Null
   *  when the score has no chrome to display (degenerate edge case). */
  chromeOverlay: ChromeOverlay | null;
  /** Tempo events within one iteration, sorted by startMs with a
   *  guaranteed entry at 0. Drives the tempo overlay text swap. */
  tempoEvents: ReadonlyArray<TempoEvent>;
  /** Tempo overlay; null for scores with only one tempo (no chrome
   *  needed when the marking never changes). */
  tempoOverlay: TempoOverlay | null;
}): () => void {
  const { host, pan, player, loop, musicWidth, playheadPx, xAtMs,
          chromeOverlay, tempoEvents, tempoOverlay } = args;
  let rafId = 0;
  let lastRenderMs = -1;
  let wrapOffset = 0;
  let lastIterSeen = 0;

  function frame() {
    const ms = player.currentMs();
    if (ms !== lastRenderMs) {
      lastRenderMs = ms;

      let translateX: number;
      if (loop) {
        const containerX = xAtMs(ms);
        const iter = player.currentIteration();
        if (iter !== lastIterSeen) {
          wrapOffset -= (iter - lastIterSeen) * musicWidth;
          lastIterSeen = iter;
        }
        translateX = playheadPx - containerX + wrapOffset;
        // Normalize translate into (-musicWidth, 0] via a phantom leader
        // tile at `-musicWidth` so the seam is visually seamless. The
        // forward wrap (`<= -musicWidth`) handles natural playback drift.
        // The downward wrap (`> 0`) only matters when wrapOffset has
        // accumulated state from prior iterations / backward jumps —
        // skipping it when wrapOffset is zero preserves the legitimate
        // fresh-start pose where translateX is a small positive value
        // (first note's natural x sits slightly left of the playhead).
        while (translateX <= -musicWidth) { translateX += musicWidth; wrapOffset += musicWidth; }
        if (wrapOffset !== 0) {
          while (translateX > 0) { translateX -= musicWidth; wrapOffset -= musicWidth; }
        }
      } else {
        translateX = playheadPx - xAtMs(ms);
      }
      // translate3d (vs translateX) forces a compositor layer on most
      // browsers — critical for the huge pan SVGs (multi-thousand-px
      // wide on long pieces) where per-frame repaints are otherwise
      // CPU-bound.
      pan.style.transform = `translate3d(${translateX}px, 0, 0)`;
      host.classList.toggle('is-playing', player.isPlaying());

      // Per-track chrome update. Each (staff, axis) track binary-searches
      // its own layers and toggles `.is-current`; no global fingerprint
      // state means a clef change on staff 1 doesn't ripple to staves 0
      // and 2. For loop mode `ms` is already modulo'd to one iteration,
      // so wrapping naturally returns each track to its initial layer.
      if (chromeOverlay) chromeOverlay.setMs(ms);
      if (tempoOverlay && tempoEvents.length > 1) {
        tempoOverlay.setCurrent(eventAtMs(tempoEvents, ms));
      }
    }
    rafId = requestAnimationFrame(frame);
  }
  frame();
  return () => cancelAnimationFrame(rafId);
}
