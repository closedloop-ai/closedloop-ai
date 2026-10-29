-- ISS-7830: the durable per-thread record that a user navigated INTO a thread.
--
-- Headless classification for an agent-spawned thread is DYNAMIC: a subagent
-- thread a person opened is interactive, one nobody opened is not. Launch
-- attribution is the default and viewership overrides it — but the predicate
-- could not consult a signal the product never captured, and nothing on
-- `origin/main` recorded one. This table is that signal.
--
-- WHY ITS OWN TABLE, not a `sessions` column. The importer rewrites
-- `sessions.metadata` wholesale from the transcript on every re-import
-- (`write-core-import-phases-session.ts`, `metadata = $6`), and a `DATA_REVISION`
-- bump re-imports the entire corpus by design. Viewership is not in the
-- transcript and no re-parse can reconstruct it, so a value stored there would be
-- erased by the very rebuild that recomputes the classification reading it. The
-- session row itself survives a rebuild (the rebuild re-imports through the
-- `existing` UPDATE branch; `deleteSessionRow` is reached only for burst
-- artifacts and folded children), so a session-keyed side table outlives it.
--
-- MONOTONIC, and the primary key is what enforces it: every write is
-- `ON CONFLICT (session_id) DO NOTHING`, so the FIRST view is the one kept and a
-- later write can neither move the timestamp nor retract the fact. A retractable
-- signal would let the same session flip between headless and attended across
-- rebuilds with no user action in between.
--
-- `ON DELETE CASCADE` matches every other session-keyed marker table: a purged
-- session must not leave a viewership record for a row that no longer exists.
--
-- Absence of a row is NOT evidence the thread was never opened — a build that
-- predates this capture recorded nothing — so a reader treats it as the safe
-- default (unviewed), never as a finding.
CREATE TABLE IF NOT EXISTS "session_viewership" (
    "session_id" TEXT NOT NULL PRIMARY KEY,
    "first_viewed_at" TEXT NOT NULL,
    CONSTRAINT "session_viewership_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
);

-- No index beyond the primary key. Both access paths are primary-key work: the
-- capture is a single-row insert, and the classification read is an `IN (…)` seek
-- over the session ids already in hand.
