import { TranscriptDisposition } from "@repo/api/src/types/transcript-disposition-constants";
import { withDb } from "@repo/database";
import {
  deriveTranscriptDispositionsBySession,
  sessionTranscriptGroupKey,
} from "../transcript-availability";

/**
 * PRD-536 G1 (Phase 3): load + fold the per-session transcript disposition for a
 * Sessions LIST page in one batched query. Filters `SessionTranscript` by the
 * page's exact `(computeTargetId, externalSessionId)` session identities within
 * the org — the same identity the detail enrichment reads, minus the per-session
 * round-trip — then groups + folds via `deriveTranscriptDispositionsBySession`.
 *
 * The WHERE is a set of composite identity predicates rather than a bare
 * `externalSessionId IN (...)` so Postgres can use the
 * `(computeTargetId, externalSessionId, fileKey)` unique index and the scan is
 * bounded by the page's identities, not the org's entire transcript history
 * (codex P2): with only an `organizationId` index available, a bare
 * `externalSessionId IN (...)` for an org with many archived transcript rows can
 * force a large per-org scan on every list response even when the flag is off.
 * Returns an empty map when the page is empty so callers skip the query.
 * `computeTargetId` is part of the group key AND the identity predicate so a rare
 * cross-target `externalSessionId` collision still folds to the right session.
 *
 * ISS-4621 list↔detail parity: a REQUESTED session that returned zero
 * `SessionTranscript` rows is synthesized as `syncing`, NOT omitted. A session
 * always expects a `main` transcript (PRD AC6), so the detail path already
 * synthesizes a `missing` main → `syncing` → `pending` for the zero-row case; if
 * the list path instead omitted the key, `reconcileCloudSyncState(undefined)`
 * would stamp `synced` and the same zero-row session would read `synced` in the
 * list but `pending` on detail. Folding zero-row requested identities to
 * `syncing` here makes both producers agree. (A session genuinely not expected to
 * have a transcript would need a `neverExpected` signal, which no cloud producer
 * emits today — every cloud session expects a main file.)
 */
export async function loadListTranscriptDispositions(
  organizationId: string,
  items: { computeTargetId: string; externalSessionId: string }[]
): Promise<Map<string, TranscriptDisposition>> {
  const identityByKey = new Map<
    string,
    { computeTargetId: string; externalSessionId: string }
  >();
  for (const item of items) {
    identityByKey.set(sessionTranscriptGroupKey(item), {
      computeTargetId: item.computeTargetId,
      externalSessionId: item.externalSessionId,
    });
  }
  if (identityByKey.size === 0) {
    return new Map();
  }
  const rows = await withDb((db) =>
    db.sessionTranscript.findMany({
      where: {
        organizationId,
        OR: [...identityByKey.values()].map((identity) => ({
          computeTargetId: identity.computeTargetId,
          externalSessionId: identity.externalSessionId,
        })),
      },
      select: {
        fileKey: true,
        uploadStatus: true,
        uploadedAt: true,
        lastObservedAt: true,
        permanentFailureReason: true,
        computeTargetId: true,
        externalSessionId: true,
      },
    })
  );
  const dispositionByKey = deriveTranscriptDispositionsBySession(rows);
  // ISS-4621 list↔detail parity: every REQUESTED identity that returned no rows
  // is synthesized as `syncing` (the detail path already does this via the
  // synthesized `missing` main), so a zero-transcript session cannot read
  // `synced` in the list while reading `pending` on detail.
  for (const key of identityByKey.keys()) {
    if (!dispositionByKey.has(key)) {
      dispositionByKey.set(key, TranscriptDisposition.Syncing);
    }
  }
  return dispositionByKey;
}
