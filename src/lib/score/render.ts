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
 *      The rAF that translates `.score-pan`, toggles glyph glow, and
 *      crossfades the frozen overlay on header changes.
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
import {
  headerFingerprint,
  type Anchor,
  type ClefState,
  type FrozenOverlay,
  type Harm,
  type HeaderEvent,
  type MeterState,
  type Note,
  type Rendered,
  type StaffDef,
  type StaffGroup,
  type TempoEvent,
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
 *  accident. Parsing is a few ms on Ravel's SVG and is correct. */
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
  return new XMLSerializer().serializeToString(doc);
}

/** Drop staves that carry no meaningful musical content. A staff is
 *  considered "sparse" when it has fewer than 10% the note count of
 *  the busiest staff in the score (or zero notes outright). Returns
 *  the serialized MEI with empty/sparse staves removed, or null if
 *  every staff is dense enough or nothing could be parsed.
 *
 *  Why: MusicXML→MEI conversions (esp. MuseScore exports of piano
 *  music with cross-hand passages on a third staff) often declare
 *  staves used for only a handful of bars across the entire piece.
 *  Rendering them adds a near-empty row to the grand staff for the
 *  vast majority of measures — pure visual noise. The 10% threshold
 *  drops Ravel's swing-up 3rd staff (71 notes vs 2846 on staff 1)
 *  while keeping balanced LH/RH parts (typically 30–60% split). */
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
  const maxCount = Math.max(...noteCount.values());
  if (maxCount === 0) return null;
  const sparseThreshold = maxCount * 0.1;

  const allStaffDefs = Array.from(doc.querySelectorAll('staffDef[n]'));
  const emptyNs = new Set<string>();
  for (const sd of allStaffDefs) {
    const n = sd.getAttribute('n');
    if (!n) continue;
    const cnt = noteCount.get(n) ?? 0;
    if (cnt < sparseThreshold) emptyNs.add(n);
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
const IDB_SCHEMA_VERSION = 3;
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

  // Parse the MEI source once, then extract harm onsets, clef/keysig
  // events, and tempo events in a single walk of <section>'s direct
  // children. Verovio's `getTimesForElement` returns `{}` for harm
  // elements — it only carries timing for notes/rests — and doesn't
  // expose clef/key/tempo changes, so we compute all three ourselves.
  //
  // BPM is tracked piecewise: every time we see a <tempo> child of a
  // measure (with tstamp=1) or a between-measure <scoreDef midi.bpm>,
  // we update the running BPM. Subsequent measures use the new BPM.
  // Verovio's timemap respects mid-piece tempo internally, so this
  // manual track only matters for harm onsets and the tempo overlay.
  const harms: Harm[] = [];
  const headerEvents: HeaderEvent[] = [];
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

    // Resolver: read attribute from the first element that defines it.
    // Tolerates both the dotted MEI source style (`key.sig`) and
    // Verovio's getMEI() normalization, which strips the dot on some
    // attrs (key.sig → keysig) while leaving others (meter.count,
    // clef.shape) intact. Returns null only when none of the
    // candidates carry it under any spelling.
    const read = (attrs: string | ReadonlyArray<string>, els: ReadonlyArray<Element | null | undefined>) => {
      const names = typeof attrs === 'string' ? [attrs] : attrs;
      for (const el of els) {
        if (!el) continue;
        for (const name of names) {
          const v = el.getAttribute(name);
          if (v !== null && v !== undefined) return v;
        }
      }
      return null;
    };

    /** Pull (shape, line) for a single <staffDef> covering both styles:
     *  attributes on the staffDef itself (`clef.shape`/`clef.line`) OR
     *  a nested `<clef shape line>` element (Verovio's normalized MEI). */
    const clefFromStaffDef = (
      sd: Element | null | undefined,
      fallback: ClefState,
    ): ClefState => {
      if (!sd) return fallback;
      const childClef = sd.querySelector(':scope > clef');
      const shape = sd.getAttribute('clef.shape') ?? childClef?.getAttribute('shape') ?? fallback.shape;
      const line = sd.getAttribute('clef.line') ?? childClef?.getAttribute('line') ?? fallback.line;
      return { shape, line };
    };

    /** Same for keysig: read attribute under either spelling
     *  (key.sig | keysig) OR child `<keySig sig="…">`. Falls back to
     *  the running value. */
    const keysigFromStaffDef = (
      sd: Element | null | undefined,
      fallback: string,
    ): string => {
      if (!sd) return fallback;
      const childKs = sd.querySelector(':scope > keySig');
      return sd.getAttribute('key.sig')
        ?? sd.getAttribute('keysig')
        ?? childKs?.getAttribute('sig')
        ?? fallback;
    };

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

    // Initial per-staff clef + (shared) keysig. Each staff's own
    // <staffDef> wins; otherwise we fall back to the scoreDef-level
    // attribute. For keysig the convention is shared-across-staves —
    // we read whichever staff defines it first (typically all match).
    const allStaffDefs = Array.from(initialStaffGrp?.querySelectorAll('staffDef') ?? []);
    const staffDefByN = new Map<string, Element>();
    for (const sd of allStaffDefs) {
      const n = sd.getAttribute('n');
      if (n) staffDefByN.set(n, sd);
    }
    const scoreDefClefFallback: ClefState = {
      shape: read(['clef.shape', 'clefshape'], [initialScoreDef]) ?? 'G',
      line: read(['clef.line', 'clefline'], [initialScoreDef]) ?? '2',
    };
    let clefs: ClefState[] = staffGroup.staves.map((s) =>
      clefFromStaffDef(staffDefByN.get(s.n), scoreDefClefFallback),
    );
    let keysig = read(['key.sig', 'keysig'], [initialScoreDef]) ?? '0';
    for (const sd of allStaffDefs) {
      const ks = keysigFromStaffDef(sd, keysig);
      if (ks !== '0' || keysig === '0') { keysig = ks; break; }
    }
    let meter: MeterState = {
      count: meterCount,
      unit: meterUnit,
      sym: initialScoreDef?.querySelector(':scope > meterSig, :scope staffDef > meterSig')?.getAttribute('sym') ?? '',
    };
    headerEvents.push({
      startMs: 0, measureIdx: 0,
      clefs: clefs.map((c) => ({ ...c })), keysig, meter: { ...meter },
    });
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
          // processed above for clef/keysig/bpm. Skip it here.
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
          const msPerMeasure = meter.count * msPerBeat;
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
        // Mid-section scoreDef override. Three axes can change:
        //   1. scoreDef-level `clef.shape` / `clef.line` / `key.sig` /
        //      `meter.count` / `meter.unit` — applies to ALL staves.
        //   2. Nested `<staffDef n="…">` — applies per-staff (multi-
        //      staff pieces use this for one-hand clef changes).
        //   3. Nested `<meterSig>` element — same change as
        //      meter.count/unit attrs but in element form.
        // We mutate `clefs` per-staff and treat `keysig`/`meter` as
        // shared across staves (standard tonal/metric convention).
        const nestedStaffDefs = Array.from(child.querySelectorAll(':scope > staffDef, :scope > staffGrp staffDef'));
        const scoreDefShape = child.getAttribute('clef.shape') ?? child.getAttribute('clefshape');
        const scoreDefLine = child.getAttribute('clef.line') ?? child.getAttribute('clefline');
        const scoreDefKey = child.getAttribute('key.sig') ?? child.getAttribute('keysig');
        const scoreDefMeterCount = child.getAttribute('meter.count') ?? child.getAttribute('metercount');
        const scoreDefMeterUnit = child.getAttribute('meter.unit') ?? child.getAttribute('meterunit');
        const meterSigEl = child.querySelector(':scope > meterSig, :scope staffDef > meterSig');
        const nextClefs: ClefState[] = clefs.map((c) => ({ ...c }));
        let nextKey = keysig;
        const nextMeter: MeterState = { ...meter };
        if (scoreDefShape || scoreDefLine) {
          for (const c of nextClefs) {
            if (scoreDefShape) c.shape = scoreDefShape;
            if (scoreDefLine) c.line = scoreDefLine;
          }
        }
        if (scoreDefKey !== null) nextKey = scoreDefKey;
        if (scoreDefMeterCount !== null) nextMeter.count = Number(scoreDefMeterCount);
        if (scoreDefMeterUnit !== null) nextMeter.unit = Number(scoreDefMeterUnit);
        if (meterSigEl) {
          const cnt = meterSigEl.getAttribute('count');
          const u = meterSigEl.getAttribute('unit');
          const sym = meterSigEl.getAttribute('sym');
          if (cnt !== null) nextMeter.count = Number(cnt);
          if (u !== null) nextMeter.unit = Number(u);
          if (sym !== null) nextMeter.sym = sym;
        }
        for (const sd of nestedStaffDefs) {
          const n = sd.getAttribute('n');
          if (!n) continue;
          const idx = staffGroup.staves.findIndex((s) => s.n === n);
          if (idx < 0) continue;
          nextClefs[idx] = clefFromStaffDef(sd, nextClefs[idx]);
          const ks = keysigFromStaffDef(sd, nextKey);
          if (ks !== nextKey) nextKey = ks;
        }
        const clefsChanged = nextClefs.some((c, i) =>
          c.shape !== clefs[i].shape || c.line !== clefs[i].line,
        );
        const meterChanged = nextMeter.count !== meter.count
          || nextMeter.unit !== meter.unit
          || nextMeter.sym !== meter.sym;
        if (clefsChanged || nextKey !== keysig || meterChanged) {
          clefs = nextClefs;
          keysig = nextKey;
          meter = nextMeter;
          headerEvents.push({
            startMs: totalMsManual, measureIdx,
            clefs: clefs.map((c) => ({ ...c })), keysig, meter: { ...meter },
          });
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
    svg, notes, harms, anchors: [], headerEvents, tempoEvents,
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

/** Result bundle from `buildPannedShells`. */
export interface PannedShellsResult {
  shells: Map<string, SVGSVGElement>;
  /** Right edge of the widest shell's chrome, in svg-rect-relative px.
   *  Drives overlay/playhead/mask sizing — the overlay box has to reserve
   *  enough room for the WIDEST keysig fingerprint so the playhead never
   *  ends up sitting INSIDE a wide-keysig shell. */
  maxChromeRight: number;
}

/**
 * Build a shell for every unique header fingerprint by COMPOSITING from
 * pan glyphs and reflowing the chrome layout.
 *
 * Layout rule (the only one):
 *   For every shell, place chrome elements left-to-right with a fixed
 *   padding `pad` (derived once from m1's natural Verovio spacing):
 *     clef   at  m1.clef position             (constant across all fps)
 *     keysig at  clef.right + pad             (only when fp.keysig != 0)
 *     meter  at  keysig.right + pad           (or clef.right + pad if no keysig)
 *
 *   Each fp's meter therefore "adapts" to the keysig width — a wide
 *   7-sharp keysig pushes the meter further right than a 0-keysig fp
 *   does. The overlay box is sized for the WIDEST chrome (returned via
 *   `maxChromeRight`) so the playhead never collides with any fp.
 *
 * Why this composite/reflow approach:
 *   Verovio's natural layout in m1 is computed for m1's specific keysig
 *   width — when we swap in a wider keysig, m1's slot is too narrow and
 *   adjacent elements collide. Rather than try to match Verovio's
 *   internal padding rules per-fp, we DO our own layout pass with one
 *   derived padding constant. Verovio's internal glyph layout WITHIN
 *   each axis (sharp positions inside a keysig, digit stacking inside
 *   a meter) is preserved untouched — we only translate the axis as a
 *   unit.
 *
 * Cancel naturals (E261 SMuFL codepoint) inside a swapped keysig are
 * stripped — frozen overlay shows the STABLE keysig only. Cancel
 * naturals are visible in pan as the change measure scrolls past, and
 * don't belong in the static chrome.
 *
 * The first tile (or the unsliced single SVG) must still have its
 * measure-1 chrome intact — call this BEFORE `stripHeadersFrom`. For
 * sliced layouts, mid-piece source measures live in later tiles, so
 * `pan` is walked for the full `.measure` set; the shell template +
 * defs come from `tile0`.
 */
export function buildPannedShells(
  pan: HTMLElement,
  tile0: SVGSVGElement,
  events: ReadonlyArray<HeaderEvent>,
  panRect: DOMRect,
): PannedShellsResult {
  const shells = new Map<string, SVGSVGElement>();
  let maxChromeRight = 0;
  if (events.length === 0) return { shells, maxChromeRight };
  // Walk pan to capture measures across tiles in document order.
  const measures = pan.querySelectorAll('.measure');
  const m1 = measures[0];
  if (!m1) return { shells, maxChromeRight };

  // Verovio nests the actual glyph drawing in `<svg class="definition-scale">`
  // whose internal viewBox is ~25× larger than the outer SVG's viewBox —
  // every chrome glyph's `<use transform="translate(...)">` is in THIS
  // internal coord space, not the outer one. To shift a swapped glyph by
  // a measured display-px delta, we convert via the def-scale viewBox →
  // pan display ratio (def_scale_units_per_display_px). Tile 0's
  // defScale carries the same viewBox as the source so this ratio is
  // identical whether we sliced or not.
  const defScale = tile0.querySelector('svg.definition-scale') as SVGSVGElement | null;
  if (!defScale || panRect.width <= 0) return { shells, maxChromeRight };
  const defVB = defScale.viewBox.baseVal;
  if (defVB.width <= 0 || defVB.height <= 0) return { shells, maxChromeRight };
  const defScalePerPxX = defVB.width / panRect.width;

  const m1Staves = Array.from(m1.querySelectorAll('.staff'));

  // Derive chrome inter-element padding from m1's natural Verovio layout
  // (first staff). Used when reflowing each shell so the keysig-meter
  // and clef-keysig gaps stay visually consistent with what Verovio would
  // have done. Two derivations:
  //   • m1 has populated keysig: pad = m1's actual clef-keysig gap
  //   • m1 has empty keysig:     pad = (clef-meter distance) / 2
  // The single value is reused on both sides; tonal music's chrome
  // padding is symmetric enough that one number suffices.
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

  // Walk events forward, tracking for each axis the measureIdx where
  // that axis was last set to its current value. When we encounter a
  // not-yet-seen fingerprint, snapshot those source-measure indices
  // and use them to compose the shell.
  let prev: HeaderEvent | null = null;
  let clefSourceMi = 0;
  let keysigSourceMi = 0;
  let meterSourceMi = 0;
  const seen = new Set<string>();

  /** Tag a clone with our additional translate while preserving any
   *  intrinsic transform Verovio gave it. */
  const prependTranslate = (el: Element, dxUnits: number) => {
    if (Math.abs(dxUnits) < 0.5) return;
    const existing = el.getAttribute('transform') ?? '';
    const offset = `translate(${dxUnits}, 0)`;
    el.setAttribute('transform', existing ? `${offset} ${existing}` : offset);
  };

  for (const e of events) {
    if (prev) {
      const clefDiff = e.clefs.some((c, i) =>
        c.shape !== prev!.clefs[i]?.shape || c.line !== prev!.clefs[i]?.line);
      if (clefDiff) clefSourceMi = e.measureIdx;
      if (e.keysig !== prev.keysig) keysigSourceMi = e.measureIdx;
      const meterDiff =
        e.meter.count !== prev.meter.count ||
        e.meter.unit !== prev.meter.unit ||
        e.meter.sym !== prev.meter.sym;
      if (meterDiff) meterSourceMi = e.measureIdx;
    }
    prev = e;

    const fp = headerFingerprint(e);
    if (seen.has(fp)) continue;
    seen.add(fp);

    const shell = cloneMeasureShell(tile0, 0);
    if (!shell) continue;

    const shellStaves = Array.from(shell.querySelectorAll('.staff'));
    const limit = Math.min(shellStaves.length, m1Staves.length);
    let shellChromeRight = 0;

    for (let i = 0; i < limit; i++) {
      const m1ClefEl = m1Staves[i].querySelector('.clef');
      const m1MeterEl = m1Staves[i].querySelector('.meterSig');
      const shellClefEl = shellStaves[i].querySelector('.clef');
      const shellKsEl = shellStaves[i].querySelector('.keySig');
      const shellMeterEl = shellStaves[i].querySelector('.meterSig');
      if (!m1ClefEl) continue;

      // ── CLEF ────────────────────────────────────────────────────────
      // Clef goes at m1's natural position. If clef changes mid-piece,
      // swap in the source clef glyph translated to m1.clef's position.
      // Clef widths are uniform enough across G/F/C clefs that we don't
      // reflow keysig+meter to accommodate width deltas — the small
      // fudge is invisible in practice.
      const m1ClefRect = m1ClefEl.getBoundingClientRect();
      let clefRightSvg = m1ClefRect.right - panRect.left;
      if (clefSourceMi !== 0) {
        const sourceClefEl = measures[clefSourceMi]?.querySelectorAll('.staff')[i]?.querySelector('.clef');
        const sourceClefRect = sourceClefEl?.getBoundingClientRect();
        if (sourceClefEl && sourceClefRect && sourceClefRect.width > 0 && shellClefEl?.parentNode) {
          const dxDisplay = m1ClefRect.left - sourceClefRect.left;
          const newClef = sourceClefEl.cloneNode(true) as Element;
          prependTranslate(newClef, dxDisplay * defScalePerPxX);
          shellClefEl.parentNode.replaceChild(newClef, shellClefEl);
          // Recompute right edge using source clef's width post-shift.
          clefRightSvg = (m1ClefRect.left - panRect.left) + sourceClefRect.width;
        }
      }

      // ── KEYSIG ──────────────────────────────────────────────────────
      // Place at clef.right + pad. For empty fp (keysig=0), strip the
      // shell's existing keysig element. Otherwise clone the source
      // measure's keysig, strip cancel naturals, translate to target.
      let keysigRightSvg = clefRightSvg;
      if (e.keysig === '0') {
        if (shellKsEl?.parentNode) shellKsEl.parentNode.removeChild(shellKsEl);
      } else {
        const sourceMeasure = keysigSourceMi === 0 ? m1 : measures[keysigSourceMi];
        const sourceKs = sourceMeasure?.querySelectorAll('.staff')[i]?.querySelector('.keySig');
        const sourceKsRect = sourceKs?.getBoundingClientRect();
        if (sourceKs && sourceKsRect && sourceKsRect.width > 0) {
          const newKs = sourceKs.cloneNode(true) as Element;
          // Strip cancel naturals (SMuFL natural-sign codepoint E261).
          // Frozen overlay shows the STABLE keysig only — naturals from
          // mid-piece transitions are visible in pan as the change
          // measure scrolls past, and would just clutter the chrome.
          for (const acc of Array.from(newKs.querySelectorAll('.keyAccid'))) {
            const u = acc.querySelector('use');
            const href = u?.getAttribute('xlink:href') ?? u?.getAttribute('href') ?? '';
            if (href.includes('E261')) acc.remove();
          }
          const targetLeftSvg = clefRightSvg + padDisplay;
          const dxDisplay = targetLeftSvg - (sourceKsRect.left - panRect.left);
          prependTranslate(newKs, dxDisplay * defScalePerPxX);
          if (shellKsEl?.parentNode) {
            shellKsEl.parentNode.replaceChild(newKs, shellKsEl);
          } else if (shellMeterEl?.parentNode) {
            shellMeterEl.parentNode.insertBefore(newKs, shellMeterEl);
          } else {
            shellStaves[i].appendChild(newKs);
          }
          // Width estimate uses source rect (may slightly over-allocate
          // when naturals were stripped, but they're stripped GLYPHS so
          // the visible content is narrower than this — the over-
          // allocation just leaves a hair more space before the meter).
          keysigRightSvg = targetLeftSvg + sourceKsRect.width;
        }
      }

      // ── METER ───────────────────────────────────────────────────────
      // Position immediately after keysig (or clef when no keysig).
      // Always re-position even when meter source = m1: the pad-derived
      // target may differ from m1's natural meter.left when keysig is
      // wider/narrower than m1's. For meter changes, swap in the source
      // meter glyph THEN apply the position translate.
      if (m1MeterEl && shellMeterEl) {
        const m1MeterRect = m1MeterEl.getBoundingClientRect();
        let activeMeterEl: Element = shellMeterEl;
        let activeMeterWidth = m1MeterRect.width;
        let activeMeterNaturalLeftSvg = m1MeterRect.left - panRect.left;
        if (meterSourceMi !== 0) {
          const sourceMeterEl = measures[meterSourceMi]?.querySelectorAll('.staff')[i]?.querySelector('.meterSig');
          const sourceMeterRect = sourceMeterEl?.getBoundingClientRect();
          if (sourceMeterEl && sourceMeterRect && sourceMeterRect.width > 0 && shellMeterEl.parentNode) {
            const newMeter = sourceMeterEl.cloneNode(true) as Element;
            shellMeterEl.parentNode.replaceChild(newMeter, shellMeterEl);
            activeMeterEl = newMeter;
            activeMeterWidth = sourceMeterRect.width;
            activeMeterNaturalLeftSvg = sourceMeterRect.left - panRect.left;
          }
        }
        const targetMeterLeftSvg = keysigRightSvg + (e.keysig === '0' ? padDisplay : padDisplay);
        const dxDisplay = targetMeterLeftSvg - activeMeterNaturalLeftSvg;
        prependTranslate(activeMeterEl, dxDisplay * defScalePerPxX);
        const meterRightSvg = targetMeterLeftSvg + activeMeterWidth;
        if (meterRightSvg > shellChromeRight) shellChromeRight = meterRightSvg;
      } else {
        if (keysigRightSvg > shellChromeRight) shellChromeRight = keysigRightSvg;
      }
    }

    if (shellChromeRight > maxChromeRight) maxChromeRight = shellChromeRight;
    shells.set(fp, shell);
  }
  return { shells, maxChromeRight };
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

/** Frozen header overlay + the only API for updating it: `setCurrent(fp)`
 *  flips which shell is visible. Keeps the shell-per-layer DOM structure
 *  an implementation detail of this function. Returns null if no shells
 *  could be built. */
export function createFrozenOverlay(
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
    layer.setAttribute('data-fp', fp);
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

/** A stage-wide SVG with 5 horizontal lines at the given y-positions.
 *  Single source of staff lines — prevents the double-stroke thickening
 *  that happened when pan and overlay both drew them. */
export function createStaffLinesLayer(ys: number[], stageRect: DOMRect): SVGSVGElement | null {
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

/** Stateful cursor over a startMs-sorted item list that maintains
 *  the current set of "live" items (startMs ≤ ms < endMs) without
 *  re-scanning every frame. Per frame we just advance the start /
 *  expire pointers based on `ms`, mutating an internal Set in place
 *  — zero allocation in the steady-state common case where ms only
 *  monotonically grows by ~16 ms per tick. `seek(ms)` resets cursors
 *  for backward jumps (drag, loop wrap).
 *
 *  Assumes `items` is sorted by `startMs`. Linear `activeIdsAt`
 *  shipped originally was fine for short pieces but Ravel's 4k+ notes
 *  × 60 fps × allocate-a-fresh-Set was the per-frame GC trigger that
 *  caused intermittent stutter even after the glow filter cut. */
class ActiveCursor {
  /** Currently-active id set (live, mutated in place). */
  readonly active = new Set<string>();
  /** Ids that became active in the latest `advance`/`seek` call. */
  readonly added = new Set<string>();
  /** Ids that became inactive in the latest `advance`/`seek` call. */
  readonly removed = new Set<string>();

  private startIdx = 0;
  /** id → endMs, built once. Avoids walking back over `items` per frame
   *  to look up an expiring item's end time. */
  private endMs = new Map<string, number>();
  private items: ReadonlyArray<{ id: string; startMs: number; endMs: number }>;
  private lastMs = -Infinity;

  constructor(items: ReadonlyArray<{ id: string; startMs: number; endMs: number }>) {
    this.items = [...items].sort((a, b) => a.startMs - b.startMs);
    for (const it of this.items) this.endMs.set(it.id, it.endMs);
  }

  /** Forward step. If `ms` went backward, falls through to `seek`. */
  advance(ms: number) {
    if (ms < this.lastMs) { this.seek(ms); return; }
    this.added.clear();
    this.removed.clear();
    while (this.startIdx < this.items.length && this.items[this.startIdx].startMs <= ms) {
      const it = this.items[this.startIdx];
      if (ms < it.endMs) {
        this.active.add(it.id);
        this.added.add(it.id);
      }
      this.startIdx++;
    }
    for (const id of this.active) {
      const end = this.endMs.get(id);
      if (end === undefined || ms >= end) {
        this.active.delete(id);
        // Don't add to `removed` if it was also in `added` this tick
        // (degenerate zero-duration item).
        if (!this.added.has(id)) this.removed.add(id);
      }
    }
    this.lastMs = ms;
  }

  /** Backward / non-monotonic jump. Rebuilds active set; tracks deltas
   *  so the same applyClassDiff path works for drag and loop-wrap. */
  seek(ms: number) {
    this.added.clear();
    this.removed.clear();
    const next = new Set<string>();
    let nextStartIdx = 0;
    for (let i = 0; i < this.items.length; i++) {
      const it = this.items[i];
      if (it.startMs > ms) break;
      nextStartIdx = i + 1;
      if (ms < it.endMs) next.add(it.id);
    }
    for (const id of this.active) {
      if (!next.has(id)) this.removed.add(id);
    }
    for (const id of next) {
      if (!this.active.has(id)) this.added.add(id);
    }
    this.active.clear();
    for (const id of next) this.active.add(id);
    this.startIdx = nextStartIdx;
    this.lastMs = ms;
  }

  /** Drop everything as removed. Used when transitioning into pause
   *  to clear the visible glow without leaving stale highlights. */
  clear() {
    this.added.clear();
    this.removed.clear();
    for (const id of this.active) this.removed.add(id);
    this.active.clear();
    this.lastMs = -Infinity;
    this.startIdx = 0;
  }
}

/** Apply class adds/removes via the precomputed `id -> Element[]` map.
 *  Loop mode's N duplicated SVG copies each carry the same xml:id so
 *  one id can map to multiple elements.
 *
 *  Caller passes the deltas computed by `ActiveCursor` so this fn
 *  doesn't need to diff Sets — that work was the hot per-frame allocation. */
function applyClassDelta(
  idMap: ReadonlyMap<string, ReadonlyArray<Element>>,
  added: ReadonlySet<string>,
  removed: ReadonlySet<string>,
  className: string,
) {
  for (const id of removed) {
    const els = idMap.get(id);
    if (!els) continue;
    for (const el of els) el.classList.remove(className);
  }
  for (const id of added) {
    const els = idMap.get(id);
    if (!els) continue;
    for (const el of els) el.classList.add(className);
  }
}

/** Walk the pan once and build an `id -> Element[]` map keyed by every
 *  xml:id Verovio emits. Used by the per-frame active-glyph diff. We
 *  capture multiple Elements per id because loop mode duplicates the
 *  pan SVG and the cloned copies share their source's ids. */
function buildIdMap(root: Element): Map<string, Element[]> {
  const map = new Map<string, Element[]>();
  for (const el of Array.from(root.querySelectorAll('[id]'))) {
    const id = el.id;
    if (!id) continue;
    const arr = map.get(id);
    if (arr) arr.push(el);
    else map.set(id, [el]);
  }
  return map;
}

/** Set up the rAF render loop that translates the pan. For loop scores,
 *  tracks a `wrapOffset` so the translate stays in (-musicWidth, 0] via
 *  invisible ±musicWidth teleports. Also toggles `.is-active` on notes
 *  and harms that are currently sounding so CSS can glow them. Returns
 *  a cancel fn. */
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
  notes: ReadonlyArray<Note>;
  harms: ReadonlyArray<Harm>;
  /** Header (clef + keysig) events within one iteration, sorted by
   *  startMs with a guaranteed entry at startMs=0. */
  headerEvents: ReadonlyArray<HeaderEvent>;
  /** Frozen overlay to crossfade as header events cross the playhead;
   *  null for scores that never visit more than one header state. */
  overlay: FrozenOverlay | null;
  /** Tempo events within one iteration, sorted by startMs with a
   *  guaranteed entry at 0. Drives the tempo overlay text swap. */
  tempoEvents: ReadonlyArray<TempoEvent>;
  /** Tempo overlay; null for scores with only one tempo (no chrome
   *  needed when the marking never changes). */
  tempoOverlay: TempoOverlay | null;
}): () => void {
  const { host, pan, player, loop, musicWidth, playheadPx, xAtMs, notes, harms,
          headerEvents, overlay, tempoEvents, tempoOverlay } = args;
  // Built once. Avoids the per-frame `pan.querySelectorAll('[id="…"]')`
  // walk that dominated playback cost on multi-thousand-element scores.
  // Loop mode's duplicated SVG copies share their source's xml:id so a
  // single id can map to multiple Elements.
  const idMap = buildIdMap(pan);
  // Stateful cursors over notes/harms: each tick they advance by the
  // ms delta and produce only the added/removed deltas. Eliminates
  // per-frame Set allocation + linear scan over thousands of notes.
  const noteCursor = new ActiveCursor(notes);
  const harmCursor = new ActiveCursor(harms);
  let rafId = 0;
  let lastRenderMs = -1;
  let wrapOffset = 0;
  let lastIterSeen = 0;
  let wasPlayingLastFrame = false;

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
        // is visually seamless.
        while (translateX <= -musicWidth) { translateX += musicWidth; wrapOffset += musicWidth; }
        while (translateX > 0) { translateX -= musicWidth; wrapOffset -= musicWidth; }
      } else {
        translateX = playheadPx - xAtMs(ms);
      }
      // translate3d (vs translateX) forces a compositor layer on most
      // browsers — critical for the huge pan SVGs (multi-thousand-px
      // wide on long pieces) where per-frame repaints are otherwise
      // CPU-bound.
      pan.style.transform = `translate3d(${translateX}px, 0, 0)`;
      host.classList.toggle('is-playing', player.isPlaying());

      // Glow only runs while playing. During drag/pause we don't want
      // random notes highlighted as the user scrubs through the timeline,
      // AND the per-frame class toggle work was the main drag cost — cheap
      // to skip when the audio isn't actually sounding anything.
      const playing = player.isPlaying();
      if (playing) {
        noteCursor.advance(ms);
        harmCursor.advance(ms);
        applyClassDelta(idMap, noteCursor.added, noteCursor.removed, 'is-active');
        applyClassDelta(idMap, harmCursor.added, harmCursor.removed, 'is-active');
      } else if (wasPlayingLastFrame) {
        // Just transitioned into pause: one-shot clear of lingering glow.
        noteCursor.clear();
        harmCursor.clear();
        applyClassDelta(idMap, noteCursor.added, noteCursor.removed, 'is-active');
        applyClassDelta(idMap, harmCursor.added, harmCursor.removed, 'is-active');
      }
      wasPlayingLastFrame = playing;

      // Overlay crossfade on any header change (clef, keysig, or both).
      // Pre-roll (ms < 0) resolves to the initial event. For loop mode
      // `ms` is already modulo'd to one iteration, so wrapping naturally
      // flips the overlay back to the initial fingerprint.
      if (overlay && headerEvents.length > 1) {
        overlay.setCurrent(headerFingerprint(eventAtMs(headerEvents, ms)));
      }
      if (tempoOverlay && tempoEvents.length > 1) {
        tempoOverlay.setCurrent(eventAtMs(tempoEvents, ms));
      }
    }
    rafId = requestAnimationFrame(frame);
  }
  frame();
  return () => cancelAnimationFrame(rafId);
}
