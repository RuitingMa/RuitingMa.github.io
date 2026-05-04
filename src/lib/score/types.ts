/*
 * Score — shared types.
 *
 * Lives in its own module so render.ts, player.ts, and the mount
 * orchestrator can import freely without import cycles.
 */

export interface Note {
  id: string;
  startMs: number;
  endMs: number;
  midi: number;
  /** If present, audio sustains to this ms instead of `endMs` — used so
   *  a tie-leading note plays through the whole tied duration without
   *  the tie-trailing note re-attacking. */
  audioEndMs?: number;
  /** False on tie-trailing notes so the scheduler skips them. Default
   *  (undefined) is treated as true. */
  playAudio?: boolean;
}

/**
 * A chord symbol / functional-analysis label in the score (Verovio's
 * `<g class="harm">`). `endMs` is the onset of the NEXT harm in document
 * order (or totalMs for the last) — harms don't carry their own
 * durations in MEI, they simply hold until the next label takes over.
 */
export interface Harm {
  id: string;
  startMs: number;
  endMs: number;
}

export interface Anchor {
  t: number;  // ms within one iteration
  x: number;  // stage-px relative to the SVG's own left edge
}

/**
 * Static (per-piece) staff layout. Captured once from the initial
 * `<scoreDef>/<staffGrp>` and threaded through Rendered so the chrome
 * overlay builder knows how many staves to allocate tracks for.
 * Verovio renders multi-staff layouts with the brace/bracket and
 * per-staff line counts driven by this group.
 */
export interface StaffDef {
  n: string;          // staff index ("1", "2", "3"...) preserved from MEI
  lines: number;      // 5 for normal staves; 1 for percussion-style; etc.
}
export interface StaffGroup {
  staves: StaffDef[];
  /** Group symbol drawn to the left of the staves: brace (piano),
   *  bracket (orchestral section), line, or none. Mirrors the source
   *  `<grpSym>` element. */
  symbol: 'brace' | 'bracket' | 'line' | null;
}

/**
 * Tempo-state snapshot. Two sources land here:
 *   - `<tempo>` elements inside a measure — Verovio renders a glyph
 *     above the staff, and `mountScore` re-times `startMs` to when
 *     that glyph crosses the playhead.
 *   - `<scoreDef midi.bpm="...">` between measures — no visible glyph,
 *     so `startMs` stays at the raw measure-onset time.
 *
 * `display` is the text shown in the tempo overlay (top-left chrome).
 * Falls back to `♩=BPM` when no text is provided in MEI.
 */
export interface TempoEvent {
  startMs: number;
  measureIdx: number;
  bpm: number;       // quarter-note BPM (consistent with MEI's midi.bpm)
  display: string;
}

export interface Rendered {
  svg: string;
  notes: Note[];
  harms: Harm[];
  anchors: Anchor[];  // filled in by mountScore after the SVG is in DOM
  tempoEvents: TempoEvent[];
  meterCount: number;
  meterUnit: number;
  totalMs: number;
  /** Captured once from the source MEI's initial `<staffGrp>`. Drives
   *  the staff count and brace/bracket symbol in the chrome overlay. */
  staffGroup: StaffGroup;
}

export interface MountedScore {
  destroy(): void;
}
