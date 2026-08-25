import test from 'node:test';
import assert from 'node:assert/strict';
import { refusalFor } from './service.ts';

// The per-step app limit, as arithmetic.
//
// This is the last check before a Composio tool runs for real, on a step
// somebody narrowed to particular apps. It is tested here rather than through
// the app because there is no IPC channel that executes a Composio tool and
// there must not be one — CLAUDE.md's first hard rule is that every tool call
// goes through the Governor, and a channel added around it to make a test
// convenient would be exactly the bypass that forbids.

test('a step nobody narrowed may run anything', () => {
  // Every automation saved before the app choice existed.
  assert.equal(refusalFor([], 'GMAIL_SEND_EMAIL', 'gmail'), '');
});

test('a step narrowed to an app may run that app’s tools', () => {
  assert.equal(refusalFor(['gmail'], 'GMAIL_SEND_EMAIL', 'gmail'), '');
  assert.equal(refusalFor(['gmail', 'notion'], 'NOTION_CREATE_PAGE', 'notion'), '');
});

test('a step narrowed to one app is refused another app’s tool, and told which', () => {
  const refusal = refusalFor(['notion'], 'GMAIL_SEND_EMAIL', 'gmail');
  assert.notEqual(refusal, '');
  // Named both ways round: an agent that is only told "no" tries again.
  assert.match(refusal, /cannot run a gmail tool/);
  assert.match(refusal, /connected to notion/);
});

test('a slug Composio has never heard of is refused rather than attempted', () => {
  // Fails closed, which is the case this exists for. An agent that invents a
  // slug must not have it forwarded on the chance that it is real.
  const refusal = refusalFor(['notion'], 'NOTION_MADE_THIS_UP', '');
  assert.match(refusal, /no Composio tool called "NOTION_MADE_THIS_UP"/);
});

test('the comparison ignores case, which is the shape these two arrive in', () => {
  // The scope comes from a step's settings, where the user picked from a list
  // of slugs; the toolkit comes back from Composio. Both are lower case today
  // and neither promises to stay that way.
  assert.equal(refusalFor(['Gmail'], 'GMAIL_SEND_EMAIL', 'gmail'), '');
  assert.equal(refusalFor(['gmail'], 'GMAIL_SEND_EMAIL', 'GMAIL'), '');
});

test('a prefix is not a match', () => {
  // The whole reason the toolkit is asked for rather than read off the slug.
  // `ZOHO_MAIL_MESSAGES_SEND_EMAIL` starts with `ZOHO_`, and twenty-five pairs
  // in Composio's catalogue collide this way.
  assert.notEqual(refusalFor(['zoho'], 'ZOHO_MAIL_MESSAGES_SEND_EMAIL', 'zoho_mail'), '');
  assert.equal(refusalFor(['zoho_mail'], 'ZOHO_MAIL_MESSAGES_SEND_EMAIL', 'zoho_mail'), '');
});
