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
});
