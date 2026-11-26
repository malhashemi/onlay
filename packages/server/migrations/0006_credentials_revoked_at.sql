-- Patch 3b (3b-S1): when a person's credentials were last revoked as a whole
-- (sign out everywhere, an email or WorkOS subject change, account deletion),
-- in Unix SECONDS, set in SQL inside the revoking batch. MCP access tokens are
-- AuthKit's, so D1 cannot delete them; their `iat` (seconds) is compared with
-- this instead, and a token issued at or before it is refused. Nullable and
-- additive: the previous Worker never reads or writes it.

ALTER TABLE people ADD COLUMN credentials_revoked_at INTEGER;
