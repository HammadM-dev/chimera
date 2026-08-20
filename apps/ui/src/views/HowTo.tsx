import { useState } from 'react';
import type { JSX, ReactNode } from 'react';
import './howto.css';

// "Not sure how?" — the steps, next to the field they are about.
//
// Both of the things this covers fail in the same way: the person has done
// nothing wrong, the app says "invalid credentials", and the actual answer is
// somewhere in a provider's settings under a name they have never heard. A
// help page they have to go and find is a help page they do not read, so the
// steps live here, folded away until asked for.

export function HowTo({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  const [open, setOpen] = useState(false);

  return (
    <div className="howto">
      <button
        type="button"
        className="howto__toggle"
        data-testid="howto-toggle"
        aria-expanded={open}
        onClick={() => {
          setOpen((current) => !current);
        }}
      >
        {open ? '▾' : '▸'} {label}
      </button>
      {open && (
        <div className="howto__body" data-testid="howto-body">
          {children}
        </div>
      )}
    </div>
  );
}

/** One numbered step. The number is the sequence, which is real information. */
export function Step({ children }: { children: ReactNode }): JSX.Element {
  return <li className="howto__step">{children}</li>;
}

export function Steps({ children }: { children: ReactNode }): JSX.Element {
  return <ol className="howto__steps">{children}</ol>;
}
