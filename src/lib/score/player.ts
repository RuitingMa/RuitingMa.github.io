/*
 * ScorePlayer — transport + audio scheduler.
 *
 * Owns the AudioContext and a Synth, exposes ms-precision currentMs() to
 * the render loop, and runs a 100ms-tick lookahead scheduler that hands
 * upcoming notes to the Synth. No DOM, no MEI parsing — those are
 * upstream of `Rendered`.
 *
 * The module-level `activePlayers` set ensures only one player on a page
 * sounds at a time: any new `play()` pauses every other member first.
 */
import { Synth } from './synth';
import type { Note, Rendered } from './types';

/** Players currently sounding audio. A new `play()` pauses every other
 *  member so two scores on the same page don't overlap. */
const activePlayers: Set<ScorePlayer> = new Set();

export class ScorePlayer {
  private static readonly LOOKAHEAD_MS = 250;
  private static readonly SCHED_INTERVAL_MS = 100;

  private ctx: AudioContext | null = null;
  private synth: Synth | null = null;
  private rendered: Rendered;
  private loop: boolean;
  private preRollMs: number;
  private tailMs: number;
  private playing = false;
  // AudioContext time that corresponds to score-time 0 of the current
  // playback run. Everything else is derived from (currentTime - iterStart).
  private iterStart = 0;
  // ms within the current iteration — set on pause so resume is seamless.
  private pausedAt = 0;
  // True in the "never played yet, or freshly reset to start" state.
  // When this is true AND pausedAt === 0, currentMs() reports -preRollMs
  // so the rest frame before first play already shows the score shifted
  // right by the lead-in distance. Clicking play then scrolls smoothly
  // from that pose with no visible jump. Any play() / seek() that
  // actually moves the position flips it false.
  private atFreshStart = true;
  // Absolute ms through which notes are already scheduled. Drives the
  // lookahead scheduler (we only add notes past this point).
  private scheduledUpTo = 0;
  private schedulerTimer: ReturnType<typeof setInterval> | null = null;
  private sortedNotes: Note[];
  // Index of the first note in `sortedNotes` whose startMs MIGHT still
  // need scheduling in the current iteration. Monotonically advances
  // forward during steady playback so the scheduler doesn't rescan
  // already-scheduled notes — critical on dense pieces (Ravel: 4k+
  // notes; full scan per 100 ms tick burned cycles for nothing).
  // Reset to 0 on iteration wrap (loop) and on seek.
  private scheduleCursor = 0;

  onEnd: (() => void) | null = null;

  constructor(rendered: Rendered, loop: boolean, preRollMs = 0, tailMs = 0) {
    this.rendered = rendered;
    this.loop = loop;
    this.preRollMs = preRollMs;
    // Loop scores don't tail — they wrap cleanly at totalMs. Only the
    // non-loop flavor has a "last note walks off" silence at the end.
    this.tailMs = loop ? 0 : tailMs;
    this.sortedNotes = [...rendered.notes].sort((a, b) => a.startMs - b.startMs);
  }

  /** End of visible playback: audio totalMs + the silent scroll-off tail.
   *  `currentMs()`, `seek()`, `isAtEnd()` all use this so the tail is
   *  treated as part of "the piece" for UI purposes. */
  private get visualTotalMs(): number {
    return this.rendered.totalMs + this.tailMs;
  }

  private ensureAudio() {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.synth = new Synth(this.ctx);
    }
  }

  async play() {
    // Only one score at a time per page — pause any sibling that's
    // currently sounding before we start.
    for (const other of activePlayers) {
      if (other !== this) other.pause();
    }
    this.ensureAudio();
    const ctx = this.ctx!;
    await ctx.resume();
    // Apply pre-roll only on a fresh start — either never played yet,
    // or just reset-to-start. Resuming from a paused mid-piece position
    // (or from a drag-seek to some arbitrary ms) shouldn't add a
    // lead-in.
    const preRollSec = this.atFreshStart ? this.preRollMs / 1000 : 0;
    this.iterStart = ctx.currentTime + preRollSec - this.pausedAt / 1000;
    this.scheduledUpTo = this.pausedAt;
    this.playing = true;
    this.atFreshStart = false;
    activePlayers.add(this);
    this.tick();
    this.schedulerTimer = setInterval(() => this.tick(), ScorePlayer.SCHED_INTERVAL_MS);
  }

  pause() {
    if (!this.playing || !this.ctx || !this.synth) return;
    this.pausedAt = (this.ctx.currentTime - this.iterStart) * 1000;
    if (this.loop) this.pausedAt = this.pausedAt % this.rendered.totalMs;
    this.playing = false;
    activePlayers.delete(this);
    if (this.schedulerTimer) { clearInterval(this.schedulerTimer); this.schedulerTimer = null; }
    this.synth.panic();
    // Force a fresh cursor on next play() so the scheduler scans from
    // the right starting point regardless of where pausedAt landed.
    this.scheduleCursor = 0;
  }

  toggle() { if (this.playing) this.pause(); else void this.play(); }

  /** ms position to use for visuals. Cheap — called from rAF. */
  currentMs(): number {
    if (!this.playing || !this.ctx) {
      if (this.atFreshStart) return -this.preRollMs;
      return this.pausedAt;
    }
    const raw = (this.ctx.currentTime - this.iterStart) * 1000;
    if (this.loop) return raw % this.rendered.totalMs;
    return Math.min(raw, this.visualTotalMs);
  }

  /** Integer iteration count (0-based). Needed by the render loop to
   *  compensate for xAtMs wrapping back to firstX each seam. */
  currentIteration(): number {
    if (!this.ctx) return 0;
    const raw = (this.ctx.currentTime - this.iterStart) * 1000;
    return Math.max(0, Math.floor(raw / this.rendered.totalMs));
  }

  isPlaying() { return this.playing; }
  isLoop() { return this.loop; }
  /** True iff a non-loop score has played through its audio AND its
   *  scroll-off tail — the score is fully offscreen-left and ready to
   *  be rewound. */
  isAtEnd(): boolean {
    return !this.loop && !this.playing && this.pausedAt >= this.visualTotalMs;
  }

  /** Jump to a specific ms without auto-playing. Clamps non-loop to
   *  [0, totalMs]; wraps loop into [0, totalMs). Pauses first if playing
   *  so synth stops cleanly before the position shift. Any seek exits
   *  fresh-start (even a seek to exactly 0 — the intent is that the
   *  reader wants to LOOK AT t=0, not the lead-in pose). */
  seek(ms: number) {
    if (this.playing) this.pause();
    if (this.loop) {
      const total = this.rendered.totalMs;
      this.pausedAt = ((ms % total) + total) % total;
    } else {
      this.pausedAt = Math.max(0, Math.min(this.visualTotalMs, ms));
    }
    this.atFreshStart = false;
    this.scheduleCursor = 0;
  }

  /** Reset to t=0 without playing. Complements isAtEnd(). Re-enters the
   *  fresh-start pose so the next play() gets its pre-roll back. */
  resetToStart() {
    if (this.playing) this.pause();
    this.pausedAt = 0;
    this.atFreshStart = true;
  }

  destroy() {
    this.pause();
    activePlayers.delete(this);
    if (this.ctx) {
      try { this.ctx.close(); } catch {}
      this.ctx = null;
      this.synth = null;
    }
  }

  // ---- scheduler ----

  private tick() {
    if (!this.playing || !this.ctx || !this.synth) return;
    const total = this.rendered.totalMs;
    const nowMs = (this.ctx.currentTime - this.iterStart) * 1000;
    const absTarget = nowMs + ScorePlayer.LOOKAHEAD_MS;

    if (this.loop) {
      // Walk whichever iterations overlap [scheduledUpTo, absTarget);
      // the loop seam is handled naturally by spanning two iterations'
      // slices in one tick. Wrapping resets the per-iter cursor.
      const firstIter = Math.max(0, Math.floor(this.scheduledUpTo / total));
      const lastIter = Math.max(firstIter, Math.floor((absTarget - 1) / total));
      for (let iter = firstIter; iter <= lastIter; iter++) {
        const iterBase = iter * total;
        const fromInIter = Math.max(0, this.scheduledUpTo - iterBase);
        const toInIter = Math.min(total, absTarget - iterBase);
        if (fromInIter < toInIter) {
          if (fromInIter === 0) this.scheduleCursor = 0;  // new iteration
          this.scheduleInIter(fromInIter, toInIter, iterBase);
        }
      }
      this.scheduledUpTo = absTarget;
    } else {
      // Schedule note audio only up to audio totalMs — the tail is
      // silent, just visual scroll-off. Clamp scheduler window.
      const toClipped = Math.min(total, absTarget);
      if (this.scheduledUpTo < toClipped) {
        this.scheduleInIter(this.scheduledUpTo, toClipped, 0);
        this.scheduledUpTo = toClipped;
      }
      // End only after the silent tail has also elapsed; that's when
      // the last note has fully scrolled past the playhead.
      const visualTotal = this.visualTotalMs;
      if (nowMs >= visualTotal) {
        this.playing = false;
        if (this.schedulerTimer) { clearInterval(this.schedulerTimer); this.schedulerTimer = null; }
        this.pausedAt = visualTotal;
        this.onEnd?.();
      }
    }
  }

  private scheduleInIter(fromMs: number, toMs: number, iterBase: number) {
    if (!this.synth) return;
    // Advance cursor past notes whose startMs is below `fromMs`. In
    // steady-state playback `fromMs` only marches forward and the
    // cursor sits exactly where this scan should start, so the inner
    // loop visits only the notes inside the window.
    const notes = this.sortedNotes;
    while (this.scheduleCursor < notes.length && notes[this.scheduleCursor].startMs < fromMs) {
      this.scheduleCursor++;
    }
    for (let i = this.scheduleCursor; i < notes.length; i++) {
      const note = notes[i];
      if (note.startMs >= toMs) break;
      this.scheduleCursor = i + 1;
      if (note.playAudio === false) continue;
      const startT = this.iterStart + (iterBase + note.startMs) / 1000;
      const audioEnd = note.audioEndMs ?? note.endMs;
      const endT = this.iterStart + (iterBase + audioEnd) / 1000;
      this.synth.play(note.midi, startT, endT);
    }
  }

  /** Debug/tests only — not part of the public API. Prefixed with `_` so
   *  callers see the intent at the use-site. */
  _debugState() {
    return {
      playing: this.playing,
      loop: this.loop,
      totalMs: this.rendered.totalMs,
      ctxTime: this.ctx?.currentTime,
      iterStart: this.iterStart,
      rawMs: this.ctx ? (this.ctx.currentTime - this.iterStart) * 1000 : null,
      currentMs: this.currentMs(),
      pausedAt: this.pausedAt,
      scheduledUpTo: this.scheduledUpTo,
    };
  }
}
