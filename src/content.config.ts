import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';
import { KINDS } from './lib/kinds';

// Long-form entries live here. Sketches are hand-authored .astro pages under
// src/pages/sketches/ (their canvas/WebGL setup is bespoke); they share the
// `kind` taxonomy with essays via src/lib/kinds.ts so a typo in either side
// is a build-time error.
const essays = defineCollection({
  loader: glob({ pattern: '**/*.{md,mdx}', base: './src/content/essays' }),
  schema: z.object({
    title: z.string(),
    // ISO-ish date (YYYY-MM-DD). Kept as string so frontmatter stays readable
    // and sort comparisons are lexical — no timezone footguns.
    date: z.string(),
    kind: z.enum(KINDS).default('ESSAY'),
    summary: z.string(),
    tint: z.enum(['plum', 'moss', 'rust', 'mist', 'dune']).optional(),
    // Name of a stage component in the STAGES registry inside
    // src/pages/essays/[...slug].astro. Omit for a prose-only essay.
    stage: z.string().optional(),
    // Publish-by-opt-in: every essay starts as a draft (hidden in PROD,
    // dev still renders). Set `published: true` to ship.
    published: z.boolean().default(false),
  }),
});

export const collections = { essays };
