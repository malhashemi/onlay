-- Round 3, S-3: sign out everywhere and account deletion also end agent
-- access at WorkOS, by removing the WorkOS user's authorized applications
-- (their Connect authorizations and every refresh token issued under them).
-- One row per WorkOS user still owed that removal, written in the revoking
-- batch itself and deleted once WorkOS confirms nothing is left authorized;
-- a failed try backs off and is retried by the every-minute cron, and a row
-- still failing a day after it was requested is dropped with a log line.
-- Additive: the old Worker never reads or writes it.
CREATE TABLE workos_access_removals (
  workos_user_id TEXT PRIMARY KEY CHECK (length(workos_user_id) BETWEEN 1 AND 254),
  -- When the latest revocation asked for it (epoch ms); a repeat restarts the day.
  requested_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL
);
CREATE INDEX workos_access_removals_due ON workos_access_removals (next_attempt_at);
