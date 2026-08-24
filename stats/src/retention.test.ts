import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

// The one piece of real logic in this worker, checked against a real SQLite.
//
// D1 is SQLite, so the query that runs in production is the query that runs
// here. It matters more than the rest of the file put together: retention is
// the number worth leading with when somebody asks how the product is doing,
// and a retention figure that is quietly wrong is worse than none — it is a
// number you would repeat in a room.

const RETENTION = `
  WITH first AS (
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
  ORDER BY cohort DESC`;

interface Row {
  cohort: string;
  size: number;
  day7: number;
  day30: number;
}

function withPings(rows: [string, string][]): Row[] {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE pings (
    install_id TEXT NOT NULL, day TEXT NOT NULL,
    version TEXT, platform TEXT, arch TEXT,
    PRIMARY KEY (install_id, day))`);
  const insert = db.prepare('INSERT INTO pings VALUES (?, ?, ?, ?, ?)');
  for (const [id, day] of rows) insert.run(id, day, '1.0.0', 'linux', 'x64');
  const result = db.prepare(RETENTION).all() as Row[];
  db.close();
  return result;
}

test('a cohort counts who came back, not who kept pinging', () => {
  const rows = withPings([
    // Stayed: seen on day 8 and again a month later.
    ['a', '2026-06-01'],
    ['a', '2026-06-09'],
    ['a', '2026-07-05'],
    // Tried it for three days and stopped.
    ['b', '2026-06-02'],
    ['b', '2026-06-04'],
    // Opened it once.
    ['c', '2026-06-03'],
  ]);

  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.size, 3);
  assert.equal(rows[0]?.day7, 1);
  assert.equal(rows[0]?.day30, 1);
});

test('a cohort is the Monday of the week somebody first appeared', () => {
  // 2026-06-01 is a Monday; 2026-06-07 is the Sunday that ends that week.
  // Both installs belong to one cohort, not two.
  const rows = withPings([
    ['a', '2026-06-01'],
    ['b', '2026-06-07'],
  ]);

  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.cohort, '2026-06-01');
  assert.equal(rows[0]?.size, 2);
});

test('a new week is a new cohort', () => {
  const rows = withPings([
    ['a', '2026-06-01'],
    ['b', '2026-06-08'],
  ]);

  assert.equal(rows.length, 2);
  // Newest first, which is the order the dashboard reads in.
  assert.equal(rows[0]?.cohort, '2026-06-08');
  assert.equal(rows[1]?.cohort, '2026-06-01');
});

test('day 7 means seven days later, not the seventh ping', () => {
  // Somebody who opens it every day for a week has not retained to day 7 — the
  // boundary is the date, and getting this wrong would flatter every cohort.
  const rows = withPings([
    ['a', '2026-06-01'],
    ['a', '2026-06-02'],
    ['a', '2026-06-03'],
    ['a', '2026-06-04'],
    ['a', '2026-06-05'],
    ['a', '2026-06-06'],
    ['a', '2026-06-07'],
  ]);

  assert.equal(rows[0]?.size, 1);
  assert.equal(rows[0]?.day7, 0);

  // One more day and they have.
  const returned = withPings([
    ['b', '2026-06-01'],
    ['b', '2026-06-08'],
  ]);
  assert.equal(returned[0]?.day7, 1);
});

test('nobody at all is zero rather than an error', () => {
  assert.deepEqual(withPings([]), []);
});
