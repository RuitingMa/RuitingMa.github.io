/*
 * Verovio — loaded once per page, reused by every Score on the page.
 *
 * The WASM is ~1.5MB gzipped, so we load it lazily via dynamic import.
 * `attachAllScores` (in index.ts) gates that load behind an
 * IntersectionObserver — the WASM doesn't fetch until at least one
 * Score is within a screen of the viewport.
 */

let verovioPromise: Promise<{ VerovioToolkit: any; module: any }> | null = null;

export async function loadVerovio() {
  if (!verovioPromise) {
    verovioPromise = (async () => {
      const [{ VerovioToolkit }, createModule] = await Promise.all([
        import('verovio/esm'),
        import('verovio/wasm').then((m) => m.default),
      ]);
      const module = await createModule();
      return { VerovioToolkit, module };
    })();
  }
  return verovioPromise;
}
