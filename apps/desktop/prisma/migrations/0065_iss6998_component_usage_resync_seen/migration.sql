-- ISS-6998: durable marker for the one-time component-usage re-delivery pass.
--
-- ISS-6884 (PR #5277) made component usage a paginated FOURTH stream, so a
-- session's full set now reaches the cloud. That fix is PRODUCER-side: it does
-- nothing for sessions that already delivered a subset truncated at
-- `MAX_SYNCED_COMPONENT_USAGE`. Selection for re-delivery is driven by local
-- change state (`sessions.updated_at`, which `listUpdatedSessionCursorRows`
-- orders on), not by "the delivery was incomplete" — so a session that has gone
-- quiet keeps its truncated cloud-side set indefinitely.
--
-- The repair bumps `updated_at` on the affected sessions, which is exactly how
-- the sync lane is asked to re-upload them. The reason it needs a TABLE rather
-- than the convergent, marker-free shape `billing-mode-heal.ts` uses: that pass
-- selects on a column it also WRITES (`billing_mode`), so a healed row stops
-- matching and the second boot selects nothing. This pass selects on
-- `COUNT(agent_component_session_usage)`, which a re-queue does not change at
-- all. Without a durable "already asked" fact the pass would re-bump the same
-- population on every single boot — the sync-cursor churn `billing-mode-heal.ts`
-- documents and refuses.
--
-- One row per session, PK on `session_id`, so the insert is naturally
-- idempotent under `ON CONFLICT DO NOTHING` and the discovery `NOT EXISTS`
-- probe is a primary-key seek rather than a scan. `ON DELETE CASCADE` matches
-- every other session-keyed marker table: a purged session must not leave a
-- marker behind claiming a re-queue for a row that no longer exists.
--
-- `usage_rows` records the count observed at re-queue time as EVIDENCE for why
-- the session was selected. It is deliberately not a delivery total and must
-- never be read as one — a marker here means "this device asked for a re-send",
-- never "the full set arrived".
--
-- No index beyond the primary key: the pass's only access paths are the
-- `NOT EXISTS (… WHERE session_id = ?)` probe and the upsert, both PK seeks.
CREATE TABLE IF NOT EXISTS "component_usage_resync_seen" (
    "session_id" TEXT NOT NULL PRIMARY KEY,
    "usage_rows" INTEGER NOT NULL,
    "requeued_at" TEXT NOT NULL,
    CONSTRAINT "component_usage_resync_seen_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
);
