/*
 * Cell SDF worker — runs the per-pixel SDF inner loop off the main
 * thread. The math is identical to the previous in-thread version
 * (see CellSketch.astro for the architectural rationale of choosing
 * a distance-field render over an analytical inset polygon).
 *
 * Protocol (single message type each direction):
 *
 *   request:
 *     { type: 'compute'; positions; neighborOffsets;
 *       neighborCounts; neighborNx; neighborNy; neighborInvD2;
 *       bboxes; cellFades; sdfBuffer; n; w; h;
 *       layerSpacing; featherRange; lutScale; featherLut; ringFades;
 *       maxRings; fgPacked; skipDist }
 *
 *   response:
 *     { type: 'result'; sdfBuffer }
 *
 * Neighbor data is laid out as struct-of-arrays (nx, ny, invD2 each
 * a separate Float32Array, indexed at the same neighbor slot) rather
 * than a single packed stride-3 array. The inner loop reads each
 * with stride-1 indexing, which the JIT can fold into pointer-add
 * arithmetic — meaningful gain on the hot loop.
 *
 * `sdfBuffer` is transferred both directions (the big 2-3 MB buffer);
 * everything else is small and structured-cloned. The main thread
 * keeps a small pool of two sdfBuffers and ping-pongs them through
 * the worker, so the worker is always one frame ahead of the
 * displayed image — pipeline that lets main and worker overlap.
 *
 * Stale replies (after a main-side resize) are detected by buffer
 * length on the main thread, not by sequence number — see the
 * message handler in CellSketch.astro.
 *
 * Per-cell bboxes are computed on the main side via
 * `voronoi.cellPolygon(k)` (which already runs there for the
 * Voronoi-edge stroke pass). Sending tight bboxes is significantly
 * cheaper than computing conservative ones in the worker, which
 * would inflate the inner loop's pixel count by ~4×.
 */
/// <reference lib="webworker" />

interface ComputeMsg {
  type: 'compute';
  positions: Float64Array;
  neighborOffsets: Uint32Array;
  neighborCounts: Uint16Array;
  neighborNx: Float32Array;    // SoA neighbor data — see header comment
  neighborNy: Float32Array;
  neighborInvD2: Float32Array;
  bboxes: Float32Array;        // [xMin, yMin, xMax, yMax] per cell
  cellFades: Float32Array;     // SDF fade-in factor per cell, 0..1 — multiplies output alpha so newly-visible cells aren't full-bright on first appearance
  sdfBuffer: Uint32Array;
  n: number;
  w: number;
  h: number;
  layerSpacing: number;
  featherRange: number;
  lutScale: number;
  featherLut: Float32Array;
  ringFades: Float32Array;
  maxRings: number;
  fgPacked: number;
  skipDist: number;
}

type ResultMsg = { type: 'result'; sdfBuffer: Uint32Array };

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.addEventListener('message', (e: MessageEvent<ComputeMsg>) => {
  const m = e.data;
  if (m.type !== 'compute') return;

  const sdfBuffer = m.sdfBuffer;
  sdfBuffer.fill(0);

  const positions       = m.positions;
  const neighborOffsets = m.neighborOffsets;
  const neighborCounts  = m.neighborCounts;
  const neighborNx      = m.neighborNx;
  const neighborNy      = m.neighborNy;
  const neighborInvD2   = m.neighborInvD2;
  const bboxes          = m.bboxes;
  const cellFades       = m.cellFades;
  const featherLut      = m.featherLut;
  const ringFades       = m.ringFades;
  const n               = m.n;
  const w               = m.w;
  const layerSpacing    = m.layerSpacing;
  const featherRange    = m.featherRange;
  const lutScale        = m.lutScale;
  const maxRings        = m.maxRings;
  const fgPacked        = m.fgPacked;
  const skipDist        = m.skipDist;

  for (let k = 0; k < n; k++) {
    const xMin = bboxes[k * 4]     | 0;
    const yMin = bboxes[k * 4 + 1] | 0;
    const xMax = bboxes[k * 4 + 2] | 0;
    const yMax = bboxes[k * 4 + 3] | 0;
    if (xMin >= xMax || yMin >= yMax) continue;

    // Cell-level fade-in. 0 → cell hasn't entered the canvas yet (or
    // just did, sub-frame); skip the entire inner loop. Above 0, all
    // ring alphas this cell writes get multiplied by cellFade — so the
    // SDF rings ramp up from 0 to full over SDF_FADE_IN_MS rather than
    // popping in at full alpha when the polygon first becomes visible.
    const cellFade = cellFades[k];
    if (cellFade <= 0) continue;

    const sx = positions[k * 2];
    const sy = positions[k * 2 + 1];
    const start = neighborOffsets[k];
    const end   = start + neighborCounts[k];

    for (let py = yMin; py < yMax; py++) {
      const rowBase = py * w;
      const dys = py - sy;
      const dys2 = dys * dys;
      for (let px = xMin; px < xMax; px++) {
        const dxs = px - sx;
        const dSelfSq = dxs * dxs + dys2;

        // Inside-test + min-SDF in a single pass.
        let inside = true;
        let minSDF = 1e9;
        for (let i = start; i < end; i++) {
          const dxn = px - neighborNx[i];
          const dyn = py - neighborNy[i];
          const dNSq = dxn * dxn + dyn * dyn;
          if (dNSq < dSelfSq) { inside = false; break; }
          const sdfHere = (dNSq - dSelfSq) * neighborInvD2[i];
          if (sdfHere < minSDF) minSDF = sdfHere;
        }
        if (!inside) continue;
        if (minSDF > skipDist) continue;

        const phase = minSDF / layerSpacing;
        const closest = (phase + 0.5) | 0;
        if (closest < 1 || closest > maxRings) continue;
        let distToRing = minSDF - closest * layerSpacing;
        if (distToRing < 0) distToRing = -distToRing;
        if (distToRing >= featherRange) continue;

        const lutIdx = (distToRing * lutScale) | 0;
        const alpha = ringFades[closest] * featherLut[lutIdx];
        if (alpha < 0.01) continue;

        const a8 = (alpha * cellFade * 255) | 0;
        if (a8 === 0) continue;
        sdfBuffer[rowBase + px] = fgPacked | (a8 << 24);
      }
    }
  }

  const res: ResultMsg = { type: 'result', sdfBuffer };
  ctx.postMessage(res, [sdfBuffer.buffer]);
});
