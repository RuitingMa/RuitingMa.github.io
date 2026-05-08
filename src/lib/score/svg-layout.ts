/*
 * svg-layout — SVG injection, tiling, anchors, and DOM geometry.
 *
 * Pure functions over the rendered SVG once it's in the DOM.  Composed
 * by mountScore (see index.ts).
 */
import { K } from './constants';
import type { Anchor, Note, Rendered } from './types';

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
