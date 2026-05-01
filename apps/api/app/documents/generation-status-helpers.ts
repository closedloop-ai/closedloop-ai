import {
  type GenerationStatus,
  getGenerationStatusRunKey,
} from "@repo/api/src/types/document";
import { withDb } from "@repo/database";
import {
  mapLoopCommand,
  mapLoopStatus,
  NONE_STATUS,
  pickBestStatus,
} from "@/lib/loops/loop-status-utils";

/**
 * Helpers for resolving the "best" `GenerationStatus` for a document.
 *
 * A document's status is derived from two sources:
 *  - Most recent `gitHubActionRun` whose `triggerData.documentId` matches.
 *  - Loop records (`loop` rows) for the document.
 *
 * `pickBestStatus` reconciles them with active > terminal > none semantics.
 *
 * Failures the user has explicitly dismissed are suppressed via the
 * `documentGenerationStatusDismissal` table — once dismissed, the same FAILURE
 * state stays hidden until a new run produces a different `runKey`.
 *
 * These helpers are shared by:
 *  - `documentGenerationStatusService` (single-document `getGenerationStatus`,
 *    `dismissGenerationStatus`).
 *  - `documentService.findAll` (batch path: `mergeLoopStatuses` +
 *    `suppressDismissedFailuresForDocumentMap`).
 */

function withRunKey(status: GenerationStatus): GenerationStatus {
  return {
    ...status,
    runKey: getGenerationStatusRunKey(status),
  };
}

/** Convert a Prisma Loop record into a GenerationStatus. */
function toLoopGenerationStatus(
  loop: {
    id: string;
    command: string;
    startedAt: Date | null;
    completedAt: Date | null;
    user: { firstName: string | null; lastName: string | null } | null;
  },
  mappedStatus: GenerationStatus["status"]
): GenerationStatus {
  return withRunKey({
    status: mappedStatus,
    command: mapLoopCommand(loop.command),
    htmlUrl: null,
    startedAt: loop.startedAt,
    completedAt: loop.completedAt,
    correlationId: null,
    source: "loop",
    loopId: loop.id,
    initiatedBy: loop.user,
  });
}

/** Fetch the latest GitHub Actions generation status for a document. */
async function fetchGitHubActionsStatus(
  workstreamId: string,
  documentId: string
): Promise<GenerationStatus | null> {
  const actionRun = await withDb((db) =>
    db.gitHubActionRun.findFirst({
      where: { workstreamId, workflowName: "symphony-dispatch" },
      orderBy: { createdAt: "desc" },
    })
  );

  if (!actionRun) {
    return null;
  }

  const triggerData = actionRun.triggerData as {
    correlationId?: string;
    documentId?: string;
    command?: "plan" | "execute" | "chat";
  } | null;

  if (triggerData?.documentId !== documentId) {
    return null;
  }

  // CANCELLED maps to FAILURE since both are terminal non-success states.
  const status: GenerationStatus["status"] =
    actionRun.status === "CANCELLED" ? "FAILURE" : actionRun.status;

  return withRunKey({
    status,
    command: triggerData?.command ?? null,
    htmlUrl: actionRun.htmlUrl || null,
    startedAt: actionRun.startedAt,
    completedAt: actionRun.completedAt,
    correlationId: triggerData?.correlationId ?? null,
    source: "github_actions",
  });
}

/** Fetch the best Loop generation status for a document. */
async function fetchLoopStatus(
  documentId: string
): Promise<GenerationStatus | null> {
  // Fetch recent loops (not just one) so pickBestStatus can prefer an active
  // loop over a newer-but-terminal one.
  const loops = await withDb((db) =>
    db.loop.findMany({
      where: { artifactId: documentId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        status: true,
        command: true,
        startedAt: true,
        completedAt: true,
        user: {
          select: { firstName: true, lastName: true },
        },
      },
    })
  );

  let best: GenerationStatus | null = null;
  for (const loop of loops) {
    const mappedStatus = mapLoopStatus(loop.status);
    if (mappedStatus) {
      best = pickBestStatus(best, toLoopGenerationStatus(loop, mappedStatus));
    }
  }
  return best;
}

/**
 * Best status across both sources for a single document.
 */
export async function fetchBestGenerationStatusForDocument(
  documentId: string,
  workstreamId: string | null
): Promise<GenerationStatus> {
  const [ghStatus, loopStatus] = await Promise.all([
    workstreamId
      ? fetchGitHubActionsStatus(workstreamId, documentId)
      : Promise.resolve(null),
    fetchLoopStatus(documentId),
  ]);

  return withRunKey(pickBestStatus(ghStatus, loopStatus));
}

/**
 * Fetch the dismissed `runKey` for a document (or `null` if no dismissal).
 */
export async function getDismissedFailureRunKey(
  documentId: string
): Promise<string | null> {
  const dismissal = await withDb((db) =>
    db.documentGenerationStatusDismissal.findUnique({
      where: { artifactId: documentId },
      select: { runKey: true },
    })
  );

  return dismissal?.runKey ?? null;
}

/**
 * Replace a dismissed FAILURE status with `NONE_STATUS`. Pass-through
 * otherwise.
 */
export function suppressDismissedFailure(
  status: GenerationStatus,
  dismissedRunKey: string | null
): GenerationStatus {
  if (status.status !== "FAILURE" || !dismissedRunKey) {
    return status;
  }
  const runKey = status.runKey ?? getGenerationStatusRunKey(status);
  if (runKey && runKey === dismissedRunKey) {
    return NONE_STATUS;
  }
  return status;
}

/**
 * Batch variant of `suppressDismissedFailure` over a map keyed by document id.
 * Mutates the map in place — entries that drop to NONE_STATUS are removed.
 */
export async function suppressDismissedFailuresForDocumentMap(
  documentIds: string[],
  generationStatusMap: Map<string, GenerationStatus>
): Promise<void> {
  if (documentIds.length === 0 || generationStatusMap.size === 0) {
    return;
  }

  const dismissals = await withDb((db) =>
    db.documentGenerationStatusDismissal.findMany({
      where: { artifactId: { in: documentIds } },
      select: { artifactId: true, runKey: true },
    })
  );

  const dismissedRunKeysByDocument = new Map<string, string>();
  for (const dismissal of dismissals) {
    dismissedRunKeysByDocument.set(dismissal.artifactId, dismissal.runKey);
  }

  for (const [documentId, status] of generationStatusMap) {
    const dismissedRunKey = dismissedRunKeysByDocument.get(documentId);
    if (!dismissedRunKey) {
      continue;
    }
    const filtered = suppressDismissedFailure(status, dismissedRunKey);
    if (filtered.status === "NONE") {
      generationStatusMap.delete(documentId);
      continue;
    }
    generationStatusMap.set(documentId, filtered);
  }
}

/**
 * Batch-fetch Loop records for the given document IDs and merge into the
 * generation status map, preferring active statuses over terminal ones and
 * most recent when both are terminal.
 */
export async function mergeLoopStatuses(
  documentIds: string[],
  generationStatusMap: Map<string, GenerationStatus>
): Promise<void> {
  if (documentIds.length === 0) {
    return;
  }

  // Fetch all recent loops (not just one per document) so pickBestStatus can
  // prefer an active loop over a newer-but-terminal one.
  const loops = await withDb((db) =>
    db.loop.findMany({
      where: { artifactId: { in: documentIds } },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        artifactId: true,
        status: true,
        command: true,
        startedAt: true,
        completedAt: true,
        user: {
          select: { firstName: true, lastName: true },
        },
      },
    })
  );

  for (const loop of loops) {
    if (!loop.artifactId) {
      continue;
    }

    const mappedStatus = mapLoopStatus(loop.status);
    if (!mappedStatus) {
      continue;
    }

    const loopGenStatus = toLoopGenerationStatus(loop, mappedStatus);
    const existing = generationStatusMap.get(loop.artifactId) ?? null;
    generationStatusMap.set(
      loop.artifactId,
      pickBestStatus(existing, loopGenStatus)
    );
  }
}

/**
 * Public re-export for callers that need to attach a runKey to an
 * already-built GenerationStatus.
 */
export { withRunKey };
