/*
 * render-mei — MEI → SVG + timing data.
 *
 * Verovio-driven SVG generation + timemap + harm/header/tie metadata.
 * Two-level cache (in-memory LRU + IndexedDB) survives SPA navigations
 * and hard reloads.  Heavy first-time renders run in a Web Worker.
 */
import { loadVerovio } from './verovio';
import RenderWorkerCtor from './render-worker.ts?worker';
import type {
  Harm,
  Note,
  Rendered,
  StaffDef,
  StaffGroup,
  TempoEvent,
} from './types';

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
