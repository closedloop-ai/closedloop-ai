-- ISS-8761: the state the Pensero delivery backfill needs to actually be run
-- by a scheduler, rather than by a human who never comes.
--
-- Three additions, all additive:
--
-- 1. `pensero_integrations.team_identifiers` — the per-org narrowing for the
--    provider poll. DEFAULT '{}' and NOT NULL so every existing row means "do
--    not narrow": an empty list omits the `team_identifiers` query parameter
--    entirely rather than sending an empty one, which would ask Pensero to
--    scope to nothing and return a window indistinguishable from a quiet day.
--    These are the PROVIDER's identifiers and are never derived from
--    ClosedLoop `Team` names.
--
-- 2. `pensero_backfill_days` — the per-org/day ATTEMPT ledger. Note what it
--    does NOT have: a `complete` column. The delivery endpoint returns no
--    `hasMore`, no cursor and no total, so no row here can honestly claim the
--    day is exhausted. `last_success_at` means "a fetch returned without a
--    transport or parse failure", including one that returned zero rows.
--
-- 3. `pensero_backfill_cursors` — one row per org carrying the two cursors.
--    `backward_cursor` is the oldest day attempted (the backward walk resumes
--    strictly below it, with no historical cutoff); `recheck_cursor` is a
--    round-robin position over days already attempted, so every attempted day
--    is revisited over time. Both nullable: NULL is "nothing attempted yet",
--    and a sentinel date would assert an attempt that never happened.

ALTER TABLE "pensero_integrations"
  ADD COLUMN "team_identifiers" TEXT[] NOT NULL DEFAULT '{}';

CREATE TABLE "pensero_backfill_days" (
  "id" UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "day" DATE NOT NULL,
  "last_attempt_at" TIMESTAMP(3) NOT NULL,
  "last_success_at" TIMESTAMP(3),
  "last_failure_reason" TEXT,
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "last_rows_written" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "pensero_backfill_days_pkey" PRIMARY KEY ("id")
);

-- The uniqueness that makes the ledger write a single atomic upsert instead of
-- a findFirst-then-create race between two overlapping runs. It is also the
-- read index: a btree on exactly (organization_id, day) already serves the
-- per-org ascending day scan the recheck lane pages through, so no second
-- index over the same tuple is created.
-- index-lock-ok(pensero_backfill_days): table is created empty in this same migration so the (org, day) unique index locks zero rows before any writer can reach it, and CONCURRENTLY cannot be mixed with the table-creation DDL Prisma wraps in one transaction; the index is also the ledger upsert's ON CONFLICT target and must exist before the first write
CREATE UNIQUE INDEX IF NOT EXISTS "pensero_backfill_days_organization_id_day_key"
  ON "pensero_backfill_days"("organization_id", "day");

CREATE TABLE "pensero_backfill_cursors" (
  "id" UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "backward_cursor" DATE,
  "recheck_cursor" DATE,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "pensero_backfill_cursors_pkey" PRIMARY KEY ("id")
);

-- index-lock-ok(pensero_backfill_cursors): table is created empty in this same migration so the one-cursor-row-per-org unique index locks zero rows before any writer can reach it, and CONCURRENTLY cannot be mixed with the table-creation DDL Prisma wraps in one transaction; the index is the cursor upsert's ON CONFLICT target and must exist before the first write
CREATE UNIQUE INDEX IF NOT EXISTS "pensero_backfill_cursors_organization_id_key"
  ON "pensero_backfill_cursors"("organization_id");

ALTER TABLE "pensero_backfill_days"
  ADD CONSTRAINT "pensero_backfill_days_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "pensero_backfill_cursors"
  ADD CONSTRAINT "pensero_backfill_cursors_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
