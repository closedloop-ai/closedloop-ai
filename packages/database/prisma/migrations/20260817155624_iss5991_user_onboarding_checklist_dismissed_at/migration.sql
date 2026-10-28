-- AlterTable
ALTER TABLE "users" ADD COLUMN     "onboarding_checklist_dismissed_at" TIMESTAMP(3);

-- ISS-5991: checklist dismissal used to live org-wide in
-- organizations.settings.onboarding, so one member's dismissal hid the checklist
-- for everyone. Hand-written because this is a data migration, which Prisma
-- cannot generate from schema.prisma: carry the org-level value onto every
-- current member so nobody sees the checklist reappear.
--
-- The cast runs per organization inside its own exception block, so an
-- unparseable legacy value is SKIPPED (that org's members simply see the
-- checklist again) instead of raising. Prisma runs this file in one
-- transaction, so a single bad row would otherwise abort the migration and
-- block the deploy for every org -- the exact outcome this guard exists to
-- prevent. A shape guard alone cannot deliver that: any regex that admits
-- '2026-02-31T00:00:00.000Z' admits a value Postgres refuses to cast, and one
-- that rejects it would have to encode the calendar.
DO $$
DECLARE
  org RECORD;
  dismissed_at timestamp(3);
BEGIN
  FOR org IN
    SELECT o."id" AS id,
           o."settings" -> 'onboarding' ->> 'checklistDismissedAt' AS raw
    FROM "organizations" o
    WHERE jsonb_typeof(o."settings" -> 'onboarding' -> 'checklistDismissedAt') = 'string'
  LOOP
    BEGIN
      dismissed_at := (org.raw::timestamptz AT TIME ZONE 'UTC')::timestamp(3);
    EXCEPTION
      WHEN others THEN
        CONTINUE;
    END;

    UPDATE "users"
    SET "onboarding_checklist_dismissed_at" = dismissed_at
    WHERE "organization_id" = org.id;
  END LOOP;
END $$;
