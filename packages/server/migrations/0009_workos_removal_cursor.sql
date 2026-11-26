-- Round 4, 3-S1: a WorkOS access removal that stops at its page cap keeps the
-- list cursor it reached, and the next attempt continues from it, so a list
-- longer than one attempt can read is still read to its end. The cursor counts
-- only for the request it was reached under (`list_after_for` equals the row's
-- `requested_at`): a repeat revocation, by either Worker, starts from page one.
-- Additive and nullable: the Worker that is live now never reads or writes them.
ALTER TABLE workos_access_removals ADD COLUMN list_after TEXT
  CHECK (list_after IS NULL OR length(list_after) BETWEEN 1 AND 254);
ALTER TABLE workos_access_removals ADD COLUMN list_after_for INTEGER;
