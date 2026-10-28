/**
 * ISS-8604: the half of the create-arm correction that can only be made AFTER
 * the upsert, because it needs to know which arm the DATABASE took.
 *
 * `upsert-arm-detail.ts` handles everything decidable from the payload alone.
 * Two things are not: a slug costs a counter increment, so it must not be paid
 * on every apply; and the PR LINK lane runs downstream of the upsert on a
 * freshness decision made against the pre-upsert read. Both are resolved here,
 * once, from one fact — see {@link repairCreateArmRace}.
 */

import { SlugPrefix } from "@repo/api/src/types/slug-prefix";
import { generateSlug } from "@/lib/slug-generator";
import type { AgentSessionUpsertTx } from "./records";

/**
 * Reconcile the post-upsert lanes with the arm Postgres actually took, and
 * return the PR-link freshness decision they should use.
 *
 * WHICH ARM RAN. The upsert writes under the key the row was found under
 * (`resolveStoredIndexKey`), so an UPDATE lands on `existingArtifactId` by
 * construction; a different id coming back means the row was swept between the
 * read and the write and Postgres created a fresh artifact. A null
 * `existingArtifactId` is a plain create and needs no repair at all — every gate
 * upstream already resolved against no stored row. This is the same seam
 * ISS-8552 reads `persisted.sessionEndedAt` through, taken at the id instead.
 *
 * THE SLUG (review, marisolashgrove). The slice resolves `slug` from that same
 * pre-upsert read, so on the race path it is `undefined` and the create arm
 * mints an artifact with a NULL slug. `Artifact.slug` is `String?` under
 * `@@unique([organizationId, slug])`, so Postgres accepts any number of NULLs
 * and nothing raises — and the update arm writes only name/status/project, so
 * that row would never acquire one on any later sync. It would stay
 * unaddressable by slug forever: `resolveArtifactSlugMap` matches on
 * `slug: { in: [...] }`, which no NULL satisfies, so a `SES-` ref from another
 * session could never resolve to it. Minted HERE rather than unconditionally
 * before the upsert because `generateSlug` increments the org's session counter
 * — paying it on every apply would burn a slug number per sync of every session
 * and leave the visible series full of holes. Rare by construction, so the
 * ordinary sync issues no extra write.
 *
 * THE PR LINKS (review, whitlockk). `resolveSessionFreshnessGates` opens both PR
 * lanes whenever there is no stored row — a row that does not exist has no newer
 * canonical set to protect — and a swept row IS that case, adjudicated against a
 * watermark that no longer exists. Left uncorrected, a stale payload created an
 * artifact and then declined to link its own PRs to it; and unlike the
 * freshness-SUPPRESSED columns, which the next fresher batch simply writes, an
 * ended session's frozen `updatedAt` means no later batch relitigates this one,
 * so the association is absent permanently. The blob half of the same correction
 * is `resolveCreateArmDetail`'s `pullRequests`, resolved before the upsert.
 */
export async function repairCreateArmRace(
  tx: AgentSessionUpsertTx,
  input: {
    organizationId: string;
    /** `null` when the pre-upsert read found nothing — a plain create. */
    existingArtifactId: string | null;
    persistedArtifactId: string;
    /** `freshness.shouldUpdatePullRequestLinks`, as the pre-upsert read saw it. */
    freshPullRequestLinks: boolean;
  }
): Promise<{ shouldUpdatePullRequestLinks: boolean }> {
  const tookCreateArm =
    input.existingArtifactId !== null &&
    input.persistedArtifactId !== input.existingArtifactId;
  if (!tookCreateArm) {
    return { shouldUpdatePullRequestLinks: input.freshPullRequestLinks };
  }
  await tx.artifact.update({
    where: { id: input.persistedArtifactId },
    data: {
      slug: await generateSlug(input.organizationId, SlugPrefix.Session),
    },
    // The result is discarded, so name the primary key: an unnarrowed write
    // asks Postgres for `RETURNING *` and materialises every column of the row
    // for a value nobody reads (`no-discarded-wide-prisma-write`). `update`
    // rather than `updateMany` on purpose — the row was created moments ago in
    // this same transaction, so a `where` that matches nothing is a bug, and
    // only `update` raises `P2025` for it.
    select: { id: true },
  });
  return { shouldUpdatePullRequestLinks: true };
}
