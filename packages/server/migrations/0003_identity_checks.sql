-- Identity kept in step with the sign-in provider, and extension enrolment
-- bound to a browser session (the security audit's findings 7 and 8). Both
-- the old and the new Worker run against this schema.

-- When WorkOS last confirmed this person's verified email (a web sign-in, a
-- first MCP sign-in, or an MCP refresh). Null: never recorded, refresh due.
ALTER TABLE people ADD COLUMN verified_at INTEGER;

-- The browser session that issued an extension sign-in code; redemption is
-- refused once that session has ended. Null only for codes minted before.
ALTER TABLE auth_codes ADD COLUMN session_id TEXT;
