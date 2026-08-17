-- What a run would have cost if every call had used the frontier tier.
--
-- M5-4's economic argument, made in numbers rather than asserted. Stored on the
-- run rather than recomputed at read time: the comparison needs the input and
-- output token split of every individual call, which only the live meter sees —
-- the run row keeps totals, and the two rates differ.
--
-- Null means no frontier model was configured, or its price is not in the
-- capability matrix. A null comparison is honest; an invented one is not.
ALTER TABLE runs ADD COLUMN frontier_cost_usd REAL;
