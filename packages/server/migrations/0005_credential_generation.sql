-- Round 3 (R3-S1): credential generations replace issue times. Clocks cannot
-- order a sign-out against a concurrent sign-in or enrolment; D1 can. Each
-- person has a generation; every session and client token is stamped with
-- the person's generation read in its own INSERT; sign out everywhere, an
-- email or WorkOS subject change and account deletion advance it in the batch
-- that deletes the person's credentials, and spaces refuse anything stamped
-- below it. Additive with defaults, so the previous Worker runs against it
-- unchanged (its rows carry generation 0, as every person starts at 0).

ALTER TABLE people ADD COLUMN credential_generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE client_tokens ADD COLUMN generation INTEGER NOT NULL DEFAULT 0;
