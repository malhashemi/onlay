-- Round 2 of the server review: control calls are per person and ordered.
-- Revocation never waits behind a roster; failed rows back off instead of
-- filling the retry window. Both the old and the new Worker run against
-- this schema: the old one's kinds stay accepted and are mapped at delivery,
-- and the trigger gives every row its priority whoever inserts it.

CREATE TABLE space_outbox_next (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN (
    'credential-revoked', 'access', 'purge', 'person',
    'standing', 'shares', 'people'
  )),
  body_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  -- Delivery order inside a space: credential-revoked, access, purge, person.
  priority INTEGER NOT NULL DEFAULT 3,
  -- Not tried again before this time (epoch ms): exponential backoff, capped.
  next_attempt_at INTEGER NOT NULL DEFAULT 0
);
INSERT INTO space_outbox_next (id, space_id, kind, body_json, created_at, attempts)
  SELECT id, space_id, kind, body_json, created_at, attempts FROM space_outbox;
DROP TABLE space_outbox;
ALTER TABLE space_outbox_next RENAME TO space_outbox;

CREATE INDEX space_outbox_due ON space_outbox (next_attempt_at, priority, created_at);
CREATE INDEX space_outbox_space ON space_outbox (space_id, priority, next_attempt_at);

-- Rows already queued (none on a fresh deployment) get their place in the order.
UPDATE space_outbox SET priority = CASE kind
  WHEN 'credential-revoked' THEN 0
  WHEN 'access' THEN 1
  WHEN 'standing' THEN 1
  WHEN 'shares' THEN 1
  WHEN 'purge' THEN 2
  ELSE 3
END;
