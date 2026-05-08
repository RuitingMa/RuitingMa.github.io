// Single source of truth for sketches. The homepage builds its listing from
// here, and SketchLayout (src/layouts/SketchLayout.astro) reads metadata from
// here via the page's `slug` prop, so each sketch page only declares which
// sketch it is — no duplicated title/date/kind/tint.
//
// Publish-by-opt-in: every entry starts as a draft. Set `published: true`
// to ship — drafts are hidden from the listing and redirect direct visits
// to /404 in production. Dev still serves them normally so you can
// preview. (The redirect target relies on src/pages/404.astro existing;
// if you ever rename or remove it, drafts will fall through to the host's
// default 404 page.)
import type { Kind } from './kinds';

export type Tint = 'plum' | 'moss' | 'rust' | 'mist' | 'dune';

export type Sketch = {
  slug: string;
  href: string;
  title: string;
  date: string;
  kind: Kind;
  summary: string;
  tint?: Tint;
  published?: boolean;
};

export const SKETCHES: Sketch[] = [
  { slug: 'cell',        href: '/sketches/cell/',        title: 'Cell',       date: '2026-05-06', kind: 'GENERATIVE',         summary: '格中钟摆。',     tint: 'moss', published: true },
  { slug: 'clinamen',    href: '/sketches/clinamen/',    title: 'Clinamen',   date: '2026-04-20', kind: 'AUDIO · GENERATIVE', summary: '河灯散布于水面。', tint: 'rust', published: true },
  { slug: 'smoke',       href: '/sketches/smoke/',       title: 'Smoke',      date: '2026-04-19', kind: 'GENERATIVE',         summary: '烟。',           tint: 'plum', published: true },
  { slug: 'hello-world', href: '/sketches/hello-world/', title: 'Flow Field', date: '2026-04-18', kind: 'GENERATIVE',         summary: '漂流点阵。',     tint: 'mist', published: true },
];

export function getSketch(slug: string): Sketch | undefined {
  return SKETCHES.find((s) => s.slug === slug);
}

/** Per-page guard for draft sketches. Each sketch page imports this
 *  and redirects to /404 in PROD when its slug is unpublished. */
export function isDraft(slug: string): boolean {
  return !getSketch(slug)?.published;
}
