-- Where this workspace sends its runs, if anywhere.
--
-- M9-5's export is opt-in and starts empty. The interesting field is
-- `includePayloads` inside the JSON: a run's trace holds what the user asked
-- and what the model answered — their business, their customers' names, the
-- contents of their files. Sending timings and token counts to a collector is
-- observability; sending the text is exporting the business, and that is a
-- separate thing to agree to.
ALTER TABLE workspace_settings ADD COLUMN telemetry_json TEXT NOT NULL DEFAULT '{}';
