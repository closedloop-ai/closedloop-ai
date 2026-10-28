/**
 * @file organization-synced-session-data.ts
 * @description ISS-8375: the guard input behind the Web `DownloadDesktop` skip.
 * A different resource (`app/onboarding/guided/`) composes it into the
 * onboarding snapshot, which is why it is a top-level sibling here rather than
 * a member of `service/` — that directory is the composition root's private
 * internals and is not importable across resources.
 */

import { ArtifactType } from "@repo/api/src/types/artifact";
import { KnownFlag } from "@repo/api/src/types/onboarding-phase";
import { withDb } from "@repo/database";
import { log } from "@repo/observability/log";

/**
 * Whether `organizationId` has any session data in the cloud right now.
 *
 * Returns the tri-state rather than a boolean, and never throws. PRD-689's
 * blind-scope authority is that "Unknown/error is not false and never grants a
 * capability": coercing a failed read to `No` silently denies the gate and
 * coercing it to `Yes` silently grants it, so the failure has to survive as its
 * own value all the way to the guard. Callers must not wrap this in a
 * try/catch — there is nothing left to catch.
 *
 * Semantics are "data present NOW", decided 2026-08-31, not "has ever synced",
 * so an org whose rows all aged out of retention is honestly re-blocked. The
 * live consumer is the required-phase swap in
 * `app/onboarding/guided/snapshot-service.ts`; ISS-12482 moved the Web download
 * skip off this field onto the snapshot's `membership`.
 *
 * The `where` is deliberately just the two columns, which seeks the
 * `@@index([organizationId, type, status])` prefix. Every predicate below was
 * considered and rejected; each will otherwise read as an omission.
 *
 * - `origin: DESKTOP_SYNC` — `origin` only exempts a row from the retention
 *   sweeps, so filtering on it here could under-report orgs that really do
 *   have synced data.
 * - a substantive/idle predicate — the desktop withholds unsubstantive sessions
 *   from sync in the first place, so a row's existence IS the proof.
 * - `pendingChunkRevision` — a chunk in flight is real data mid-arrival, not a
 *   stub to skip over.
 * - `dataRevision` / `dataSyncLevel` — legitimately NULL on older desktop
 *   builds, so filtering on either silently drops real orgs.
 * - `status` — free-form TEXT carrying several disjoint vocabularies
 *   (`schema.prisma`, `Artifact.status`), not a discriminator.
 * - `deletedAt` — `artifacts` has no such column, and neither does
 *   `session_detail`; session deletion is a hard cascade. (`BranchDetail` and
 *   the GitHub comment projections are the soft-deleted models, not this one.)
 *
 * There is no `orderBy` on purpose: `findFirst` may take an arbitrary matching
 * row, so the query stays an index seek that stops at the first hit.
 */
export async function organizationHasSyncedSessionData(
  organizationId: string
): Promise<KnownFlag> {
  try {
    const session = await withDb((db) =>
      db.artifact.findFirst({
        where: { organizationId, type: ArtifactType.Session },
        select: { id: true },
      })
    );
    return session ? KnownFlag.Yes : KnownFlag.No;
  } catch (error) {
    log.error(
      "[organization-synced-session-data] synced session probe failed",
      {
        organizationId,
        error: error instanceof Error ? error.message : String(error),
      }
    );
    return KnownFlag.Unknown;
  }
}
