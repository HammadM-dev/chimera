-- What a run produced, kept with the run.
--
-- It was never stored. The renderer that started a run learned the answer from
-- a live event and held it in memory; anything that arrived late — a second
-- window watching, the Runs view afterwards — had no way to ask. A run that
-- finished in four seconds could not be watched at all, because everything
-- worth seeing had already been broadcast before the watcher existed.
ALTER TABLE runs ADD COLUMN output TEXT NOT NULL DEFAULT '';
