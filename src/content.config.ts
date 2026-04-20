import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

// Long-form entries live here. Sketches are still hand-authored .astro pages
// under src/pages/sketches/ — their layouts are bespoke enough that a shared
// template would fight them. When/if a sketch ever gets a prose-heavy body,
// it can migrate in.
const essays = defineCollection({
  loader: glob({ pattern: '**/*.{md,mdx}', base: './src/content/essays' }),
  schema: z.object({
    title: z.string(),
    // ISO-ish date (YYYY-MM-DD). Kept as string so frontmatter stays readable
    // and sort comparisons are lexical — no timezone footguns.
    date: z.string(),
    kind: z.string().default('ESSAY'),
    summary: z.string(),
    tint: z.enum(['plum', 'moss', 'rust', 'mist', 'dune']).optional(),
    // Name of a stage component in the STAGES registry inside
    // src/pages/essays/[...slug].astro. Omit for a prose-only essay.
    stage: z.string().optional(),
  }),
});

export const collections = { essays };
