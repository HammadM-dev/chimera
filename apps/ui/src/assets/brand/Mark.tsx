import type { JSX } from 'react';
import { MARK_DATA_URI } from './mark.ts';
import './mark.css';

// The mark, wherever it appears.
//
// Filled with `currentColor` through a CSS mask rather than drawn as an image,
// so one asset serves both themes: it is dark on the light theme and light on
// the dark one for the same reason the text around it is, and neither is a
// second file that can be forgotten when the first one changes.

export function Mark({
  size = 32,
  className = '',
}: {
  /** Rendered size in pixels, square. */
  size?: number;
  className?: string;
}): JSX.Element {
  return (
    <span
      className={`brandmark${className === '' ? '' : ` ${className}`}`}
      data-testid="brand-mark"
      aria-hidden="true"
      style={{
        width: `${String(size)}px`,
        height: `${String(size)}px`,
        // The URL travels as a custom property so the stylesheet holds the
        // mask rules and this holds the asset — the alternative is six mask
        // longhands written inline on every call site.
        ['--brand-mark' as string]: `url("${MARK_DATA_URI}")`,
      }}
    />
  );
}
