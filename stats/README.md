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

Open the worker's URL in a browser. It asks for a username and password: the
username is `chimera`, the password is your `STATS_TOKEN`.

The page shows active installs today, this week and this month; new installs
this month; installs ever seen; total downloads; a thirty-day chart of daily
actives; retention by weekly cohort; and a breakdown by version and platform.

The same figures as JSON, for anything that needs to read them programmatically:

```sh
curl -H "Authorization: Bearer $STATS_TOKEN" https://chimera-stats.<you>.workers.dev/stats
```

## Can users see any of this?

No. `/stats` and the dashboard both require the token, and nothing in the app
can reach either — CHIMERA only ever calls `/ping`, which returns `204` and no
body. A user can see that their own copy pings, because the setup screen says
so and the Providers panel repeats it, and they can switch it off. They cannot
read anyone's numbers, including their own, and there is nothing to read: their
install id is a UUID that means nothing on its own.

## Proving the numbers to somebody

Be straight about which figures are strong and which are not; the difference is
about who controls them, and anybody doing diligence will ask.

**Downloads are the strong ones.** They come from the GitHub releases API. An
investor can read them without asking you, and you cannot change them. Lead
with these.

**Retention is the one worth knowing.** The share of each week's new installs
still running at day 7 and day 30. It is what a serious investor asks for
anyway, and its shape is far harder to invent convincingly than a total.

**Active-install counts are the weak ones, and here is why.** `/ping` is public
and unauthenticated. It has to be: a desktop app cannot hold a secret, so any
credential shipped inside it can be read out of the binary by anybody who cares
to. That means the count is trustworthy exactly to the extent that nobody has
posted to the endpoint who is not running the app — which is true today and is
not something this service can prove. Cloudflare rate-limiting rules on `/ping`
raise the cost of abuse and do not change the argument.

Anyone experienced will know this about *any* self-reported telemetry, yours or
a competitor's. Saying it first is worth more than being asked.

**What actually settles it,** when it comes to that: a source you do not
control. Payment processor revenue, app-store installs, a customer who will take
a reference call. Offer read access to this dashboard rather than a screenshot
of it — a screenshot is the weakest possible form of a number.

**On inflating the count.** It would be easy: post UUIDs to `/ping` and it goes
up. Do not. Presenting invented user numbers to raise money is fraud, it is the
specific thing diligence exists to catch, and a founder found to have done it is
finished — the fabrication ends up mattering far more than whatever number it
was covering for. If the honest number is small, the honest framing is that it
is early; investors fund early things constantly and fund liars never.

## Testing it before it is live

Point a development build at your deployed worker and run it:

```sh
CHIMERA_USAGE_ENDPOINT=https://chimera-stats.<you>.workers.dev/ping \
  npm run build --workspace @chimera/desktop
```

Your own machine then appears as one install, which is exactly what it is. If
you want to see the dashboard populated before launch, insert rows locally
against a local D1 and look at that — never against the deployed database, and
never anything you would then quote:

```sh
wrangler d1 execute chimera-stats --local --command \
  "INSERT INTO pings VALUES ('00000000-0000-4000-8000-000000000001','2026-08-24','0.1.0','linux','x64')"
```

`--local` is the whole point of that line: it writes to a SQLite file on your
machine, not to the database the dashboard reads.

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
