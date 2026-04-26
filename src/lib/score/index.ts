/*
 * Score — public surface.
 *
 * Score.astro imports `attachAllScores` / `detachAllScores` from here.
 * `mountScore` is the per-host orchestrator: fetch MEI → render →
 * measure geometry → build overlay/staff layers → wire the player +
 * render loop + pointer handlers.
 *
 * Module map:
 *   constants.ts  — K, MEASURE_MUSIC_CLASSES
 *   types.ts      — Note, Harm, Anchor, HeaderEvent, Rendered, FrozenOverlay
 *   verovio.ts    — lazy WASM loader
 *   synth.ts      — Web Audio voice bank (no DOM)
 *   render.ts     — MEI → SVG, geometry helpers, rAF render loop
 *   player.ts     — ScorePlayer (transport + audio scheduler)
 *   index.ts      — mountScore + attach/detach (this file)
 */
import { K } from './constants';
import { ScorePlayer } from './player';
import {
  appendLoopLeader,
  applyLoopSpacing,
  buildAnchors,
  buildPannedShells,
  createFrozenOverlay,
  createStaffLinesLayer,
  createTempoOverlay,
  injectCopies,
  makeXAtMs,
  measureHeaderWidth,
  measureStaffYs,
  msAtX,
  padAnchors,
  renderScore,
  setFadeMaskVars,
  setupRenderLoop,
  stripHeadersFrom,
  stripStaffLinesFrom,
  type ScoreSource,
} from './render';
import { headerFingerprint, type MountedScore, type Rendered } from './types';

/**
 * Look for `score.mxl`, then `.musicxml`, then `.mei` under the slug's
 * directory. First match wins. .mxl gets returned as ArrayBuffer (for
 * Verovio's base64-zip entry); the text formats get returned as string.
 *
 * Why this priority order:
 *   - .mxl: shipped by virtually every notation tool (MuseScore /
 *     Finale / Sibelius / Dorico). Compressed → smaller transfer.
 *   - .musicxml: same content, uncompressed; some sources only offer
 *     this flavor.
 *   - .mei: our canonical format for hand-authored pieces; smaller and
 *     more legible in the repo than MusicXML.
 */
async function fetchScore(slug: string): Promise<ScoreSource> {
  const tries: Array<['mxl' | 'musicxml' | 'mei', 'mxl' | 'text']> = [
    ['mxl', 'mxl'],
    ['musicxml', 'text'],
    ['mei', 'text'],
  ];
  for (const [ext, kind] of tries) {
    const r = await fetch(`/scores/${slug}/score.${ext}`);
    if (!r.ok) continue;
    if (kind === 'mxl') {
      return { kind: 'mxl', data: await r.arrayBuffer() };
    }
    return { kind: 'text', data: await r.text() };
  }
  throw new Error(`no score file under /scores/${slug}/ (tried .mxl, .musicxml, .mei)`);
}

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
  let source: ScoreSource;
  try { source = await fetchScore(slug); }
  catch (err) { console.warn('[score]', slug, 'score load failed:', err); return null; }

  let rendered: Rendered;
  try { rendered = await renderScore(source); }
  catch (err) { console.warn('[score]', slug, 'Verovio render failed:', err); return null; }

  // --- Auto-scale stage height for multi-staff pieces --------------------
  // Verovio renders the SVG to fill the stage height; with N staves
  // sharing that height, each staff ends up ~1/N the size of a solo
  // single-staff render. We ensure at least REF_STAGE_HEIGHT_PX of
  // stage per staff so individual staves land at a consistent visual
  // size regardless of staff count. The author's `--score-h` is
  // honored when it's already at least that tall. Capped to 80vh so
  // a 4-staff orchestral piece doesn't push past the viewport.
  const staffCount = Math.max(1, rendered.staffGroup.staves.length);
  if (staffCount > 1) {
    const authoredH = parseFloat(host.style.getPropertyValue('--score-h')) || K.REF_STAGE_HEIGHT_PX;
    const minMultiH = K.REF_STAGE_HEIGHT_PX * staffCount;
    const cap = window.innerHeight * 0.8;
    const effectiveH = Math.min(Math.max(authoredH, minMultiH), cap);
    host.style.setProperty('--score-h', `${effectiveH}px`);
  }

  // --- Inject SVG copies into pan -----------------------------------------
  const panSvgs = injectCopies(pan, rendered.svg, loop ? K.LOOP_COPIES : 1);
  const svgEl = panSvgs[0];
  if (!svgEl) return null;

  // --- Measure geometry (anchors, header, staff y's) ----------------------
  const svgRect0 = svgEl.getBoundingClientRect();
  const stageRect0 = stage.getBoundingClientRect();
  const firstMeasure = svgEl.querySelector('.measure');
  // ALL staves in measure 1 — piano grand staff has 2; orchestral N.
  // Their y-positions feed the staff-lines layer so every staff gets
  // its 5 horizontal lines, not just the top one.
  const firstMeasureStaves = firstMeasure?.querySelectorAll('.staff') ?? [];

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
  // the inline change glyph in the pan (clef, keysig, and/or meter)
  // actually crosses the playhead. Without this, overlay crossfades
  // fire at the first-note onset (hundreds of ms later at normal scroll
  // rates) and the glyph vanishes into the header before the header
  // updates. When several axes change at once we anchor to whichever
  // glyph sits leftmost — clef / keysig / meterSig render side by side
  // in that order at the start of a change measure, so leftmost-wins
  // picks the change-leading glyph and the rest follow it past the
  // playhead at the same scroll rate. Pure meter changes (no clef/key)
  // need .meterSig in the selector — without it the event would fall
  // through and keep its raw measure-onset time, drifting the overlay
  // off from the visible change.
  const svgMeasures = Array.from(svgEl.querySelectorAll('.measure'));
  for (const evt of rendered.headerEvents) {
    if (evt.measureIdx === 0) continue;
    const m = svgMeasures[evt.measureIdx];
    if (!m) continue;
    let leftMost: DOMRect | null = null;
    for (const g of Array.from(m.querySelectorAll('.clef, .keySig, .meterSig'))) {
      const r = (g as Element).getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      if (!leftMost || r.left < leftMost.left) leftMost = r;
    }
    if (!leftMost) continue;
    const centerX = leftMost.left + leftMost.width / 2 - svgRect0.left;
    evt.startMs = msAtX(anchors, centerX);
  }

  // Same dance for tempo events: when MEI has a <tempo> element inside
  // a measure, Verovio renders it as <g class="tempo"> above the staff.
  // Re-time the event to when that glyph crosses the playhead so the
  // overlay text swap aligns with the visible marking. Tempo events
  // sourced from a between-measure <scoreDef midi.bpm="..."> have no
  // glyph and keep their raw measure-onset time.
  for (const evt of rendered.tempoEvents) {
    if (evt.measureIdx === 0) continue;
    const m = svgMeasures[evt.measureIdx];
    if (!m) continue;
    const glyph = m.querySelector('.tempo');
    if (!glyph) continue;
    const r = (glyph as Element).getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    const centerX = r.left + r.width / 2 - svgRect0.left;
    evt.startMs = msAtX(anchors, centerX);
  }

  const staffYs = measureStaffYs(firstMeasureStaves, stageRect0.top);

  // --- Build overlay shells + playhead + mask ---------------------------
  // Each shell is composed from pan glyphs and reflowed to a uniform
  // chrome layout: clef at m1.clef position; keysig at clef.right + pad
  // (only when keysig != 0); meter at keysig.right + pad. Cancel
  // naturals from mid-piece keysig changes are stripped — frozen
  // overlay is the STABLE keysig display only. `maxChromeRight` is the
  // right edge of the WIDEST fp's chrome, used to size the overlay box
  // so the playhead never lands inside any fp's chrome.
  const { shells: shellMap, maxChromeRight } = buildPannedShells(
    svgEl, rendered.headerEvents, svgRect0,
  );
  const headerWidestWidth = Math.max(actualHeaderWidth, maxChromeRight);

  // Playhead sits a small constant offset to the right of the actual
  // widest header. HEADER_MAX_PX acts as a stable axis floor so scores
  // with very narrow keysigs (e.g. C-major with no accidentals) don't
  // pull the playhead all the way left and visually disagree with
  // neighboring scores on the same page; we no longer scale it by
  // stage height because the header glyph widths are largely a function
  // of the keysig + clef stack (a few discrete cases), not the stage.
  // `playheadFrac` is honored only as a floor — author override.
  const playheadPx = Math.max(
    headerWidestWidth + K.PLAYHEAD_OFFSET_PX,
    K.HEADER_MAX_PX,
    playheadFrac * stageRect0.width,
  );
  playheadEl.style.left = `${playheadPx}px`;

  const initialFingerprint = rendered.headerEvents[0]
    ? headerFingerprint(rendered.headerEvents[0])
    : headerFingerprint({
        clefs: rendered.staffGroup.staves.map(() => ({ shape: 'G', line: '2' })),
        keysig: '0',
        meter: { count: rendered.meterCount, unit: rendered.meterUnit, sym: '' },
      });
  const frozenOverlay = createFrozenOverlay(
    shellMap, initialFingerprint, headerWidestWidth,
  );
  if (frozenOverlay) stage.appendChild(frozenOverlay.host);

  // Tempo overlay: only build when the piece actually has a tempo
  // marking that's worth showing. A score whose only tempo is the
  // implicit default (no <tempo> in MEI, just midi.bpm on scoreDef)
  // gets a single auto-generated event with display "♩=NN" — fine to
  // show, but skipped when the piece never changes tempo to keep the
  // chrome out of the way.
  const tempoOverlay = rendered.tempoEvents.length > 1
    ? createTempoOverlay(rendered.tempoEvents)
    : null;
  if (tempoOverlay) stage.appendChild(tempoOverlay.host);

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

  const player = new ScorePlayer(rendered, loop, K.TAIL_MS);
  if (import.meta.env.DEV) {
    (host as unknown as { _player: ScorePlayer })._player = player;
  }
  player.onEnd = () => host.classList.remove('is-playing');

  const cancelLoop = setupRenderLoop({
    host, pan, player, loop, musicWidth, playheadPx, xAtMs,
    notes: rendered.notes, harms: rendered.harms,
    headerEvents: rendered.headerEvents, overlay: frozenOverlay,
    tempoEvents: rendered.tempoEvents, tempoOverlay,
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
      player.seek(0);
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
          // Wrap in try/catch so a failure inside mountScore (Verovio
          // load failure, WASM fetch error, malformed MEI, stale Vite
          // dep cache, …) surfaces as a console warning instead of a
          // silent unhandled rejection. Without this, an awaited dynamic
          // import that never resolves left mountScore hung mid-way
          // through with no visible error — the score showed only its
          // SVG injection (no playhead, no overlay, no listeners) and
          // the page looked "broken but not loud about it".
          try {
            const handle = await mountScore(host);
            if (handle) mounted.set(host, handle);
          } catch (err) {
            console.warn('[score] mount failed:', err);
          }
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
