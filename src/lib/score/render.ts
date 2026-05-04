/*
 * Render — everything that touches MEI / SVG / DOM geometry.
 *
 * Three layers:
 *   1. MEI → Rendered:        renderMei()
 *      Verovio-driven SVG generation + timemap + harm/header/tie metadata.
 *   2. Layout helpers:        injectCopies, buildAnchors, makeXAtMs, …
 *      Pure functions over the SVG once it's in the DOM. Compose in
 *      mountScore (see index.ts).
 *   3. Per-frame loop:        setupRenderLoop()
 *      The rAF that translates `.score-pan` and crossfades the frozen
 *      overlay on header changes.
 *
 * No transport, no audio. Reads ms positions from a ScorePlayer-shaped
 * handle (type-only import keeps render.ts independent of player.ts).
 */
import { K, MEASURE_MUSIC_CLASSES } from './constants';
import { loadVerovio } from './verovio';
// Vite's `?worker` suffix yields a default export that's a Worker
// constructor; the worker entry is bundled as a separate chunk and
// the URL is resolved correctly in both dev and prod builds.
import RenderWorkerCtor from './render-worker.ts?worker';
import type {
  Anchor,
  Harm,
  Note,
  Rendered,
  StaffDef,
  StaffGroup,
  TempoEvent,
} from './types';
import type { ScorePlayer } from './player';

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

/**
 * Source data for renderScore. Either UTF-8 text (MEI / uncompressed
 * MusicXML / Humdrum / ABC — Verovio sniffs the format) or an
 * ArrayBuffer for compressed `.mxl` (PKZIP container holding a
 * MusicXML file). The bridge to Verovio is:
 *   - text → toolkit.loadData(string)
 *   - mxl  → toolkit.loadZipDataBase64(base64)
 */
export type ScoreSource =
  | { kind: 'text'; data: string }
  | { kind: 'mxl';  data: ArrayBuffer };

/** Encode an ArrayBuffer as base64 in chunks (avoids the call-stack
 *  blowup `String.fromCharCode(...new Uint8Array(buf))` causes on
 *  large files — `.mxl` containers can be tens of MB). */
function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(
      null, bytes.subarray(i, i + CHUNK) as unknown as number[],
    );
  }
  return btoa(binary);
}

/** Parse the rendered SVG once, strip whole subtrees of non-visible
 *  Verovio bookkeeping + dense markings (pedal), then serialize back
 *  to a string that gets injected into the pan. Doing this once on the
 *  string saves N parse+strip+walk passes when injectCopies tiles N
 *  copies of the SVG into the DOM.
 *
 *  Why DOMParser instead of regex string surgery: the SMuFL font defs
 *  contain `<glyph>` elements whose substring `<g` confuses any
 *  homemade balanced-tag tracker, eating whole sibling subtrees by
 *  accident. Parsing is a few ms on Ravel's SVG and is correct.
 *
 *  Pure-BPM tempo markings (the `<g class="tempo">` rendered as just
 *  `♩=N` with no descriptive word) are also stripped. A series of
 *  rit. BPM steps stacks up to a row of identical-looking quarter-
 *  note-equals-number stamps that crowd the pan; the tempo overlay
 *  in the top-left already shows the currently-active value, so the
 *  inline copies are redundant. Named tempos ("Allegretto", "TRES
 *  DOUX") are kept — those carry interpretive intent the overlay's
 *  numeric display can't convey. */
function stripInvisibleChromeFromSvgString(svgStr: string): string {
  const targets = [
    '.pb', '.sb',
    '.pgHead', '.pgFoot',
    '.pageMilestoneEnd', '.pageMilestoneStart',
    '.systemMilestone', '.systemMilestoneEnd',
    '.sectionMilestone', '.sectionMilestoneEnd',
    '.pedal',
  ].join(',');
  const doc = new DOMParser().parseFromString(svgStr, 'image/svg+xml');
  if (doc.querySelector('parsererror')) return svgStr;
  for (const el of Array.from(doc.querySelectorAll(targets))) el.remove();
  // Strip pure-BPM tempo glyphs: `<g class="tempo">` whose only
  // textual payload is a music symbol (♩, ♪, etc., from the Leipzig
  // PUA E000-F8FF range) plus digits + `=` + parens + whitespace.
  // A `<g>` with ANY 3-or-more consecutive Latin/Greek/CJK letters
  // is a named tempo and stays.
  const NAMED_RE = /[A-Za-zÀ-žα-ωΑ-Ω一-鿿]{3,}/;
  for (const tempoEl of Array.from(doc.querySelectorAll('.tempo'))) {
    const txt = tempoEl.textContent ?? '';
    if (!NAMED_RE.test(txt)) tempoEl.remove();
  }
  return new XMLSerializer().serializeToString(doc);
}

/** Drop staves that carry no notes at all across the entire piece.
 *  Returns the serialized MEI with truly-empty staves removed, or null
 *  if every staff has at least one note (or nothing could be parsed).
 *
 *  Why ZERO instead of a fractional threshold: a sparse-but-nonzero
 *  staff (e.g. Ravel's 3rd staff for cross-hand passages: 71 notes vs
 *  2846 on staff 1) carries real music; deleting it makes those notes
 *  silent. The remaining visual noise of long-empty stretches is
 *  handled downstream by per-staff visual dimming when the staff is
 *  silent for many consecutive measures, NOT by removal here. */
function trimEmptyStaves(meiText: string): string | null {
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(meiText, 'application/xml');
  } catch {
    return null;
  }
  if (doc.querySelector('parsererror')) return null;

  // Count notes per staff number across the entire piece.
  const noteCount = new Map<string, number>();
  for (const staff of Array.from(doc.querySelectorAll('staff[n]'))) {
    const n = staff.getAttribute('n');
    if (!n) continue;
    noteCount.set(n, (noteCount.get(n) ?? 0) + staff.querySelectorAll('note').length);
  }
  if (noteCount.size === 0) return null;

  const allStaffDefs = Array.from(doc.querySelectorAll('staffDef[n]'));
  const emptyNs = new Set<string>();
  for (const sd of allStaffDefs) {
    const n = sd.getAttribute('n');
    if (!n) continue;
    const cnt = noteCount.get(n) ?? 0;
    if (cnt === 0) emptyNs.add(n);
  }
  if (emptyNs.size === 0) return null;
  // Refuse to drop ALL staves — leaves Verovio nothing to render and
  // is almost certainly a parser quirk in our counting rather than a
  // genuinely note-less score.
  if (emptyNs.size >= allStaffDefs.length) return null;

  for (const sd of allStaffDefs) {
    const n = sd.getAttribute('n');
    if (n && emptyNs.has(n)) sd.remove();
  }
  for (const st of Array.from(doc.querySelectorAll('staff[n]'))) {
    const n = st.getAttribute('n');
    if (n && emptyNs.has(n)) st.remove();
  }
  // Also drop control elements (dynam, harm, tempo placements, etc.)
  // that point at the removed staves via @staff — Verovio would warn
  // and they have no anchor anymore. Keeps the rendered SVG clean.
  for (const el of Array.from(doc.querySelectorAll('[staff]'))) {
    const ref = el.getAttribute('staff');
    if (ref && emptyNs.has(ref)) el.remove();
  }

  return new XMLSerializer().serializeToString(doc);
}

/** Cache of rendered scores keyed by source-data hash. Survives Astro
 *  SPA `astro:page-load` navigations (the module isn't reloaded), so
 *  bouncing between essays that reference the same score skips the
 *  full Verovio render path on subsequent mounts. Sized for ~10
 *  scores; the LRU eviction is naive (oldest insert wins) but fine
 *  for a personal-blog scale.
 *
 *  Cache hit savings on Ravel: ~10s of Verovio MXL→MEI conversion
 *  and full SVG render avoided per re-mount. The IndexedDB layer
 *  below extends this across hard refreshes / new tabs / new days. */
const RENDER_CACHE = new Map<string, Rendered>();
const RENDER_CACHE_MAX = 12;

/** Cheap non-cryptographic hash of source bytes (FNV-1a 32-bit). Same
 *  source always produces the same key; collisions across different
 *  scores are vanishingly unlikely at our scale. We also mix in the
 *  source kind so a hypothetical .mei vs .mxl with byte-identical
 *  content (impossible in practice but safer to be defensive) maps
 *  to distinct cache entries. */
function sourceHash(src: ScoreSource): string {
  let h = 0x811c9dc5;
  if (src.kind === 'text') {
    for (let i = 0; i < src.data.length; i++) {
      h ^= src.data.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
  } else {
    const bytes = new Uint8Array(src.data);
    for (let i = 0; i < bytes.length; i++) {
      h ^= bytes[i];
      h = Math.imul(h, 0x01000193);
    }
  }
  return `${src.kind}:${(h >>> 0).toString(36)}`;
}

// ---------------------------------------------------------------------------
// IndexedDB cache layer — persists Rendered across sessions
// ---------------------------------------------------------------------------

/** Bumped whenever the persisted Rendered shape changes. Old entries
 *  are silently ignored (treated as misses) so a stale schema can't
 *  feed the new pipeline malformed data. */
const IDB_SCHEMA_VERSION = 10;
const IDB_NAME = 'score-cache';
const IDB_STORE = 'rendered';

let idbOpenPromise: Promise<IDBDatabase | null> | null = null;
function openIdb(): Promise<IDBDatabase | null> {
  if (idbOpenPromise) return idbOpenPromise;
  idbOpenPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') { resolve(null); return; }
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  return idbOpenPromise;
}

interface IdbEntry { v: number; rendered: Rendered; ts: number }

async function idbGet(key: string): Promise<Rendered | null> {
  const db = await openIdb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(key);
      req.onsuccess = () => {
        const entry = req.result as IdbEntry | undefined;
        if (!entry || entry.v !== IDB_SCHEMA_VERSION) { resolve(null); return; }
        resolve(entry.rendered);
      };
      req.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}

async function idbPut(key: string, rendered: Rendered): Promise<void> {
  const db = await openIdb();
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(
        { v: IDB_SCHEMA_VERSION, rendered, ts: Date.now() } satisfies IdbEntry,
        key,
      );
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch { resolve(); }
  });
}

/** Best-effort defer: prefer requestIdleCallback, fall back to a
 *  zero-timeout. Keeps the IDB write off the mount-critical path so
 *  the user sees the score paint before we commit the cache write. */
function whenIdle(fn: () => void): void {
  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(fn, { timeout: 2000 });
  } else {
    setTimeout(fn, 0);
  }
}

// ---------------------------------------------------------------------------
// Web Worker dispatcher — first-time render cost runs off the main thread
// ---------------------------------------------------------------------------
//
// Verovio's MXL→MEI conversion + full SVG render takes 5–15 s on dense
// pieces like Ravel's Jeux d'eau. Running that on the main thread froze
// scrolling, the page menu, and any other JS during cold load. The
// worker takes the source bytes, returns the Rendered object, and the
// main thread's IDB cache then keeps subsequent loads instant.
//
// We pool a single worker per page (Verovio WASM is ~1.5 MB and reuses
// internal state across loadData calls). All scores share it. If the
// browser blocks workers (very rare) or worker boot fails, we fall
// back to running renderScoreUncached on the main thread.

interface WorkerReq { id: number; src: ScoreSource }
type WorkerRes =
  | { id: number; ok: true; rendered: Rendered }
  | { id: number; ok: false; error: string };

let renderWorkerInstance: Worker | null = null;
let renderWorkerFailed = false;
const workerPending = new Map<
  number,
  { resolve: (r: Rendered) => void; reject: (e: Error) => void }
>();
let nextWorkerMsgId = 0;

function getRenderWorker(): Worker | null {
  if (renderWorkerFailed) return null;
  if (renderWorkerInstance) return renderWorkerInstance;
  if (typeof Worker === 'undefined') { renderWorkerFailed = true; return null; }
  try {
    const w = new RenderWorkerCtor();
    w.addEventListener('message', (e: MessageEvent<WorkerRes>) => {
      const msg = e.data;
      const pending = workerPending.get(msg.id);
      if (!pending) return;
      workerPending.delete(msg.id);
      if (msg.ok) pending.resolve(msg.rendered);
      else pending.reject(new Error(msg.error));
    });
    w.addEventListener('error', (ev) => {
      console.warn('[score] render worker error', ev);
      for (const { reject } of workerPending.values()) {
        reject(new Error('render worker crashed'));
      }
      workerPending.clear();
      renderWorkerInstance = null;
      renderWorkerFailed = true;
    });
    renderWorkerInstance = w;
    return w;
  } catch (err) {
    console.warn('[score] worker creation failed, will fall back to main thread:', err);
    renderWorkerFailed = true;
    return null;
  }
}

async function renderScoreViaWorker(src: ScoreSource): Promise<Rendered> {
  const w = getRenderWorker();
  if (!w) return renderScoreUncached(src);
  return new Promise<Rendered>((resolve, reject) => {
    const id = ++nextWorkerMsgId;
    workerPending.set(id, { resolve, reject });
    // Use structured clone (no transfer): if the worker fails for any
    // reason and we fall back to the main-thread render, the buffer
    // is still usable. The clone cost on a sub-MB .mxl is sub-ms,
    // dwarfed by the Verovio render that follows.
    w.postMessage({ id, src } satisfies WorkerReq);
  }).catch(async (err) => {
    const msg = String((err as Error)?.message ?? err);
    // If the worker reported a capability gap we can't recover from
    // (e.g. older browsers without DOMParser in WorkerGlobalScope),
    // permanently disable the worker so subsequent renders skip the
    // round-trip and just run on the main thread.
    if (/DOMParser unavailable/.test(msg)) {
      console.warn('[score] worker disabled (browser lacks DOMParser in workers); using main thread');
      try { renderWorkerInstance?.terminate(); } catch {}
      renderWorkerInstance = null;
      renderWorkerFailed = true;
    } else {
      console.warn('[score] worker render failed, falling back:', err);
    }
    return renderScoreUncached(src);
  });
}

export async function renderScore(src: ScoreSource): Promise<Rendered> {
  const key = sourceHash(src);
  // L1: in-memory (per-session, survives SPA navigations).
  const memCached = RENDER_CACHE.get(key);
  if (memCached) {
    RENDER_CACHE.delete(key);
    RENDER_CACHE.set(key, memCached);
    return memCached;
  }
  // L2: IndexedDB (persistent across reloads / tabs / days).
  const idbCached = await idbGet(key);
  if (idbCached) {
    RENDER_CACHE.set(key, idbCached);
    return idbCached;
  }
  // Cold path — full Verovio render. Runs in a Web Worker so the main
  // thread stays responsive (scrolling, menu, overlays) during the
  // 5–15 s first-time render of dense pieces.
  const rendered = await renderScoreViaWorker(src);
  RENDER_CACHE.set(key, rendered);
  if (RENDER_CACHE.size > RENDER_CACHE_MAX) {
    const oldest = RENDER_CACHE.keys().next().value;
    if (oldest !== undefined) RENDER_CACHE.delete(oldest);
  }
  // Fire-and-forget IDB write — defer past the current paint so the
  // serialization cost (3MB+ for Ravel) doesn't compete with render
  // loop setup.
  whenIdle(() => { void idbPut(key, rendered); });
  return rendered;
}

export async function renderScoreUncached(src: ScoreSource): Promise<Rendered> {
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
    // Tighten the inter-staff gap. Verovio's default `spacingStaff` (12)
    // reserves room above/below each staff for harm + dynam + tempo
    // glyphs that may sit between staves; for our scrolling renderer
    // we want grand staves to read like a single block, so we collapse
    // most of that reservation.
    spacingStaff: 4,
    // Same idea for system distance; we only ever render one system
    // (breaks: 'none'), but keeping it small avoids dead margin around
    // the music when adjustPageHeight rounds the layout.
    spacingSystem: 4,
    // Tighten brace-group inter-staff spacing on grand staves —
    // separate option from spacingStaff and the default leaves a lot
    // of air between treble + bass.
    spacingBraceGroup: 4,
    spacingBracketGroup: 4,
    // Pull harm labels closer to the staff they annotate so they don't
    // push extra vertical space between staves.
    harmDist: 0.5,
    // Likewise for dynamics (pp, dolcissimo, una corda).
    dynamDist: 0.5,
    // Skip page header / footer — we don't render either, and Verovio's
    // default emits a `<g class="pgHead">` (title block) and matching
    // pgFoot that just inflate the SVG. Header is "auto" by default;
    // setting "none" suppresses it.
    header: 'none',
    footer: 'none',
  });
  // Load whichever flavor we received. Verovio auto-detects the text
  // formats (MEI / MusicXML / Humdrum / ABC); compressed MXL needs the
  // base64-zip entry point.
  const ok = src.kind === 'mxl'
    ? toolkit.loadZipDataBase64(arrayBufferToBase64(src.data))
    : toolkit.loadData(src.data);
  if (!ok) throw new Error('Verovio loadData failed');

  // Pre-pass: detect staves that carry no notes anywhere in the piece
  // and rewrite the loaded MEI to drop them. MusicXML→MEI converters
  // (esp. MuseScore) often emit declared-but-empty staves — Ravel's
  // Jeux d'eau opening allocates a 3rd staff that holds whole rests
  // throughout the visible region, which would otherwise add a useless
  // empty row to the rendered grand staff. Reload and continue with
  // the trimmed MEI so subsequent timemap + getMEI calls reflect it.
  {
    const trimmed = trimEmptyStaves(toolkit.getMEI());
    if (trimmed) toolkit.loadData(trimmed);
  }

  // We always parse the MEI representation for harm/tempo/header
  // metadata — Verovio normalizes any input format into MEI internally,
  // so calling getMEI() gives us a consistent surface to walk regardless
  // of whether the source was MusicXML, Humdrum, or already MEI.
  const meiText: string = toolkit.getMEI();

  // Verovio occasionally bakes `fill="black"` into specific glyph paths
  // (noteheads in some font/version combos, pedal markers, dir glyphs).
  // CSS `fill: currentColor` on ancestor groups can't override an
  // explicit presentation attribute on the path itself, so we rewrite
  // the SVG source up-front. `currentColor` then resolves to whatever
  // `color` the consuming CSS sets (`var(--fg-dim)` here). Same fix
  // for stroke="black" which a few line/bracket glyphs carry.
  //
  // Also strip whole subtrees of non-visible chrome before the SVG
  // ever hits the DOM — doing it on the raw string is dramatically
  // cheaper than parsing, querying, and removing N times once it's
  // injected into N loop copies. For Ravel that drops ~1k nodes per
  // copy (pedal × 438 + milestoneEnds × hundreds + indent whitespace).
  const svg: string = stripInvisibleChromeFromSvgString(
    toolkit.renderToSVG(1, false)
      .replace(/\bfill="(black|#000|#000000)"/gi, 'fill="currentColor"')
      .replace(/\bstroke="(black|#000|#000000)"/gi, 'stroke="currentColor"'),
  );
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

  // Parse the MEI source once and walk it for everything that needs MEI
  // structure (not visible glyphs): the staff group (count + brace
  // symbol), tempo events, harm onsets, and the running BPM/meter that
  // turn `<tempo>`/`<harm>` tstamps into ms positions. Clef/keysig
  // chrome state used to be derived here too — that path now flows
  // through `buildChromeOverlay` reading the rendered SVG directly,
  // since Verovio's glyph choices (E07A vs E050, courtesy clefs, etc.)
  // are the only source of truth that consistently matches the pan.
  const harms: Harm[] = [];
  const tempoEvents: TempoEvent[] = [];
  let meterCount = 4;
  let meterUnit = 4;
  // Defaulted; populated from the source MEI below. Fallback shape covers
  // the degenerate "no <staffDef>" case so downstream code always has at
  // least one staff to iterate.
  let staffGroup: StaffGroup = {
    staves: [{ n: '1', lines: 5 }],
    symbol: null,
  };
  try {
    const meiDoc = new DOMParser().parseFromString(meiText, 'application/xml');
    const initialScoreDef = meiDoc.querySelector('scoreDef');
    let currentBpm = Number(initialScoreDef?.getAttribute('midi.bpm') ?? 120);
    meterCount = Number(initialScoreDef?.getAttribute('meter.count') ?? 4);
    meterUnit = Number(initialScoreDef?.getAttribute('meter.unit') ?? 4);

    // Walk the entire <staffGrp> tree to enumerate every leaf <staffDef>
    // in document order, and capture the brace/bracket symbol if present.
    // Multi-staff sources (piano grand staff, orchestral) nest a child
    // <staffGrp bar.thru="true"> inside the outer one; we recurse so we
    // catch staves at any nesting depth and pick up `<grpSym symbol="…">`
    // wherever it sits in the hierarchy.
    const initialStaffGrp = initialScoreDef?.querySelector('staffGrp');
    const collectedStaves: StaffDef[] = [];
    let collectedSymbol: StaffGroup['symbol'] = null;
    const walkStaffGrp = (grp: Element | null | undefined) => {
      if (!grp) return;
      for (const child of Array.from(grp.children)) {
        const ln = child.localName;
        if (ln === 'grpSym') {
          const sym = child.getAttribute('symbol');
          if (sym === 'brace' || sym === 'bracket' || sym === 'line') collectedSymbol = sym;
        } else if (ln === 'staffGrp') {
          walkStaffGrp(child);
        } else if (ln === 'staffDef') {
          const n = child.getAttribute('n') ?? String(collectedStaves.length + 1);
          const lines = Number(child.getAttribute('lines') ?? 5);
          collectedStaves.push({ n, lines });
        }
      }
    };
    walkStaffGrp(initialStaffGrp);
    if (collectedStaves.length > 0) {
      staffGroup = { staves: collectedStaves, symbol: collectedSymbol };
    }

    // Synthetic initial tempo event (display "♩=BPM") is needed only
    // if measure 1 doesn't have its own <tempo> at tstamp=1 — otherwise
    // they'd both sit at startMs=0 and the synthetic would shadow the
    // real marking ("Tres doux" etc.) on the initial overlay paint.
    // Plain `querySelector('measure')` (no parent constraint) finds
    // measure 1 even when MusicXML→MEI nests it inside an inner section.
    const firstMeasureEl = meiDoc.querySelector('measure');
    const firstMeasureHasTempo = !!(firstMeasureEl && Array.from(firstMeasureEl.children).some((c) =>
      c.localName === 'tempo' && Number(c.getAttribute('tstamp') ?? 1) === 1,
    ));
    if (!firstMeasureHasTempo) {
      tempoEvents.push({
        startMs: 0, measureIdx: 0, bpm: currentBpm, display: `♩=${currentBpm}`,
      });
    }

    /** Read a BPM from a <tempo> or <scoreDef> element. Prefers
     *  midi.bpm (always quarter-note); falls back to mm with mm.unit
     *  conversion (e.g. mm=144 mm.unit=8 → quarter-bpm 72). */
    const bpmFromEl = (el: Element): number | null => {
      const direct = Number(el.getAttribute('midi.bpm'));
      if (Number.isFinite(direct) && direct > 0) return direct;
      const mm = Number(el.getAttribute('mm'));
      if (!Number.isFinite(mm) || mm <= 0) return null;
      const unit = Number(el.getAttribute('mm.unit') ?? 4);
      if (!Number.isFinite(unit) || unit <= 0) return null;
      // mm beats of value (mm.unit) per minute → quarter-bpm = mm * (4 / unit)
      return mm * (4 / unit);
    };

    const meiOnsets: number[] = [];
    let totalMsManual = 0;  // running ms accumulator for manual measure starts
    // Running meter — count is multiplied by msPerBeat to advance
    // totalMsManual per measure, so mid-piece meter changes affect
    // subsequent measure boundaries (and harm onsets that key off them).
    let runMeterCount = meterCount;
    // Walk measures and mid-piece scoreDefs in document order, recursing
    // through any nesting. MusicXML→MEI conversion wraps the actual
    // measures in an inner <section> (with <expansion>/<pb> siblings at
    // the outer level), so a single-level `section.children` walk misses
    // every measure on imported pieces. The generator yields measure
    // and scoreDef elements only; it does NOT recurse into either, since
    // their children (notes, staffGrps) aren't relevant to this loop.
    function* walkMusicElements(root: Element): Generator<Element> {
      for (const child of Array.from(root.children)) {
        if (child.localName === 'measure' || child.localName === 'scoreDef') {
          yield child;
          continue;
        }
        yield* walkMusicElements(child);
      }
    }
    const scoreEl = meiDoc.querySelector('score');
    if (scoreEl) {
      let measureIdx = 0;
      let initialScoreDefSkipped = false;
      for (const child of walkMusicElements(scoreEl)) {
        if (child.localName === 'scoreDef' && !initialScoreDefSkipped) {
          // The first scoreDef is the top-level initial one, already
          // processed above for staff group / bpm / meter. Skip here.
          initialScoreDefSkipped = true;
          continue;
        }
        if (child.localName === 'measure') {
          // Apply any <tempo tstamp="1"> at the head of this measure
          // BEFORE computing this measure's beat ms. Mid-measure tempo
          // changes (tstamp > 1) are recorded for the overlay but the
          // measure's harm onsets use the head-of-measure BPM — full
          // mid-measure piecewise harm timing isn't worth the complexity.
          const tempoEl = Array.from(child.children).find((c) =>
            c.localName === 'tempo' && Number(c.getAttribute('tstamp') ?? 1) === 1,
          );
          if (tempoEl) {
            const newBpm = bpmFromEl(tempoEl);
            if (newBpm) currentBpm = newBpm;
            const display = tempoEl.textContent?.trim() || `♩=${currentBpm}`;
            tempoEvents.push({
              startMs: totalMsManual, measureIdx, bpm: currentBpm, display,
            });
          }

          const msPerBeat = 60000 / currentBpm;
          const msPerMeasure = runMeterCount * msPerBeat;
          const measureStart = totalMsManual;

          for (const c of Array.from(child.children)) {
            if (c.localName !== 'harm') continue;
            const tstamp = Number(c.getAttribute('tstamp') ?? 1);
            meiOnsets.push(measureStart + (tstamp - 1) * msPerBeat);
          }

          totalMsManual += msPerMeasure;
          measureIdx += 1;
          continue;
        }
        if (child.localName !== 'scoreDef') continue;
        // Mid-section scoreDef: pick up meter changes (so subsequent
        // measures get the right msPerMeasure for harm onsets) and BPM
        // changes (running tempo for the same calculation + tempo
        // overlay). Clef/keysig changes here are deliberately ignored —
        // the chrome overlay reads those off the rendered SVG.
        const scoreDefMeterCount = child.getAttribute('meter.count') ?? child.getAttribute('metercount');
        const meterSigEl = child.querySelector(':scope > meterSig, :scope staffDef > meterSig');
        if (scoreDefMeterCount !== null) {
          const c = Number(scoreDefMeterCount);
          if (Number.isFinite(c) && c > 0) runMeterCount = c;
        } else if (meterSigEl) {
          const cnt = meterSigEl.getAttribute('count');
          if (cnt !== null) {
            const c = Number(cnt);
            if (Number.isFinite(c) && c > 0) runMeterCount = c;
          }
        }
        const newBpm = bpmFromEl(child);
        if (newBpm && newBpm !== currentBpm) {
          currentBpm = newBpm;
          tempoEvents.push({
            startMs: totalMsManual, measureIdx,
            bpm: currentBpm, display: `♩=${currentBpm}`,
          });
        }
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
    // and mute Y in the audio scheduler.
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
    svg, notes, harms, anchors: [], tempoEvents,
    meterCount, meterUnit, totalMs: maxTstamp, staffGroup,
  };
}

// ---------------------------------------------------------------------------
// Layout helpers — small, single-purpose, composed by mountScore
// ---------------------------------------------------------------------------

/** Inject N identical SVG copies into the pan. Normalize per-SVG attrs.
 *  Parses the SVG string ONCE (via innerHTML) then deep-clones for any
 *  additional copies needed. Re-parsing a multi-MB SVG in loop mode
 *  was a measurable mount-time cost; cloneNode bypasses the parser. */
export function injectCopies(pan: HTMLElement, svg: string, copies: number): SVGSVGElement[] {
  pan.innerHTML = svg;
  const first = pan.querySelector<SVGSVGElement>(':scope > svg');
  if (!first) return [];
  first.setAttribute('preserveAspectRatio', 'xMinYMid meet');
  (first as unknown as HTMLElement).style.display = 'block';
  for (let i = 1; i < copies; i++) {
    pan.appendChild(first.cloneNode(true));
  }
  return Array.from(pan.querySelectorAll<SVGSVGElement>(':scope > svg'));
}

/**
 * Slice a wide pan SVG into multiple smaller `<svg>` tiles laid out
 * left-to-right when its displayed width exceeds `tileMaxPx`.
 *
 * Why: Ravel-class scores render as one ~37k-px-wide system. Multiplied
 * by devicePixelRatio that exceeds every reasonable GPU's max texture
 * dimension (Intel iGPUs: 8192; modern discrete: 16384), so the layer
 * can't be promoted in one go and the browser CPU-rasterizes the entire
 * pan on every transform change — playback drops to ~10 fps. Splitting
 * into ≤ tileMaxPx chunks restores per-tile GPU promotion.
 *
 * How: each tile is a fresh `<svg>` whose viewBox crops the source's
 * outer-coord space to that tile's slice. Inside, a re-built
 * `svg.definition-scale` keeps the SOURCE'S full inner viewBox but is
 * explicitly positioned at the source's outer dimensions — that way
 * Verovio's internal-coord transforms on each note/beam/staff resolve
 * to the same outer-coord positions as the source, and the outer
 * viewBox crop selects which of those land inside the tile's display.
 *
 * Measures are MOVED out of the source (not cloned) so the total DOM
 * node count stays roughly equal to the source's. `<defs>` are cloned
 * per tile (small — ~50 SMuFL symbols).
 *
 * The first tile keeps the system-level chrome (system bar, brace /
 * bracket); later tiles drop those since they only render at the
 * system's left edge.
 *
 * If the source fits within `tileMaxPx`, returns `[srcSvg]` unchanged.
 *
 * NOTE: cross-measure spans (slurs / ties / hairpins) that happen to
 * straddle a tile boundary will be visually clipped on whichever tile
 * doesn't carry the span's parent measure. With a 4096-px tile size
 * and typical slur durations (< 1 s ≈ 300 px at Ravel scroll rate),
 * this is rare in practice; we accept it for now.
 */
export function sliceSvgIntoTiles(
  pan: HTMLElement,
  srcSvg: SVGSVGElement,
  tileMaxPx: number,
): SVGSVGElement[] {
  const srcRect = srcSvg.getBoundingClientRect();
  if (srcRect.width <= tileMaxPx) return [srcSvg];

  const srcOuterVB = srcSvg.viewBox.baseVal;
  if (!srcOuterVB || srcOuterVB.width === 0) return [srcSvg];

  const defScale = srcSvg.querySelector('svg.definition-scale') as SVGSVGElement | null;
  const pageMargin = defScale?.querySelector('.page-margin') as Element | null;
  const system = pageMargin?.querySelector('.system') as Element | null;
  if (!defScale || !pageMargin || !system) return [srcSvg];

  const measures = Array.from(system.querySelectorAll(':scope > .measure'));
  if (measures.length === 0) return [srcSvg];

  const srcDefScaleVB = defScale.getAttribute('viewBox') ?? '';
  if (!srcDefScaleVB) return [srcSvg];

  // System-level chrome (bare paths for system bar, .grpSym for brace/
  // bracket). These render at the left edge of the system, so we keep
  // them only on the first tile.
  const systemChromeChildren: Element[] = [];
  for (const child of Array.from(system.children)) {
    if (!child.classList?.contains('measure')) {
      systemChromeChildren.push(child);
    }
  }

  // Conversion: 1 displayed pixel = N outer-user-units
  const userPerPx = srcOuterVB.width / srcRect.width;

  // Group measures into tiles by accumulated displayed width.
  type Group = { measures: Element[]; xLeftDisp: number; xRightDisp: number };
  const groups: Group[] = [];
  let cur: Group | null = null;
  for (const m of measures) {
    const r = m.getBoundingClientRect();
    const xL = r.left - srcRect.left;
    const xR = r.right - srcRect.left;
    if (!cur) cur = { measures: [], xLeftDisp: xL, xRightDisp: xR };
    if (cur.measures.length > 0 && (xR - cur.xLeftDisp) > tileMaxPx) {
      groups.push(cur);
      cur = { measures: [], xLeftDisp: xL, xRightDisp: xR };
    }
    cur.measures.push(m);
    cur.xRightDisp = xR;
  }
  if (cur && cur.measures.length > 0) groups.push(cur);
  if (groups.length <= 1) return [srcSvg];

  const defs = srcSvg.querySelector('defs');
  const NS = 'http://www.w3.org/2000/svg';
  const tiles: SVGSVGElement[] = [];

  for (let gi = 0; gi < groups.length; gi++) {
    const g = groups[gi];
    const isLast = gi === groups.length - 1;
    const xSliceUser = g.xLeftDisp * userPerPx + srcOuterVB.x;
    // Last tile extends to source's outer-right so any trailing barline
    // / system-end mark isn't lost.
    const wSliceUser = isLast
      ? (srcOuterVB.x + srcOuterVB.width) - xSliceUser
      : (g.xRightDisp - g.xLeftDisp) * userPerPx;

    const tile = document.createElementNS(NS, 'svg') as SVGSVGElement;
    tile.setAttribute(
      'viewBox',
      `${xSliceUser} ${srcOuterVB.y} ${wSliceUser} ${srcOuterVB.height}`,
    );
    tile.setAttribute('preserveAspectRatio', 'xMinYMid meet');
    (tile as unknown as HTMLElement).style.display = 'block';

    if (defs) tile.appendChild(defs.cloneNode(true));

    // Inner defScale: same internal viewBox as source, sized + placed
    // to span source's full outer area in user coords. The tile's
    // outer viewBox then crops display to just this slice.
    const defScaleClone = defScale.cloneNode(false) as SVGSVGElement;
    defScaleClone.setAttribute('x', String(srcOuterVB.x));
    defScaleClone.setAttribute('y', String(srcOuterVB.y));
    defScaleClone.setAttribute('width', String(srcOuterVB.width));
    defScaleClone.setAttribute('height', String(srcOuterVB.height));

    const pmClone = pageMargin.cloneNode(false) as Element;
    const sysClone = system.cloneNode(false) as Element;

    if (gi === 0) {
      for (const c of systemChromeChildren) sysClone.appendChild(c.cloneNode(true));
    }
    for (const m of g.measures) sysClone.appendChild(m);

    pmClone.appendChild(sysClone);
    defScaleClone.appendChild(pmClone);
    tile.appendChild(defScaleClone);
    tiles.push(tile);
  }

  // Replace srcSvg in pan with the tile sequence
  const next = srcSvg.nextSibling;
  pan.removeChild(srcSvg);
  for (const t of tiles) {
    if (next) pan.insertBefore(t, next);
    else pan.appendChild(t);
  }
  return tiles;
}

/** Compute anchors (time → x) from note onsets across the pan. We
 *  measure via getBoundingClientRect because Verovio's nested transforms
 *  make getBBox unreliable, and we want pan-relative pixel values for
 *  the render loop. Walks the entire pan so it works whether the SVG
 *  is unsliced (single child) or sliced into tiles (N children). */
export function buildAnchors(
  pan: HTMLElement,
  rendered: Rendered,
  panRect0: DOMRect,
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
      const el = pan.querySelector(`#${CSS.escape(id)}`);
      if (!el) continue;
      const rect = (el as Element).getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      xSum += (rect.left + rect.width / 2) - panRect0.left;
      count++;
    }
    if (count > 0) anchors.push({ t, x: xSum / count });
  }
  if (anchors.length === 0) {
    // Fallback: span full width linearly.
    anchors.push({ t: 0, x: 0 });
    anchors.push({ t: rendered.totalMs, x: panRect0.width });
  }
  return anchors;
}

/** Rightmost edge (SVG-relative pixels) of the frozen header — the
 *  region that mustn't scroll. For the pan SVG this is the right edge
 *  of measure 1's meter (after which the music begins); the brace and
 *  system bar sit further LEFT so they don't extend this boundary.
 *  Pass `firstMeasure` here. For the SHELL SVG, callers want the SAME
 *  boundary plus an allowance for the brace's leftward extent — see
 *  `measureShellHeaderWidth` which delegates here and adjusts. */
export function measureHeaderWidth(firstMeasure: Element | null, svgRect0: DOMRect): number {
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

/** Pad the anchor list to cover [0, totalMs] (non-loop adds a tail
 *  beyond totalMs so the last note can scroll past the playhead). */
export function padAnchors(
  anchors: Anchor[],
  rendered: Rendered,
  loop: boolean,
  musicWidth: number,
  pan: HTMLElement,
  panRect0: DOMRect,
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
        const el = pan.querySelector(`#${CSS.escape(lastNote.id)}`);
        if (el) {
          const rect = (el as Element).getBoundingClientRect();
          xEnd = (rect.left + rect.width) - panRect0.left;
        }
      }
      xEnd = Math.min(xEnd, panRect0.width);
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
  return anchors;
}

/** Build a linear-interpolating x(ms) function over a sorted anchor
 *  list. Maintains a hidden cursor so monotonic forward sweeps (the
 *  common playback case) cost O(1) per call, not O(N). Backward jumps
 *  (drag, loop wrap) cost at worst O(N) once, then O(1) again. Long
 *  pieces with hundreds of anchors used to chew CPU on the per-frame
 *  linear scan. */
export function makeXAtMs(anchors: Anchor[]): (ms: number) => number {
  let cursor = 1;  // index of the upper anchor for the current ms
  return (ms: number) => {
    const n = anchors.length;
    if (n === 0) return 0;
    if (ms <= anchors[0].t) { cursor = 1; return anchors[0].x; }
    const last = anchors[n - 1];
    if (ms >= last.t) { cursor = n - 1; return last.x; }
    // Move cursor forward while the upper bound is still left of `ms`.
    if (cursor < 1) cursor = 1;
    if (cursor >= n) cursor = n - 1;
    while (cursor < n && anchors[cursor].t < ms) cursor++;
    // Move backward if `ms` jumped left of our current bracket.
    while (cursor > 1 && anchors[cursor - 1].t > ms) cursor--;
    const a = anchors[cursor - 1], b = anchors[cursor];
    const f = b.t === a.t ? 0 : (ms - a.t) / (b.t - a.t);
    return a.x + f * (b.x - a.x);
  };
}

/** Inverse of makeXAtMs — given an x in SVG-coord stage-px, return the
 *  score-time ms at which that x is under the playhead. Used to align
 *  overlay crossfades to when an inline keysig glyph (rather than the
 *  following note) crosses the playhead. */
export function msAtX(anchors: Anchor[], x: number): number {
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
 * defs + definition-scale > page-margin > system > [system-bar + grpSym + measure k]
 * with `MEASURE_MUSIC_CLASSES` stripped from the measure clone.
 *
 * Why the whole chain: every ancestor contributes a transform (most
 * importantly `.definition-scale`'s own viewBox, which maps Verovio's
 * internal unit system onto the outer SVG's small viewBox). Cloning
 * only the leaf clef/keysig/meter elements loses those transforms and
 * the glyphs render at raw internal coords — way off-screen.
 *
 * For multi-staff pieces the system level also carries the brace/
 * bracket (`<g class="grpSym">`) and the vertical bar that joins the
 * staves on the left (a bare `<path>` direct child of `.system`).
 * These are preserved so the frozen overlay shows a proper grand-staff
 * left edge. The part-name `<g class="label">` is skipped — a
 * perpetual "Pno." in the chrome would be visual noise.
 *
 * `measureIdx` selects which measure's clef/keysig/meter to clone
 * (defaults to 0 = the initial header). Header-only Verovio renders
 * always have just one measure, so 0 is correct there. When cloning
 * from the actual pan SVG (preferred — gives perfect alignment because
 * the shell shares the pan's viewBox + Verovio scale), pass the
 * change-measure index so the right glyphs are cloned.
 */
function cloneMeasureShell(srcSvg: SVGSVGElement, measureIdx: number = 0): SVGSVGElement | null {
  const defScale = srcSvg.querySelector('svg.definition-scale') as SVGSVGElement | null;
  const pm = defScale?.querySelector('.page-margin');
  const sys = defScale?.querySelector('.system');
  const measures = defScale?.querySelectorAll('.measure');
  const measure = measures?.[measureIdx];
  if (!defScale || !pm || !sys || !measure) return null;

  const out = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  out.setAttribute('viewBox', srcSvg.getAttribute('viewBox') ?? '');
  out.setAttribute('preserveAspectRatio', 'xMinYMid meet');

  const origDefs = srcSvg.querySelector('defs');
  if (origDefs) out.appendChild(origDefs.cloneNode(true));

  const defScaleClone = defScale.cloneNode(false) as SVGSVGElement;
  const pmClone = pm.cloneNode(false) as Element;
  const sysClone = sys.cloneNode(false) as Element;

  // System-level chrome: brace/bracket (`grpSym`) and the system left
  // bar (bare `<path>` child) come BEFORE the measure clone so they
  // sit at the natural left edge of the system.
  for (const child of Array.from(sys.children)) {
    if (child.tagName === 'path' || child.classList?.contains('grpSym')) {
      sysClone.appendChild(child.cloneNode(true));
    }
  }

  const measureClone = measure.cloneNode(true) as Element;
  const sel = MEASURE_MUSIC_CLASSES.map((c) => '.' + c).join(',');
  for (const el of Array.from(measureClone.querySelectorAll(sel))) el.remove();

  sysClone.appendChild(measureClone);
  pmClone.appendChild(sysClone);
  defScaleClone.appendChild(pmClone);
  out.appendChild(defScaleClone);
  return out;
}

/**
 * Frozen header overlay built from independent per-(staff, axis) tracks.
 *
 * Each track is a stack of cloned chrome elements (clefs, keysigs, or
 * meters), one per distinct visual state the staff visits across the
 * piece, all positioned at the same slot X under their staff. CSS
 * opacity transitions handle the crossfade between layers; the render
 * loop calls `setMs(ms)` each frame and each track binary-searches its
 * own layers to find the active one.
 *
 * Why this beats the old shell-per-fingerprint approach:
 *
 *   • SOURCE OF TRUTH IS THE RENDERED SVG. Verovio decides whether a
 *     given clef glyph is plain G (E050), 8va alta (E07A), 8vb (E07C),
 *     or true bass F (E062) based on octave displacement state we don't
 *     track in MEI. By cloning whatever Verovio drew, the overlay
 *     always matches the pan visually — no MEI vs SVG drift, no need
 *     to model `dis`/`disPlace` separately.
 *
 *   • NO FINGERPRINT COLLISIONS. Two events with `clefs=[G2,G2,G2]` in
 *     the MEI but different rendered glyph variants used to collide
 *     under one shell with one set of glyphs (the ones Verovio happened
 *     to draw at the source measure we picked). Per-axis tracks dedupe
 *     by *visual content*, not by MEI metadata.
 *
 *   • PER-STAFF INDEPENDENCE. A clef change on staff 1 doesn't trigger
 *     an opacity swap on staves 0 and 2. Each axis × staff fades
 *     independently when its own state crosses the playhead.
 *
 * Build is single-pass over `pan.querySelectorAll('.measure')`: for each
 * measure, for each (staff, axis), if Verovio rendered a chrome element
 * AND its glyph signature differs from the previous layer in this
 * track, push a new layer. Layer 0 is m1's chrome (already in the
 * shell skeleton). All later layers are cloned and X-translated to the
 * track's slot.
 */
export interface ChromeOverlay {
  host: HTMLDivElement;
  /** Update which layer of every track is `.is-current`. Cheap — each
   *  track does a binary search over its own (typically <20) layers.
   *  Class toggles only happen when the current layer actually changes,
   *  so steady-state ms updates are no-ops once classes are set. */
  setMs(ms: number): void;
  /** Right edge of the widest chrome content (panRect-relative px).
   *  Drives overlay/playhead/mask sizing — the overlay reserves room
   *  for the widest keysig that appears anywhere in the piece so the
   *  playhead never lands inside a chrome glyph. */
  maxChromeRight: number;
}

interface ChromeLayer {
  el: SVGGElement;
  /** ms when this layer becomes the active one for its track. The first
   *  layer in a track typically has activeFrom=0 (m1's initial state).
   *  Computed via msAtX of the source element's pan-x so the swap fires
   *  when the visual change crosses the playhead. */
  activeFrom: number;
}

/** One independent crossfade lane for a single (staff, axis) combination.
 *  Owns its layer DOM clones; toggles `.is-current` on the active one.
 *  Optional `onActivate` lets a separate axis react to this one's swaps —
 *  used so the meter slot can re-translate itself based on the active
 *  keysig's width when the keysig track switches layers. */
class ChromeTrack {
  readonly layers: ChromeLayer[];
  private currentIdx = -1;
  onActivate?: (layerIdx: number) => void;

  constructor(layers: ChromeLayer[]) {
    // Sorted ascending by activeFrom in build order (we walk measures
    // forward); explicit sort is a cheap safety net.
    this.layers = layers.slice().sort((a, b) => a.activeFrom - b.activeFrom);
  }

  /** Find the layer with the largest activeFrom ≤ ms. Returns -1 when
   *  ms precedes every layer (i.e. this track has no active state yet
   *  — a keysig that doesn't appear until measure 5 will return -1
   *  for ms < its activeFrom, leaving every layer at opacity 0 which
   *  is the desired "no keysig drawn" state). */
  setActiveAt(ms: number): void {
    let lo = 0, hi = this.layers.length - 1, found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.layers[mid].activeFrom <= ms) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (found === this.currentIdx) return;
    if (this.currentIdx >= 0) this.layers[this.currentIdx].el.classList.remove('is-current');
    if (found >= 0) this.layers[found].el.classList.add('is-current');
    this.currentIdx = found;
    this.onActivate?.(found);
  }
}

/** Pull the (x, y) translate component out of a transform string like
 *  `translate(123, 456) scale(0.7, 0.7)`. Returns null if no translate
 *  is found — caller falls back to leaving the clone untouched. */
function parseTranslate(transform: string | null): { x: number; y: number } | null {
  if (!transform) return null;
  const m = /translate\(\s*(-?[\d.]+)[ ,]+(-?[\d.]+)/.exec(transform);
  if (!m) return null;
  return { x: parseFloat(m[1]), y: parseFloat(m[2]) };
}

/** Tag a clone with our additional translate while preserving any
 *  intrinsic transform Verovio gave it. `dxUnits` is in def-scale
 *  internal units (the same coord system the cloned `transform=`
 *  attribute uses). */
function prependTranslate(el: Element, dxUnits: number) {
  if (Math.abs(dxUnits) < 0.5) return;
  const existing = el.getAttribute('transform') ?? '';
  const offset = `translate(${dxUnits}, 0)`;
  el.setAttribute('transform', existing ? `${offset} ${existing}` : offset);
}

/** Map from SMuFL "clef change" (mid-piece courtesy) glyph codepoints to
 *  their full-size start-of-system equivalents. Verovio emits the small
 *  variant for every mid-piece clef change so the in-line glyph reads as
 *  a transitional courtesy mark. The chrome overlay sits at the start of
 *  the visible window and represents the *current* clef as if it were
 *  starting a new system, so it should always show the full-size glyph —
 *  otherwise the overlay clef visibly shrinks each time a courtesy
 *  change crosses the playhead. */
const SMALL_TO_FULL_CLEF_GLYPH: Record<string, string> = {
  E07A: 'E050', // gClefChange → gClef
  E07B: 'E05C', // cClefChange → cClef
  E07C: 'E062', // fClefChange → fClef
};

/** Rewrite small "clef change" glyphs in a cloned clef element to their
 *  full-size equivalents. Acts on every `<use>` descendant whose href
 *  matches a known small variant; the SMuFL reference points are
 *  preserved across the pair (gClef and gClefChange both anchor on the
 *  G2 line) so swapping the codepoint keeps staff-line alignment. */
function upgradeChromeClefGlyphs(clefEl: Element): void {
  for (const u of Array.from(clefEl.querySelectorAll('use'))) {
    for (const attr of ['xlink:href', 'href']) {
      const href = u.getAttribute(attr);
      if (!href) continue;
      // Format: "#E07A-l3gkhoe" — leading hash, 4-char codepoint, then
      // Verovio's per-render symbol-id suffix. Only the codepoint changes.
      const m = href.match(/^(#?)(E[0-9A-F]{3})(.*)$/i);
      if (!m) continue;
      const replacement = SMALL_TO_FULL_CLEF_GLYPH[m[2].toUpperCase()];
      if (!replacement) continue;
      u.setAttribute(attr, `${m[1]}${replacement}${m[3]}`);
    }
  }
}

/** Read a chrome element's "visual signature" — the joined list of
 *  symbol references its `<use>` children point at. Two elements with
 *  identical signatures render identically; we use this to dedupe
 *  consecutive layers. Cancel naturals (E261) are stripped from the
 *  signature so a transitional keysig glyph that includes "cancel
 *  previous" naturals reads the same as the stable one without them. */
function chromeSignature(el: Element | null): string {
  if (!el) return '';
  const parts: string[] = [];
  for (const u of Array.from(el.querySelectorAll('use'))) {
    const href = u.getAttribute('xlink:href') ?? u.getAttribute('href') ?? '';
    if (href.includes('E261')) continue;
    parts.push(href);
  }
  return parts.join(',');
}

/**
 * Build the chrome overlay by walking the rendered pan SVG once and
 * snapshotting per-(staff, axis) state changes into ChromeTrack stacks.
 *
 * Layout uses two pre-computed values from m1's natural Verovio layout:
 *   • `padDisplay` — the gap between adjacent chrome elements (clef→
 *     keysig and keysig→meter). Derived from m1's actual element
 *     positions.
 *   • `maxKeysigWidth` — the widest keysig glyph that appears anywhere
 *     in the piece. The meter slot is pinned at `clefRight + pad +
 *     maxKeysigWidth + pad` so the meter never overlaps with a wider
 *     keysig that arrives later (handles the all-keys 0→7 sharp
 *     stress test cleanly).
 *
 * Cancel-natural accidentals (SMuFL E261) inside any cloned keysig
 * layer are stripped — they're transitional glyphs that belong in the
 * pan as the change scrolls past, not in the static chrome.
 */
export function buildChromeOverlay(
  pan: HTMLElement,
  tile0: SVGSVGElement,
  panRect: DOMRect,
  msAtX: (x: number) => number,
): ChromeOverlay | null {
  const measures = pan.querySelectorAll('.measure');
  const m1 = measures[0];
  if (!m1) return null;

  const defScale = tile0.querySelector('svg.definition-scale') as SVGSVGElement | null;
  if (!defScale || panRect.width <= 0) return null;
  const defVB = defScale.viewBox.baseVal;
  if (defVB.width <= 0 || defVB.height <= 0) return null;
  const defScalePerPxX = defVB.width / panRect.width;

  const shell = cloneMeasureShell(tile0, 0);
  if (!shell) return null;

  const m1Staves = Array.from(m1.querySelectorAll('.staff'));
  const shellStaves = Array.from(shell.querySelectorAll('.staff'));
  const limit = Math.min(shellStaves.length, m1Staves.length);
  if (limit === 0) return null;

  // Inter-element padding from m1's first staff. Two derivations:
  //   • m1 has a populated keysig: pad = m1's actual clef→keysig gap.
  //   • m1 has no keysig: pad = (clef→meter distance) / 2.
  // Tonal music's chrome padding is symmetric enough that one number
  // suffices for both clef→keysig and keysig→meter.
  let padDisplay = 0;
  {
    const m1Clef = m1Staves[0]?.querySelector('.clef');
    const m1Ks = m1Staves[0]?.querySelector('.keySig');
    const m1Meter = m1Staves[0]?.querySelector('.meterSig');
    if (m1Clef && m1Meter) {
      const clefR = m1Clef.getBoundingClientRect();
      const meterR = m1Meter.getBoundingClientRect();
      const ksR = m1Ks?.getBoundingClientRect();
      if (ksR && ksR.width > 0) {
        padDisplay = Math.max(0, ksR.left - clefR.right);
      } else {
        padDisplay = Math.max(0, (meterR.left - clefR.right) / 2);
      }
    }
  }

  // Pre-scan: widest keysig and meter anywhere. The keysig width is
  // what the meter slot can grow up to before bumping the right edge
  // of the overlay; the meter width is added on top to size the
  // overlay's reserved chrome region. Note: the meter's actual X
  // position SLIDES with each active keysig (see meterSlot below) so
  // the chrome stays tight, but the OVERLAY box has to be wide enough
  // for the worst-case (widest keysig + widest meter) so the playhead
  // never lands inside chrome at any point in the piece.
  let maxKeysigWidth = 0;
  let maxMeterWidth = 0;
  for (const m of Array.from(measures)) {
    for (const ks of Array.from(m.querySelectorAll('.keySig'))) {
      const w = ks.getBoundingClientRect().width;
      if (w > maxKeysigWidth) maxKeysigWidth = w;
    }
    for (const mt of Array.from(m.querySelectorAll('.meterSig'))) {
      const w = mt.getBoundingClientRect().width;
      if (w > maxMeterWidth) maxMeterWidth = w;
    }
  }

  const tracks: ChromeTrack[] = [];
  let maxChromeRight = 0;

  for (let i = 0; i < limit; i++) {
    const m1ClefEl = m1Staves[i].querySelector('.clef');
    const m1KsEl = m1Staves[i].querySelector('.keySig');
    const m1MeterEl = m1Staves[i].querySelector('.meterSig');
    const shellStaff = shellStaves[i];
    if (!m1ClefEl) continue;
    // Forward decl: keysig track is built before the meter track so the
    // meter setup can install its `onActivate` callback (we slide the
    // meter slot when a keysig swap changes the keysig's visible width).
    let keysigTrack: ChromeTrack | null = null;

    const m1ClefRect = m1ClefEl.getBoundingClientRect();
    const clefSlotLeftSvg = m1ClefRect.left - panRect.left;
    const clefRightSvg = m1ClefRect.right - panRect.left;
    const ksSlotLeftSvg = clefRightSvg + padDisplay;
    const meterSlotLeftSvg = ksSlotLeftSvg + maxKeysigWidth + padDisplay;

    const m1ClefUseTranslate = parseTranslate(
      m1ClefEl.querySelector('use')?.getAttribute('transform') ?? null,
    );

    // ── CLEF TRACK ──────────────────────────────────────────────────
    {
      const layers: ChromeLayer[] = [];
      const shellClefEl = shellStaff.querySelector('.clef') as SVGGElement | null;
      let lastSig = chromeSignature(m1ClefEl);
      if (shellClefEl) {
        layers.push({ el: shellClefEl, activeFrom: 0 });
      }
      for (let mi = 1; mi < measures.length; mi++) {
        const measureStaff = measures[mi].querySelectorAll('.staff')[i];
        if (!measureStaff) continue;
        // Walk EVERY `<g class="clef">` inside this measure's staff in
        // document order, not just the first. Verovio routinely emits
        // multiple clef glyphs per measure: a start-of-measure change
        // glyph, then a mid-measure change inside a `<beam>` (Ravel's
        // Jeux d'eau hits ~10 measures with two distinct clef states
        // back-to-back). A single `querySelector('.clef')` would lock
        // onto the first and miss every later swap, leaving the
        // overlay stuck on a stale glyph for the rest of the piece.
        for (const clefEl of Array.from(measureStaff.querySelectorAll('.clef'))) {
          const sig = chromeSignature(clefEl);
          // Empty signature means a `<clef sameas="…">` reference
          // without its own `<use>` glyph — Verovio's marker that the
          // running state continues; nothing visible to swap to. Skip.
          if (!sig || sig === lastSig) continue;
          lastSig = sig;

          const cloned = clefEl.cloneNode(true) as SVGGElement;
          // Replace small "clef change" glyphs with their full-size
          // equivalents so the chrome overlay renders every clef at the
          // same visual weight as the m1 starting clef.
          upgradeChromeClefGlyphs(cloned);
          const clonedUse = cloned.querySelector('use');
          const clonedTranslate = parseTranslate(
            clonedUse?.getAttribute('transform') ?? null,
          );
          if (clonedUse && m1ClefUseTranslate && clonedTranslate) {
            // Pin X to m1's clef slot; keep source's Y so glyph
            // baseline (E050 G vs E07C 8vb vs E062 F) sits correctly.
            const t = clonedUse.getAttribute('transform') ?? '';
            clonedUse.setAttribute(
              'transform',
              t.replace(/translate\([^)]*\)/, `translate(${m1ClefUseTranslate.x}, ${clonedTranslate.y})`),
            );
          }
          const cr = clefEl.getBoundingClientRect();
          const cx = (cr.left + cr.width / 2) - panRect.left;
          layers.push({ el: cloned, activeFrom: msAtX(cx) });
          shellStaff.appendChild(cloned);
        }
      }
      tracks.push(new ChromeTrack(layers));
      const clefRight = clefSlotLeftSvg + m1ClefRect.width;
      if (clefRight > maxChromeRight) maxChromeRight = clefRight;
    }

    // ── KEYSIG TRACK ────────────────────────────────────────────────
    // Layer 0 is m1's keysig if it has one; otherwise track starts
    // empty and remains empty until a non-zero keysig measure appears
    // mid-piece. Before any layer's activeFrom, every clone is at
    // opacity 0 (no .is-current) — the desired "no keysig" visual.
    //
    // Per-layer width (in display px) is captured so the meter track
    // can reposition itself based on the active keysig: a 0-sharp
    // layer shows the meter tucked right after the clef, a 7-sharp
    // layer pushes it ~80px further right. Indexed by layer position
    // (and `[-1]` for "no keysig active yet" handled inline below).
    const ksLayerWidths: number[] = [];
    let m1KsWidth = 0;
    {
      const layers: ChromeLayer[] = [];
      const shellKsEl = shellStaff.querySelector('.keySig') as SVGGElement | null;
      let lastSig = chromeSignature(m1KsEl);
      if (shellKsEl) {
        const m1KsRect = m1KsEl?.getBoundingClientRect();
        if (m1KsRect && m1KsRect.width > 0 && lastSig) {
          // m1's keysig is already in the shell at its natural Verovio
          // position. The slot anchor (clefRight + pad) is derived
          // from m1's own clef-keysig gap, so dx is effectively zero
          // and prependTranslate is a no-op — but compute and apply
          // it anyway in case Verovio's m1 layout has a sub-pixel
          // mismatch from the pad approximation.
          const dxDisplay = ksSlotLeftSvg - (m1KsRect.left - panRect.left);
          prependTranslate(shellKsEl, dxDisplay * defScalePerPxX);
          layers.push({ el: shellKsEl, activeFrom: 0 });
          m1KsWidth = m1KsRect.width;
          ksLayerWidths.push(m1KsRect.width);
        } else {
          // Empty placeholder from cloneMeasureShell; remove so it
          // doesn't accidentally shadow later layers via stacking.
          shellKsEl.parentNode?.removeChild(shellKsEl);
          lastSig = '';
        }
      }
      for (let mi = 1; mi < measures.length; mi++) {
        const measureStaff = measures[mi].querySelectorAll('.staff')[i];
        if (!measureStaff) continue;
        // Walk every `<g class="keySig">` in this measure's staff in
        // document order. Same rationale as the clef loop: Verovio can
        // emit multiple keysig glyphs per measure (e.g. a cancel-only
        // glyph at the start, then the new keysig later), and missing
        // any of them strands the overlay on a stale signature.
        for (const ksEl of Array.from(measureStaff.querySelectorAll('.keySig'))) {
          const sig = chromeSignature(ksEl);
          if (sig === lastSig) continue;
          lastSig = sig;
          const cloned = ksEl.cloneNode(true) as SVGGElement;
          // Strip cancel naturals (SMuFL E261) — frozen overlay shows
          // the STABLE keysig only; transitional naturals are visible
          // in the pan as the change measure scrolls past.
          for (const acc of Array.from(cloned.querySelectorAll('.keyAccid'))) {
            const u = acc.querySelector('use');
            const href = u?.getAttribute('xlink:href') ?? u?.getAttribute('href') ?? '';
            if (href.includes('E261')) acc.remove();
          }
          const ksRect = ksEl.getBoundingClientRect();
          const dxDisplay = ksSlotLeftSvg - (ksRect.left - panRect.left);
          prependTranslate(cloned, dxDisplay * defScalePerPxX);
          const cx = (ksRect.left + ksRect.width / 2) - panRect.left;
          layers.push({ el: cloned, activeFrom: msAtX(cx) });
          shellStaff.appendChild(cloned);
          // After-strip width: source bounding rect counts cancel
          // naturals we just removed, so shrink by that count's worth.
          const sourceCount = ksEl.querySelectorAll('.keyAccid').length || 1;
          const survived = cloned.querySelectorAll('.keyAccid').length;
          ksLayerWidths.push(ksRect.width * (survived / sourceCount));
        }
      }
      keysigTrack = new ChromeTrack(layers);
      tracks.push(keysigTrack);
      const ksRight = ksSlotLeftSvg + maxKeysigWidth;
      if (ksRight > maxChromeRight) maxChromeRight = ksRight;
    }

    // ── METER TRACK ─────────────────────────────────────────────────
    // All meter layers are normalized to m1's natural meter X. A
    // wrapper `<g class="meter-slot">` then translates the whole stack
    // based on the active keysig: when the keysig narrows or widens,
    // the slot slides so the meter sits a constant pad past the keysig
    // — no fixed reservation for the widest keysig, no jump on swap.
    // (Verovio's natural m1.meter.x already factors in m1's keysig
    // width, so the reference is `m1.keysig.width`; layers with a
    // wider keysig push the slot right, narrower ones pull it left,
    // and "no keysig" pulls it back to the no-keysig position.)
    const meterSlot = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    meterSlot.setAttribute('class', 'meter-slot');
    {
      const layers: ChromeLayer[] = [];
      const shellMeterEl = shellStaff.querySelector('.meterSig') as SVGGElement | null;
      let lastSig = chromeSignature(m1MeterEl);
      if (shellMeterEl && m1MeterEl) {
        // Layer 0 = m1's meter element, already at m1's natural X. Move
        // it from its current position in shellStaff into meterSlot.
        shellMeterEl.parentNode?.removeChild(shellMeterEl);
        meterSlot.appendChild(shellMeterEl);
        layers.push({ el: shellMeterEl, activeFrom: 0 });
      }
      // Pull m1's meter `<use>` internal-x as the alignment target. All
      // meter clones get translated so their `<use>` lands at this same
      // internal x, by computing dx purely in INTERNAL coords — never
      // round-tripping through display px. Why: in a sliced layout
      // each tile owns its own outer-SVG viewBox with a slightly
      // different per-tile internal-to-display ratio, so a `dxDisplay
      // × global_ratio` calculation that crosses tiles drifts by
      // ~15 px, enough to shove the cloned meter back onto the
      // keysig's rightmost accidental and visually swallow it.
      const m1MeterUseInternalX = m1MeterEl
        ? parseTranslate(
            m1MeterEl.querySelector('use')?.getAttribute('transform') ?? null,
          )?.x
        : null;
      for (let mi = 1; mi < measures.length; mi++) {
        const measureStaff = measures[mi].querySelectorAll('.staff')[i];
        if (!measureStaff) continue;
        // Same multi-glyph walk as clef + keysig — see comment there.
        for (const mtrEl of Array.from(measureStaff.querySelectorAll('.meterSig'))) {
          const sig = chromeSignature(mtrEl);
          if (sig === lastSig) continue;
          lastSig = sig;
          const cloned = mtrEl.cloneNode(true) as SVGGElement;
          // Shift the whole cloned `<g class="meterSig">` so its `<use>`
          // children (numerator + denominator stacked at the same x
          // but different y) land at m1's meter internal-x. Translating
          // the parent group keeps both digits in sync — rewriting
          // just the first `<use>` would strand the denominator at the
          // source measure's x.
          const sourceUseInternalX = parseTranslate(
            cloned.querySelector('use')?.getAttribute('transform') ?? null,
          )?.x;
          if (m1MeterUseInternalX !== null && m1MeterUseInternalX !== undefined &&
              sourceUseInternalX !== undefined) {
            prependTranslate(cloned, m1MeterUseInternalX - sourceUseInternalX);
          }
          const mtrRect = mtrEl.getBoundingClientRect();
          const cx = (mtrRect.left + mtrRect.width / 2) - panRect.left;
          layers.push({ el: cloned, activeFrom: msAtX(cx) });
          meterSlot.appendChild(cloned);
        }
      }
      shellStaff.appendChild(meterSlot);
      tracks.push(new ChromeTrack(layers));
      const meterRight = meterSlotLeftSvg + maxMeterWidth;
      if (meterRight > maxChromeRight) maxChromeRight = meterRight;

      // Wire keysig-track activations to slide the meter slot. Internal
      // units (defScalePerPxX × display delta) because the slot lives
      // inside the def-scale coord space. `idx === -1` means no keysig
      // is currently active (track hasn't started yet), in which case
      // the meter sits where m1 had it (slot delta 0 — m1 may itself
      // have had no keysig, in which case m1's meter X already reflects
      // the no-keysig layout). For idx ≥ 0, slide by `(layerWidth -
      // m1KsWidth) × defScalePerPxX`.
      if (keysigTrack) {
        keysigTrack.onActivate = (idx: number) => {
          const widthDeltaDisplay =
            idx >= 0 ? (ksLayerWidths[idx] ?? 0) - m1KsWidth : 0;
          if (Math.abs(widthDeltaDisplay) < 0.5) {
            meterSlot.removeAttribute('transform');
          } else {
            meterSlot.setAttribute(
              'transform',
              `translate(${widthDeltaDisplay * defScalePerPxX}, 0)`,
            );
          }
        };
      }
    }
  }

  const host = document.createElement('div');
  host.className = 'score-frozen-overlay';
  host.appendChild(shell);
  // Initial state: every track's first layer (if any) becomes current.
  for (const tr of tracks) tr.setActiveAt(0);

  return {
    host,
    setMs(ms: number) {
      for (const tr of tracks) tr.setActiveAt(ms);
    },
    maxChromeRight,
  };
}


/** Tempo overlay — a single text node showing the active tempo marking.
 *  Updates via `setCurrent(event)`; CSS handles the opacity crossfade.
 *  Returns null if `events` has only the initial entry (no display chrome
 *  needed for a single-tempo piece). */
export interface TempoOverlay {
  host: HTMLDivElement;
  setCurrent(event: TempoEvent): void;
}
export function createTempoOverlay(
  events: ReadonlyArray<TempoEvent>,
): TempoOverlay | null {
  if (events.length === 0) return null;
  const host = document.createElement('div');
  host.className = 'score-tempo-overlay';
  host.textContent = events[0].display;
  let currentStartMs = events[0].startMs;
  return {
    host,
    setCurrent(event: TempoEvent) {
      if (event.startMs === currentStartMs) return;
      currentStartMs = event.startMs;
      // Two-step swap: fade out, swap text, fade in. The CSS transition
      // on opacity drives both halves; the timeout sits just past the
      // transition midpoint. Single-text-node keeps DOM minimal.
      host.classList.add('is-changing');
      setTimeout(() => {
        host.textContent = event.display;
        host.classList.remove('is-changing');
      }, 180);
    },
  };
}


/** Measured y-midlines (stage-relative px) of EVERY staff's 5 lines.
 *  Multi-staff pieces (piano grand staff = 2; orchestral = N) need lines
 *  on every staff, not just the top — `staves` is the full NodeList from
 *  `svg.querySelectorAll('.staff')` in measure 1. Returns flat array of
 *  all y-positions, deduplicated for sanity. */
export function measureStaffYs(staves: ArrayLike<Element>, stageTop: number): number[] {
  const ys: number[] = [];
  for (const staff of Array.from(staves)) {
    for (const p of Array.from(staff.children)) {
      if (p.tagName !== 'path') continue;
      const r = (p as Element).getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      ys.push((r.top + r.bottom) / 2 - stageTop);
    }
  }
  return ys;
}

/** A stage-wide SVG with 5 horizontal lines per staff at the given
 *  y-positions. Single source of staff lines — prevents the
 *  double-stroke thickening that happened when pan and overlay both
 *  drew them. Color comes from CSS (`--fg-dim`) so all lines render at
 *  the same recede-into-background gray. */
export function createStaffLinesLayer(
  ys: number[],
  stageRect: DOMRect,
): SVGSVGElement | null {
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
export function stripStaffLinesFrom(root: Element) {
  for (const staff of Array.from(root.querySelectorAll('.staff'))) {
    for (const c of Array.from(staff.children)) {
      if (c.tagName === 'path') c.remove();
    }
  }
}

/** Remove the opening clef/keysig/meter from measure 1 plus the
 *  system-level chrome (brace/bracket, part-name label, system left
 *  bar) — the frozen overlay owns all of these. Mid-piece key-sig
 *  changes in later measures are LEFT IN PLACE so they can scroll
 *  past the playhead — the overlay fades to the new key as each
 *  change crosses. */
export function stripHeadersFrom(root: Element) {
  const first = root.querySelector('.measure');
  if (first) {
    for (const el of Array.from(first.querySelectorAll('.clef, .keySig, .meterSig'))) {
      el.remove();
    }
  }
  // System-level chrome lives outside any measure: a `<g class="grpSym">`
  // for the brace, a `<g class="label">` for the part name, and a bare
  // `<path>` direct child for the vertical bar joining the staves.
  // Removing them from the pan keeps them from scrolling away with the
  // music — the frozen overlay redraws them in place.
  const sys = root.querySelector('.system');
  if (sys) {
    for (const child of Array.from(sys.children)) {
      if (child.tagName === 'path') { child.remove(); continue; }
      if (child.classList?.contains('grpSym')) { child.remove(); continue; }
      if (child.classList?.contains('label')) { child.remove(); continue; }
    }
  }
}

/** For loop mode: shift SVG copies 2..N left by headerWidth so music tiles
 *  end-to-end. Copy i's empty header region overlaps copy (i-1)'s music
 *  tail — blank there, no overdraw. */
export function applyLoopSpacing(panSvgs: SVGSVGElement[], headerWidth: number) {
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
export function appendLoopLeader(pan: HTMLElement, source: SVGSVGElement, musicWidth: number): void {
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
export function setFadeMaskVars(stage: HTMLElement, start: number, end: number) {
  stage.style.setProperty('--mask-start', `${start}px`);
  stage.style.setProperty('--mask-end', `${end}px`);
}

// ---------------------------------------------------------------------------
// Per-frame render loop
// ---------------------------------------------------------------------------

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
