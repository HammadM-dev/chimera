# chimera-stats

The endpoint CHIMERA copies report to, and the numbers you show a sponsor.

Deliberately separate from the app. It shares no code with CHIMERA, and CHIMERA
depends on it for nothing — if this is down, every user's day is unaffected.

## What it can and cannot tell you

It can tell you how many copies ran today, this week and this month, which
versions and platforms they were, and how many times a release has been
downloaded.

It cannot tell you who anybody is. There is no user table, because there are no
users here. An install id is a UUID a copy of CHIMERA generated about itself; it
is not derived from a machine id, a hostname, an email or anything else, so it
joins to nothing. Names, automations, prompts, files and API keys never leave
the user's machine and are not stored here in any form. The table keeps a date,
never a time, because a finer timestamp is a trace of one person's working
hours.

That is the deal the setup screen makes with the user, and it is enforced by
this schema rather than promised by it.

## Checking it

```sh
npm run typecheck:stats
```

The D1 and fetch types it needs are declared in `types.d.ts` rather than pulled
from `@cloudflare/workers-types`: four methods do not justify a dependency, and
this keeps the directory buildable with nothing installed. If the declaration
drifts from the real API, `wrangler deploy` is where you find out — which is the
right place, since it is the only thing that runs this code.

## Setting it up

You need a free Cloudflare account. No card.

```sh
npm install -g wrangler
wrangler login

cd stats
wrangler d1 create chimera-stats          # paste the id it prints into wrangler.toml
wrangler d1 execute chimera-stats --remote --file=./schema.sql

# The password for reading your own numbers. Invent a long one.
wrangler secret put STATS_TOKEN

wrangler deploy
```

`wrangler deploy` prints a URL like `https://chimera-stats.<you>.workers.dev`.

## Pointing the app at it

The endpoint is compiled in at build time, so a user cannot be redirected to
somebody else's collector by editing a settings file:

```sh
CHIMERA_USAGE_ENDPOINT=https://chimera-stats.<you>.workers.dev/ping \
  npm run build --workspace @chimera/desktop
```

Left unset — which is what a local development build does — nothing is ever
sent, whatever the user's setting says.

## Reading the numbers

```sh
curl -H "Authorization: Bearer $STATS_TOKEN" \
  https://chimera-stats.<you>.workers.dev/stats
```

```json
{
  "activeToday": 317,
  "activeThisWeek": 902,
  "activeThisMonth": 1284,
  "installsEverSeen": 2140,
  "downloads": 4902,
  "byVersion": [{ "version": "0.1.1", "n": 1103 }],
  "byPlatform": [{ "platform": "win32", "n": 811 }],
  "daily": [{ "day": "2026-08-24", "n": 317 }]
}
```

`downloads` is read live from the GitHub releases API and counts every asset of
every release, so it needs no storage here and cannot be inflated by this
service. It reads `GITHUB_REPO` in `wrangler.toml`.

## The numbers a sponsor will ask about

`activeThisMonth` is the one to quote: distinct installs that reported in the
last thirty days. `installsEverSeen` is larger and means less — it includes
every copy that ever ran once. Quoting the second as though it were the first is
the standard way these numbers become untrustworthy, and the reason both are
reported separately here rather than as one flattering total.
