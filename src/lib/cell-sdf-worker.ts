/*
 * Cell SDF worker — runs the per-pixel SDF inner loop off the main
 * thread. The math is identical to the previous in-thread version
 * (see CellSketch.astro for the architectural rationale of choosing
 * a distance-field render over an analytical inset polygon).
 *
 * Protocol (single message type each direction):
 *
 *   request:
 *     { type: 'compute'; seqNo; positions; neighborOffsets;
 *       neighborCounts; neighborData; bboxes; sdfBuffer; n; w; h;
 *       layerSpacing; featherRange; lutScale; featherLut; ringFades;
 *       maxRings; fgPacked; skipDist }
 *
 *   response:
 *     { type: 'result'; seqNo; sdfBuffer }
 *
 * `sdfBuffer` is transferred both directions (the big 2-3 MB buffer);
 * everything else is small and structured-cloned. The main thread
 * keeps a small pool of two sdfBuffers and ping-pongs them through
 * the worker, so the worker is always one frame ahead of the
 * displayed image — pipeline that lets main and worker overlap.
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
  seqNo: number;
  positions: Float64Array;
  neighborOffsets: Uint32Array;
  neighborCounts: Uint16Array;
  neighborData: Float32Array;
  bboxes: Float32Array;        // [xMin, yMin, xMax, yMax] per cell
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

type ResultMsg = { type: 'result'; seqNo: number; sdfBuffer: Uint32Array };

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.addEventListener('message', (e: MessageEvent<ComputeMsg>) => {
  const m = e.data;
  if (m.type !== 'compute') return;

  const sdfBuffer = m.sdfBuffer;
  sdfBuffer.fill(0);

  const positions      = m.positions;
  const neighborOffsets = m.neighborOffsets;
  const neighborCounts  = m.neighborCounts;
  const neighborData    = m.neighborData;
  const bboxes          = m.bboxes;
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

    const sx = positions[k * 2];
    const sy = positions[k * 2 + 1];
    const start = neighborOffsets[k];
    const end   = start + neighborCounts[k] * 3;

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
        for (let i = start; i < end; i += 3) {
          const dxn = px - neighborData[i];
          const dyn = py - neighborData[i + 1];
          const dNSq = dxn * dxn + dyn * dyn;
          if (dNSq < dSelfSq) { inside = false; break; }
          const sdfHere = (dNSq - dSelfSq) * neighborData[i + 2];
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

        const a8 = (alpha * 255) | 0;
        sdfBuffer[rowBase + px] = fgPacked | (a8 << 24);
      }
    }
  }

  const res: ResultMsg = { type: 'result', seqNo: m.seqNo, sdfBuffer };
  ctx.postMessage(res, [sdfBuffer.buffer]);
});
