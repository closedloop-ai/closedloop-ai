-- ISS-11670: record WHEN THIS USER sent invitations, and seed the marker for
-- readers who have already finished onboarding.
--
-- The only invite fact the product had was org-scoped:
-- `organizations.settings->'onboarding'->>'invitesSentAt'`, written by
-- `recordInvitesSent(organizationId)` with no user on it, plus a live
-- `activeUserCount > 1`. Both answer "has anyone in this org invited anyone",
-- which the guided invite step was rendering as "YOUR teammates have been
-- invited" — and, through `isStepOutstanding`, was using to skip the step for
-- every member of an established org.
--
-- Two operator rulings, both 2026-09-30, govern the two statements below:
--   1. "We want each new user to be prompted to invite team mates; regardless
--      of what the rest of the org has done." (ISS-11670, Expected behavior)
--   2. "no, onboared users should not get re-prompted" /
--      "Backfill invites sent at or we'll run into #1 which we don't want"
--
-- Ruling 1 needs the per-user column; ruling 2 names the backfill as the
-- mechanism that keeps ruling 1 from dragging an already-onboarded reader back
-- onto the invite step. Hand-written because Prisma cannot express a data
-- migration.
--
-- The column joins the four markers already on this table
-- (`account_skipped_at`, `desktop_downloaded_at`, `tour_completed_at`,
-- `completed_at`), which share the rule that each records when something FIRST
-- happened and is never rewritten.
ALTER TABLE "onboarding_attempts"
  ADD COLUMN "invites_sent_at" TIMESTAMP(3);

-- The backfill, scoped to `completed_at IS NOT NULL` and nothing wider.
--
-- WHICH ROWS. `completed_at` is this run's own completion marker and is the
-- same fact `hasFinishedOnboarding` reads as `guidedRunCompleted`
-- (`apps/api/app/onboarding/guided/snapshot-service.ts`). A row carrying it is a
-- reader who finished their guided run, which is exactly ruling 2's cohort. A
-- row without it is a run still in flight — a new user the ticket exists to
-- prompt — so blanket-stamping every row would suppress the prompt for the very
-- readers ruling 1 is about, the opposite failure and a worse one.
--
-- WHICH VALUE. `completed_at`, not `now()`. There is no record of when these
-- users actually sent, and `now()` would assert a send that happened during a
-- migration. `completed_at` is a real timestamp already on the row and is the
-- latest moment by which anything that happened inside that run had happened,
-- which is the honest bound for a marker whose only job is "this run is done
-- asking". It is never NULL here: the predicate requires it.
--
-- `invites_sent_at IS NULL` makes this idempotent and write-once, the same guard
-- `guidedOnboardingAttemptStore.markInvitesSent` carries: re-running moves no
-- existing stamp.
UPDATE "onboarding_attempts"
  SET "invites_sent_at" = "completed_at"
  WHERE "completed_at" IS NOT NULL
    AND "invites_sent_at" IS NULL;

-- The second cohort: EXISTING users who have no run row at all.
--
-- Operator ruling 2026-09-30: "actually, nevermind - let's do a backfill for
-- existing users to set it; that's the most appropriate." The `UPDATE` above
-- reaches only users who already have an `onboarding_attempts` row. A user who
-- onboarded before runs were recorded (ISS-8375 created this table on
-- 2026-09-02) has none, and no onboarding fact distinguishes them from a
-- genuinely new member — both read `attempt IS NULL`. `users.created_at` does,
-- per reader and not org-scoped, so it is the discriminator here.
--
-- WHICH ROWS. Users whose row predates this migration AND who have no attempt
-- row. The bound is a LITERAL, not `CURRENT_TIMESTAMP`: a deploy applies this
-- some time after the branch is cut, and a literal leaves anyone who signs up
-- in that window PROMPTED rather than stamped. That is the safe direction — the
-- ticket exists to prompt new users, so the predicate errs toward prompting.
--
-- WHY A ROW AT ALL. `invites_sent_at` lives on this table, so there is nowhere
-- else to record the fact, and the alternative — a second runtime predicate
-- beside the column — is the org-scoped answer ISS-11670 removed wearing a new
-- name. Every invented column below was MEASURED against the real snapshot and
-- transition services before this was written, on both hosts:
--   * `state` is EXACTLY what `settledOnboardingState` already synthesizes and
--     reports for these readers today, so the row persists the server's own
--     current answer rather than inventing a new one. Measured:
--     `restoreOnboardingState` returns `Restored` (not `Unreadable` or
--     `UnreachableState`), the phase stays `ready`, and `isBlockingPhase` is
--     false — so no first-run takeover reopens, which is the failure this would
--     otherwise have caused for every existing user.
--   * `host` is documented as write-only provenance that nothing reads back
--     ("restoreOnboardingState resolves a stored state against the host of
--     whoever is READING"), and both hosts measured identically. It is a
--     required column on a row that exists to carry one marker, not a claim
--     about where anything happened.
--   * `experience_variant` measured inert: every client reads
--     `snapshot.experienceVariant ?? WorkspaceExperience.V2`.
--   * `revision` 0 measured safe: a transition later posted against the row is
--     ACCEPTED through the compare-and-swap path (0 to 1) where it used to take
--     the create path, with no duplicate row and the marker preserved.
--
-- `invites_sent_at` is the migration's own clock here, unlike the `UPDATE`
-- above which had the run's `completed_at` to use. There is no per-user
-- timestamp for this cohort at all, so the honest value is when this fact was
-- recorded, which is now.
--
-- `gen_random_uuid()` rather than a v7: Postgres 16 has no `uuidv7()`, and this
-- follows the backfill precedent already in this directory
-- (20260812160000_iss6058_branch_activity_atoms, and three others).
--
-- Idempotent two ways: the `NOT EXISTS` skips anyone who already has a row, and
-- `ON CONFLICT` covers the `(user_id, organization_id)` unique if a run is
-- created concurrently with this statement.
INSERT INTO "onboarding_attempts" (
  "id", "user_id", "organization_id", "experience_variant", "host", "state",
  "revision", "invites_sent_at", "created_at", "updated_at"
)
SELECT
  gen_random_uuid(),
  u."id",
  u."organization_id",
  'v2',
  'web',
  '{"version":1,"phase":"ready","history":["dashboard_available"],"accountProvider":null,"resuming":false,"organizationEstablished":true}'::jsonb,
  0,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "users" u
WHERE u."created_at" < TIMESTAMP '2026-09-30 18:00:00'
  AND NOT EXISTS (
    SELECT 1 FROM "onboarding_attempts" a
    WHERE a."user_id" = u."id" AND a."organization_id" = u."organization_id"
  )
ON CONFLICT ("user_id", "organization_id") DO NOTHING;
