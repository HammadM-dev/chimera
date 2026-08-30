// When a reminder is due, in the words a person actually reasons in.
//
// Nobody plans against "2026-09-01T09:00:00.000Z". They plan against "tomorrow"
// and "four days late". The absolute date is kept as the tooltip, because the
// moment relative time stops being enough — booking something, checking a
// contract — only the real date will do.
//
// Its own module because date arithmetic is where this kind of code goes wrong,
// and a pure function is the only part of a board that can be tested properly.

export interface DueReading {
  /** What to show. Empty for a note, which has no date. */
  label: string;
  /** Past its date and not ticked off. Drives the one urgent colour on screen. */
  late: boolean;
  /** Due today, and not yet late. */
  today: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Midnight local, so "tomorrow" means the next calendar day rather than 24 hours. */
function startOfDay(at: Date): number {
  return new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime();
}

export function readDue(dueAt: string | null, now: Date = new Date()): DueReading {
  if (dueAt === null || dueAt === '') return { label: '', late: false, today: false };

  const due = new Date(dueAt);
  if (Number.isNaN(due.getTime())) return { label: '', late: false, today: false };

  // Counted in whole days between calendar dates, not in elapsed hours. A
  // reminder set for 9am and read at 5pm the same day is due *today*, and
  // saying "8 hours ago" about it would be technically true and useless.
  const days = Math.round((startOfDay(due) - startOfDay(now)) / DAY_MS);

  if (days < 0) {
    const late = Math.abs(days);
    return {
      label: late === 1 ? '1 day late' : `${String(late)} days late`,
      late: true,
      today: false,
    };
  }
  if (days === 0) return { label: 'due today', late: false, today: true };
  if (days === 1) return { label: 'due tomorrow', late: false, today: false };
  if (days <= 7) return { label: `due in ${String(days)} days`, late: false, today: false };

  return {
    label: `due ${due.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`,
    late: false,
    today: false,
  };
}

/** The full date, for the tooltip. Relative time is not enough to book against. */
export function exactDue(dueAt: string | null): string {
  if (dueAt === null || dueAt === '') return '';
  const due = new Date(dueAt);
  return Number.isNaN(due.getTime()) ? '' : due.toLocaleString();
}

/**
 * What wrote this, in words rather than an id.
 *
 * The one fact this board has that a list of tasks does not: some of these were
 * left by an agent. A run id is not something to show a person, but "left by an
 * automation" is.
 */
export function describeSource(source: string): string {
  if (source === 'user' || source === '') return '';
  if (source === 'assistant') return 'left by the assistant';
  return 'left by an automation';
}
