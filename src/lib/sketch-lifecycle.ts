/**
 * Sketch lifecycle wrapper for ClientRouter SPA navigation.
 *
 * Each sketch component's <script> imports this and calls
 * `mountSketch(init)` once at module top level. The helper:
 *
 *   - runs `init()` immediately and again on every astro:page-load
 *     (covering both the initial bundle load and ClientRouter
 *     navigations into a page that hosts the canvas);
 *   - if `init()` returns a teardown function, registers it as a
 *     one-shot astro:before-swap handler so listeners and rAFs are
 *     released before the next page builds its own;
 *   - if the sketch is already mounted (cleanup pending), the next
 *     fire of page-load is a no-op — no double-init, no leaks.
 *
 * `init()` should:
 *   - bail with `return` (no value) if the sketch's host canvas isn't
 *     on this page — the helper interprets a void return as "nothing
 *     mounted, no cleanup needed";
 *   - return `() => void` to register cleanup. The helper nulls its
 *     pending-cleanup pointer automatically after teardown fires, so
 *     the cleanup body itself does NOT need to clear any module-scope
 *     "running" flag.
 *
 * Multiple early-return paths (e.g. prefers-reduced-motion shortcuts)
 * are fine — each path just returns its own cleanup closure.
 */
type Cleanup = () => void;
type Init = () => Cleanup | void;

export function mountSketch(init: Init): void {
  let cleanup: Cleanup | null = null;

  function start() {
    if (cleanup) return;
    const teardown = init();
    if (typeof teardown === 'function') {
      cleanup = teardown;
      document.addEventListener(
        'astro:before-swap',
        () => {
          cleanup?.();
          cleanup = null;
        },
        { once: true },
      );
    }
  }

  start();
  document.addEventListener('astro:page-load', start);
}
