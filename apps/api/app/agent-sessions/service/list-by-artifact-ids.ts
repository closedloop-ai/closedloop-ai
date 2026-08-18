import type { AgentSessionListItem } from "@repo/api/src/types/agent-session";
import { withDb } from "@repo/database";
import { sessionTranscriptGroupKey } from "../transcript-availability";
import { isUuid } from "./coercion";
import { getReconciledCostsBySessionId } from "./cost-reconciled-reader";
import { loadListTranscriptDispositions } from "./list-transcript-dispositions";
import { toSessionListItem } from "./projections";
import { findSourceArtifactsById } from "./query-builder";
import { agentSessionListSelect } from "./records";
import { SESSION_DEFAULT_ORDER_BY } from "./session-sort-order";

/**
 * Fetch org-scoped session list-item summaries for a set of Session artifact
 * ids (`SessionDetail.artifactId`), in the same wire shape the Sessions page
 * consumes. Reuses `agentSessionListSelect` + `toSessionListItem` so callers
 * (e.g. the agent-component detail "Sessions" tab) never re-derive the list
 * projection. Rows are org-scoped via `artifact.organizationId`; ids from
 * another org are silently dropped. Ordered by the canonical
 * `SESSION_DEFAULT_ORDER_BY`. An empty id list short-circuits with no query.
 *
 * Extracted from the `agentSessionsService` composition root (FEA-4276): it is
 * the same list-page read + cost-reconciled projection concern as
 * `list-page-fetch.ts`, so it lives beside it rather than fattening `service.ts`.
 */
export async function listSessionsByArtifactIds(
  organizationId: string,
  artifactIds: readonly string[],
  // ISS-5464: optional row bound, applied as `take` INSIDE the query so the
  // per-row enrichment below (source artifacts, reconciled costs, transcript
  // dispositions) runs over the retained rows only rather than over every id the
  // caller passed. Omitted means unbounded, as before.
  limit?: number
): Promise<AgentSessionListItem[]> {
  const ids = [...new Set(artifactIds)].filter(isUuid);
  if (ids.length === 0) {
    return [];
  }

  const records = await withDb((db) =>
    db.sessionDetail.findMany({
      where: {
        artifactId: { in: ids },
        artifact: { is: { organizationId } },
      },
      select: agentSessionListSelect,
      // ISS-5464: the canonical Sessions order, NOT a hand-rolled
      // `{ lastActivityAt: "desc" }`. Two reasons, both load-bearing once `take`
      // moves the slice server-side. `lastActivityAt` is nullable, and Postgres
      // sorts DESC NULLS FIRST — so never-active sessions would float to the top
      // and could consume the whole bound. And a bare column is not a total
      // order: rows tied on `lastActivityAt` would be cut at an arbitrary,
      // run-to-run-unstable boundary once the planner takes a top-N path (the
      // ISS-5307 class of bug). `SESSION_DEFAULT_ORDER_BY` pins `nulls: "last"`
      // and closes ties with `sessionStartedAt` then the unique artifact key.
      orderBy: SESSION_DEFAULT_ORDER_BY,
      // Floor at 1 so a caller passing 0/negative cannot invert into "no bound";
      // `undefined` keeps the unbounded read.
      ...(limit === undefined ? {} : { take: Math.max(1, limit) }),
    })
  );

  const sourceArtifactsById = await findSourceArtifactsById(
    organizationId,
    records.map((record) => record.sourceArtifactId)
  );
  // FEA-4276: reconcile cost against the per-event token stream so this list
  // surface (agent-component "Sessions" tab) matches the session detail card.
  const costAuthorityById = await getReconciledCostsBySessionId({
    organizationId,
    sessionIds: records.map((record) => record.artifactId),
  });
  // ISS-4621 (review): batch the transcript disposition exactly like the main
  // Sessions list, so this surface's `cloudSyncState` goes through the same
  // reconciliation. Passing `undefined` here left the pre-ISS-4621 hardcoded
  // `synced` on the agent-component "Sessions" tab while list/detail reported
  // `pending` for the same missing/uploading transcript.
  const transcriptDispositionByKey = await loadListTranscriptDispositions(
    organizationId,
    records.map((record) => ({
      computeTargetId: record.computeTarget.id,
      externalSessionId: record.externalSessionId,
    }))
  );

  return records.map((record) =>
    toSessionListItem(
      record,
      sourceArtifactsById,
      transcriptDispositionByKey.get(
        sessionTranscriptGroupKey({
          computeTargetId: record.computeTarget.id,
          externalSessionId: record.externalSessionId,
        })
      ),
      costAuthorityById.get(record.artifactId)
    )
  );
}
