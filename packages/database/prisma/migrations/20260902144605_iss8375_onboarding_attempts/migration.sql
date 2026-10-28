-- ISS-8375 (PRD-689): the guided-onboarding run store, one row per user per
-- organization.
--
-- Purely additive: no existing table is altered and the legacy onboarding flow
-- keeps working untouched. Rollback is `DROP TABLE "onboarding_attempts"` and
-- nothing else.
--
-- NOT dark: `guidedOnboardingAttemptStore` reads and writes these rows in the
-- same change. What is missing is a caller -- ISS-8353 owns mounting the guided
-- onboarding surface, and `workspace-experience-v2` is off until it ships.
--
-- `(user_id, organization_id)` is the run's identity, not merely a de-duplication
-- guard: the compare-and-swap that accepts a transition is an `updateMany`
-- selecting on that pair plus `revision`, so this UNIQUE is what makes exactly
-- one row eligible and the increment a real CAS rather than a blind write.
--
-- HAND EDIT: the DDL below is Prisma-generated; only the `IF NOT EXISTS` and the
-- `index-lock-ok` markers on the two CREATE INDEX statements were added, because
-- `scripts/lint/check-destructive-migrations.ts` requires both for a reviewed
-- plain (non-CONCURRENTLY) index build. The matching INDEX_LOCK_ALLOWLIST
-- entries live in `scripts/lint/destructive-migrations/index-lock-allowlist.ts`.

-- CreateTable
CREATE TABLE "onboarding_attempts" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "experience_variant" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "state" JSONB NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "last_command_id" UUID,
    "account_skipped_at" TIMESTAMP(3),
    "desktop_downloaded_at" TIMESTAMP(3),
    "tour_completed_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "onboarding_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- index-lock-ok(onboarding_attempts): table is created empty in this same migration so both the one-run-per-user-per-org unique and the organization cascade-support index build lock zero rows before any writer can reach them, and CONCURRENTLY cannot be mixed with the table-creation DDL Prisma wraps in one transaction
CREATE INDEX IF NOT EXISTS "onboarding_attempts_organization_id_idx" ON "onboarding_attempts"("organization_id");

-- CreateIndex
-- index-lock-ok(onboarding_attempts): table is created empty in this same migration so both the one-run-per-user-per-org unique and the organization cascade-support index build lock zero rows before any writer can reach them, and CONCURRENTLY cannot be mixed with the table-creation DDL Prisma wraps in one transaction
CREATE UNIQUE INDEX IF NOT EXISTS "onboarding_attempts_user_id_organization_id_key" ON "onboarding_attempts"("user_id", "organization_id");

-- AddForeignKey
ALTER TABLE "onboarding_attempts" ADD CONSTRAINT "onboarding_attempts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "onboarding_attempts" ADD CONSTRAINT "onboarding_attempts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
