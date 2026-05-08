# Sunken Keep (眠海) — Blog & Creative-Coding Portfolio

Astro 6 static site. Chinese-language essays + interactive WebGL/Canvas sketches.

## Commands

```bash
npm run dev      # local dev server (port 4321)
npm run build    # production build → dist/
npx tsc --noEmit # type-check without emitting
```

## Architecture

```
src/
  components/    # Astro components; *Sketch.astro files are large (400–960 lines)
                 # with inline <script>/<style> — each is a self-contained WebGL/Canvas app
  content/       # essays in .md/.mdx with frontmatter (see content.config.ts for schema)
  layouts/       # BaseLayout (520 lines — global styles, ViewTransitions, header/footer)
  lib/           # shared TS utilities
    score/       # music notation subsystem (Verovio MEI → SVG playback)
               # render.ts is the largest file (~1960 lines)
    sketches.ts  # sketch registry (title/date/kind/published for each sketch page)
    kinds.ts     # shared Kind union — single source of truth for category labels
  pages/         # Astro file-based routing
    sketches/    # hand-authored sketch pages (not content-collection)
    essays/      # [...slug].astro dynamic route for essay content collection
  shaders/       # GLSL fragment/vertex shaders (clinamen)
  styles/        # tokens.css — CSS custom properties / design tokens
  audio/         # modal-bell.ts — audio synthesis helpers
data/            # large training/reference data (MNIST, makemeahanzi) — NOT source code
public/          # static assets: fonts, scores (.mei/.mxl), ML model weights
integrations/    # Astro integration: font-subset.mjs (subsetting CJK fonts at build)
scripts/         # Python/JS build scripts (font building, stroke extraction, ML training)
```

## Key patterns

- **Draft system**: essays use `published: true/false` in frontmatter; sketches use the same field in `src/lib/sketches.ts`. Drafts render in dev, filtered in prod.
- **Kind taxonomy**: `src/lib/kinds.ts` is the single source of truth for category labels used by both essay schema and sketch registry.
- **Sketch components** are large monolithic `.astro` files with inline `<script>` and `<style>`. WebGL/Canvas setup is bespoke per sketch.
- **Score subsystem** (`src/lib/score/`): renders MEI music notation via Verovio, with Web Worker rendering and Web Audio playback.
- **Font subsetting**: `integrations/font-subset.mjs` runs at `astro:build:done` to subset CJK fonts per page.
- **Vite worker format**: set to `es` in astro.config.mjs so render-worker.ts can import shared modules.

## Large files (read selectively)

| File | Lines | Note |
|------|-------|------|
| `src/lib/score/render.ts` | ~1960 | MEI→SVG rendering pipeline |
| `src/components/CellSketch.astro` | ~960 | SDF cellular automaton sketch |
| `src/components/ClinamenSketch.astro` | ~850 | WebGL particle sketch |
| `src/layouts/BaseLayout.astro` | ~520 | global layout + all shared CSS |
| `src/components/Score.astro` | ~470 | interactive score player UI |
| `src/components/ShiSketch.astro` | ~480 | ML handwriting sketch |

When editing these, use line-range reads instead of reading the full file.

## Git conventions

- Commit messages: do NOT append `Co-Authored-By` lines.
