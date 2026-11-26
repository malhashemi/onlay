-- The directory (spec §6): people, their credentials, spaces, members,
-- invitations, workspace creators, deployment settings, shares and rate
-- counters. Times are epoch milliseconds; emails are stored lower-cased and
-- trimmed; credentials are stored as SHA-256 hex, never raw.

-- A person is their email. Account deletion keeps the row as a tombstone
-- ("Deleted person", email and WorkOS id cleared) so past messages in shared
-- spaces stay attributed; a later sign-in with that email is a new person.
CREATE TABLE people (
  id TEXT PRIMARY KEY CHECK (id GLOB 'p_[a-z2-7]*' AND length(id) = 22),
  email TEXT UNIQUE CHECK (email IS NULL OR (email = lower(trim(email)) AND length(email) BETWEEN 3 AND 254)),
  workos_user_id TEXT UNIQUE,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  initials TEXT NOT NULL CHECK (length(initials) BETWEEN 1 AND 3),
  tint TEXT NOT NULL,
  avatar_url TEXT,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER,
  CHECK ((deleted_at IS NULL) = (email IS NOT NULL))
);

-- Seeded from the SUPER_ADMINS secret at first sign-in (added_by null), or
-- named by another super admin.
CREATE TABLE super_admins (
  person_id TEXT PRIMARY KEY REFERENCES people (id) ON DELETE CASCADE,
  added_by TEXT REFERENCES people (id),
  created_at INTEGER NOT NULL
);

-- The web app's session cookie: 30 days, renewed on use after an hour.
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES people (id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  renewed_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_person ON sessions (person_id);
CREATE INDEX sessions_expiry ON sessions (expires_at);

-- The extension's client tokens: no expiry, revocable. last_used_at is
-- written at most once a minute.
CREATE TABLE client_tokens (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES people (id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);
CREATE INDEX client_tokens_person ON client_tokens (person_id);

-- One-time extension sign-in codes, bound to (person, PKCE challenge), two
-- minutes. Redemption deletes the row, so a code is spent at most once.
CREATE TABLE auth_codes (
  code_hash TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES people (id) ON DELETE CASCADE,
  challenge TEXT NOT NULL CHECK (length(challenge) = 43),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX auth_codes_expiry ON auth_codes (expires_at);

-- A personal space has exactly one person, its owner, held as its only
-- member with role admin; it is named "personal" and takes no invitations.
-- A workspace's name is unique and follows the workspace name rule.
CREATE TABLE spaces (
  id TEXT PRIMARY KEY CHECK (id GLOB 's_[a-z2-7]*' AND length(id) = 22),
  kind TEXT NOT NULL CHECK (kind IN ('personal', 'workspace')),
  name TEXT NOT NULL,
  owner_id TEXT REFERENCES people (id),
  created_by TEXT NOT NULL REFERENCES people (id),
  created_at INTEGER NOT NULL,
  CHECK (
    (kind = 'personal' AND name = 'personal' AND owner_id IS NOT NULL)
    OR (
      kind = 'workspace' AND owner_id IS NULL
      AND length(name) BETWEEN 1 AND 63
      AND name NOT GLOB '*[^a-z0-9-]*'
      AND name NOT GLOB '-*'
      AND name NOT IN ('api', 'app', 'auth', 's', 'mcp', 'personal')
    )
  )
);
CREATE UNIQUE INDEX spaces_workspace_name ON spaces (name) WHERE kind = 'workspace';
CREATE UNIQUE INDEX spaces_personal_owner ON spaces (owner_id) WHERE kind = 'personal';

CREATE TABLE space_members (
  space_id TEXT NOT NULL REFERENCES spaces (id) ON DELETE CASCADE,
  person_id TEXT NOT NULL REFERENCES people (id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (space_id, person_id)
);
CREATE INDEX space_members_person ON space_members (person_id);

-- An invitation is an email waiting to sign in; claimed (as member) and
-- deleted after that person's next sign-in. No token, no expiry, no email sent.
CREATE TABLE invitations (
  space_id TEXT NOT NULL REFERENCES spaces (id) ON DELETE CASCADE,
  email TEXT NOT NULL CHECK (email = lower(trim(email)) AND length(email) BETWEEN 3 AND 254),
  invited_by TEXT NOT NULL REFERENCES people (id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (space_id, email)
);
CREATE INDEX invitations_email ON invitations (email);

CREATE TABLE workspace_creators (
  entry TEXT PRIMARY KEY CHECK (entry = lower(trim(entry)) AND length(entry) BETWEEN 1 AND 254),
  kind TEXT NOT NULL CHECK (kind IN ('email', 'domain')),
  added_by TEXT NOT NULL REFERENCES people (id),
  created_at INTEGER NOT NULL
);

CREATE TABLE deployment_settings (
  key TEXT PRIMARY KEY CHECK (key IN ('workspace_creation')),
  value_json TEXT NOT NULL,
  updated_by TEXT REFERENCES people (id),
  updated_at INTEGER NOT NULL
);

-- One interaction granted to one email. The holder, once signed in and not a
-- member, is a guest of the space who sees only their shared interactions.
CREATE TABLE shares (
  space_id TEXT NOT NULL REFERENCES spaces (id) ON DELETE CASCADE,
  interaction_id TEXT NOT NULL,
  email TEXT NOT NULL CHECK (email = lower(trim(email)) AND length(email) BETWEEN 3 AND 254),
  shared_by TEXT NOT NULL REFERENCES people (id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (space_id, interaction_id, email)
);
CREATE INDEX shares_email ON shares (email);

-- Fixed one-minute windows: one row per bucket, reset when the window moves.
CREATE TABLE rate_counters (
  key TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL
);

-- Guard rows (dossier's pattern): a batch inserts a row whose `ok` is the
-- rule evaluated inside the batch's own transaction, then deletes it. A rule
-- that fails violates its CHECK and rolls the whole batch back, so a race
-- between a check and a write cannot break last-admin, authority or
-- membership rules.
CREATE TABLE change_guards (
  id TEXT NOT NULL,
  reason TEXT NOT NULL,
  ok INTEGER,
  PRIMARY KEY (id, reason),
  CONSTRAINT change_guard_authority CHECK (reason <> 'authority' OR ok = 1),
  CONSTRAINT change_guard_admins CHECK (reason <> 'admins' OR ok = 1),
  CONSTRAINT change_guard_super_admins CHECK (reason <> 'super_admins' OR ok = 1),
  CONSTRAINT change_guard_not_member CHECK (reason <> 'not_member' OR ok = 1),
  CONSTRAINT change_guard_policy CHECK (reason <> 'policy' OR ok = 1)
);
