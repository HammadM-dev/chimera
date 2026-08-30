import type { JSX } from 'react';

// A mark per provider, drawn rather than fetched.
//
// These are geometric marks in each provider's own accent, not their
// trademarks — deliberately abstract rather than near-copies, because a wonky
// approximation of a logo people see every day reads as a knock-off. Each says
// something true about the provider instead: a router fanning out to many
// endpoints, a gateway converging on one, a window you drive yourself.
//
// Real assets win over all of it: drop `<id>.png` into assets/providers and it
// is used instead, untinted.

export type MarkId =
  | 'anthropic'
  | 'openai'
  | 'google'
  | 'openrouter'
  | 'ollama'
  | 'ollama-cloud'
  | 'omniroute'
  | 'lmstudio';

/**
 * A drawn mark per provider, for the ones with no logo file.
 *
 * These were single letters — G, M, R — which is what a placeholder looks like
 * rather than what a product looks like. They are geometric marks now:
 * deliberately abstract rather than approximations of the real trademarks,
 * because a wonky near-copy of a logo people see every day reads as a knock-off
 * and a clean abstract shape does not. Each one says something true about the
 * provider instead.
 *
 * Dropping a real asset into assets/providers/<id>.png still wins over all of
 * this — see `logoFor`.
 */
const STROKE = {
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
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
  // Four quadrants around a gap: a search index, not the letter G.
  google: {
    tint: 'var(--mark-google)',
    glyph: (
      <g {...STROKE}>
        <path d="M12 4a8 8 0 0 1 8 8" />
        <path d="M20 12a8 8 0 0 1-8 8" />
        <path d="M12 20a8 8 0 0 1-8-8" />
        <circle cx="12" cy="12" r="3" />
      </g>
    ),
  },
  // One inlet fanning out to many outlets: what a router does.
  openrouter: {
    tint: 'var(--mark-openrouter)',
    glyph: (
      <g {...STROKE}>
        <circle cx="5" cy="12" r="2" />
        <circle cx="19" cy="6" r="2" />
        <circle cx="19" cy="12" r="2" />
        <circle cx="19" cy="18" r="2" />
        <path d="M7 12h3l5-6M10 12h7M10 12h3l4 6" />
      </g>
    ),
  },
  // A llama's head in three strokes, which is the joke the name is already making.
  ollama: {
    tint: 'var(--mark-ollama)',
    glyph: (
      <g {...STROKE}>
        <path d="M9 5v5M15 5v5" />
        <path d="M7 10h10v5a5 5 0 0 1-10 0z" />
        <path d="M11 19v2M13 19v2" />
      </g>
    ),
  },
  'ollama-cloud': {
    tint: 'var(--mark-ollama)',
    glyph: (
      <g {...STROKE}>
        <path d="M9 6v4M15 6v4" />
        <path d="M7 10h10v4a5 5 0 0 1-10 0z" />
        <path d="M5 19h14" />
      </g>
    ),
  },
  // Many lines converging into one: a gateway in front of every provider.
  omniroute: {
    tint: 'var(--mark-omniroute)',
    glyph: (
      <g {...STROKE}>
        <path d="M4 6h6M4 12h6M4 18h6" />
        <path d="M10 6q5 0 5 6t5 6" />
        <path d="M10 12h10" />
        <path d="M10 18q5 0 5-6t5-6" />
      </g>
    ),
  },
  // A window with a slider: a desktop app you drive yourself.
  lmstudio: {
    tint: 'var(--mark-lmstudio)',
    glyph: (
      <g {...STROKE}>
        <rect x="3.5" y="5" width="17" height="13" rx="2" />
        <path d="M3.5 9h17" />
        <path d="M7 13.5h10" />
        <circle cx="13" cy="13.5" r="1.6" />
      </g>
    ),
  },
  openai: {
    tint: 'var(--mark-openai)',
    glyph: (
      <g {...STROKE}>
        <path d="M12 4.5 19 8.5v7L12 19.5 5 15.5v-7z" />
        <path d="M12 12v7.5M12 12 5 8.5M12 12l7-3.5" />
      </g>
    ),
  },
};

/**
 * Real logos, if any have been dropped into assets/providers.
 *
 * Globbed at build time rather than imported one by one, so adding a file is
 * the whole of adding a logo — no import to remember, no switch to extend, and
 * a half-filled folder renders correctly instead of showing gaps. The monogram
 * below is the fallback, which is what every provider gets until its file
 * arrives.
 */
const LOGOS = import.meta.glob<string>('../assets/providers/*.{png,svg,webp}', {
  eager: true,
  query: '?url',
  import: 'default',
});

function logoFor(id: MarkId): string | undefined {
  const match = Object.entries(LOGOS).find(([path]) => {
    const file = path.split('/').pop() ?? '';
    return file.replace(/\.[^.]+$/, '') === id;
  });
  return match?.[1];
}

export function ProviderMark({ id }: { id: MarkId }): JSX.Element {
  const mark = MARKS[id];
  const logo = logoFor(id);

  if (logo !== undefined) {
    // No tint on a real logo: these arrive with their own colour, and a brand
    // recoloured to fit a palette is a brand used wrongly.
    return (
      <span className="mark mark--logo" aria-hidden="true">
        <img src={logo} alt="" />
      </span>
    );
  }

  return (
    <span className="mark" style={{ color: mark.tint }} aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
        {mark.glyph}
      </svg>
    </span>
  );
}
