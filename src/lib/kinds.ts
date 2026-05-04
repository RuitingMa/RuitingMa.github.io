/**
 * Kind labels — the small-caps category line shown below each title.
 *
 * Single tag (NOTE, GENERATIVE) or ' · '-composed multi-tag
 * (AUDIO · GENERATIVE). Adding a new kind: append the literal here.
 * Both the essay schema (src/content.config.ts) and the sketch registry
 * (src/lib/sketches.ts) pull from this single union, so a typo in either
 * place becomes a build-time error.
 */
export const KINDS = [
  'ESSAY',
  'NOTE',
  'GENERATIVE',
  'AUDIO · GENERATIVE',
  'AI · INTERACTIVE',
] as const;

export type Kind = (typeof KINDS)[number];
