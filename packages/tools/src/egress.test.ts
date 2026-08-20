import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolExecutionError } from '@chimera/errors';
import { assertEgressAllowed, assertResolvesPublic, isPrivateHost } from './servers/http.ts';
import { htmlToText } from './html.ts';

// How far an automation may reach.
//
// The rule used to be one list: named hosts or nothing, which made the agent
// whose whole job is reading sources useless until somebody guessed the right
// domains in advance. The split that replaces it is the point of this file —
// reading the web and sending data out of it are not the same permission.

const refused = (err: unknown): boolean => err instanceof ToolExecutionError;

test('browse mode reads any public site without being told about it first', () => {
  const url = assertEgressAllowed('https://catalog.data.gov/dataset', [], 'browse', 'GET');
  assert.equal(url.hostname, 'catalog.data.gov');
});

test('browse mode refuses to send anywhere it was not told about', () => {
  // The half that matters. An agent that has read a mailbox and can POST
  // anywhere is an exfiltration path, and a hostile page will try to use it.
  assert.throws(
    () => assertEgressAllowed('https://attacker.example/collect', [], 'browse', 'POST'),
    refused,
  );
  for (const method of ['PUT', 'PATCH', 'DELETE']) {
    assert.throws(
      () => assertEgressAllowed('https://attacker.example/collect', [], 'browse', method),
      refused,
    );
  }
});

test('a named site can be sent to, in browse mode', () => {
  const url = assertEgressAllowed(
    'https://api.mycrm.test/leads',
    ['api.mycrm.test'],
    'browse',
    'POST',
  );
  assert.equal(url.hostname, 'api.mycrm.test');
});

test('browsing cannot reach inside the machine or its network', () => {
  // The classic turn: an outward-looking fetch pointed inward. A cloud
  // instance's metadata endpoint is the one that costs somebody their keys.
  for (const address of [
    'http://169.254.169.254/latest/meta-data/',
    'http://192.168.0.1/admin',
    'http://127.0.0.1:8080/',
    'http://localhost:3000/',
    'http://10.0.0.5/',
    'http://172.16.4.1/',
  ]) {
    assert.throws(() => assertEgressAllowed(address, [], 'browse', 'GET'), refused, address);
  }
});

test('a private address that was named on purpose is still allowed', () => {
  // Somebody typing 127.0.0.1 into the allowed sites means it. Wandering into
  // it is what is refused.
  const url = assertEgressAllowed('http://127.0.0.1:8080/api', ['127.0.0.1'], 'browse', 'POST');
  assert.equal(url.port, '8080');
});

test('allowlist mode is unchanged: named hosts or nothing', () => {
  assert.throws(() => assertEgressAllowed('https://example.com', [], 'allowlist', 'GET'), refused);
  const url = assertEgressAllowed('https://example.com', ['example.com'], 'allowlist', 'GET');
  assert.equal(url.hostname, 'example.com');
});

test('open mode sends anywhere public, and still not inside the network', () => {
  const url = assertEgressAllowed('https://anything.example/submit', [], 'open', 'POST');
  assert.equal(url.hostname, 'anything.example');
  assert.throws(() => assertEgressAllowed('http://169.254.169.254/', [], 'open', 'GET'), refused);
});

test('the refusal says what to do rather than inviting another guess', () => {
  try {
    assertEgressAllowed('https://attacker.example/collect', ['api.mycrm.test'], 'browse', 'POST');
    assert.fail('should have been refused');
  } catch (err) {
    const message = (err as Error).message;
    assert.match(message, /may only send/);
    assert.match(message, /api\.mycrm\.test/);
  }
});

test('every spelling of a private address is refused, not just the plain one', () => {
  // A background security review found these. WHATWG parsing normalises the
  // decimal, octal and hex forms of an IPv4 address, so those arrive here
  // already dotted — but IPv6 arrives bracketed, and an IPv4 address can be
  // written inside one. `[::ffff:169.254.169.254]` is the cloud metadata
  // endpoint wearing an IPv6 hat, and the first version of this check waved it
  // through.
  const hostOf = (url: string): string => new URL(url).hostname;

  for (const url of [
    'http://[::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:169.254.169.254]/',
    'http://[fe80::1]/',
    'http://[fd00::1]/',
    'http://2130706433/',
    'http://0177.0.0.1/',
    'http://0x7f000001/',
    'http://127.1/',
    'http://100.64.0.1/',
    'http://169.254.169.254/latest/meta-data/',
  ]) {
    assert.equal(isPrivateHost(hostOf(url)), true, url);
  }

  // And the public internet is still the public internet.
  for (const url of ['https://example.com/', 'https://8.8.8.8/', 'https://[2606:4700::1111]/']) {
    assert.equal(isPrivateHost(hostOf(url)), false, url);
  }
});

test('a name that resolves somewhere private is refused, however it is spelt', async () => {
  // The other half: an ordinary public hostname whose A record points inside.
  // localhost is the one name that reliably resolves that way on any machine.
  await assert.rejects(() => assertResolvesPublic('localhost'), refused);

  // A name that does not resolve is left to fail on its own terms rather than
  // being turned into a refusal that says the wrong thing.
  await assertResolvesPublic('nothing-here-9f2c.invalid');
});

test('private-address detection covers the ranges and leaves public ones alone', () => {
  for (const host of ['localhost', '127.0.0.1', '10.1.2.3', '192.168.1.1', '169.254.1.1', '::1']) {
    assert.equal(isPrivateHost(host), true, host);
  }
  for (const host of ['example.com', '8.8.8.8', '172.32.0.1', '11.0.0.1']) {
    assert.equal(isPrivateHost(host), false, host);
  }
});

test('a page arrives as what it says, not as what it is made of', () => {
  const page = [
    '<html><head><style>.a{color:red}</style><script>var x=1</script></head>',
    '<body><h1>Renewal</h1><p>The agreement renews on 28 February 2027.</p>',
    '<ul><li>INV-1001</li><li>INV-1044</li></ul>',
    '<p>Notice is 90&nbsp;days.</p></body></html>',
  ].join('');

  const text = htmlToText(page);
  assert.match(text, /Renewal/);
  assert.match(text, /28 February 2027/);
  assert.match(text, /- INV-1044/);
  assert.match(text, /90 days/);
  // The markup, the script and the styling are gone.
  assert.doesNotMatch(text, /<[a-z]/i);
  assert.doesNotMatch(text, /color:red/);
  assert.doesNotMatch(text, /var x/);
  assert.ok(text.length < page.length / 2, 'should be substantially smaller than the markup');
});
