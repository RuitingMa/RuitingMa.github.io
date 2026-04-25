/*
 * Score — shared types + the headerFingerprint helper.
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
   *  the tie-trailing note re-attacking. `endMs` still bounds the
   *  visual glow so the glyph goes dark when its beat is over. */
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

/** Per-staff clef state at a moment in time. */
export interface ClefState {
  shape: string;  // 'G', 'F', 'C', ...
  line: string;   // '2', '4', ...
}

/**
 * Static (per-piece) staff layout. Captured once from the initial
 * `<scoreDef>/<staffGrp>` and threaded through Rendered so the shell
 * generator can mirror it. Verovio renders multi-staff layouts with the
 * brace/bracket and per-staff line counts driven by this group.
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

/** Time-signature snapshot. `sym` is Verovio's `meterSig@sym` value
 *  ("common", "cut", or empty for plain numeric like "4/4" / "2/4"). */
export interface MeterState {
  count: number;
  unit: number;
  sym: string;
}

/**
 * Header-state snapshot for the frozen overlay. Captures everything
 * the chrome shows — per-staff clefs, shared keysig, and meter — so
 * any one of them changing emits a new event and the overlay
 * crossfades. `startMs` is re-timed in `mountScore` to the moment
 * the inline change glyph crosses the playhead (not the first note
 * of the new measure, which is hundreds of ms later). `measureIdx`
 * is the 0-based section position so we can locate the glyph in the
 * rendered SVG.
 *
 * `clefs.length` always matches the StaffGroup's staves.length — for
 * single-staff pieces it's a 1-element array.
 */
export interface HeaderEvent {
  startMs: number;
  measureIdx: number;
  clefs: ClefState[];
  keysig: string;
  meter: MeterState;
}

/** Shell-match key for a header event — two events with the same
 *  fingerprint reuse the same pre-rendered shell. */
export function headerFingerprint(
  e: Pick<HeaderEvent, 'clefs' | 'keysig' | 'meter'>,
) {
  const c = e.clefs.map((cl) => `${cl.shape}${cl.line}`).join('|');
  const m = `${e.meter.count}/${e.meter.unit}${e.meter.sym ? '~' + e.meter.sym : ''}`;
  return `${c}-${e.keysig}-${m}`;
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
  headerEvents: HeaderEvent[];
  tempoEvents: TempoEvent[];
  meterCount: number;
  meterUnit: number;
  totalMs: number;
  /** Captured once from the source MEI's initial `<staffGrp>`. Drives
   *  the multi-staff shell pipeline (one shell SVG with N staffDefs +
   *  brace/bracket) so the frozen overlay matches the rendered system. */
  staffGroup: StaffGroup;
}

export interface MountedScore {
  destroy(): void;
}

/** Frozen header overlay handle — `setCurrent(fp)` flips which shell is
 *  visible. Created by render.ts; consumed by mount + render-loop. */
export interface FrozenOverlay {
  host: HTMLDivElement;
  setCurrent(fingerprint: string): void;
}
