-- ISS-5029: record when the desktop packer dropped retained revisions of a
-- component at its per-family entry cap or per-component variant byte budget,
-- so the detail read can say the revision history it shows is PARTIAL instead of
-- presenting a capped set as if it were complete.
--
-- Additive and non-destructive: NOT NULL with a `false` default, so every
-- existing row reads as "no evidence of truncation" (today's behaviour) with no
-- backfill, and an older API instance that never writes the column keeps working.
-- AlterTable
ALTER TABLE "agent_components" ADD COLUMN     "variants_truncated" BOOLEAN NOT NULL DEFAULT false;

-- ISS-5029 (wongk, #4391): record WHICH cap bound alongside the boolean. Only a
-- per-family cap bounds how many revisions the device holds, so only it lets the
-- detail read prove the cloud is short; a byte-budget stop proves nothing and
-- must be distinguishable. Nullable and additive — existing rows and any API
-- instance that never writes it read as "reason unknown", which is the same safe
-- default as "not truncated".
-- AlterTable
ALTER TABLE "agent_components" ADD COLUMN     "variants_truncated_reason" TEXT;
