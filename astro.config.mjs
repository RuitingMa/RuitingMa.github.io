// @ts-check
import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';
import fontSubset from './integrations/font-subset.mjs';

// https://astro.build/config
export default defineConfig({
  site: 'https://sunkenkeep.space',
  // Order: mdx first so .mdx essays can import components; font-subset runs
  // at astro:build:done, after everything else has emitted HTML.
  integrations: [mdx(), fontSubset()],
  vite: {
    worker: {
      // ES module workers — required because src/lib/score/render-worker.ts
      // imports from render.ts (which is code-split). Vite's default `iife`
      // worker format would refuse the import; `es` lets the worker chunk
      // share modules with the main bundle.
      format: 'es',
    },
  },
});
