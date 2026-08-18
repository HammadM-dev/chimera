-- Whether an agent is one you point several others at.
--
-- The canvas lets a node take as many inputs as the graph needs, and a rule
-- stops the commonest mistake: pointing five copies of the same agent at one
-- step, which costs five times as much and usually says the same thing five
-- times. The exception is the agents whose whole job is to take many things and
-- return one — a summariser with three inputs is a summariser being used
-- correctly.
--
-- Nullable-with-default rather than derived from the role id, because a user's
-- own agent can be a combiner too and CHIMERA cannot know that from its name.
ALTER TABLE roles ADD COLUMN combines_many INTEGER NOT NULL DEFAULT 0;

-- The starter roles that exist to combine. Applied to the shipped ones only —
-- a user's own agents keep whatever they were saved with.
UPDATE roles SET combines_many = 1
WHERE is_builtin = 1 AND id IN ('summariser', 'reviewer', 'qa', 'planner');
