import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import type { SessionAttributionResolverCache } from "../agent-sync/agent-session-attribution.js";
import type {
  LocalSessionListProjectionRequest,
  LocalSessionListProjectionResponse,
} from "../agent-sync/agent-session-read-model.js";
import type { SyncedAgentSession } from "../agent-sync/agent-session-sync-contract.js";
import type { AgentSessionSyncSource } from "../agent-sync/agent-session-sync-source.js";
import {
  billingModeAt,
  resolveBillingModesNonBlocking,
} from "../cost/billing-mode-detector.js";
import { projectLocalSessionList } from "../session/local-session-list-projection.js";
import { LIST_LOAD } from "../session/shared-agent-sessions-load-shapes.js";
import { yieldDbHostLoop } from "./db-host/yield-db-host-loop.js";
import type { SqliteSessionRow } from "./db-row-types.js";
import type { DesktopPrisma } from "./prisma-client.js";
import { groupRowsBySessionId } from "./session-detail-mappers.js";
import { mapSessionListFacts } from "./session-list-facts-mapper.js";
import { buildSessionListTraceProjection } from "./session-list-trace-builder.js";
import {
  ensureSessionListTraceProjections,
  readSessionListTraceProjections,
} from "./session-list-trace-projection.js";
import {
  persistResolvedRepoFullNames,
  resolveSyncAttributions,
} from "./sync-attribution-resolution.js";
import { readArtifactLinkRows } from "./sync-source-rollup-reads.js";
import { selectSessionRows } from "./sync-source-session-rows.js";
import {
  selectInvocationCountRows,
  selectListTokenUsageRows,
} from "./sync-source-usage-rows.js";

const LIST_READ_CHUNK_IDS = 200;
const MAX_LIST_PROJECTION_REPAIR_ATTEMPTS = 2;

/** Clone-safe DB-host entry point for the complete local Sessions list response. */
export function readSessionListProjection(
  prisma: DesktopPrisma,
  source: AgentSessionSyncSource,
  input: LocalSessionListProjectionRequest
): Promise<LocalSessionListProjectionResponse> {
  return projectLocalSessionList(source, input, (ids, cache) =>
    loadListRows(prisma, ids, cache)
  );
}

/** Read only compact facts and bounded relations consumed by list projection. */
async function loadListRows(
  prisma: DesktopPrisma,
  ids: string[],
  cache: SessionAttributionResolverCache
): Promise<SyncedAgentSession[]> {
  const sessions: SyncedAgentSession[] = [];
  for (let start = 0; start < ids.length; start += LIST_READ_CHUNK_IDS) {
    const chunk = ids.slice(start, start + LIST_READ_CHUNK_IDS);
    const rows = await readListChunkWithProjectionRepair(prisma, chunk);
    const linksBySessionId = groupRowsBySessionId(rows.artifactLinkRows);
    const tokenRowsBySessionId = groupRowsBySessionId(rows.tokenRows);
    const { bySessionId, writeBacks } = await resolveSyncAttributions(
      rows.sessionRows,
      cache,
      linksBySessionId
    );
    const sessionRows = rows.sessionRows as SqliteSessionRow[];
    const billingModes = await resolveBillingModesNonBlocking(
      sessionRows.map((row) => ({
        billingMode: row.billing_mode,
        harness: row.harness,
        model: row.model,
      }))
    );
    for (const [rowIndex, row] of sessionRows.entries()) {
      const projection = rows.projections.get(row.id);
      if (!projection) {
        throw new Error(`Missing list trace projection for session ${row.id}`);
      }
      sessions.push(
        mapSessionListFacts({
          row,
          billingMode: billingModeAt(billingModes, rowIndex),
          projection,
          tokenRows: tokenRowsBySessionId.get(row.id) ?? [],
          invocationCount: rows.invocationCountBySessionId.get(row.id) ?? 0,
          attribution: bySessionId.get(row.id),
        })
      );
    }
    await persistResolvedRepoFullNames(prisma, writeBacks);
    if (start + LIST_READ_CHUNK_IDS < ids.length) {
      await yieldDbHostLoop();
    }
  }
  return sessions;
}

async function readListChunkWithProjectionRepair(
  prisma: DesktopPrisma,
  ids: string[]
) {
  for (
    let repairAttempt = 0;
    repairAttempt <= MAX_LIST_PROJECTION_REPAIR_ATTEMPTS;
    repairAttempt += 1
  ) {
    const rows = await readListChunkSnapshot(
      prisma,
      ids,
      repairAttempt === MAX_LIST_PROJECTION_REPAIR_ATTEMPTS
    );
    const idsToRepair = rows.sessionRows
      .filter(
        (row) =>
          row.status !== SESSION_STATUS.ACTIVE && !rows.projections.has(row.id)
      )
      .map((row) => row.id);
    if (idsToRepair.length === 0) {
      return rows;
    }
    if (repairAttempt === MAX_LIST_PROJECTION_REPAIR_ATTEMPTS) {
      break;
    }
    await ensureSessionListTraceProjections(
      prisma,
      idsToRepair,
      buildSessionListTraceProjection
    );
  }
  throw new Error(
    `List trace projection remained invalidated after ${MAX_LIST_PROJECTION_REPAIR_ATTEMPTS} repair attempts`
  );
}

function readListChunkSnapshot(
  prisma: DesktopPrisma,
  ids: string[],
  buildMissingProjections = false
) {
  return prisma.read((reader) =>
    reader.$transaction(async (snapshot) => {
      // Metadata-derived list fields come from the validated trace projection.
      // Active rows build that projection from their own snapshot query below;
      // inactive rows read the persisted projection. Keep the base row shape
      // while avoiding a second copy of the blob in the ordinary list read.
      const sessionRows = await selectSessionRows(snapshot, ids, {
        ...LIST_LOAD,
        omitMetadata: true,
      });
      const tokenRows = await selectListTokenUsageRows(snapshot, ids);
      const invocationCountBySessionId = await selectInvocationCountRows(
        snapshot,
        ids
      );
      const artifactLinkRows = await readArtifactLinkRows(snapshot, ids, {
        omitLinkEvidence: true,
      });
      const projections = await readSessionListTraceProjections(snapshot, ids);
      for (const row of sessionRows) {
        if (row.status === SESSION_STATUS.ACTIVE) {
          await buildAndSetProjection(snapshot, row.id, projections);
        } else if (buildMissingProjections && !projections.has(row.id)) {
          await buildAndSetProjection(snapshot, row.id, projections);
        }
      }
      return {
        sessionRows,
        tokenRows,
        invocationCountBySessionId,
        artifactLinkRows,
        projections,
      };
    })
  );
}

async function buildAndSetProjection(
  snapshot: Parameters<typeof buildSessionListTraceProjection>[0],
  sessionId: string,
  projections: Awaited<ReturnType<typeof readSessionListTraceProjections>>
): Promise<void> {
  const projection = await buildSessionListTraceProjection(snapshot, sessionId);
  if (projection) {
    projections.set(sessionId, projection);
  } else {
    projections.delete(sessionId);
  }
}
