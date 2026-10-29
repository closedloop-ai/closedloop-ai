-- ISS-7352 item F, IDENTITY half — the per-session account and organization
-- identifiers.
--
-- This is the table 0086's header said was deliberately not there. 0086 shipped
-- item F's other half, the four per-event join keys, as columns on the eight
-- event-sourced tables; those are per-RECORD. Everything here is per-SESSION,
-- which is why it is one row keyed by `session_id` rather than seven more
-- columns repeated on every event table.
--
-- `session_id` is the PRIMARY KEY, not part of a wider natural key. A session
-- has one identity, and the normalizer merges the readings it saw across a
-- batch before the persister upserts, so a batch that spans a login writes one
-- row carrying both what was known before it and what was known after.
--
-- Every identity column is NULLABLE and every absent one stays NULL rather than
-- taking a placeholder: a session whose account cannot be resolved is
-- unattributed, and a placeholder would be indistinguishable from a resolved
-- value to anyone reading this table later.
--
-- There is no column here for `user.email` or `user.groups`. Those attributes
-- ride on the same records and are excluded by decision — this table joins
-- rows to an account, it does not describe a person.

CREATE TABLE IF NOT EXISTS "claude_code_session_identity" (
    "session_id" TEXT NOT NULL PRIMARY KEY,
    "observed_at" TEXT NOT NULL,
    "organization_id" TEXT,
    "user_account_uuid" TEXT,
    "user_account_id" TEXT,
    "identity_source" TEXT,
    "terminal_type" TEXT,
    "app_version" TEXT,
    "app_entrypoint" TEXT,
    "data_revision" INTEGER NOT NULL DEFAULT 1,
    "created_at" TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    "updated_at" TEXT
);

-- The one access path this table has beyond its primary key: "which sessions
-- belong to this organization".
CREATE INDEX IF NOT EXISTS "idx_claude_code_session_identity_org" ON "claude_code_session_identity"("organization_id");
