-- One row per install per day. That shape is the whole privacy argument.
--
-- There is no user table because there are no users here: an install id is a
-- UUID a copy of CHIMERA made about itself, joined to nothing, resolvable to
-- nobody. The most this database can ever say is "this many copies ran on this
-- day, on these versions, on these platforms" — which is the question sponsors
-- ask and the only question it can answer.
--
-- The primary key is (install_id, day), so a copy that pings twice on one day
-- counts once. That is what makes "active installs" mean active installs
-- rather than "launches by people who restart a lot".
CREATE TABLE IF NOT EXISTS pings (
  install_id TEXT NOT NULL,
  day        TEXT NOT NULL,
  version    TEXT NOT NULL,
  platform   TEXT NOT NULL,
  arch       TEXT NOT NULL,
  PRIMARY KEY (install_id, day)
);

-- Every query here is "how many, over a window", so the day leads the index.
CREATE INDEX IF NOT EXISTS pings_by_day ON pings (day);

-- Deliberately absent: any column that could carry an IP, a hostname, a
-- workspace name, a user agent, or a timestamp finer than the day. A finer
-- timestamp is a behavioural trace of one person's working hours, and nothing
-- here needs it.
