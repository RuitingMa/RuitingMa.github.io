/*
 * Score player
 *
 * Mounts a Verovio-rendered score inside a host element and drives:
 *   - horizontal auto-scroll so that the "playhead line" stays fixed and
 *     the score translates underneath it
 *   - a tiny Web Audio synth that renders the score's notes
 *   - optional seamless looping (for short progressions used in-line)
 *
 * Reads from the host element:
 *   data-slug      — name of public/scores/<slug>/ directory
 *   data-loop      — if present (any value), playback loops forever
 *   data-playhead  — 0..1 fraction across the container (default DEFAULT_PLAYHEAD_FRAC)
 *
 * Expects the host's .score-stage to contain:
 *   .score-pan-mask   — non-transforming mask wrapper (stage-coord fade)
 *     .score-pan      — the transform target; holds the SVG copies
 *   .score-playhead   — the fixed vertical indicator line
 *
 * Lifecycle: the Verovio WASM is ~1.5MB gzipped. We load it lazily, once
 * per page (promise-cached), only when at least one Score component
 * intersects the viewport. AudioContext is created on first click —
 * browsers disallow it without a user gesture.
 */

// ---------------------------------------------------------------------------
// Tunable constants — everything here can be edited without touching logic.
// ---------------------------------------------------------------------------

const K = {
  /** Identical SVG copies tiled side-by-side for loop scores. Must be ≥ 2
   *  so the invisible wrap always has content to the right of the one
   *  currently under the playhead. 3 buys an extra iteration of buffer. */
  LOOP_COPIES: 3,
  /** Reference stage height the header-width constants were measured at.
   *  Everything else scales proportionally via stageHeight / this value. */
  REF_STAGE_HEIGHT_PX: 200,
  /** Upper-bound display width of a frozen header (clef + up to 7
   *  accidentals + meter), at REF_STAGE_HEIGHT_PX. Scaled per actual
   *  stage height in mountScore, so mobile stages shrink the reserved
   *  playhead zone in proportion with the glyphs. The overlay and mask
   *  still hug the ACTUAL widest keysig this score visits — this is
   *  only the floor that keeps the playhead axis stable across scores. */
  HEADER_MAX_PX: 184,
  /** Minimum horizontal distance between the overlay's right edge and
   *  the playhead (also at REF_STAGE_HEIGHT_PX, scaled per stage). The
   *  fade zone collapses toward this when a score uses exceptionally
   *  wide key signatures; below it we push the playhead right rather
   *  than cut the fade further. */
  PLAYHEAD_OFFSET_PX: 16,
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

// Measure contents that are NOT part of the frozen header — removed when
// cloning measure 1 into the overlay so the overlay has ONLY clef/keysig/
// meter (plus whatever structural bits get left behind).
const MEASURE_MUSIC_CLASSES = [
  'layer', 'ledgerLines', 'harm', 'chordSymbol', 'dynam',
  'verse', 'lyric', 'tuplet', 'beam', 'slur', 'tie', 'arpeg', 'artic',
] as const;

// ---------------------------------------------------------------------------
// Verovio — loaded once per page, reused by every Score on the page.
// ---------------------------------------------------------------------------

let verovioPromise: Promise<{ VerovioToolkit: any; module: any }> | null = null;

async function loadVerovio() {
  if (!verovioPromise) {
    verovioPromise = (async () => {
      const [{ VerovioToolkit }, createModule] = await Promise.all([
        import('verovio/esm'),
        import('verovio/wasm').then((m) => m.default),
      ]);
      const module = await createModule();
      return { VerovioToolkit, module };
    })();
  }
  return verovioPromise;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Note {
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
interface Harm {
  id: string;
  startMs: number;
  endMs: number;
}

interface Anchor {
  t: number;  // ms within one iteration
  x: number;  // stage-px relative to the SVG's own left edge
}

/**
 * Header-state snapshot for the frozen overlay. Each event captures the
 * current clef + keysig; either of those changing (via an inline
 * `<scoreDef>` mid-section) emits a new event. `startMs` is re-timed in
 * `mountScore` to the moment the inline change glyph crosses the
 * playhead (not the first note of the new measure, which is hundreds
 * of ms later). `measureIdx` is the 0-based section position so we can
 * locate the glyph in the rendered SVG.
 */
interface HeaderEvent {
  startMs: number;
  measureIdx: number;
  clefShape: string;
  clefLine: string;
  keysig: string;
}

/** Shell-match key for a header event — two events with the same
 *  fingerprint reuse the same pre-rendered shell. */
function headerFingerprint(e: Pick<HeaderEvent, 'clefShape' | 'clefLine' | 'keysig'>) {
  return `${e.clefShape}${e.clefLine}-${e.keysig}`;
}

interface Rendered {
  svg: string;
  notes: Note[];
  harms: Harm[];
  anchors: Anchor[];  // filled in by mountScore after the SVG is in DOM
  headerEvents: HeaderEvent[];
  meterCount: number;
  meterUnit: number;
  totalMs: number;
}

interface MountedScore {
  destroy(): void;
}

// ---------------------------------------------------------------------------
// MEI → SVG + timing data
// ---------------------------------------------------------------------------

const PNAME_SEMITONES: Record<string, number> = {
  c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11,
};

function pitchFromAttrs(pname: string, oct: number, accid?: string): number {
  const base = PNAME_SEMITONES[pname.toLowerCase()];
  if (base === undefined) return NaN;
  let shift = 0;
  if (accid === 's') shift = 1;
  else if (accid === 'f') shift = -1;
  else if (accid === 'ss' || accid === 'x') shift = 2;
  else if (accid === 'ff') shift = -2;
  return (oct + 1) * 12 + base + shift;
}

async function renderMei(meiText: string): Promise<Rendered> {
  const { VerovioToolkit, module } = await loadVerovio();
  const toolkit = new VerovioToolkit(module);
  // breaks: 'none' lays out as one continuous horizontal system. Large
  // pageWidth/Height prevent Verovio from wrapping or clipping.
  toolkit.setOptions({
    breaks: 'none',
    scale: 40,
    pageWidth: 100000,
    pageHeight: 60000,
    pageMarginTop: 40,
    pageMarginBottom: 40,
    pageMarginLeft: 40,
    pageMarginRight: 40,
    adjustPageHeight: true,
    adjustPageWidth: true,
    svgViewBox: true,
    svgBoundingBoxes: false,
  });
  if (!toolkit.loadData(meiText)) throw new Error('Verovio loadData failed');

  const svg: string = toolkit.renderToSVG(1, false);
  const timemap: Array<{ tstamp: number; on?: string[]; off?: string[] }> =
    toolkit.renderToTimemap({ includeMeasures: false, includeRests: false });

  // Pair each note id's first `on` with its matching `off`; resolve pitch
  // from the note's MEI attributes. Notes without pitch (rests, etc.) are
  // silently skipped — the synth only needs playable notes.
  const onTimes = new Map<string, number>();
  let maxTstamp = 0;
  for (const evt of timemap) {
    maxTstamp = Math.max(maxTstamp, evt.tstamp);
    for (const id of evt.on ?? []) if (!onTimes.has(id)) onTimes.set(id, evt.tstamp);
  }
  const notes: Note[] = [];
  for (const evt of timemap) {
    for (const id of evt.off ?? []) {
      const startMs = onTimes.get(id);
      if (startMs === undefined) continue;
      const attrs = toolkit.getElementAttr(id) as {
        pname?: string; oct?: string | number; accid?: string;
      };
      if (!attrs?.pname || attrs.oct === undefined) continue;
      const midi = pitchFromAttrs(String(attrs.pname), Number(attrs.oct), attrs.accid);
      if (!Number.isFinite(midi)) continue;
      notes.push({ id, startMs, endMs: evt.tstamp, midi });
    }
  }

  // Parse the MEI source once, then extract both harm onsets and
  // clef/keysig events in a single walk of <section>'s direct children.
  // Verovio's `getTimesForElement` returns `{}` for harm elements — it
  // only carries timing for notes/rests — and doesn't expose clef/key
  // changes, so we compute both ourselves.
  const harms: Harm[] = [];
  const headerEvents: HeaderEvent[] = [];
  let meterCount = 4;
  let meterUnit = 4;
  try {
    const meiDoc = new DOMParser().parseFromString(meiText, 'application/xml');
    const initialScoreDef = meiDoc.querySelector('scoreDef');
    const initialStaffDef = initialScoreDef?.querySelector('staffDef');
    const bpm = Number(initialScoreDef?.getAttribute('midi.bpm') ?? 120);
    meterCount = Number(initialScoreDef?.getAttribute('meter.count') ?? 4);
    meterUnit = Number(initialScoreDef?.getAttribute('meter.unit') ?? 4);
    const msPerBeat = 60000 / bpm;
    const msPerMeasure = meterCount * msPerBeat;

    // Clef + keysig can live directly on <scoreDef> or on a nested
    // <staffDef n="1">. Resolver falls back across both.
    const read = (attr: string, els: ReadonlyArray<Element | null | undefined>) => {
      for (const el of els) {
        const v = el?.getAttribute(attr);
        if (v !== null && v !== undefined) return v;
      }
      return null;
    };
    let clefShape = read('clef.shape', [initialStaffDef, initialScoreDef]) ?? 'G';
    let clefLine = read('clef.line', [initialStaffDef, initialScoreDef]) ?? '2';
    let keysig = read('key.sig', [initialScoreDef, initialStaffDef]) ?? '0';
    headerEvents.push({ startMs: 0, measureIdx: 0, clefShape, clefLine, keysig });

    const meiOnsets: number[] = [];
    const section = meiDoc.querySelector('section');
    if (section) {
      let measureIdx = 0;
      for (const child of Array.from(section.children)) {
        if (child.localName === 'measure') {
          const measureStart = measureIdx * msPerMeasure;
          for (const c of Array.from(child.children)) {
            if (c.localName !== 'harm') continue;
            const tstamp = Number(c.getAttribute('tstamp') ?? 1);
            meiOnsets.push(measureStart + (tstamp - 1) * msPerBeat);
          }
          measureIdx += 1;
          continue;
        }
        if (child.localName !== 'scoreDef') continue;
        // scoreDef override: read new values, emit event only on any change.
        const nestedStaffDef = child.querySelector('staffDef');
        const newShape = read('clef.shape', [child, nestedStaffDef]) ?? clefShape;
        const newLine = read('clef.line', [child, nestedStaffDef]) ?? clefLine;
        const newKey = read('key.sig', [child, nestedStaffDef]) ?? keysig;
        if (newShape === clefShape && newLine === clefLine && newKey === keysig) continue;
        clefShape = newShape;
        clefLine = newLine;
        keysig = newKey;
        headerEvents.push({
          startMs: measureIdx * msPerMeasure, measureIdx,
          clefShape, clefLine, keysig,
        });
      }
    }

    // Harm ids from the rendered SVG appear in the same document order
    // as the MEI source, so zip by index to assign each id its onset.
    // endMs is the next DISTINCT onset so harm pairs sharing a tstamp
    // (e.g. "Dm7 above" + "ii below") cover the same interval.
    const svgDoc = new DOMParser().parseFromString(svg, 'image/svg+xml');
    const svgHarmIds = Array.from(svgDoc.querySelectorAll('.harm[id]'))
      .map((el) => (el as Element).id)
      .filter(Boolean);
    if (svgHarmIds.length === meiOnsets.length) {
      const distinctStarts = [...new Set(meiOnsets)].sort((a, b) => a - b);
      const nextAfter = new Map<number, number>();
      for (let i = 0; i < distinctStarts.length; i++) {
        nextAfter.set(distinctStarts[i], distinctStarts[i + 1] ?? maxTstamp);
      }
      for (let i = 0; i < svgHarmIds.length; i++) {
        const start = meiOnsets[i];
        harms.push({ id: svgHarmIds[i], startMs: start, endMs: nextAfter.get(start) ?? maxTstamp });
      }
    } else if (svgHarmIds.length > 0) {
      console.warn(
        '[score] harm count mismatch — MEI:', meiOnsets.length,
        'SVG:', svgHarmIds.length, '— skipping harm sync',
      );
    }

    // Ties: `<tie startid="#X" endid="#Y"/>` means the X note sustains
    // into Y without a re-attack. Extend X's audio range through Y,
    // and mute Y in the audio scheduler. Visuals keep both notes so
    // each glyph glows when its own beat is sounding.
    const notesById = new Map<string, Note>();
    for (const n of notes) notesById.set(n.id, n);
    for (const tie of Array.from(meiDoc.querySelectorAll('tie'))) {
      const startId = tie.getAttribute('startid')?.replace(/^#/, '');
      const endId = tie.getAttribute('endid')?.replace(/^#/, '');
      if (!startId || !endId) continue;
      const startNote = notesById.get(startId);
      const endNote = notesById.get(endId);
      if (!startNote || !endNote) continue;
      startNote.audioEndMs = endNote.endMs;
      endNote.playAudio = false;
    }
  } catch (err) {
    console.warn('[score] MEI metadata extraction failed:', err);
  }

  toolkit.destroy();

  return {
    svg, notes, harms, anchors: [], headerEvents,
    meterCount, meterUnit, totalMs: maxTstamp,
  };
}

// ---------------------------------------------------------------------------
// Web Audio synth — a tiny polyphonic voice bank
// ---------------------------------------------------------------------------

/** Procedurally-generated impulse response for a convolution reverb —
 *  decaying stereo noise, cheap to build, sounds roomy. `decay` tilts
 *  the curve (higher = darker tail). */
function buildReverbIR(ctx: AudioContext, durationSec: number, decay: number): AudioBuffer {
  const rate = ctx.sampleRate;
  const len = Math.max(1, Math.floor(rate * durationSec));
  const ir = ctx.createBuffer(2, len, rate);
  for (let ch = 0; ch < 2; ch++) {
    const data = ir.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
  }
  return ir;
}

/** Tiny polyphonic electric-piano-ish voice bank with a shared
 *  convolution reverb. Each voice is a sine fundamental + a quickly-
 *  decaying octave "bell" (for attack shimmer) through a lowpass, then
 *  split between a dry bus and a reverb send. */
class Synth {
  private ctx: AudioContext;
  private dry: GainNode;
  private reverbSend: GainNode;
  private active: Set<{ stop: (t: number) => void }> = new Set();

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    this.dry = ctx.createGain();
    this.dry.gain.value = 0.2;
    this.dry.connect(ctx.destination);

    const convolver = ctx.createConvolver();
    convolver.buffer = buildReverbIR(ctx, 1.8, 1.8);
    const wet = ctx.createGain();
    wet.gain.value = 0.28;
    this.reverbSend = ctx.createGain();
    this.reverbSend.gain.value = 1;
    this.reverbSend.connect(convolver);
    convolver.connect(wet);
    wet.connect(ctx.destination);
  }

  play(midi: number, startT: number, endT: number) {
    const ctx = this.ctx;
    if (endT <= startT) endT = startT + 0.05;
    const freq = 440 * Math.pow(2, (midi - 69) / 12);

    // Voice bus feeds both the dry master and the reverb send.
    const voice = ctx.createGain();
    voice.gain.value = 0;
    const lowpass = ctx.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.frequency.value = Math.min(4800, freq * 8);
    lowpass.Q.value = 0.4;
    voice.connect(lowpass);
    lowpass.connect(this.dry);
    const send = ctx.createGain();
    send.gain.value = 0.45;
    lowpass.connect(send);
    send.connect(this.reverbSend);

    // Fundamental — warm body, sine.
    const body = ctx.createOscillator();
    body.type = 'sine';
    body.frequency.value = freq;
    body.connect(voice);

    // Bell — octave sine with its own fast-decay envelope, blended in
    // at attack for that Rhodes shimmer. Detune a hair to reduce beating
    // with the body.
    const bell = ctx.createOscillator();
    bell.type = 'sine';
    bell.frequency.value = freq * 2;
    bell.detune.value = 4;
    const bellGain = ctx.createGain();
    bellGain.gain.setValueAtTime(0, startT);
    bellGain.gain.linearRampToValueAtTime(0.35, startT + 0.004);
    bellGain.gain.exponentialRampToValueAtTime(0.001, startT + 0.35);
    bell.connect(bellGain);
    bellGain.connect(voice);

    // Amplitude envelope on the voice bus.
    const A = 0.006, D = 0.22, S = 0.48, R = 0.18, peak = 0.85;
    const sustain = peak * S;
    const sustainUntil = Math.max(startT + A + D, endT - R);
    voice.gain.setValueAtTime(0, startT);
    voice.gain.linearRampToValueAtTime(peak, startT + A);
    voice.gain.exponentialRampToValueAtTime(Math.max(0.0001, sustain), startT + A + D);
    voice.gain.setValueAtTime(sustain, sustainUntil);
    voice.gain.exponentialRampToValueAtTime(0.0001, sustainUntil + R);

    const stopAt = sustainUntil + R + 0.02;
    body.start(startT);
    bell.start(startT);
    body.stop(stopAt);
    bell.stop(Math.min(stopAt, startT + 0.4));

    const handle = {
      stop: (t: number) => {
        try {
          voice.gain.cancelScheduledValues(t);
          voice.gain.setValueAtTime(voice.gain.value, t);
          voice.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
          body.stop(t + 0.07);
          bell.stop(t + 0.07);
        } catch {}
      },
    };
    this.active.add(handle);
    body.onended = () => {
      try { voice.disconnect(); } catch {}
      try { send.disconnect(); } catch {}
      this.active.delete(handle);
    };
  }

  /** Cancel all pending/sounding voices — used on pause. */
  panic() {
    const t = this.ctx.currentTime;
    for (const v of this.active) v.stop(t);
    this.active.clear();
  }
}

// ---------------------------------------------------------------------------
// ScorePlayer — transport + scheduling
// ---------------------------------------------------------------------------

/** Module-level set of players currently sounding audio. A new `play()`
 *  pauses every other member so two scores on the same page don't overlap. */
const activePlayers: Set<ScorePlayer> = new Set();

class ScorePlayer {
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
      // slices in one tick.
      const firstIter = Math.max(0, Math.floor(this.scheduledUpTo / total));
      const lastIter = Math.max(firstIter, Math.floor((absTarget - 1) / total));
      for (let iter = firstIter; iter <= lastIter; iter++) {
        const iterBase = iter * total;
        const fromInIter = Math.max(0, this.scheduledUpTo - iterBase);
        const toInIter = Math.min(total, absTarget - iterBase);
        if (fromInIter < toInIter) this.scheduleInIter(fromInIter, toInIter, iterBase);
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
    for (const note of this.sortedNotes) {
      if (note.startMs < fromMs) continue;
      if (note.startMs >= toMs) break;
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

// ---------------------------------------------------------------------------
// Mount — helper functions
//
// Each of these is intentionally small enough to read top-to-bottom. Most
// either query/mutate a slice of DOM or compute a geometric value. The
// mountScore orchestrator below just sequences them.
// ---------------------------------------------------------------------------

async function fetchMei(slug: string): Promise<string> {
  const r = await fetch(`/scores/${slug}/score.mei`);
  if (!r.ok) throw new Error(`MEI fetch: HTTP ${r.status}`);
  return r.text();
}

/** Inject N identical SVG copies into the pan. Normalize per-SVG attrs. */
function injectCopies(pan: HTMLElement, svg: string, copies: number): SVGSVGElement[] {
  pan.innerHTML = Array(copies).fill(svg).join('');
  const svgs = Array.from(pan.querySelectorAll<SVGSVGElement>(':scope > svg'));
  for (const s of svgs) {
    s.setAttribute('preserveAspectRatio', 'xMinYMid meet');
    (s as unknown as HTMLElement).style.display = 'block';
  }
  return svgs;
}

/** Compute anchors (time → x) from note onsets in the SVG. We measure via
 *  getBoundingClientRect because Verovio's nested transforms make getBBox
 *  unreliable, and we want stage-relative pixel values for the render loop. */
function buildAnchors(
  svgEl: SVGSVGElement,
  rendered: Rendered,
  svgRect0: DOMRect,
): Anchor[] {
  const byStart = new Map<number, string[]>();
  for (const n of rendered.notes) {
    const arr = byStart.get(n.startMs) ?? [];
    arr.push(n.id);
    byStart.set(n.startMs, arr);
  }
  const anchors: Anchor[] = [];
  for (const t of [...byStart.keys()].sort((a, b) => a - b)) {
    const ids = byStart.get(t)!;
    let xSum = 0, count = 0;
    for (const id of ids) {
      const el = svgEl.querySelector(`#${CSS.escape(id)}`);
      if (!el) continue;
      const rect = (el as Element).getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      xSum += (rect.left + rect.width / 2) - svgRect0.left;
      count++;
    }
    if (count > 0) anchors.push({ t, x: xSum / count });
  }
  if (anchors.length === 0) {
    // Fallback: span full width linearly.
    anchors.push({ t: 0, x: 0 });
    anchors.push({ t: rendered.totalMs, x: svgRect0.width });
  }
  return anchors;
}

/** Rightmost edge (SVG-relative pixels) of clef + keysig + meter in measure 1. */
function measureHeaderWidth(firstMeasure: Element | null, svgRect0: DOMRect): number {
  if (!firstMeasure) return 0;
  const els = firstMeasure.querySelectorAll('.clef, .keySig, .meterSig');
  let width = 0;
  for (const el of Array.from(els)) {
    const rect = (el as Element).getBoundingClientRect();
    const right = (rect.left + rect.width) - svgRect0.left;
    if (right > width) width = right;
  }
  return width;
}

/** Pad the anchor list to cover [-PRE_ROLL_MS, totalMs]. See inline
 *  comments for the different endpoints non-loop vs loop use. */
function padAnchors(
  anchors: Anchor[],
  rendered: Rendered,
  loop: boolean,
  musicWidth: number,
  svgEl: SVGSVGElement,
  svgRect0: DOMRect,
): Anchor[] {
  if (anchors[0].t > 0) {
    anchors.unshift({ t: 0, x: anchors[0].x });
  }
  const last = anchors[anchors.length - 1];
  if (last.t < rendered.totalMs) {
    if (loop) {
      anchors.push({ t: rendered.totalMs, x: anchors[0].x + musicWidth });
    } else {
      let lastNote: Note | null = null;
      for (const n of rendered.notes) {
        if (!lastNote || n.startMs > lastNote.startMs) lastNote = n;
      }
      let xEnd = last.x;
      if (lastNote) {
        const el = svgEl.querySelector(`#${CSS.escape(lastNote.id)}`);
        if (el) {
          const rect = (el as Element).getBoundingClientRect();
          xEnd = (rect.left + rect.width) - svgRect0.left;
        }
      }
      xEnd = Math.min(xEnd, svgRect0.width);
      anchors.push({ t: rendered.totalMs, x: xEnd });
      // Tail anchor: the last note should keep drifting left at the
      // same rate until it's off the stage. Extend by TAIL_MS of silent
      // time with a proportional x advance so the slope stays continuous
      // from the rest-of-piece rate into the tail.
      if (K.TAIL_MS > 0) {
        const rate = (xEnd - anchors[0].x) / (rendered.totalMs - anchors[0].t);
        anchors.push({
          t: rendered.totalMs + K.TAIL_MS,
          x: xEnd + rate * K.TAIL_MS,
        });
      }
    }
  }

  // Pre-roll: prepend an anchor at t=-PRE_ROLL_MS so that on first play,
  // the first note begins RIGHT of the playhead and scrolls toward it
  // at the same rate as normal playback. Computing the lead-in distance
  // from the overall piece's scroll rate (px per ms) keeps the pre-roll
  // scroll speed continuous with the post-start scroll speed — no
  // visible acceleration at the moment audio begins.
  if (K.PRE_ROLL_MS > 0 && anchors.length >= 2) {
    const first = anchors[0];
    const finalA = anchors[anchors.length - 1];
    const rate = (finalA.x - first.x) / (finalA.t - first.t);
    const leadIn = rate * K.PRE_ROLL_MS;
    anchors.unshift({ t: -K.PRE_ROLL_MS, x: first.x - leadIn });
  }
  return anchors;
}

/** Build a linear-interpolating x(ms) function over a sorted anchor list. */
function makeXAtMs(anchors: Anchor[]): (ms: number) => number {
  return (ms: number) => {
    if (anchors.length === 0) return 0;
    if (ms <= anchors[0].t) return anchors[0].x;
    if (ms >= anchors[anchors.length - 1].t) return anchors[anchors.length - 1].x;
    for (let i = 1; i < anchors.length; i++) {
      if (anchors[i].t >= ms) {
        const a = anchors[i - 1], b = anchors[i];
        const f = b.t === a.t ? 0 : (ms - a.t) / (b.t - a.t);
        return a.x + f * (b.x - a.x);
      }
    }
    return anchors[anchors.length - 1].x;
  };
}

/** Inverse of makeXAtMs — given an x in SVG-coord stage-px, return the
 *  score-time ms at which that x is under the playhead. Used to align
 *  overlay crossfades to when an inline keysig glyph (rather than the
 *  following note) crosses the playhead. */
function msAtX(anchors: Anchor[], x: number): number {
  if (anchors.length === 0) return 0;
  if (x <= anchors[0].x) return anchors[0].t;
  if (x >= anchors[anchors.length - 1].x) return anchors[anchors.length - 1].t;
  for (let i = 1; i < anchors.length; i++) {
    if (anchors[i].x >= x) {
      const a = anchors[i - 1], b = anchors[i];
      const f = b.x === a.x ? 0 : (x - a.x) / (b.x - a.x);
      return a.t + f * (b.t - a.t);
    }
  }
  return anchors[anchors.length - 1].t;
}

/**
 * Build a fresh SVG containing ONLY the ancestor chain
 * defs + definition-scale > page-margin > system > measure 1
 * with `MEASURE_MUSIC_CLASSES` stripped from the measure clone.
 *
 * Why the whole chain: every ancestor contributes a transform (most
 * importantly `.definition-scale`'s own viewBox, which maps Verovio's
 * internal unit system onto the outer SVG's small viewBox). Cloning
 * only the leaf clef/keysig/meter elements loses those transforms and
 * the glyphs render at raw internal coords — way off-screen.
 */
function cloneMeasureOneShell(srcSvg: SVGSVGElement): SVGSVGElement | null {
  const defScale = srcSvg.querySelector('svg.definition-scale') as SVGSVGElement | null;
  const pm = defScale?.querySelector('.page-margin');
  const sys = defScale?.querySelector('.system');
  const measure = defScale?.querySelector('.measure');
  if (!defScale || !pm || !sys || !measure) return null;

  const out = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  out.setAttribute('viewBox', srcSvg.getAttribute('viewBox') ?? '');
  out.setAttribute('preserveAspectRatio', 'xMinYMid meet');

  const origDefs = srcSvg.querySelector('defs');
  if (origDefs) out.appendChild(origDefs.cloneNode(true));

  const defScaleClone = defScale.cloneNode(false) as SVGSVGElement;
  const pmClone = pm.cloneNode(false) as Element;
  const sysClone = sys.cloneNode(false) as Element;
  const measureClone = measure.cloneNode(true) as Element;

  const sel = MEASURE_MUSIC_CLASSES.map((c) => '.' + c).join(',');
  for (const el of Array.from(measureClone.querySelectorAll(sel))) el.remove();

  sysClone.appendChild(measureClone);
  pmClone.appendChild(sysClone);
  defScaleClone.appendChild(pmClone);
  out.appendChild(defScaleClone);
  return out;
}

/** Minimal MEI: a single-measure whole rest with the given clef + keysig
 *  + meter. Used to pre-render a clean "full header" shell for every
 *  (clef, keysig) combination a score visits — so the frozen overlay
 *  shows the same visual style regardless of whether the change is a
 *  keysig modulation, a clef switch (e.g. treble↔bass), or both. */
function headerOnlyMei(
  clefShape: string, clefLine: string, keysig: string,
  meterCount: number, meterUnit: number,
): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<mei xmlns="http://www.music-encoding.org/ns/mei" meiversion="5.0">
  <meiHead><fileDesc><titleStmt><title>k</title></titleStmt><pubStmt/></fileDesc></meiHead>
  <music><body><mdiv><score>
    <scoreDef meter.count="${meterCount}" meter.unit="${meterUnit}" key.sig="${keysig}">
      <staffGrp><staffDef n="1" lines="5" clef.shape="${clefShape}" clef.line="${clefLine}"/></staffGrp>
    </scoreDef>
    <section><measure n="1"><staff n="1"><layer n="1">
      <rest dur="1"/>
    </layer></staff></measure></section>
  </score></mdiv></body></music>
</mei>`;
}

/** Render one SVG shell per unique (clef, keysig) event via Verovio.
 *  Shell = clef + keysig + meter, measure-music stripped. Keyed by
 *  `headerFingerprint` so callers reuse the same shell for equivalent events. */
async function renderHeaderShells(
  events: ReadonlyArray<HeaderEvent>, meterCount: number, meterUnit: number,
): Promise<Map<string, SVGSVGElement>> {
  const { VerovioToolkit, module } = await loadVerovio();
  const byFingerprint = new Map<string, HeaderEvent>();
  for (const e of events) {
    const fp = headerFingerprint(e);
    if (!byFingerprint.has(fp)) byFingerprint.set(fp, e);
  }
  const shells = new Map<string, SVGSVGElement>();
  for (const [fp, e] of byFingerprint) {
    try {
      const tk = new VerovioToolkit(module);
      tk.setOptions({
        breaks: 'none', scale: 40, pageWidth: 100000, pageHeight: 60000,
        pageMarginTop: 40, pageMarginBottom: 40,
        pageMarginLeft: 40, pageMarginRight: 40,
        adjustPageHeight: true, adjustPageWidth: true, svgViewBox: true,
      });
      tk.loadData(headerOnlyMei(e.clefShape, e.clefLine, e.keysig, meterCount, meterUnit));
      const svgStr = tk.renderToSVG(1, false);
      tk.destroy();
      const tmp = document.createElement('div');
      tmp.innerHTML = svgStr;
      const srcSvg = tmp.querySelector('svg') as SVGSVGElement | null;
      if (!srcSvg) continue;
      const shell = cloneMeasureOneShell(srcSvg);
      if (shell) shells.set(fp, shell);
    } catch (err) {
      console.warn(`[score] shell render failed for ${fp}:`, err);
    }
  }
  return shells;
}

/** Display-px width of each shell's clef+keysig+meter at the given stage
 *  height. Attaches clones of all shells in one off-screen probe so layout
 *  flushes once for the whole batch. The overlay sizes to the widest of
 *  these, which lets the fade zone (overlay-right → playhead) stretch into
 *  any blank space narrow keysigs leave unused. */
function measureShellWidths(
  shells: Map<string, SVGSVGElement>, stageHeightPx: number,
): Map<string, number> {
  const widths = new Map<string, number>();
  if (shells.size === 0) return widths;
  const probe = document.createElement('div');
  probe.style.cssText =
    `position:fixed;left:-99999px;top:0;height:${stageHeightPx}px;` +
    `display:flex;pointer-events:none;z-index:-1;`;
  const clones: Array<{ fp: string; clone: SVGSVGElement }> = [];
  for (const [fp, shell] of shells) {
    const clone = shell.cloneNode(true) as SVGSVGElement;
    clone.style.display = 'block';
    clone.style.height = '100%';
    clone.style.width = 'auto';
    probe.appendChild(clone);
    clones.push({ fp, clone });
  }
  document.body.appendChild(probe);
  for (const { fp, clone } of clones) {
    const w = measureHeaderWidth(clone.querySelector('.measure'), clone.getBoundingClientRect());
    widths.set(fp, w);
  }
  probe.remove();
  return widths;
}

/** Frozen header overlay + the only API for updating it: `setCurrent(fp)`
 *  flips which shell is visible. Keeps the shell-per-layer DOM structure
 *  an implementation detail of this function. Returns null if no shells
 *  could be built. */
interface FrozenOverlay {
  host: HTMLDivElement;
  setCurrent(fingerprint: string): void;
}
function createFrozenOverlay(
  shells: Map<string, SVGSVGElement>,
  initialFingerprint: string,
  overlayWidth: number,
): FrozenOverlay | null {
  if (shells.size === 0) return null;
  const host = document.createElement('div');
  host.className = 'score-frozen-overlay';
  host.style.width = `${overlayWidth}px`;
  const layers = new Map<string, HTMLDivElement>();
  for (const [fp, shell] of shells) {
    const layer = document.createElement('div');
    layer.className = 'score-frozen-shell';
    if (fp === initialFingerprint) layer.classList.add('is-current');
    layer.appendChild(shell);
    host.appendChild(layer);
    layers.set(fp, layer);
  }
  let current = initialFingerprint;
  return {
    host,
    setCurrent(fingerprint: string) {
      if (fingerprint === current) return;
      layers.get(current)?.classList.remove('is-current');
      layers.get(fingerprint)?.classList.add('is-current');
      current = fingerprint;
    },
  };
}

/** Measured y-midlines (stage-relative px) of the 5 staff lines in the
 *  first staff. Returns empty array if no staff or no path children. */
function measureStaffYs(firstStaff: Element | null, stageTop: number): number[] {
  if (!firstStaff) return [];
  const ys: number[] = [];
  for (const p of Array.from(firstStaff.children)) {
    if (p.tagName !== 'path') continue;
    const r = (p as Element).getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    ys.push((r.top + r.bottom) / 2 - stageTop);
  }
  return ys;
}

/** A stage-wide SVG with 5 horizontal lines at the given y-positions.
 *  Single source of staff lines — prevents the double-stroke thickening
 *  that happened when pan and overlay both drew them. */
function createStaffLinesLayer(ys: number[], stageRect: DOMRect): SVGSVGElement | null {
  if (ys.length === 0) return null;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'score-staff-lines');
  svg.setAttribute('preserveAspectRatio', 'none');
  // Viewport-pixel viewBox so <line> coords ARE stage pixels.
  svg.setAttribute('viewBox', `0 0 ${stageRect.width} ${stageRect.height}`);
  for (const y of ys) {
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', '0');
    line.setAttribute('y1', String(y));
    line.setAttribute('x2', String(stageRect.width));
    line.setAttribute('y2', String(y));
    svg.appendChild(line);
  }
  return svg;
}

/** Remove bare `<path>` children under `.staff` — the 5 staff lines Verovio
 *  draws. The dedicated staff-lines layer provides the single source. */
function stripStaffLinesFrom(root: Element) {
  for (const staff of Array.from(root.querySelectorAll('.staff'))) {
    for (const c of Array.from(staff.children)) {
      if (c.tagName === 'path') c.remove();
    }
  }
}

/** Remove the opening clef/keysig/meter from measure 1 only. The frozen
 *  overlay already draws these. Mid-piece key-sig changes in later
 *  measures are LEFT IN PLACE so they can scroll past the playhead —
 *  the overlay fades to the new key as each change crosses. */
function stripHeadersFrom(root: Element) {
  const first = root.querySelector('.measure');
  if (!first) return;
  for (const el of Array.from(first.querySelectorAll('.clef, .keySig, .meterSig'))) {
    el.remove();
  }
}

/** For loop mode: shift SVG copies 2..N left by headerWidth so music tiles
 *  end-to-end. Copy i's empty header region overlaps copy (i-1)'s music
 *  tail — blank there, no overdraw. */
function applyLoopSpacing(panSvgs: SVGSVGElement[], headerWidth: number) {
  for (let i = 1; i < panSvgs.length; i++) {
    panSvgs[i].style.marginLeft = `-${headerWidth}px`;
  }
}

/** Loop mode: attach an out-of-flow phantom tile positioned `-musicWidth`
 *  to the left of copy 1. It clones copy 1 (already header-stripped) so
 *  when the pan is translated right — either in the pre-roll lead-in
 *  pose, or when the reader drags backward past copy 1's start — the
 *  stage-left region shows the loop's tail rather than empty space. Also
 *  makes the wrap-left teleport (`while translateX > 0`) visually
 *  seamless: the content the wrap "reveals" on the left matches what the
 *  phantom was already drawing. */
function appendLoopLeader(pan: HTMLElement, source: SVGSVGElement, musicWidth: number): void {
  const leader = source.cloneNode(true) as SVGSVGElement;
  leader.style.position = 'absolute';
  leader.style.left = `-${musicWidth}px`;
  leader.style.top = '0';
  leader.style.height = '100%';
  leader.style.width = 'auto';
  leader.style.display = 'block';
  leader.setAttribute('aria-hidden', 'true');
  pan.appendChild(leader);
}

/** Set `--mask-start` / `--mask-end` CSS vars on the stage for the pan
 *  mask gradient. 0 → mask-start is fully transparent (pan hidden where
 *  the frozen overlay sits), mask-start → mask-end fades from 0 → 1,
 *  and mask-end onward is fully opaque. Pinning `end` to the playhead
 *  means a note at the playhead is at opacity 1 when it sounds, and
 *  fades out as it scrolls past into the header zone. Aligning `start`
 *  with the overlay's right edge keeps mid-piece key-change glyphs in
 *  the pan from leaking through the overlay during crossfades. */
function setFadeMaskVars(stage: HTMLElement, start: number, end: number) {
  stage.style.setProperty('--mask-start', `${start}px`);
  stage.style.setProperty('--mask-end', `${end}px`);
}

/**
 * Last header-event whose startMs ≤ ms. `events` is sorted by startMs
 * with a guaranteed entry at startMs=0, so the result is always defined.
 * Cheap enough to call each frame given typical event counts.
 */
function headerAtMs(events: ReadonlyArray<HeaderEvent>, ms: number): HeaderEvent {
  let e = events[0];
  for (const cand of events) {
    if (cand.startMs <= ms) e = cand;
    else break;
  }
  return e;
}

/**
 * Compute which timed elements are active at `ms` (startMs ≤ ms < endMs).
 * Returns a Set of ids so the caller can cheaply diff against the previous
 * frame's set. Assumes items list is small enough (≲ a few thousand) that
 * linear scanning every frame is fine — true for any realistic score.
 */
function activeIdsAt(
  items: ReadonlyArray<{ id: string; startMs: number; endMs: number }>,
  ms: number,
): Set<string> {
  const out = new Set<string>();
  for (const it of items) if (it.startMs <= ms && ms < it.endMs) out.add(it.id);
  return out;
}

/**
 * Apply the symmetric difference between `prev` and `next` sets as
 * class toggles on matching elements under `root`. Using the
 * attribute-selector form so we hit ALL elements sharing that id —
 * loop mode's N duplicated SVG copies each carry the same xml:id, and
 * the user may see any of them under the playhead at a given moment.
 */
function applyClassDiff(
  root: Element,
  prev: ReadonlySet<string>,
  next: ReadonlySet<string>,
  className: string,
) {
  for (const id of prev) {
    if (next.has(id)) continue;
    for (const el of root.querySelectorAll(`[id="${CSS.escape(id)}"]`)) {
      el.classList.remove(className);
    }
  }
  for (const id of next) {
    if (prev.has(id)) continue;
    for (const el of root.querySelectorAll(`[id="${CSS.escape(id)}"]`)) {
      el.classList.add(className);
    }
  }
}

/** Set up the rAF render loop that translates the pan. For loop scores,
 *  tracks a `wrapOffset` so the translate stays in (-musicWidth, 0] via
 *  invisible ±musicWidth teleports. Also toggles `.is-active` on notes
 *  and harms that are currently sounding so CSS can glow them. Returns
 *  a cancel fn. */
function setupRenderLoop(args: {
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
  notes: ReadonlyArray<Note>;
  harms: ReadonlyArray<Harm>;
  /** Header (clef + keysig) events within one iteration, sorted by
   *  startMs with a guaranteed entry at startMs=0. */
  headerEvents: ReadonlyArray<HeaderEvent>;
  /** Frozen overlay to crossfade as header events cross the playhead;
   *  null for scores that never visit more than one header state. */
  overlay: FrozenOverlay | null;
}): () => void {
  const { host, pan, player, loop, musicWidth, playheadPx, xAtMs, notes, harms,
          headerEvents, overlay } = args;
  let rafId = 0;
  let lastRenderMs = -1;
  let wrapOffset = 0;
  let lastIterSeen = 0;
  let prevActiveNotes: Set<string> = new Set();
  let prevActiveHarms: Set<string> = new Set();

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
        // Keep translate in (-musicWidth, 0]. The phantom leader tile
        // positioned at `-musicWidth` means either side of that range
        // has identical content to what the wrap reveals — the snap
        // is visually seamless. Skipping during pre-roll (ms<0) preserves
        // the lead-in pose where translate is intentionally positive.
        if (ms >= 0) {
          while (translateX <= -musicWidth) { translateX += musicWidth; wrapOffset += musicWidth; }
          while (translateX > 0) { translateX -= musicWidth; wrapOffset -= musicWidth; }
        }
      } else {
        translateX = playheadPx - xAtMs(ms);
      }
      pan.style.transform = `translateX(${translateX}px)`;
      host.classList.toggle('is-playing', player.isPlaying());

      // Glow only runs while playing. During drag/pause we don't want
      // random notes highlighted as the user scrubs through the timeline,
      // AND the per-frame class toggle work was the main drag cost — cheap
      // to skip when the audio isn't actually sounding anything.
      if (player.isPlaying()) {
        const nextNotes = activeIdsAt(notes, ms);
        const nextHarms = activeIdsAt(harms, ms);
        applyClassDiff(pan, prevActiveNotes, nextNotes, 'is-active');
        applyClassDiff(pan, prevActiveHarms, nextHarms, 'is-active');
        prevActiveNotes = nextNotes;
        prevActiveHarms = nextHarms;
      } else if (prevActiveNotes.size > 0 || prevActiveHarms.size > 0) {
        // Transitioning into pause: one-shot clear of any lingering glow.
        applyClassDiff(pan, prevActiveNotes, new Set(), 'is-active');
        applyClassDiff(pan, prevActiveHarms, new Set(), 'is-active');
        prevActiveNotes = new Set();
        prevActiveHarms = new Set();
      }

      // Overlay crossfade on any header change (clef, keysig, or both).
      // Pre-roll (ms < 0) resolves to the initial event. For loop mode
      // `ms` is already modulo'd to one iteration, so wrapping naturally
      // flips the overlay back to the initial fingerprint.
      if (overlay && headerEvents.length > 1) {
        overlay.setCurrent(headerFingerprint(headerAtMs(headerEvents, ms)));
      }
    }
    rafId = requestAnimationFrame(frame);
  }
  frame();
  return () => cancelAnimationFrame(rafId);
}

// ---------------------------------------------------------------------------
// Mount — the public entry point
// ---------------------------------------------------------------------------

export async function mountScore(host: HTMLElement): Promise<MountedScore | null> {
  const slug = host.dataset.slug;
  if (!slug) return null;
  const loop = host.hasAttribute('data-loop');
  const playheadFrac = Number(host.dataset.playhead ?? String(K.DEFAULT_PLAYHEAD_FRAC));

  const pan = host.querySelector<HTMLElement>('.score-pan');
  const playheadEl = host.querySelector<HTMLElement>('.score-playhead');
  const stage = host.querySelector<HTMLElement>('.score-stage') ?? host;
  if (!pan || !playheadEl) return null;

  // --- Fetch + render -----------------------------------------------------
  let meiText: string;
  try { meiText = await fetchMei(slug); }
  catch (err) { console.warn('[score]', slug, 'MEI load failed:', err); return null; }

  let rendered: Rendered;
  try { rendered = await renderMei(meiText); }
  catch (err) { console.warn('[score]', slug, 'Verovio render failed:', err); return null; }

  // --- Inject SVG copies into pan -----------------------------------------
  const panSvgs = injectCopies(pan, rendered.svg, loop ? K.LOOP_COPIES : 1);
  const svgEl = panSvgs[0];
  if (!svgEl) return null;

  // --- Measure geometry (anchors, header, staff y's) ----------------------
  const svgRect0 = svgEl.getBoundingClientRect();
  const stageRect0 = stage.getBoundingClientRect();
  const firstMeasure = svgEl.querySelector('.measure');
  const firstStaff = svgEl.querySelector('.staff');

  // measure-1 header in the pan's own coordinates — drives loop
  // copy-shifting so music tiles end-to-end across loop copies.
  const actualHeaderWidth = measureHeaderWidth(firstMeasure, svgRect0);
  const musicWidth = svgRect0.width - actualHeaderWidth;

  const anchors = padAnchors(
    buildAnchors(svgEl, rendered, svgRect0),
    rendered, loop, musicWidth, svgEl, svgRect0,
  );
  rendered.anchors = anchors;
  const xAtMs = makeXAtMs(anchors);

  // Re-time each mid-piece header event so its startMs matches the moment
  // the inline change glyph in the pan (clef and/or keysig) actually
  // crosses the playhead. Without this, overlay crossfades fire at the
  // first-note onset (hundreds of ms later at normal scroll rates) and
  // the glyph vanishes into the header before the header updates.
  // When both clef and keysig change we anchor to whichever glyph sits
  // leftmost — they render side by side at the start of the measure.
  const svgMeasures = Array.from(svgEl.querySelectorAll('.measure'));
  for (const evt of rendered.headerEvents) {
    if (evt.measureIdx === 0) continue;
    const m = svgMeasures[evt.measureIdx];
    if (!m) continue;
    let leftMost: DOMRect | null = null;
    for (const g of Array.from(m.querySelectorAll('.clef, .keySig'))) {
      const r = (g as Element).getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      if (!leftMost || r.left < leftMost.left) leftMost = r;
    }
    if (!leftMost) continue;
    const centerX = leftMost.left + leftMost.width / 2 - svgRect0.left;
    evt.startMs = msAtX(anchors, centerX);
  }

  const staffYs = measureStaffYs(firstStaff, stageRect0.top);

  // --- Build overlay shells + playhead + mask ---------------------------
  const shellMap = await renderHeaderShells(
    rendered.headerEvents, rendered.meterCount, rendered.meterUnit,
  );
  const shellWidths = measureShellWidths(shellMap, stageRect0.height);
  // Widest shell this score visits (NOT page-global). The overlay sizes
  // to this; the mask fade zone spans (this → playhead). For a C-only
  // score that's ~78→200 px of fade through blank space; for a
  // 7-accidental score it tightens to ~30 px. Fallback to the pan's
  // measure-1 header if no shell measurements landed.
  const headerWidestWidth =
    Math.max(0, ...shellWidths.values()) || actualHeaderWidth;

  // Playhead anchored to `HEADER_MAX_PX + OFFSET` so scores on one page
  // share the same axis, both scaled with actual stage height so mobile
  // (smaller stage) shrinks the reserved zone proportionally. Clamped
  // upward by the widest shell + OFFSET and by author-supplied
  // `data-playhead` (stage-fraction).
  const stageScale = stageRect0.height / K.REF_STAGE_HEIGHT_PX;
  const playheadOffsetPx = K.PLAYHEAD_OFFSET_PX * stageScale;
  const playheadPx = Math.max(
    headerWidestWidth + playheadOffsetPx,
    K.HEADER_MAX_PX * stageScale + playheadOffsetPx,
    playheadFrac * stageRect0.width,
  );
  playheadEl.style.left = `${playheadPx}px`;

  const initialFingerprint = rendered.headerEvents[0]
    ? headerFingerprint(rendered.headerEvents[0])
    : 'G2-0';
  const frozenOverlay = createFrozenOverlay(
    shellMap, initialFingerprint, headerWidestWidth,
  );
  if (frozenOverlay) stage.appendChild(frozenOverlay.host);

  const staffLayer = createStaffLinesLayer(staffYs, stageRect0);
  if (staffLayer) stage.insertBefore(staffLayer, stage.firstChild);

  // Shells own clef/keysig/meter for measure 1; strip it from the pan so
  // it's not drawn twice. Mid-piece changes in later measures stay put
  // and scroll past the playhead naturally.
  for (const s of panSvgs) stripStaffLinesFrom(s);
  if (frozenOverlay) stripStaffLinesFrom(frozenOverlay.host);
  for (const s of panSvgs) stripHeadersFrom(s);

  if (loop) {
    applyLoopSpacing(panSvgs, actualHeaderWidth);
    appendLoopLeader(pan, panSvgs[0], musicWidth);
  }
  setFadeMaskVars(stage, headerWidestWidth, playheadPx);

  const player = new ScorePlayer(rendered, loop, K.PRE_ROLL_MS, K.TAIL_MS);
  if (import.meta.env.DEV) {
    (host as unknown as { _player: ScorePlayer })._player = player;
  }
  player.onEnd = () => host.classList.remove('is-playing');

  const cancelLoop = setupRenderLoop({
    host, pan, player, loop, musicWidth, playheadPx, xAtMs,
    notes: rendered.notes, harms: rendered.harms,
    headerEvents: rendered.headerEvents, overlay: frozenOverlay,
  });

  // --- Pointer handler: drag-to-seek + click-to-toggle + fade-to-start ---
  // Overall scroll rate (px of pan-content per ms of score time). Computed
  // once from the anchor span; used by drag to translate pointer delta
  // into a ms delta. Matches the pre-roll rate by construction.
  const firstAnchor = anchors[0];
  const lastAnchor = anchors[anchors.length - 1];
  const scrollRatePxPerMs =
    (lastAnchor.x - firstAnchor.x) / (lastAnchor.t - firstAnchor.t);

  interface DragState {
    pointerId: number;
    startClientX: number;
    startMs: number;
    wasPlaying: boolean;
    moved: boolean;
  }
  let drag: DragState | null = null;

  const onPointerDown = (e: PointerEvent) => {
    if ((e.target as HTMLElement)?.closest('a, button')) return;
    // Only left mouse / primary touch — skip middle/right clicks.
    if (e.button !== undefined && e.button !== 0) return;
    // Record state but DO NOT pause yet. The pointer might just be a
    // click-to-toggle; pausing here would then let pointerup's toggle()
    // flip right back to playing, making "click to pause" a no-op.
    // Pausing is deferred until the first pointermove crosses the drag
    // threshold — at that moment seek() (called from onPointerMove)
    // auto-pauses any active playback.
    drag = {
      pointerId: e.pointerId,
      startClientX: e.clientX,
      startMs: player.currentMs(),
      wasPlaying: player.isPlaying(),
      moved: false,
    };
    stage.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const dx = e.clientX - drag.startClientX;
    if (!drag.moved && Math.abs(dx) > K.DRAG_THRESHOLD_PX) {
      drag.moved = true;
      // Flag active drag so CSS can suspend expensive effects (notably
      // the backdrop-filter blur, which must re-sample its backdrop
      // every frame the underlying pan translates).
      stage.classList.add('is-dragging');
    }
    if (!drag.moved) return;
    // dx > 0 (drag right) = reveal earlier music → seek backward in time.
    // player.seek() pauses internally if currently playing, so the audio
    // goes quiet as soon as the drag really begins.
    const msDelta = -dx / scrollRatePxPerMs;
    player.seek(drag.startMs + msDelta);
  };

  function triggerFadeToStart() {
    // Fade out, snap to t=0 while invisible, fade back in. The
    // `.is-resetting` class on .score-pan drives the CSS opacity
    // transition; we wait just past the transition end before snapping
    // position and peeling the class off.
    pan.classList.add('is-resetting');
    setTimeout(() => {
      player.resetToStart();
      // One rAF so renderFrame has a chance to repaint at the new
      // pausedAt=0 position BEFORE opacity returns.
      requestAnimationFrame(() => {
        pan.classList.remove('is-resetting');
      });
    }, K.RESET_FADE_MS + 20);
  }

  const onPointerUp = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const { wasPlaying, moved } = drag;
    try { stage.releasePointerCapture(e.pointerId); } catch {}
    drag = null;
    stage.classList.remove('is-dragging');
    if (moved) {
      // Drag completed — resume playback from the new position if the
      // reader was playing before they grabbed the score.
      if (wasPlaying) void player.play();
    } else {
      // Treat as a click.
      if (player.isAtEnd()) {
        triggerFadeToStart();
      } else {
        player.toggle();
      }
    }
  };

  const onPointerCancel = () => {
    drag = null;
    stage.classList.remove('is-dragging');
  };

  stage.addEventListener('pointerdown', onPointerDown);
  stage.addEventListener('pointermove', onPointerMove);
  stage.addEventListener('pointerup', onPointerUp);
  stage.addEventListener('pointercancel', onPointerCancel);

  return {
    destroy() {
      stage.removeEventListener('pointerdown', onPointerDown);
      stage.removeEventListener('pointermove', onPointerMove);
      stage.removeEventListener('pointerup', onPointerUp);
      stage.removeEventListener('pointercancel', onPointerCancel);
      cancelLoop();
      player.destroy();
    },
  };
}

// ---------------------------------------------------------------------------
// Bootstrapper — called from Score.astro's inline script
// ---------------------------------------------------------------------------

const mounted = new WeakMap<Element, MountedScore>();
const observed = new WeakSet<Element>();

export function attachAllScores() {
  for (const host of document.querySelectorAll<HTMLElement>('.score[data-slug]')) {
    if (mounted.has(host) || observed.has(host)) continue;
    observed.add(host);
    // Defer until the score is within 1 screen of the viewport — avoids
    // pulling Verovio's WASM on pages where the reader never reaches a score.
    const io = new IntersectionObserver(
      async (entries, obs) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          obs.disconnect();
          const handle = await mountScore(host);
          if (handle) mounted.set(host, handle);
        }
      },
      { rootMargin: `${K.IO_ROOT_MARGIN_PX}px 0px ${K.IO_ROOT_MARGIN_PX}px 0px` },
    );
    io.observe(host);
  }
}

/** Cleanup — called on astro:before-swap so AudioContexts and rAF loops
 *  from the outgoing page don't leak across SPA navigations. */
export function detachAllScores() {
  for (const host of document.querySelectorAll<HTMLElement>('.score[data-slug]')) {
    const handle = mounted.get(host);
    if (handle) { handle.destroy(); mounted.delete(host); }
    observed.delete(host);
  }
}
