export function setupCanvas2D(id: string, maxDpr = 1.5) {
  const canvas = document.getElementById(id) as HTMLCanvasElement | null;
  if (!canvas) return null;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const dpr = Math.min(window.devicePixelRatio || 1, maxDpr);
  return { canvas, ctx, dpr };
}

export function resizeCanvas2D(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  dpr: number,
) {
  const rect = canvas.getBoundingClientRect();
  const w = rect.width;
  const h = rect.height;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { w, h };
}
