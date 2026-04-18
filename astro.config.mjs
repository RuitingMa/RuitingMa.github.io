// @ts-check
import { defineConfig } from 'astro/config';
import fontSubset from './integrations/font-subset.mjs';

// https://astro.build/config
export default defineConfig({
  site: 'https://sunkenkeep.space',
  integrations: [fontSubset()],
});
