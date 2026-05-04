// Single source of truth for sketches. The homepage builds its listing from
// here, and SketchLayout (src/layouts/SketchLayout.astro) reads metadata from
// here via the page's `slug` prop, so each sketch page only declares which
// sketch it is — no duplicated title/date/kind/tint.
//
// Mark `draft: true` to hide an entry from the listing and redirect direct
// visits to /404 in production builds. Dev still serves them normally so you
// can preview. (The redirect target relies on src/pages/404.astro existing;
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
  draft?: boolean;
};

export const SKETCHES: Sketch[] = [
  { slug: 'shi',         href: '/sketches/shi/',         title: '识',          date: '2026-04-22', kind: 'AI · INTERACTIVE',   summary: '机器识字。',     tint: 'moss', draft: true },
  { slug: 'clinamen',    href: '/sketches/clinamen/',    title: 'Clinamen',   date: '2026-04-20', kind: 'AUDIO · GENERATIVE', summary: '河灯散布于水面。', tint: 'rust' },
  { slug: 'smoke',       href: '/sketches/smoke/',       title: 'Smoke',      date: '2026-04-19', kind: 'GENERATIVE',         summary: '烟。',           tint: 'plum' },
  { slug: 'hello-world', href: '/sketches/hello-world/', title: 'Flow Field', date: '2026-04-18', kind: 'GENERATIVE',         summary: '漂流点阵。',     tint: 'mist', draft: true },
];

export function getSketch(slug: string): Sketch | undefined {
  return SKETCHES.find((s) => s.slug === slug);
}

export function isDraft(slug: string): boolean {
  return getSketch(slug)?.draft === true;
}
