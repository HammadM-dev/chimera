import type { JSX } from 'react';

// A mark per provider, drawn rather than fetched.
//
// These are geometric monograms in each provider's own accent, not their
// trademarks. I do not have their SVGs and cannot reproduce them accurately
// from memory, and a wonky approximation of a logo people see every day looks
// worse than a clean letter — it reads as a knock-off rather than as a brand.
// Dropping real assets in later is a one-line change per provider: replace the
// `glyph` with the path, keep the badge.
//
// Anthropic's is the exception: its mark is a radial burst, which is geometry
// rather than draughtsmanship, so it is drawn as one.

export type MarkId =
  | 'anthropic'
  | 'openai'
  | 'google'
  | 'openrouter'
  | 'ollama'
  | 'ollama-cloud'
  | 'omniroute'
  | 'lmstudio';

const LETTER = {
  x: 12,
  y: 12,
  textAnchor: 'middle' as const,
  dominantBaseline: 'central' as const,
  fontSize: 12,
  fontWeight: 500,
  stroke: 'none',
  fill: 'currentColor',
};

const MARKS: Record<MarkId, { tint: string; glyph: JSX.Element }> = {
  anthropic: {
    tint: 'var(--mark-anthropic)',
    glyph: (
      <g strokeLinecap="round">
        <path d="M12 4v16M4.6 7.6l14.8 8.8M19.4 7.6 4.6 16.4" strokeWidth="2.4" />
      </g>
    ),
  },
  openai: { tint: 'var(--mark-openai)', glyph: <text {...LETTER}>O</text> },
  google: { tint: 'var(--mark-google)', glyph: <text {...LETTER}>G</text> },
  openrouter: { tint: 'var(--mark-openrouter)', glyph: <text {...LETTER}>R</text> },
  ollama: { tint: 'var(--mark-ollama)', glyph: <text {...LETTER}>L</text> },
  'ollama-cloud': { tint: 'var(--mark-ollama)', glyph: <text {...LETTER}>L</text> },
  omniroute: { tint: 'var(--mark-omniroute)', glyph: <text {...LETTER}>Ω</text> },
  lmstudio: { tint: 'var(--mark-lmstudio)', glyph: <text {...LETTER}>M</text> },
};

export function ProviderMark({ id }: { id: MarkId }): JSX.Element {
  const mark = MARKS[id];
  return (
    <span className="mark" style={{ color: mark.tint }} aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
        {mark.glyph}
      </svg>
    </span>
  );
}
