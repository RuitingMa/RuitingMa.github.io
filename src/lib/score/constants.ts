/*
 * Score — tunable constants. Pulled into render.ts (geometry), player.ts
 * (transport timing), and the mount orchestrator. Edit these without
 * touching logic.
 */
export const K = {
  /** Identical SVG copies tiled side-by-side for loop scores. Must be ≥ 2
   *  so the invisible wrap always has content to the right of the one
   *  currently under the playhead. 3 buys an extra iteration of buffer. */
  LOOP_COPIES: 3,
  /** Reference stage height the header-width constants were measured at.
   *  Everything else scales proportionally via stageHeight / this value. */
  REF_STAGE_HEIGHT_PX: 200,
  /** Floor for the playhead's distance from the stage's left edge. Set
   *  so single-staff scores with up-to-7-accidental keysigs land at the
   *  same playhead axis as 0-accidental ones (otherwise C-major scores
   *  pull the playhead far left and read inconsistently next to
   *  modulating scores on the same page). The actual playhead position
   *  is `max(headerWidestWidth + PLAYHEAD_OFFSET_PX, HEADER_MAX_PX)`. */
  HEADER_MAX_PX: 110,
  /** Minimum horizontal distance between the overlay's right edge and
   *  the playhead. Wide enough that the fade zone reads as a separate
   *  region from both the chrome and the playhead. */
  PLAYHEAD_OFFSET_PX: 24,
  /** How far the IntersectionObserver pre-loads a score before viewport entry. */
  IO_ROOT_MARGIN_PX: 200,
  /** Fallback playhead position when neither `data-playhead` nor the
   *  header-derived minimum yields something larger. Rarely hit — most
   *  scores are bound by the stable header minimum. */
  DEFAULT_PLAYHEAD_FRAC: 0.35,
  /** Lead-in before playback: the first note starts to the right of the
   *  playhead and scrolls toward it at normal scroll rate, hitting the
   *  playhead exactly when audio begins. 0 = no pre-roll. */
  PRE_ROLL_MS: 1200,
  /** Duration of the fade-out / fade-in when the user clicks on a
   *  finished non-loop score (rewinds to start). */
  RESET_FADE_MS: 400,
  /** Pointer movement past this threshold counts as a drag, not a click. */
  DRAG_THRESHOLD_PX: 3,
  /** After the last audio note ends, keep scrolling for this long so the
   *  final note visually walks off the stage. Non-loop only. */
  TAIL_MS: 1800,
} as const;

/** Measure contents that are NOT part of the frozen header — removed
 *  when cloning a measure into the overlay so the shell has ONLY
 *  clef/keysig/meter (plus whatever structural bits remain). The PAN
 *  keeps all of these so inline annotations (dynamics, harm labels,
 *  tempo markings) still scroll past the playhead naturally. */
export const MEASURE_MUSIC_CLASSES = [
  'layer', 'ledgerLines', 'harm', 'chordSymbol', 'dynam',
  'verse', 'lyric', 'tuplet', 'beam', 'slur', 'tie', 'arpeg', 'artic',
  // Mid-piece rendering elements that have no place in a static
  // header chrome — without these the cloned shell shows the m1
  // tempo marking ("♩=144 Allegretto") peeking out over the
  // overlay area, which the dedicated tempo overlay already covers.
  'tempo', 'dir', 'pedal', 'fermata', 'fing', 'mordent', 'turn', 'trill',
  // Whole-rest glyphs from staves we kept "for layout" but no longer
  // want to display chrome for. (Verovio renders rests with the
  // `.rest` class.)
  'rest',
] as const;
