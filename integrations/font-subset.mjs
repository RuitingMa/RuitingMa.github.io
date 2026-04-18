// Astro integration: after `astro build`, run the Python font subsetter
// against the generated dist/ directory. The subsetter:
//   - scans every .html for the characters actually used on each page
//   - produces mini WOFF2 subsets under dist/fonts/p/
//   - injects a <style> block with per-page @font-face rules into each
//     HTML's <head>
//
// Requires Python on PATH with fonttools + brotli installed.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(HERE, '..', 'scripts', 'build-fonts.py');

export default function fontSubset() {
  return {
    name: 'font-subset',
    hooks: {
      'astro:build:done': ({ dir, logger }) => {
        const distPath = fileURLToPath(dir);
        logger.info(`subsetting fonts per page under ${distPath}`);
        const result = spawnSync(
          'python',
          [SCRIPT, 'pages', distPath],
          { stdio: 'inherit' },
        );
        if (result.error) {
          throw new Error(`could not spawn python: ${result.error.message}`);
        }
        if (result.status !== 0) {
          throw new Error(`font subsetter exited with code ${result.status}`);
        }
      },
    },
  };
}
