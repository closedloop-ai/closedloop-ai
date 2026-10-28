-- ISS-12048: the production feature-flag snapshot a `$vibe` preview schema
-- pins, so a preview environment evaluates every flag as production did for the
-- person who opened it.
--
-- At most one row (`id = 'current'`), written only into a `preview_*` schema by
-- `POST /preview-schemas/feature-flag-snapshot` and read only by an `apps/api`
-- runtime whose own schema is a preview schema. In `public` (stage and
-- production) the table exists and stays empty.
--
-- Purely additive: a new table no existing query reads or writes.

-- CreateTable
CREATE TABLE "feature_flag_snapshots" (
    "id" TEXT NOT NULL,
    "distinct_id" TEXT NOT NULL,
    "org_id" TEXT,
    "taken_at" TIMESTAMP(3) NOT NULL,
    "flags" JSONB NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "feature_flag_snapshots_pkey" PRIMARY KEY ("id")
);
