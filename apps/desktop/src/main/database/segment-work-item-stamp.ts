/**
 * @file segment-work-item-stamp.ts
 * @description FEA-2272 (PRD-488, PLN-1197): the DB-facing half of optional
 * work-item labelling — read a session's persisted segment spans and its
 * artifact-link candidates, run the PURE resolver in `segment-work-item-ref.ts`
 * over them, and write the result back onto `session_activity_segments`.
 *
 * Split out of `write-core.ts` by FEA-4010 (AA-10): the stamping concern is
 * cohesive and self-contained (three functions, one table written), it is what
 * that work changed, and `write-core.ts` is a shrink-only grandfathered file. The
 * import path calls it as record group 7.5; the activity-segment and artifact-link
 * backfills call it directly, which is why it lives beside them rather than
 * inside the importer.
 */
import {
  type ArtifactRefRelation,
  ArtifactRefTargetKind,
} from "@repo/api/src/types/session-artifact-link";
import type { WorkItemOccurrence } from "../collectors/parsing/work-item-occurrences.js";
import { EVENT_INSERT_PARAM_CAP } from "./db-constants.js";
import type { Prisma } from "./generated/client.js";
import {
  resolveSegmentWorkItemRefs,
  type SegmentSpan,
  type WorkItemCandidate,
} from "./segment-work-item-ref.js";

/** Read a session's persisted activity-segment spans (epoch-ms) for stamping. */
async function readSegmentSpans(
  tx: Prisma.TransactionClient,
  sessionId: string
): Promise<(SegmentSpan & { workItemRef: string | null })[]> {
  const rows = await tx.sessionActivitySegment.findMany({
    where: { sessionId },
    // workItemRef is read alongside the span so the stamp can detect a REAL
    // change (resolved value differs from stored) and dirty-mark the session for
    // cloud re-sync (FEA-3568) — the resolver itself ignores this extra field.
    // `phase` gates the AA-10 idle rule (an idle span claims no work item).
    select: {
      id: true,
      startMs: true,
      endMs: true,
      phase: true,
      workItemRef: true,
    },
  });
  // start_ms / end_ms are BIGINT columns (surfaced as bigint via the delegate).
  return rows.map((row) => ({
    id: row.id,
    startMs: Number(row.startMs),
    endMs: Number(row.endMs),
    phase: row.phase,
    workItemRef: row.workItemRef ?? null,
  }));
}

/**
 * Read a session's work-item candidate links — its `session_artifact_links`
 * joined to their `artifacts`, restricted to the kinds that can label a segment
 * (`commit` is deliberately excluded: commits drive rail dots, not segment refs).
 * `occurredAtMs` is null for every included kind: the store carries no trustworthy
 * per-occurrence transcript time for slugs / PRs / branches (only the
 * session-level `observed_at`), so the session-level fan-out applies — the
 * documented, correct behavior (PLN-1197 Open Q #3).
 */
async function readWorkItemCandidates(
  tx: Prisma.TransactionClient,
  sessionId: string
): Promise<WorkItemCandidate[]> {
  const rows = await tx.sessionArtifactLink.findMany({
    where: {
      sessionId,
      artifact: {
        kind: {
          in: [
            ArtifactRefTargetKind.ClosedloopArtifact,
            ArtifactRefTargetKind.PullRequest,
            ArtifactRefTargetKind.Branch,
          ],
        },
      },
    },
    select: {
      relation: true,
      isPrimary: true,
      artifact: {
        select: {
          slug: true,
          kind: true,
          prNumber: true,
          branchName: true,
          repoFullName: true,
        },
      },
    },
  });
  return rows.map((row) => ({
    slug: row.artifact.slug,
    kind: row.artifact.kind as ArtifactRefTargetKind,
    relation: row.relation as ArtifactRefRelation,
    isPrimary: row.isPrimary,
    occurredAtMs: null,
    prNumber: row.artifact.prNumber ?? null,
    branchName: row.artifact.branchName,
    repoFullName: row.artifact.repoFullName,
  }));
}

/**
 * FEA-2272 (PLN-1197): stamp each of a session's activity segments with its
 * optional `work_item_ref`, projected from the session's already-persisted
 * artifact links. STRICTLY a projection: segment geometry (count, order, spans)
 * is never touched — only the nullable column is written, including back to NULL
 * for segments no link resolves to, so re-import / link re-derivation converges
 * (idempotent). Reads only DB rows (no filesystem, no transcript), so callers can
 * — and do — run it inside a tolerant group: a failure leaves the tiling intact.
 *
 * One UPDATE per distinct resolved value keeps the common case (a session-level
 * slug applied to every segment) a single statement; id lists are param-capped
 * exactly like the chunked event inserts.
 */
export async function stampSegmentWorkItemRefs(
  tx: Prisma.TransactionClient,
  sessionId: string,
  occurrences: readonly WorkItemOccurrence[]
): Promise<number> {
  const segments = await readSegmentSpans(tx, sessionId);
  if (segments.length === 0) {
    return 0;
  }
  const candidates = await readWorkItemCandidates(tx, sessionId);
  const refBySegmentId = resolveSegmentWorkItemRefs(
    segments,
    candidates,
    occurrences
  );

  // Count segments whose resolved ref actually DIFFERS from the stored value —
  // the honest "changed" signal. The non-null UPDATE below is intentionally
  // unguarded (it must also fill freshly-NULL rows), so its updateMany count
  // includes same-value rewrites and can't be used for this; compare against the
  // value read alongside the span instead. Callers dirty-mark the session for
  // cloud re-sync only when this is > 0 (FEA-3568).
  let changed = 0;
  // Group segment ids by their resolved ref value (null included) so each
  // distinct value — usually just one per session — is a single set-based UPDATE.
  const idsByValue = new Map<string | null, string[]>();
  for (const segment of segments) {
    const value = refBySegmentId.get(segment.id) ?? null;
    if (value !== segment.workItemRef) {
      changed += 1;
    }
    const ids = idsByValue.get(value);
    if (ids) {
      ids.push(segment.id);
    } else {
      idsByValue.set(value, [segment.id]);
    }
  }

  // Clearing back to NULL (value === null) is the common no-link case:
  // persistActivitySegments just wrote every row NULL, so guard on
  // `workItemRef: { not: null }` (→ IS NOT NULL) and touch ZERO rows on that hot
  // import/backfill path while still clearing any stale ref. Stamping a real value
  // is unguarded — Prisma's `{ not: value }` would skip the NULL rows we must
  // fill, and re-stamping the same slug is a rare, idempotent no-op. `id` chunks
  // stay two below the param cap so a large tiling can't blow the SQLite variable
  // limit.
  const idsPerStatement = EVENT_INSERT_PARAM_CAP - 2;
  for (const [value, ids] of idsByValue) {
    for (let i = 0; i < ids.length; i += idsPerStatement) {
      const chunk = ids.slice(i, i + idsPerStatement);
      await tx.sessionActivitySegment.updateMany({
        where: {
          sessionId,
          id: { in: chunk },
          ...(value === null ? { workItemRef: { not: null } } : {}),
        },
        data: { workItemRef: value },
      });
    }
  }
  return changed;
}
