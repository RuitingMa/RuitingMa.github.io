/*
 * chrome-overlay — frozen header overlay with per-(staff, axis) tracks.
 *
 * Builds the clef/keysig/meter overlay that stays fixed while the score
 * scrolls.  Each (staff, axis) combination gets an independent crossfade
 * track — clef changes on staff 1 don't ripple to staves 0 and 2.
 * Source of truth is the rendered SVG (whatever Verovio drew).
 */
import { MEASURE_MUSIC_CLASSES } from './constants';
import type { TempoEvent } from './types';

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
 *  G2 line) so swapping the codepoint keeps staff-line alignment.
 *
 *  Critical: only swap when the target full glyph is actually present
 *  in the source SVG's `<defs>`. Verovio embeds only the glyphs the
 *  rendered piece uses — a score whose mid-piece F clef changes only
 *  ever appear as small E07C will NOT have E062 in defs. Swapping
 *  blindly there points the `<use>` at a missing symbol id, which the
 *  browser silently renders as 0×0 — the chrome F clef vanishes. When
 *  the target isn't available, leave the small variant in place
 *  (visually a touch smaller than ideal, but visible). */
function upgradeChromeClefGlyphs(
  clefEl: Element,
  availableCodepoints: Set<string>,
): void {
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
      if (!availableCodepoints.has(replacement)) continue;
      u.setAttribute(attr, `${m[1]}${replacement}${m[3]}`);
    }
  }
}

/** Scan the source SVG's `<defs>` once and collect every SMuFL codepoint
 *  it has a symbol for. Used by upgradeChromeClefGlyphs to gate codepoint
 *  swaps so they never point at a missing symbol. */
function collectAvailableCodepoints(srcSvg: SVGSVGElement): Set<string> {
  const out = new Set<string>();
  const defs = srcSvg.querySelector('defs');
  if (!defs) return out;
  for (const c of Array.from(defs.children)) {
    const m = c.id.match(/^(E[0-9A-F]{3})/i);
    if (m) out.add(m[1].toUpperCase());
  }
  return out;
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

  // SMuFL codepoints actually present in the rendered SVG's <defs>.
  // Gates the small→full clef glyph upgrade so it never rewrites a
  // <use> to point at a missing symbol (which would silently render
  // as 0×0 — see upgradeChromeClefGlyphs's docstring for the failure
  // mode this prevents).
  const availableCodepoints = collectAvailableCodepoints(tile0);

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
          // same visual weight as the m1 starting clef. Gated on the
          // full glyph's symbol actually being in defs.
          upgradeChromeClefGlyphs(cloned, availableCodepoints);
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
