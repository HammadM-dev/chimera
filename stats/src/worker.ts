// The endpoint CHIMERA copies report to, and the page Hammad reads.
//
// A separate deployment from the app on purpose: it is the one place that holds
// anything about anybody else's use of CHIMERA, and it holds as little as a
// counter can. It shares no code with the app, and the app depends on it for
// nothing — an outage here is invisible to every user.
//
// Two routes.
//   POST /ping   — a copy saying it is running. Public, unauthenticated, and
//                  cheap to abuse; see the notes on that below.
//   GET  /stats  — the numbers. Behind a token, because they are commercial
//                  information rather than a secret about anyone.

import { renderDashboard, type DashboardData } from './dashboard.ts';

export interface Env {
  DB: D1Database;
  /** Set with `wrangler secret put STATS_TOKEN`. Never in the repository. */
  STATS_TOKEN: string;
  /** e.g. "HammadM-dev/chimera". Download counts are read from the public API. */
  GITHUB_REPO?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Short, and checked, because everything here is written by a stranger. */
function clean(value: unknown, max = 32): string {
  return typeof value === 'string' ? value.slice(0, max).replace(/[^\w.:+-]/g, '') : '';
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

async function handlePing(request: Request, env: Env): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response('bad json', { status: 400 });
  }

  const record = (body ?? {}) as Record<string, unknown>;
  const installId = clean(record['installId'], 36);
  // A malformed id is dropped rather than stored. The alternative is a table
  // that fills with whatever anybody felt like posting, and a count nobody can
  // defend when a sponsor asks how it was arrived at.
  if (!UUID.test(installId)) return new Response('bad install id', { status: 400 });

  await env.DB.prepare(
    `INSERT INTO pings (install_id, day, version, platform, arch)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (install_id, day) DO UPDATE SET version = excluded.version`,
  )
    .bind(
      installId,
      today(),
      clean(record['version']),
      clean(record['platform']),
      clean(record['arch']),
    )
    .run();

  // No body. Nothing here is worth a round trip of information back to a copy
  // that is only saying hello.
  return new Response(null, { status: 204 });
}

async function downloads(env: Env): Promise<{ total: number; note: string }> {
  const repo = env.GITHUB_REPO ?? '';
  if (repo === '') return { total: 0, note: 'set GITHUB_REPO to count downloads' };
  try {
    const response = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=100`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'chimera-stats' },
    });
    if (!response.ok) return { total: 0, note: `GitHub returned ${String(response.status)}` };
    const releases = (await response.json()) as { assets?: { download_count?: number }[] }[];
    const total = releases.reduce(
      (sum, release) =>
        sum +
        (release.assets ?? []).reduce((inner, asset) => inner + (asset.download_count ?? 0), 0),
      0,
    );
    return { total, note: '' };
  } catch {
    return { total: 0, note: 'GitHub was unreachable' };
  }
}

async function handleStats(env: Env): Promise<Response> {
  const day = today();
  const since = (days: number): string =>
    new Date(Date.parse(day) - days * 86_400_000).toISOString().slice(0, 10);

  const counts = await env.DB.batch([
    env.DB.prepare('SELECT COUNT(DISTINCT install_id) AS n FROM pings WHERE day = ?').bind(day),
    env.DB.prepare('SELECT COUNT(DISTINCT install_id) AS n FROM pings WHERE day >= ?').bind(
      since(7),
    ),
    env.DB.prepare('SELECT COUNT(DISTINCT install_id) AS n FROM pings WHERE day >= ?').bind(
      since(30),
    ),
    env.DB.prepare('SELECT COUNT(DISTINCT install_id) AS n FROM pings'),
  ]);

  const number = (index: number): number =>
    Number((counts[index]?.results?.[0] as { n?: number } | undefined)?.n ?? 0);

  const byVersion = await env.DB.prepare(
    `SELECT version, COUNT(DISTINCT install_id) AS n FROM pings
     WHERE day >= ? GROUP BY version ORDER BY n DESC LIMIT 10`,
  )
    .bind(since(30))
    .all();

  const byPlatform = await env.DB.prepare(
    `SELECT platform, COUNT(DISTINCT install_id) AS n FROM pings
     WHERE day >= ? GROUP BY platform ORDER BY n DESC`,
  )
    .bind(since(30))
    .all();

  const daily = await env.DB.prepare(
    `SELECT day, COUNT(DISTINCT install_id) AS n FROM pings
     WHERE day >= ? GROUP BY day ORDER BY day`,
  )
    .bind(since(30))
    .all();

  // How many of each week's new installs are still running later.
  //
  // A first appearance is the earliest day an install id was ever seen, which
  // the pings table already knows without a column for it. Retention is the
  // number worth leading with: it says whether the thing is worth keeping, and
  // its shape is far harder to invent convincingly than a total.
  const retention = await env.DB.prepare(
    `WITH first AS (
       SELECT install_id, MIN(day) AS started FROM pings GROUP BY install_id
     )
     SELECT
       DATE(first.started, 'weekday 0', '-6 days') AS cohort,
       COUNT(DISTINCT first.install_id) AS size,
       COUNT(DISTINCT CASE WHEN later.day >= DATE(first.started, '+7 days')
                           THEN first.install_id END) AS day7,
       COUNT(DISTINCT CASE WHEN later.day >= DATE(first.started, '+30 days')
                           THEN first.install_id END) AS day30
     FROM first
     LEFT JOIN pings AS later ON later.install_id = first.install_id
     GROUP BY cohort
     ORDER BY cohort DESC
     LIMIT 8`,
  ).all();

  const newThisMonth = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM (
       SELECT install_id FROM pings GROUP BY install_id HAVING MIN(day) >= ?
     )`,
  )
    .bind(since(30))
    .first<{ n: number }>();

  const download = await downloads(env);

  return Response.json({
    activeToday: number(0),
    activeThisWeek: number(1),
    activeThisMonth: number(2),
    installsEverSeen: number(3),
    newThisMonth: newThisMonth?.n ?? 0,
    retention: retention.results ?? [],
    downloads: download.total,
    downloadsNote: download.note,
    byVersion: byVersion.results,
    byPlatform: byPlatform.results,
    daily: daily.results,
    generatedAt: new Date().toISOString(),
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/ping') {
      return handlePing(request, env);
    }

    // The page. Basic auth rather than a bearer token, because a browser can be
    // prompted for Basic and cannot be asked for a header from the address bar.
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/dashboard')) {
      const offered = request.headers.get('authorization') ?? '';
      const expected = `Basic ${btoa(`chimera:${env.STATS_TOKEN}`)}`;
      if (env.STATS_TOKEN === '' || offered !== expected) {
        return new Response('unauthorised', {
          status: 401,
          headers: { 'www-authenticate': 'Basic realm="CHIMERA stats"' },
        });
      }
      const stats = await handleStats(env);
      const data = (await stats.json()) as DashboardData;
      return new Response(renderDashboard(data), {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }

    if (request.method === 'GET' && url.pathname === '/stats') {
      // A bearer token, compared in full. These are not secrets about a person
      // — they are business numbers — but they are nobody else's business
      // either, and an open endpoint is one a competitor scrapes daily.
      const offered = (request.headers.get('authorization') ?? '').replace(/^Bearer /i, '');
      if (env.STATS_TOKEN === '' || offered !== env.STATS_TOKEN) {
        return new Response('unauthorised', { status: 401 });
      }
      return handleStats(env);
    }

    return new Response('not found', { status: 404 });
  },
};
