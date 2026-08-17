// A five-field cron parser, and the next time an expression fires.
//
// Written rather than depended on: CLAUDE.md requires asking before adding a
// dependency, and this is the whole of what a scheduler needs — minute, hour,
// day of month, month, day of week, with `*`, lists, ranges and steps. What is
// deliberately not supported is the extended vocabulary (`@yearly`, `L`, `W`,
// `#`, seconds fields, timezones-in-expression): each is a thing a user could
// write that behaves differently in every implementation, and a scheduler that
// silently misreads one fires at the wrong time forever.

export interface CronFields {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
  /** True when both day fields are restricted — cron's one genuine oddity. */
  bothDaysRestricted: boolean;
}

export interface CronParseResult {
  fields: CronFields | null;
  /** Why it could not be read, in words a user can act on. */
  problem: string;
}

const RANGES: Record<string, { min: number; max: number }> = {
  minutes: { min: 0, max: 59 },
  hours: { min: 0, max: 23 },
  daysOfMonth: { min: 1, max: 31 },
  months: { min: 1, max: 12 },
  // 7 is allowed on the way in and normalised to 0 below: Sunday is written
  // both ways, and refusing one of them would refuse expressions people have
  // been pasting out of crontabs for thirty years.
  daysOfWeek: { min: 0, max: 7 },
};

const NAMED_MONTHS = [
  'jan',
  'feb',
  'mar',
  'apr',
  'may',
  'jun',
  'jul',
  'aug',
  'sep',
  'oct',
  'nov',
  'dec',
];
const NAMED_DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function nameToNumber(token: string, field: string): string {
  const lower = token.toLowerCase();
  if (field === 'months') {
    const index = NAMED_MONTHS.indexOf(lower);
    return index === -1 ? token : String(index + 1);
  }
  if (field === 'daysOfWeek') {
    const index = NAMED_DAYS.indexOf(lower);
    return index === -1 ? token : String(index);
  }
  return token;
}

// One field: a star, a number, a range like 1-4, a step like star-slash-15 or
// 1-9/2, or a comma-separated list of those. Written out in words because the
// step syntax closes a block comment if you write it literally.
function parseField(raw: string, field: keyof typeof RANGES): Set<number> | null {
  const { min, max } = RANGES[field] ?? { min: 0, max: 0 };
  const values = new Set<number>();

  for (const part of raw.split(',')) {
    const [spec, stepText] = part.split('/');
    if (spec === undefined || spec === '') return null;

    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) return null;

    let from = min;
    let to = max;
    if (spec !== '*') {
      const [startText, endText] = spec.split('-');
      const start = Number(nameToNumber(startText ?? '', field));
      if (!Number.isInteger(start)) return null;
      from = start;
      to = endText === undefined ? start : Number(nameToNumber(endText, field));
      if (!Number.isInteger(to)) return null;
      // A range with a step counts from the start of the range, not of the
      // field: `1-9/2` is 1,3,5,7,9.
      if (stepText !== undefined && endText === undefined) to = max;
    }

    if (from < min || to > max || from > to) return null;
    for (let value = from; value <= to; value += step) values.add(value);
  }

  // Sunday is both 0 and 7 in every cron anybody has used.
  if (field === 'daysOfWeek' && values.has(7)) values.add(0);
  return values.size === 0 ? null : values;
}

export function parseCron(expression: string): CronParseResult {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    return {
      fields: null,
      problem: `A schedule has five parts — minute, hour, day of month, month, day of week. "${expression}" has ${String(parts.length)}.`,
    };
  }

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
  const minutes = parseField(minute ?? '', 'minutes');
  const hours = parseField(hour ?? '', 'hours');
  const daysOfMonth = parseField(dayOfMonth ?? '', 'daysOfMonth');
  const months = parseField(month ?? '', 'months');
  const daysOfWeek = parseField(dayOfWeek ?? '', 'daysOfWeek');

  if (!minutes || !hours || !daysOfMonth || !months || !daysOfWeek) {
    return {
      fields: null,
      problem: `"${expression}" is not a schedule this build can read. Use numbers, ranges like 9-17, steps like */15, or lists like 1,15.`,
    };
  }

  return {
    fields: {
      minutes,
      hours,
      daysOfMonth,
      months,
      daysOfWeek,
      // Cron's one genuine oddity, and it is worth being explicit about:
      // when *both* day fields are restricted, a match on *either* fires.
      // `0 9 13 * 5` is "the 13th, and every Friday", not "Friday the 13th".
      bothDaysRestricted: (dayOfMonth ?? '*') !== '*' && (dayOfWeek ?? '*') !== '*',
    },
    problem: '',
  };
}

/**
 * The next minute at or after `from` that this expression fires.
 *
 * Minute by minute rather than by arithmetic on each field: a year of minutes
 * is half a million iterations at worst, it takes microseconds, and it is
 * obviously correct — where field arithmetic across month boundaries and
 * daylight-saving shifts is where every scheduler bug lives.
 *
 * Null when nothing matches within a year, which means an impossible date like
 * the 31st of February. A schedule that never fires is a fact the user needs
 * told, not a silent no-op.
 */
export function nextFireAfter(fields: CronFields, from: Date): Date | null {
  const candidate = new Date(from.getTime());
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);

  const limit = new Date(from.getTime());
  limit.setFullYear(limit.getFullYear() + 1);

  while (candidate.getTime() <= limit.getTime()) {
    const matchesDayOfMonth = fields.daysOfMonth.has(candidate.getDate());
    const matchesDayOfWeek = fields.daysOfWeek.has(candidate.getDay());
    const dayMatches = fields.bothDaysRestricted
      ? matchesDayOfMonth || matchesDayOfWeek
      : matchesDayOfMonth && matchesDayOfWeek;

    if (
      fields.minutes.has(candidate.getMinutes()) &&
      fields.hours.has(candidate.getHours()) &&
      fields.months.has(candidate.getMonth() + 1) &&
      dayMatches
    ) {
      return candidate;
    }

    candidate.setMinutes(candidate.getMinutes() + 1);
  }

  return null;
}

/**
 * Whether this expression fired during the minute that just ended.
 *
 * The question a ticker actually asks, and it is asked this way — "would it
 * have fired since a minute ago" — rather than by storing the next fire time.
 * A stored next-fire is lost when the app restarts, and for a nightly job that
 * means missing a night without anything looking wrong.
 */
export function firedInLastMinute(fields: CronFields, now: Date): boolean {
  const next = nextFireAfter(fields, new Date(now.getTime() - 60_000));
  return next !== null && next.getTime() <= now.getTime();
}

/** What a schedule says, in a sentence, for the UI. */
export function describeCron(expression: string): string {
  const { fields, problem } = parseCron(expression);
  if (!fields) return problem;

  const every = (set: Set<number>, size: number) => set.size === size;
  if (every(fields.minutes, 60)) return 'Every minute';
  if (
    fields.minutes.size === 1 &&
    every(fields.hours, 24) &&
    every(fields.daysOfMonth, 31) &&
    every(fields.months, 12) &&
    every(fields.daysOfWeek, 7)
  ) {
    return 'Every hour';
  }

  const next = nextFireAfter(fields, new Date());
  return next === null ? 'Never — no date matches this' : `Next at ${next.toLocaleString()}`;
}
