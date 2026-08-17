import type { DesktopAgentSessionsPayload } from "@repo/api/src/types/agent-session";
import { withDb } from "@repo/database";
import { emitTelemetryMetric } from "@repo/observability/telemetry/metrics";
import { frustrationSettingService } from "@/app/settings/frustration-setting-service";
import { resolveArtifactSlugMap } from "./artifact-links/slug-links";
import {
  stampIngestSyncWatermark,
  stampIngestWatermarkAfterFailedBatch,
} from "./ingest-sync-stamp";
import {
  type LoopSessionBacklink,
  linkLoopSessionArtifact,
} from "./loop-session-backlink";
import { resolveProjectResolution } from "./project-resolution";
import type { UpsertSessionsContext } from "./records";
import { SessionSyncMetric } from "./session-sync-metrics";
import { createStatusFoldTally } from "./status-fold-telemetry";
import { upsertSessionSlice } from "./upsert-session-slice";

// Guardrail for each bounded per-session write slice; pre-resolution reads and
// the final target watermark run outside this transaction.
const AGENT_SESSION_UPSERT_TX_TIMEOUT_MS = 30_000;
const AGENT_SESSION_UPSERT_TX_MAX_WAIT_MS = 5000;

/**
 * The desktop-sync ingest batch: resolve once what every per-session slice
 * needs, apply each session in its own bounded transaction, then stamp the
 * target watermarks.
 *
 * Lifted out of `service.ts` (which is grandfathered shrink-only) alongside the
 * FEA-1718 back-link, following the `buildUsageSummary` precedent: the service
 * object keeps the method because the route and its tests address it, while the
 * ingest sequencing lives with the slice it drives.
 *
 * Multi-session payloads remain accepted for version skew even though the
 * desktop now sends one session per request, and each slice commits on its own —
 * so a batch that fails partway leaves the already-committed sessions durable,
 * which is exactly what the landed-data watermark in the `finally` reports.
 *
 * Goal stage 2 (atomic row-level ack): resolves to the `externalSessionId`s
 * this batch actually PERSISTED, so the desktop's outbox clear can be keyed on
 * server truth rather than on what the client sent. A slice that deliberately
 * did not write (a foreign chunk — one whose revision does not match the
 * server's pending assembly) reports `persisted: false`, and its id must NOT
 * appear in the ack echo: echoing it would let the desktop clear a row the
 * server never stored, which is silent loss.
 *
 * What may be hoisted into the batch-wide preflight below, and what may NOT.
 * The project and slug maps are safe to resolve once here: they are pooled reads
 * and nothing locks on them. The repository-default authority map is NOT — it
 * stays in `upsert-session-slice.ts`, inside each slice's write transaction,
 * because eligibility authority is mutable and must not change between
 * validation and branch/PR-head materialization (ISS-5827 / COMMON-021).
 * Hoisting `resolveBranchRepoMap` up here to "remove the N+1" would break it
 * silently rather than loudly: `readLockedAuthorityRows` takes
 * `FOR SHARE OF repository, installation`, and a row lock taken through pooled
 * `withDb` is released at statement end, so the caller would still receive an
 * identical-looking map with no lock behind it and no test would distinguish
 * the two.
 */
export async function upsertSessionsBatch(
  context: UpsertSessionsContext,
  payload: DesktopAgentSessionsPayload
): Promise<{ persistedSessionIds: string[] }> {
  const syncTimestamp = new Date();

  // FEA-4022: resolve the org's `calculateSessionFrustration` gate ONCE for the
  // batch BEFORE opening the interactive transaction (a pooled read, keeping the
  // transaction narrow per the serverless-tx guidance). When the org has not
  // opted in, the desktop-computed raw frustration signal is dropped at ingest —
  // never written to SessionDetail — so the column stays NULL and Insights
  // renders an empty state.
  const includeFrustration =
    await frustrationSettingService.isFrustrationEnabled(
      context.organizationId
    );

  let batchSucceeded = false;
  // Stage 2 tracks the ids actually persisted (the ack echo is keyed on them);
  // the count the watermark reports is derived from that list rather than
  // maintained as a second, independently-incremented counter.
  const persistedSessionIds: string[] = [];
  const statusFoldTally = createStatusFoldTally();
  try {
    const { projectResolution, slugMap } = await withDb(async (db) => {
      const target = await db.computeTarget.findFirst({
        where: {
          id: context.computeTargetId,
          organizationId: context.organizationId,
        },
        select: {
          id: true,
        },
      });
      if (!target) {
        throw new Error("compute_target_not_found");
      }

      const [resolvedProjects, resolvedSlugs] = await Promise.all([
        resolveProjectResolution(db, context.organizationId, payload.sessions),
        resolveArtifactSlugMap(db, context.organizationId, payload.sessions),
      ]);

      return {
        projectResolution: resolvedProjects,
        slugMap: resolvedSlugs,
      };
    });

    for (const session of payload.sessions) {
      const outcome = await withDb.tx(
        (tx) =>
          upsertSessionSlice(tx, {
            context,
            includeFrustration,
            projectResolution,
            session,
            slugMap,
            syncTimestamp,
          }),
        {
          timeout: AGENT_SESSION_UPSERT_TX_TIMEOUT_MS,
          maxWait: AGENT_SESSION_UPSERT_TX_MAX_WAIT_MS,
        }
      );
      const { loopBacklink, persisted } = outcome;
      if (persisted) {
        persistedSessionIds.push(session.externalSessionId);
      }
      statusFoldTally.record(outcome);
      // FEA-1718: claim `Loop.sessionArtifactId` for the session that just
      // materialized. Deliberately AFTER the slice transaction has committed —
      // the target column is uniquely indexed, so this write can lose a race,
      // and AGENTS.md forbids recovering from a failed write inside the same
      // interactive transaction.
      //
      // BEST-EFFORT, and scoped to this session (wongk, review). The session is
      // already durable when this runs, and the batch may carry more sessions
      // behind it, so a failed derived edge must not abort their ingest — that
      // would be the cross-repo "never block core flows" break, reachable from
      // nothing worse than a transient error on a version-skewed multi-session
      // payload. The failure is counted, not absorbed silently, and the next
      // sync of this session re-attempts the claim.
      if (loopBacklink) {
        await applyLoopBacklink(loopBacklink, context.organizationId);
      }
    }

    batchSucceeded = true;
  } finally {
    // ISS-5648 (wongk, PR #4786): one aggregate emission per source for the
    // whole request, never one per session. Rationale, and why `finally`:
    // `service/status-fold-telemetry.ts`.
    statusFoldTally.emit(context);
    const persistedSessionCount = persistedSessionIds.length;
    if (batchSucceeded) {
      await withDb((db) =>
        stampIngestSyncWatermark(db, {
          computeTargetId: context.computeTargetId,
          persistedSessionCount,
          syncTimestamp,
        })
      );
    } else {
      await stampIngestWatermarkAfterFailedBatch({
        computeTargetId: context.computeTargetId,
        persistedSessionCount,
        syncTimestamp,
      });
    }
  }
  return { persistedSessionIds };
}

/**
 * Apply a back-link without letting its failure reach the batch loop.
 *
 * The owning session has already committed by the time this runs, so the only
 * thing a throw could still destroy is the ingest of the sessions QUEUED BEHIND
 * it in the same payload. That trade is never worth a derived edge, so every
 * failure is counted and dropped here rather than propagated.
 */
async function applyLoopBacklink(
  backlink: LoopSessionBacklink,
  organizationId: string
): Promise<void> {
  try {
    await linkLoopSessionArtifact(backlink);
  } catch {
    // AGENTS.md "Handling Bad or Nonsensical Data": an accepted loss is routed
    // to the monitored path, never absorbed silently.
    emitTelemetryMetric({
      metric: SessionSyncMetric.LoopSessionBacklinkFailed,
      organizationId,
      count: 1,
    });
  }
}
