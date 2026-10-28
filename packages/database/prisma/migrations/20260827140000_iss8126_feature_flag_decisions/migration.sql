-- ISS-8126: the shared record that makes a viewer's flag decision survive a
-- cold serverless instance.
--
-- WHY A TABLE AT ALL. ISS-7860 memoized the LOC/$ cost-basis gate so one
-- viewer's reads AGREE inside one instance. `apps/api` is serverless, so that is
-- not the whole promise: two reads served by two COLD instances during a PostHog
-- outage still resolved differently — one holding the rollout basis, the other
-- failing closed to API-billed — and the reader watched the ratio change between
-- two nearby page loads with nothing on screen to say why. An in-process memo
-- structurally cannot close that; a cold instance has no last-known decision to
-- hold. This is where it holds one.
--
-- WHY POSTGRES RATHER THAN REDIS. `@repo/redis` exists but is used only by
-- `apps/relay` and `apps/mcp`, both long-lived containers with a `REDIS_URL`
-- already provisioned. `apps/api` has no Redis binding, so choosing it would put
-- a NEW external dependency on the serverless request path, provisioned per
-- environment, with its own availability to reason about. Postgres is already on
-- that path and already pooled: if it is down the request was not going to be
-- served anyway.
--
-- SHAPE. Keyed on (flag_key, viewer_key) — the composite primary key IS the
-- lookup index, so the read is a single index probe and no secondary index is
-- needed. `viewer_key` is the gate's OWN memo cache key (the JSON-encoded
-- distinct-id list), not a user id: keying it any other way would let two
-- instances compute different keys for one viewer, leave every instance cold,
-- and make this table inert.
--
-- `decided_at` is when PostHog EVALUATED the decision, not when the row was
-- written, and the two are deliberately separate columns. The staleness window
-- the gate enforces is measured from the evaluation, and the conditional upsert
-- that keeps an older evaluation from overwriting a newer verdict
-- (apps/api/AGENTS.md, "last-write-wins is not freshness-safe") compares
-- `decided_at` — a write timestamp would make a slow-but-older instance look
-- fresher simply because it finished last.
--
-- GROWTH is bounded by (flags using a store) x (viewers ever evaluated), which
-- is the user population rather than anything an external caller can inflate:
-- one row per viewer per flag, overwritten in place. Rows for a RETIRED flag key
-- are the one form of dead weight here and should be deleted along with the
-- flag; there is deliberately no sweep, because nothing in the read path degrades
-- as unrelated rows accumulate.
--
-- NOT A CACHE OF THE FLAG. It is read on exactly one path — the fallback for an
-- evaluation that could not be made — and never when PostHog answers, so
-- flipping a rollout still takes effect within the memo's TTL instead of being
-- pinned here.
--
-- Purely additive: a new table no existing query reads or writes.

-- CreateTable
CREATE TABLE "feature_flag_decisions" (
    "flag_key" TEXT NOT NULL,
    "viewer_key" TEXT NOT NULL,
    "value" BOOLEAN NOT NULL,
    "decided_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "feature_flag_decisions_pkey" PRIMARY KEY ("flag_key","viewer_key")
);
