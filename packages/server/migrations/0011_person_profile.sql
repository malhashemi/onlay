-- People's names and pictures. Additive: the old Worker reads none of it, and
-- the new one treats a person without these as before (named by the provider
-- or their email's local part, drawn with their initials).

-- When the person set their own name in Settings. Null: the sign-in
-- provider's name is taken at every sign-in (the email's local part when it
-- gives none); set: no sign-in renames them again.
ALTER TABLE people ADD COLUMN name_set_at INTEGER;

-- Which picture shows: null = the sign-in provider's (when one was fetched),
-- 'own' = the one the person uploaded, 'none' = their initials.
ALTER TABLE people ADD COLUMN picture_choice TEXT
  CHECK (picture_choice IS NULL OR picture_choice IN ('own', 'none'));

-- Onlay's own copy of each person's pictures, at most one per source, so no
-- client ever loads an image from a provider. `key` names this copy (it
-- changes with the bytes, so a URL holding it can be cached for good);
-- `source_url` is the provider's address the copy was fetched from.
CREATE TABLE person_pictures (
  person_id TEXT NOT NULL REFERENCES people (id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('provider', 'own')),
  key TEXT NOT NULL UNIQUE CHECK (key GLOB '[a-z2-7]*' AND length(key) = 16),
  type TEXT NOT NULL CHECK (type IN ('image/png', 'image/jpeg', 'image/webp')),
  bytes BLOB NOT NULL CHECK (length(bytes) BETWEEN 1 AND 65536),
  source_url TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (person_id, source)
);
