-- Durable edge → space control calls and the access epoch (review finding 1).
-- Both the old and the new Worker run against this schema: the old one never
-- reads the new column or table.

-- Bumped in the same batch as any membership, role or share change in the
-- space (and a sign-out of someone who sees it). The edge forwards the epoch
-- it read with the caller's access; a space told of a newer one refuses the
-- forward as stale, and the edge reads again.
ALTER TABLE spaces ADD COLUMN access_epoch INTEGER NOT NULL DEFAULT 0;

-- One control call the edge owes a space, written in the same batch as the
-- directory change it reports, delivered after the commit, deleted once the
-- space accepts it, and retried by the scheduled handler until then. The
-- body names what changed (a person, an interaction, credentials); the call
-- itself is built from the directory as it stands at delivery, so a late or
-- repeated delivery carries current truth. No foreign key: a purge row
-- outlives its deleted space.
CREATE TABLE space_outbox (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('people', 'standing', 'shares', 'purge', 'credential-revoked')),
  body_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX space_outbox_space ON space_outbox (space_id, created_at);
CREATE INDEX space_outbox_created ON space_outbox (created_at);

-- Guard rows gain two rules: the target is a live person, and a thread's
-- share cap. The table only ever holds rows inside a batch, so it is
-- recreated with the new constraints.
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
  CONSTRAINT change_guard_share_cap CHECK (reason <> 'share_cap' OR ok = 1)
);
