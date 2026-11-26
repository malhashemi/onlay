-- Sign-out ends the sign-in: a web session remembers the AuthKit session it
-- came from (the `sid` claim of the access token the code exchange returned),
-- so signing out can send the browser to AuthKit's logout for that session
-- and the next visit asks who you are. NULL for a session made before this
-- column existed, by the dev stub, or from an exchange that named no session:
-- signing one of those out ends only onlay's session, as before.
-- Additive and nullable: the Worker that is live now never reads or writes it,
-- and the sessions it inserts carry NULL.
ALTER TABLE sessions ADD COLUMN workos_session_id TEXT
  CHECK (workos_session_id IS NULL OR length(workos_session_id) BETWEEN 1 AND 254);
