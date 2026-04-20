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
  /** Width of the fade zone just past the overlay where notes fade in/out
   *  as they scroll toward the header. Smaller = more abrupt. */
  MASK_FADE_PX: 24,
  /** Gap between the overlay's right edge and the start of the fade zone. */
  MASK_OVERLAY_MARGIN_PX: 4,
  /** Extra pixels added to overlay width past headerWidth for visual breath. */
  OVERLAY_BREATH_PX: 8,
  /** How far the IntersectionObserver pre-loads a score before viewport entry. */
  IO_ROOT_MARGIN_PX: 200,
  /** Default playhead position when the author doesn't specify one. */
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

interface Rendered {
  svg: string;
  notes: Note[];
  harms: Harm[];
  anchors: Anchor[];  // filled in by mountScore after the SVG is in DOM
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

  // Harms (chord symbols + functional labels). Parse the SVG to find
  // every `.harm[id]`, ask Verovio for its onset ms, then compute each
  // harm's endMs as the onset of the next DISTINCT harm beat (so the
  // "Dm7 above" and "ii below" pair that share a tstamp both cover
  // the same interval). For the last group, endMs = maxTstamp.
  const harms: Harm[] = [];
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(svg, 'image/svg+xml');
    const harmEls = Array.from(doc.querySelectorAll('.harm[id]'));
    const byStart = new Map<number, string[]>();
    for (const el of harmEls) {
      const id = (el as Element).id;
      if (!id) continue;
      const t = toolkit.getTimesForElement(id) as {
        realTimeOnsetMilliseconds?: number | number[];
      };
      const onsetRaw = t?.realTimeOnsetMilliseconds;
      const onset = Array.isArray(onsetRaw) ? onsetRaw[0] : onsetRaw;
      if (typeof onset !== 'number') continue;
      const arr = byStart.get(onset) ?? [];
      arr.push(id);
      byStart.set(onset, arr);
    }
    const sortedStarts = [...byStart.keys()].sort((a, b) => a - b);
    for (let i = 0; i < sortedStarts.length; i++) {
      const start = sortedStarts[i];
      const end = sortedStarts[i + 1] ?? maxTstamp;
      for (const id of byStart.get(start)!) {
        harms.push({ id, startMs: start, endMs: end });
      }
    }
  } catch (err) {
    // Harm timing extraction is best-effort — if Verovio's API shape
    // changes or the SVG is unusual, just ship without harm sync.
    console.warn('[score] harm timing extraction failed:', err);
  }

  toolkit.destroy();

  return { svg, notes, harms, anchors: [], totalMs: maxTstamp };
}

// ---------------------------------------------------------------------------
// Web Audio synth — a tiny polyphonic voice bank
// ---------------------------------------------------------------------------

class Synth {
  private ctx: AudioContext;
  private master: GainNode;
  private active: Set<{ osc: OscillatorNode; gain: GainNode; until: number }> = new Set();

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0.24;
    this.master.connect(ctx.destination);
  }

  /** Schedule one note on the audio clock, with an ADSR envelope. */
  play(midi: number, startT: number, endT: number) {
    const ctx = this.ctx;
    if (endT <= startT) endT = startT + 0.05;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.value = 440 * Math.pow(2, (midi - 69) / 12);

    const A = 0.015, D = 0.09, S = 0.55, R = 0.12, peak = 0.8;
    const sustain = peak * S;
    const sustainUntil = Math.max(startT + A + D, endT - R);
    gain.gain.setValueAtTime(0, startT);
    gain.gain.linearRampToValueAtTime(peak, startT + A);
    gain.gain.linearRampToValueAtTime(sustain, startT + A + D);
    gain.gain.setValueAtTime(sustain, sustainUntil);
    gain.gain.linearRampToValueAtTime(0, sustainUntil + R);

    osc.connect(gain);
    gain.connect(this.master);
    osc.start(startT);
    osc.stop(sustainUntil + R + 0.02);

    const voice = { osc, gain, until: sustainUntil + R };
    this.active.add(voice);
    osc.onended = () => {
      try { gain.disconnect(); } catch {}
      this.active.delete(voice);
    };
  }

  /** Cancel all pending/sounding voices — used on pause. */
  panic() {
    const now = this.ctx.currentTime;
    for (const v of this.active) {
      try {
        v.gain.gain.cancelScheduledValues(now);
        v.gain.gain.setValueAtTime(v.gain.gain.value, now);
        v.gain.gain.linearRampToValueAtTime(0, now + 0.04);
        v.osc.stop(now + 0.06);
      } catch {}
    }
    this.active.clear();
  }
}

// ---------------------------------------------------------------------------
// ScorePlayer — transport + scheduling
// ---------------------------------------------------------------------------

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
    this.tick();
    this.schedulerTimer = setInterval(() => this.tick(), ScorePlayer.SCHED_INTERVAL_MS);
  }

  pause() {
    if (!this.playing || !this.ctx || !this.synth) return;
    this.pausedAt = (this.ctx.currentTime - this.iterStart) * 1000;
    if (this.loop) this.pausedAt = this.pausedAt % this.rendered.totalMs;
    this.playing = false;
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
      const startT = this.iterStart + (iterBase + note.startMs) / 1000;
      const endT = this.iterStart + (iterBase + note.endMs) / 1000;
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

/** Frozen header overlay (clef / keysig / meter, pinned at stage left).
 *  Returns null if there's no header to show. */
function createFrozenOverlay(
  srcSvg: SVGSVGElement,
  headerWidth: number,
): HTMLDivElement | null {
  const shell = cloneMeasureOneShell(srcSvg);
  if (!shell) return null;
  const host = document.createElement('div');
  host.className = 'score-frozen-overlay';
  host.style.width = `${headerWidth + K.OVERLAY_BREATH_PX}px`;
  host.appendChild(shell);
  return host;
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

/** Remove clef/keysig/meter from every measure inside a subtree. */
function stripHeadersFrom(root: Element) {
  for (const el of Array.from(root.querySelectorAll('.clef, .keySig, .meterSig'))) {
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

/** Set `--mask-start` / `--mask-end` CSS vars on the stage for the pan
 *  mask gradient. Mask is opaque-0 through mask-start (hidden beneath
 *  overlay), fades to opaque-1 by mask-end (the fade zone past the
 *  overlay), then opaque all the way to the right edge. */
function setFadeMaskVars(stage: HTMLElement, headerWidth: number) {
  const start = headerWidth + K.MASK_OVERLAY_MARGIN_PX;
  const end = start + K.MASK_FADE_PX;
  stage.style.setProperty('--mask-start', `${start}px`);
  stage.style.setProperty('--mask-end', `${end}px`);
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
  stage: HTMLElement;
  pan: HTMLElement;
  player: ScorePlayer;
  loop: boolean;
  musicWidth: number;
  playheadFrac: number;
  xAtMs: (ms: number) => number;
  notes: ReadonlyArray<Note>;
  harms: ReadonlyArray<Harm>;
}): () => void {
  const { host, stage, pan, player, loop, musicWidth, playheadFrac, xAtMs, notes, harms } = args;
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
      const stageRect = stage.getBoundingClientRect();
      const playheadPx = playheadFrac * stageRect.width;

      let translateX: number;
      if (loop) {
        const containerX = xAtMs(ms);
        const iter = player.currentIteration();
        if (iter !== lastIterSeen) {
          wrapOffset -= (iter - lastIterSeen) * musicWidth;
          lastIterSeen = iter;
        }
        translateX = playheadPx - containerX + wrapOffset;
        // Wrap logic only applies AFTER pre-roll (ms >= 0). During the
        // lead-in, translate is intentionally positive so the first note
        // sits off to the right of the playhead — wrapping would teleport
        // the pan into a mid-loop copy and destroy the effect.
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
  playheadEl.style.left = `${playheadFrac * 100}%`;

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

  const headerWidth = measureHeaderWidth(firstMeasure, svgRect0);
  const svgWidth = svgRect0.width;
  const musicWidth = svgWidth - headerWidth;

  const anchors = padAnchors(
    buildAnchors(svgEl, rendered, svgRect0),
    rendered, loop, musicWidth, svgEl, svgRect0,
  );
  rendered.anchors = anchors;
  const xAtMs = makeXAtMs(anchors);

  const staffYs = measureStaffYs(firstStaff, stageRect0.top);

  // --- Build overlay (while the header elements are still in place) ------
  const frozenOverlay = createFrozenOverlay(svgEl, headerWidth);
  if (frozenOverlay) stage.appendChild(frozenOverlay);

  // --- Build the single-source staff-lines layer -------------------------
  const staffLayer = createStaffLinesLayer(staffYs, stageRect0);
  if (staffLayer) stage.insertBefore(staffLayer, stage.firstChild);

  // --- Strip: staff lines from pan + overlay, headers from pan -----------
  for (const s of panSvgs) stripStaffLinesFrom(s);
  if (frozenOverlay) stripStaffLinesFrom(frozenOverlay);
  for (const s of panSvgs) stripHeadersFrom(s);

  // --- Loop spacing + pan mask --------------------------------------------
  if (loop) applyLoopSpacing(panSvgs, headerWidth);
  setFadeMaskVars(stage, headerWidth);

  // --- Player + render + pointer handler ---------------------------------
  const player = new ScorePlayer(rendered, loop, K.PRE_ROLL_MS, K.TAIL_MS);
  if (import.meta.env.DEV) {
    // Dev-only hook for console inspection / tests. Not referenced by any
    // production code path.
    (host as unknown as { _player: ScorePlayer })._player = player;
  }
  player.onEnd = () => host.classList.remove('is-playing');

  const cancelLoop = setupRenderLoop({
    host, stage, pan, player, loop, musicWidth, playheadFrac, xAtMs,
    notes: rendered.notes, harms: rendered.harms,
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
