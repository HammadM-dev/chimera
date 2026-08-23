import test from 'node:test';
import assert from 'node:assert/strict';
import { KNOWN_TOOL_IDS } from '@chimera/tools';
import { BUILT_IN_TOOL_IDS } from './service.ts';

// The list a person picks from, against the list the build actually ships.
//
// They are two hand-maintained copies of one fact, and they had drifted:
// `browser.html` and `search.web` both existed, were both registered for every
// run, and could not be granted to an agent by anybody using the editor. There
// was no symptom — the tool simply was not on screen — and the only way to
// notice was to go looking for something you had already built.

/**
 * Mail is the one exception, and it is a deliberate one.
 *
 * A mailbox is registered under its own server id — `email-<account>.send` —
 * so an agent is granted one account rather than "email", the alternative being
 * an agent told to handle support mail that can also send from the founder's
 * personal address. The bare `email.*` ids exist only for reversibility
 * classification and are never a tool anybody calls.
 */
const perAccount = (id: string): boolean => id.startsWith('email');

test('every tool this build ships can be granted in the agent editor', () => {
  const offered = new Set(BUILT_IN_TOOL_IDS);
  const missing = KNOWN_TOOL_IDS.filter((id) => !offered.has(id) && !perAccount(id));

  assert.deepEqual(
    missing,
    [],
    `these tools exist and cannot be granted: ${missing.join(', ')}. Add them to BUILT_IN_TOOLS.`,
  );
});

test('the editor offers nothing this build does not ship', () => {
  const shipped = new Set(KNOWN_TOOL_IDS);
  const phantom = BUILT_IN_TOOL_IDS.filter((id) => !shipped.has(id) && !perAccount(id));

  assert.deepEqual(phantom, [], `the editor offers tools that do not exist: ${phantom.join(', ')}`);
});
