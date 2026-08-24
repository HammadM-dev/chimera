// The page you actually look at.
//
// Behind HTTP Basic auth rather than the bearer token the JSON API uses, for
// the boring reason that a browser can prompt for Basic and cannot send a
// bearer header from the address bar. Same secret, two doors.
//
// No dependencies, no build step, no external requests: the whole page is one
// string, and the chart is inline SVG. A dashboard that needs a toolchain is a
// dashboard that stops working in six months.

export interface DashboardData {
  activeToday: number;
  activeThisWeek: number;
  activeThisMonth: number;
  installsEverSeen: number;
  newThisMonth: number;
  downloads: number;
  downloadsNote: string;
  byVersion: { version: string; n: number }[];
  byPlatform: { platform: string; n: number }[];
  daily: { day: string; n: number }[];
  retention: { cohort: string; size: number; day7: number; day30: number }[];
  generatedAt: string;
}

function escape(text: string): string {
  return text.replace(
    /[&<>"]/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char] ?? char,
  );
}

/** A sparkline of daily actives. Inline SVG so it needs nothing. */
function chart(daily: { day: string; n: number }[]): string {
  if (daily.length < 2) return '<p class="muted">Not enough days yet to draw a line.</p>';

  const width = 720;
  const height = 160;
  const peak = Math.max(...daily.map((point) => point.n), 1);
  const step = width / (daily.length - 1);

  const points = daily
    .map(
      (point, index) =>
        `${(index * step).toFixed(1)},${(height - (point.n / peak) * height).toFixed(1)}`,
    )
    .join(' ');

  return `<svg viewBox="0 0 ${String(width)} ${String(height)}" class="chart" role="img"
      aria-label="Daily active installs over the last 30 days">
    <polyline points="${points}" fill="none" stroke="currentColor" stroke-width="2" />
  </svg>
  <p class="muted">${escape(daily[0]?.day ?? '')} to ${escape(daily.at(-1)?.day ?? '')} · peak ${String(peak)}</p>`;
}

function rows(items: { label: string; n: number }[]): string {
  if (items.length === 0) return '<tr><td colspan="2" class="muted">Nothing yet.</td></tr>';
  return items
    .map((item) => `<tr><td>${escape(item.label)}</td><td class="num">${String(item.n)}</td></tr>`)
    .join('');
}

function retentionRows(data: DashboardData): string {
  if (data.retention.length === 0) {
    return '<tr><td colspan="4" class="muted">No cohort is old enough yet.</td></tr>';
  }
  return data.retention
    .map((cohort) => {
      const pct = (value: number): string =>
        cohort.size === 0 ? '—' : `${String(Math.round((value / cohort.size) * 100))}%`;
      return `<tr>
        <td>${escape(cohort.cohort)}</td>
        <td class="num">${String(cohort.size)}</td>
        <td class="num">${pct(cohort.day7)}</td>
        <td class="num">${pct(cohort.day30)}</td>
      </tr>`;
    })
    .join('');
}

export function renderDashboard(data: DashboardData): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CHIMERA — installs</title>
<style>
  :root { color-scheme: dark; }
  body {
    margin: 0; padding: 32px;
    font: 14px/1.5 ui-sans-serif, system-ui, sans-serif;
    background: #0d0d0c; color: #f5f3ee;
  }
  main { max-width: 780px; margin: 0 auto; }
  h1 { font-size: 20px; font-weight: 500; margin: 0 0 4px; }
  h2 { font-size: 14px; font-weight: 500; margin: 32px 0 8px; }
  .muted { color: #a3a09a; font-size: 12px; margin: 4px 0 0; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-top: 20px; }
  .card { padding: 14px; background: #161614; border: 1px solid rgba(245,243,238,.1); border-radius: 10px; }
  .card b { display: block; font-size: 26px; font-weight: 500; }
  .card span { color: #a3a09a; font-size: 12px; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; }
  td, th { padding: 6px 0; border-bottom: 1px solid rgba(245,243,238,.1); text-align: left; font-weight: 400; }
  th { color: #a3a09a; font-size: 12px; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .chart { width: 100%; height: 160px; color: #4a8fd4; margin-top: 8px; }
  .note { margin-top: 32px; padding: 14px; background: #161614;
          border: 1px solid rgba(245,243,238,.1); border-radius: 10px; color: #a3a09a; font-size: 12px; }
  .note strong { color: #f5f3ee; font-weight: 500; }
</style>
</head>
<body>
<main>
  <h1>CHIMERA installs</h1>
  <p class="muted">Generated ${escape(data.generatedAt)}</p>

  <div class="grid">
    <div class="card"><b>${String(data.activeThisMonth)}</b><span>active this month</span></div>
    <div class="card"><b>${String(data.activeThisWeek)}</b><span>active this week</span></div>
    <div class="card"><b>${String(data.activeToday)}</b><span>active today</span></div>
    <div class="card"><b>${String(data.newThisMonth)}</b><span>new this month</span></div>
    <div class="card"><b>${String(data.downloads)}</b><span>downloads${
      data.downloadsNote === '' ? '' : ` — ${escape(data.downloadsNote)}`
    }</span></div>
    <div class="card"><b>${String(data.installsEverSeen)}</b><span>installs ever seen</span></div>
  </div>

  <h2>Daily actives, last 30 days</h2>
  ${chart(data.daily)}

  <h2>Retention</h2>
  <table>
    <tr><th>Cohort (first week)</th><th class="num">Installs</th><th class="num">Day 7</th><th class="num">Day 30</th></tr>
    ${retentionRows(data)}
  </table>
  <p class="muted">
    The share of each week's new installs still running seven and thirty days later.
    This is the number that says whether the product is worth keeping, and it is the one
    to lead with.
  </p>

  <h2>Versions</h2>
  <table>${rows(data.byVersion.map((item) => ({ label: item.version, n: item.n })))}</table>

  <h2>Platforms</h2>
  <table>${rows(data.byPlatform.map((item) => ({ label: item.platform, n: item.n })))}</table>

  <div class="note">
    <p><strong>What these numbers are.</strong> Every figure above except downloads comes
    from CHIMERA copies reporting in. That endpoint is public and unauthenticated — it has
    to be, since a desktop app cannot hold a secret — so the counts are trustworthy only to
    the extent that nobody has posted to it who is not running the app.</p>
    <p><strong>What that means when somebody asks you to prove it.</strong> Lead with
    downloads: they come from the GitHub releases API, anybody can read them without asking
    you, and you cannot alter them. Then retention, which is the shape that is hard to fake
    and the thing worth knowing anyway. Offer read access to this page rather than a
    screenshot of it. If the numbers ever matter enough to be challenged, the answer is a
    source you do not control — a payment processor, a store — not a tighter argument
    about this one.</p>
  </div>
</main>
</body>
</html>`;
}
