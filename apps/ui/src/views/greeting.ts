// What the home screen says at the top, and when.

/**
 * The right greeting for the hour, on the clock in front of the person.
 *
 * `new Date().getHours()` is the local hour on their machine, which is the only
 * hour that matters here — somebody starting at six in the morning in Karachi
 * should not be wished good evening because a server is in California.
 *
 * Five bands rather than three. "Good evening" at one in the morning is wrong
 * in a way people notice, and it was wrong for a third of the day: everything
 * from six in the evening to midnight and everything from midnight to five got
 * the same line.
 */
export function greeting(hour: number): string {
  if (hour < 5) return 'Still up';
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  if (hour < 22) return 'Good evening';
  return 'Working late';
}

/**
 * The greeting with a name on it, when there is one.
 *
 * A trailing comma before a name that is not there reads as a mistake, so the
 * comma belongs to the name rather than to the greeting.
 */
export function greetingFor(hour: number, firstName: string): string {
  const name = firstName.trim();
  return name === '' ? greeting(hour) : `${greeting(hour)}, ${name}`;
}
