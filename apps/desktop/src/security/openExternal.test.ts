import test from 'node:test';
import assert from 'node:assert/strict';
import { isOpenable } from './openExternal.ts';

// The gate on "open the user's browser at this URL". Every URL that reaches it
// came out of an API response body, so the list of destinations is the whole
// of the defence.

test('Composio’s own sign-in link opens', () => {
  // The real shape, verified against the live API: every toolkit's `authorize`
  // answers with this host.
  assert.ok(isOpenable('https://connect.composio.dev/link/lk_evA5PT0ryfR8'));
});

test('a host nobody named does not open', () => {
  assert.equal(isOpenable('https://connect.composio.dev.evil.test/link/x'), false);
  assert.equal(isOpenable('https://example.com/'), false);
  assert.equal(isOpenable('https://logos.composio.dev/gmail.png'), false);
});

test('anything that is not https does not open', () => {
  // `file:` and `javascript:` are the two that matter: one reaches the user's
  // disk through their file manager, the other is a script URL.
  assert.equal(isOpenable('http://connect.composio.dev/link/x'), false);
  assert.equal(isOpenable('file:///etc/passwd'), false);
  assert.equal(isOpenable('javascript:alert(1)'), false);
});

test('something that is not a URL at all is refused rather than thrown on', () => {
  assert.equal(isOpenable(''), false);
  assert.equal(isOpenable('connect.composio.dev'), false);
});
