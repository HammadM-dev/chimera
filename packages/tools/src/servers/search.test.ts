import test from 'node:test';
import assert from 'node:assert/strict';
import { createSearchServer, unwrapBing } from './search.ts';
import { connectInProcess } from '../mcpClient.ts';

// No network (CLAUDE.md: "never hit a real API in CI"). The markup below is
// trimmed from what the real engines returned, keeping the trap each one has.

function respond(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/html' } });
}

// Both engines put the grey breadcrumb link *before* the title link. Reading
// the first anchor gave every result a title of its own URL — and on Mojeek,
// where the guard against that threw the block away, gave no results at all.
const BING = `
<ol>
<li class="b_algo"><div class="b_tpcn"><a href="https://www.bing.com/ck/a?!&&u=a1aHR0cHM6Ly9leGFtcGxlLmNvbS9yYXRlcw">example.com › rates</a></div>
<h2><a href="https://www.bing.com/ck/a?!&&u=a1aHR0cHM6Ly9leGFtcGxlLmNvbS9yYXRlcw">Rates for 2026</a></h2>
<p>The rate is 3.75%.</p></li>
</ol>`;

const MOJEEK = `
<ul class="results-standard">
<li class="r1"><a title="https://example.org/a" href="https://example.org/a" class="ob"><p class="i"><span class="url">https://example.org &rsaquo; a</span></p></a><h2><a class="title" href="https://example.org/a">A real title</a></h2><p class="s">A real <strong>snippet</strong>.</p></li>
</ul>`;

async function search(
  responses: (url: string) => Response,
  args: Record<string, unknown> = { query: 'rates' },
  options: Record<string, unknown> = {},
) {
  const calls: string[] = [];
  const client = await connectInProcess(
    createSearchServer({
      ...options,
      transport: (url: string) => {
        calls.push(url);
        return Promise.resolve(responses(url));
      },
    }),
  );
  const result = await client.callTool('web', args);
  return { result, calls };
}

test('a result carries its title, its real link, and its snippet', async () => {
  const { result } = await search(() => respond(BING));

  assert.equal(result.isError, false);
  assert.match(result.text, /Rates for 2026/);
  // Un-wrapped: left as bing.com/ck/a, the agent's next fetch reads a redirect
  // page and learns nothing.
  assert.match(result.text, /https:\/\/example\.com\/rates/);
  assert.equal(result.text.includes('bing.com/ck'), false);
  assert.match(result.text, /The rate is 3\.75%/);
  // And never the breadcrumb as a title.
  assert.equal(result.text.includes('example.com › rates'), false);
});

test('an engine that answers with nothing is passed over, not reported as an empty web', async () => {
  // What a captcha page looks like from here: HTTP 200, no results in it.
  const { result, calls } = await search((url) =>
    url.includes('bing') ? respond('<html>Captcha</html>') : respond(MOJEEK),
  );

  assert.equal(result.isError, false);
  assert.match(result.text, /A real title/);
  assert.equal(calls.length, 2, 'the second engine should have been tried');
});

test('when no engine answers, it says so rather than saying there is nothing', async () => {
  const { result } = await search(() => respond('<html>Captcha</html>'));

  assert.equal(result.isError, true);
  assert.match(result.text, /No search engine answered/);
  // Named, so the trace shows which ones were tried and why each was no good.
  assert.match(result.text, /bing/);
  assert.match(result.text, /duckduckgo/);
});

test('a query keeps its words', async () => {
  // `%20` reads as a single-word query to Bing: "best selling electric car UK
  // 2026" came back as definitions of the word "best".
  const { calls } = await search(() => respond(BING), { query: 'uk base rate 2026' });

  assert.match(calls[0] ?? '', /q=uk\+base\+rate\+2026/);
  assert.equal((calls[0] ?? '').includes('%20'), false);
});

test('a configured search API is used first, and its key stays in the header', async () => {
  const seen: RequestInit[] = [];
  const client = await connectInProcess(
    createSearchServer({
      provider: 'brave',
      apiKey: 'sk-secret-value',
      transport: (url: string, init: RequestInit) => {
        seen.push(init);
        return Promise.resolve(
          new Response(
            JSON.stringify({
              web: {
                results: [{ title: 'Keyed', url: 'https://example.net/x', description: 'd' }],
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        );
      },
    }),
  );

  const result = await client.callTool('web', { query: 'rates' });
  assert.match(result.text, /Keyed/);
  assert.match(result.text, /via brave/);
  assert.equal(seen.length, 1, 'the scraped engines should not have been reached');
  assert.equal(result.text.includes('sk-secret-value'), false);
});

test('a search API that refuses falls back, and does not quote the request back', async () => {
  const { result } = await search(
    (url) =>
      url.includes('brave')
        ? // A rejected search API echoes the request — which carries the key.
          respond('{"error":"bad token sk-secret-value"}', 401)
        : respond(BING),
    { query: 'rates' },
    { provider: 'brave', apiKey: 'sk-secret-value' },
  );

  assert.match(result.text, /Rates for 2026/);
  assert.equal(result.text.includes('sk-secret-value'), false);
});

test('search is refused when the automation is locked to named sites', async () => {
  const { result, calls } = await search(
    () => respond(BING),
    { query: 'rates' },
    {
      egressMode: 'allowlist',
    },
  );

  assert.equal(result.isError, true);
  assert.equal(calls.length, 0, 'nothing should leave the machine');
  assert.match(result.text, /may only reach the sites it names/);
});

test('an empty query is refused before anything leaves', async () => {
  const { result, calls } = await search(() => respond(BING), { query: '   ' });

  assert.equal(result.isError, true);
  assert.equal(calls.length, 0);
});

test('a bing redirect that is not one is left alone', () => {
  assert.equal(unwrapBing('https://example.com/a'), 'https://example.com/a');
  // Malformed base64 is not a reason to hand back nothing.
  assert.equal(
    unwrapBing('https://www.bing.com/ck/a?u=a1!!!'),
    'https://www.bing.com/ck/a?u=a1!!!',
  );
});

test('the built-in search says it is the built-in search', async () => {
  // Measured live from a datacentre address: "os2museum Athlon" came back with
  // three results for an adult dating site. An agent told these are reliable
  // goes and reads one.
  const { result } = await search(() => respond(BING));
  assert.match(result.text, /not always accurate/);

  const keyed = await search(
    (url) =>
      url.includes('brave')
        ? new Response(
            JSON.stringify({ web: { results: [{ title: 'K', url: 'https://e.net/x' }] } }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        : respond(BING),
    { query: 'rates' },
    { provider: 'brave', apiKey: 'k' },
  );
  assert.equal(keyed.result.text.includes('not always accurate'), false);
});
