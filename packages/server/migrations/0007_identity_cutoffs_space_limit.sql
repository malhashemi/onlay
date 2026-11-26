-- Follow-ups after the hosted merge (S-1, S-2, S-3). Both the old and the new
-- Worker run against this schema: everything here is additive or, for
-- change_guards, a table that only ever holds rows inside a batch.

-- S-1: a cutoff that outlives the person row. Account deletion clears the
-- tombstone's email and WorkOS subject, so a cutoff kept on `people` no longer
-- reaches a token that names them. One row per identity (a WorkOS subject or
-- a verified email) with the time, in Unix SECONDS set by SQLite in the
-- revoking batch, at or before which an MCP access token proving it is
-- refused, whichever person it would reach or create. Also written for the
-- former subject when a person is continued by a new one. Kept 31 days (the
-- daily sweep), far longer than an access token lives. The old Worker never
-- reads or writes it.
CREATE TABLE identity_cutoffs (
  kind TEXT NOT NULL CHECK (kind IN ('workos', 'email')),
  value TEXT NOT NULL CHECK (length(value) BETWEEN 1 AND 254),
  revoked_at INTEGER NOT NULL,
  PRIMARY KEY (kind, value)
);
CREATE INDEX identity_cutoffs_revoked ON identity_cutoffs (revoked_at);

-- S-2: the MCP access token whose own sign-in caused the person's latest
-- revocation (a WorkOS subject or email change), as `<credentials_revoked_at>:<jti>`.
-- That token is not refused by the cutoff it caused; the pairing with the
-- cutoff's value means any later revocation, by either Worker, ends the
-- exemption. Nullable and additive: the old Worker never reads it.
ALTER TABLE people ADD COLUMN credentials_revoked_by TEXT;

-- S-3: an invitation whose invitee already reaches the most spaces one person
-- may (LIMITS.MAX_SPACES_PER_PERSON) stays an invitation; this is when it
-- was first held for that reason (epoch ms), null otherwise. The old Worker
-- never reads it.
ALTER TABLE invitations ADD COLUMN waiting_since INTEGER;

-- S-3: guard rows gain the space limit. The table only ever holds rows inside
-- a batch, so it is recreated with the new constraint (as in 0002); every
-- reason the old Worker uses stays.
DROP TABLE change_guards;
CREATE TABLE change_guards (
  id TEXT NOT NULL,
  reason TEXT NOT NULL,
  ok INTEGER,
  PRIMARY KEY (id, reason),
  CONSTRAINT change_guard_authority CHECK (reason <> 'authority' OR ok = 1),
  CONSTRAINT change_guard_admins CHECK (reason <> 'admins' OR ok = 1),
  CONSTRAINT change_guard_super_admins CHECK (reason <> 'super_admins' OR ok = 1),
  CONSTRAINT change_guard_not_member CHECK (reason <> 'not_member' OR ok = 1),
  CONSTRAINT change_guard_policy CHECK (reason <> 'policy' OR ok = 1),
  CONSTRAINT change_guard_live CHECK (reason <> 'live' OR ok = 1),
  CONSTRAINT change_guard_share_cap CHECK (reason <> 'share_cap' OR ok = 1),
  CONSTRAINT change_guard_space_limit CHECK (reason <> 'space_limit' OR ok = 1)
);
