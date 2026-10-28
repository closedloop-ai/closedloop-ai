/**
 * ISS-12552: the historical attribution backfill. Walks
 * session artifacts by id from the run's cursor, backfills each session in
 * its own transaction, and records the cursor and running counts in that same
 * transaction, so an interrupted run resumes where it stopped and its counts
 * hold exactly the committed changes. A session whose backfill fails is counted
 * and logged and the walk moves on, so one session cannot stall the run. A run
 * is keyed by the policy and extractor versions; a later run with the same
 * versions changes no evidence because each session's backfill is idempotent.
 *
 * Each page first re-derives implementation evidence for the branches its
 * sessions link to, one call per organization, so a session that synced
 * before a document produced its branch gets that document associated with
 * its implementation row. That
 * derivation reads only stored links and snapshots, never GitHub, and is
 * idempotent, so a resumed page derives it again.
 */
import { ArtifactType, LinkType } from "@repo/api/src/types/artifact";
import { OPERATION_EVIDENCE_EXTRACTOR_VERSION } from "@repo/api/src/types/operation-claims";
import { withDb } from "@repo/database";
import { ATTRIBUTION_POLICY_VERSION } from "@repo/lib/attribution/classify-operation";
import { log } from "@repo/observability/log";
import { z } from "zod";
import {
  backfillSessionEvidence,
  type SessionBackfillResult,
} from "./backfill-session-evidence";
import { deriveImplementationEvidence } from "./derive-implementation-evidence";
import { syncSessionEvidenceLinks } from "./session-evidence-links";

export const AttributionBackfillStatus = {
  Running: "running",
  Completed: "completed",
} as const;
export type AttributionBackfillStatus =
  (typeof AttributionBackfillStatus)[keyof typeof AttributionBackfillStatus];

export type AttributionBackfillCounts = {
  sessionsScanned: number;
  sessionsChanged: number;
  noRetainedProof: number;
  bound: number;
  corroborated: number;
  reclassified: number;
  /** Writes still awaiting a receipt a day after the call, finalized as missing. */
  finalized: number;
  /** Sessions whose backfill failed; each is logged with its id. */
  failed: number;
};

/**
 * One session's backfill is one transaction over at most a few hundred
 * evidence rows and its documents' versions, so it gets a script-sized budget
 * rather than the interactive default.
 */
const SESSION_TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 120_000 };

const EMPTY_COUNTS: AttributionBackfillCounts = {
  sessionsScanned: 0,
  sessionsChanged: 0,
  noRetainedProof: 0,
  bound: 0,
  corroborated: 0,
  reclassified: 0,
  finalized: 0,
  failed: 0,
};

const countsSchema = z.object({
  sessionsScanned: z.number().int().nonnegative(),
  sessionsChanged: z.number().int().nonnegative(),
  noRetainedProof: z.number().int().nonnegative(),
  bound: z.number().int().nonnegative(),
  corroborated: z.number().int().nonnegative(),
  reclassified: z.number().int().nonnegative(),
  // A run saved before these counts existed resumes with none of either.
  finalized: z.number().int().nonnegative().default(0),
  failed: z.number().int().nonnegative().default(0),
});

export type AttributionBackfillOutcome = {
  runId: string;
  status: AttributionBackfillStatus;
  counts: AttributionBackfillCounts;
};

export async function runAttributionBackfill(
  options: {
    pageSize?: number;
    maxPages?: number;
    /** Walk one organization's sessions; omit to walk all. */
    organizationId?: string;
    /** The run's clock, for finalizing writes that never got a receipt. */
    now?: Date;
  } = {}
): Promise<AttributionBackfillOutcome> {
  const pageSize = Math.max(1, options.pageSize ?? 200);
  const run = await openRun(options.organizationId ?? null);
  let cursor = run.cursor;
  let counts = { ...run.counts };
  for (
    let page = 0;
    options.maxPages === undefined || page < options.maxPages;
    page += 1
  ) {
    const sessions = await withDb((db) =>
      db.artifact.findMany({
        where: {
          type: ArtifactType.Session,
          ...(options.organizationId
            ? { organizationId: options.organizationId }
            : {}),
          ...(cursor ? { id: { gt: cursor } } : {}),
        },
        orderBy: { id: "asc" },
        take: pageSize,
        select: { id: true, organizationId: true },
      })
    );
    if (sessions.length === 0) {
      await saveRun(
        run.id,
        cursor,
        counts,
        AttributionBackfillStatus.Completed
      );
      return {
        runId: run.id,
        status: AttributionBackfillStatus.Completed,
        counts,
      };
    }
    await deriveImplementationForPage(sessions);
    for (const session of sessions) {
      counts = await backfillOne(
        run.id,
        session,
        counts,
        options.now ?? new Date()
      );
      cursor = session.id;
    }
  }
  return { runId: run.id, status: AttributionBackfillStatus.Running, counts };
}

/** Resume this version pair and scope's unfinished run, or start one. */
async function openRun(organizationId: string | null): Promise<{
  id: string;
  cursor: string | null;
  counts: AttributionBackfillCounts;
}> {
  const versions = {
    policyVersion: ATTRIBUTION_POLICY_VERSION,
    extractorVersion: OPERATION_EVIDENCE_EXTRACTOR_VERSION,
    organizationId,
  };
  const existing = await withDb((db) =>
    db.attributionBackfillRun.findFirst({
      where: { ...versions, status: AttributionBackfillStatus.Running },
      orderBy: { startedAt: "desc" },
      select: { id: true, cursor: true, counts: true },
    })
  );
  if (existing) {
    const counts = countsSchema.safeParse(existing.counts);
    return {
      id: existing.id,
      cursor: existing.cursor,
      counts: counts.success ? counts.data : { ...EMPTY_COUNTS },
    };
  }
  const created = await withDb((db) =>
    db.attributionBackfillRun.create({
      data: {
        ...versions,
        status: AttributionBackfillStatus.Running,
        counts: EMPTY_COUNTS,
      },
      select: { id: true },
    })
  );
  return { id: created.id, cursor: null, counts: { ...EMPTY_COUNTS } };
}

async function saveRun(
  runId: string,
  cursor: string | null,
  counts: AttributionBackfillCounts,
  status: AttributionBackfillStatus
): Promise<void> {
  await withDb((db) =>
    db.attributionBackfillRun.update({
      where: { id: runId },
      data: {
        cursor,
        counts,
        status,
        ...(status === AttributionBackfillStatus.Completed
          ? { finishedAt: new Date() }
          : {}),
      },
      select: { id: true },
    })
  );
}

/**
 * The run's cursor and counts are saved in the session's own transaction, so a
 * crash can never leave a committed session uncounted or a counted one
 * uncommitted.
 */
async function backfillOne(
  runId: string,
  session: { id: string; organizationId: string },
  counts: AttributionBackfillCounts,
  now: Date
): Promise<AttributionBackfillCounts> {
  const scanned = { ...counts, sessionsScanned: counts.sessionsScanned + 1 };
  try {
    const { next, changed } = await withDb.tx(async (tx) => {
      const result = await backfillSessionEvidence(
        tx,
        { organizationId: session.organizationId, agentSessionId: session.id },
        now
      );
      const next = withSessionResult(scanned, result);
      await tx.attributionBackfillRun.update({
        where: { id: runId },
        data: { cursor: session.id, counts: next },
        select: { id: true },
      });
      return { next, changed: result.bindingChangedSessionIds };
    }, SESSION_TRANSACTION_OPTIONS);
    // Also writes links for a session that synced before the flag was on, and
    // for the sessions this one's binding changed, which may never sync again.
    await syncSessionEvidenceLinks(session.organizationId, [
      session.id,
      ...changed,
    ]);
    return next;
  } catch (error) {
    log.warn("attribution backfill failed for a session; continuing", {
      organizationId: session.organizationId,
      agentSessionId: session.id,
      error: error instanceof Error ? error.message : String(error),
    });
    const next = { ...scanned, failed: scanned.failed + 1 };
    await saveRun(runId, session.id, next, AttributionBackfillStatus.Running);
    return next;
  }
}

function withSessionResult(
  counts: AttributionBackfillCounts,
  result: SessionBackfillResult
): AttributionBackfillCounts {
  const changes =
    result.bound + result.corroborated + result.reclassified + result.finalized;
  return {
    ...counts,
    sessionsChanged: counts.sessionsChanged + (changes > 0 ? 1 : 0),
    noRetainedProof: counts.noRetainedProof + (result.noRetainedProof ? 1 : 0),
    bound: counts.bound + result.bound,
    corroborated: counts.corroborated + result.corroborated,
    reclassified: counts.reclassified + result.reclassified,
    finalized: counts.finalized + result.finalized,
  };
}

/**
 * Re-derives implementation evidence for every branch the page's sessions
 * link to, one batch of branch ids per organization. A failed organization is
 * logged and the walk moves on, as a failed session is.
 */
async function deriveImplementationForPage(
  sessions: readonly { id: string; organizationId: string }[]
): Promise<void> {
  const byOrganization = new Map<string, string[]>();
  for (const session of sessions) {
    const ids = byOrganization.get(session.organizationId) ?? [];
    ids.push(session.id);
    byOrganization.set(session.organizationId, ids);
  }
  for (const [organizationId, sessionIds] of byOrganization) {
    try {
      await withDb.tx(async (tx) => {
        const links = await tx.artifactLink.findMany({
          where: {
            organizationId,
            sourceId: { in: sessionIds },
            linkType: LinkType.RelatesTo,
            target: { organizationId, type: ArtifactType.Branch },
          },
          distinct: ["targetId"],
          select: { targetId: true },
        });
        await deriveImplementationEvidence(tx, {
          organizationId,
          branchIds: links.map((link) => link.targetId),
        });
      }, SESSION_TRANSACTION_OPTIONS);
    } catch (error) {
      log.warn("attribution backfill implementation derivation failed", {
        level: "warn",
        status: "warn",
        organizationId,
        sessionCount: sessionIds.length,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
