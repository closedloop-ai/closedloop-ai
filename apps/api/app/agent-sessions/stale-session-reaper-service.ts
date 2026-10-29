import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { type TransactionClient, withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { captureSystemSessionStatusChange } from "@/lib/artifact-activity-recording";
import { getPrismaRawQuerySqlState } from "@/lib/db-utils";
import { IndexKeyOrigin } from "@/lib/index-key-lookup";
import { acquireSessionAdvisoryLocks } from "./service/advisory-locks";
import { resolvePositiveEnvNumber } from "./service/env-config";

const LOCK_TIMEOUT_MESSAGE_RE = /lock timeout/i;

async function runStaleSessionSweep(): Promise<StaleSessionSweepResult> {
  const cutoff = new Date(Date.now() - getStaleSessionAgeHours() * MS_PER_HOUR);
  const candidates = await withDb((db) =>
    db.sessionDetail.findMany({
      where: {
        // ISS-11129 (operator ruling, 2026-09-24): every origin is closed the
        // same way at the same cutoff, so the scan carries no origin filter.
        // This sweep deletes nothing, it closes a session's STATUS.
        artifact: {
          is: {
            status: { in: REAPABLE_SESSION_STATUSES },
          },
        },
        lastActivityAt: { lt: cutoff },
      },
      select: {
        artifactId: true,
        externalSessionId: true,
        lastActivityAt: true,
      },
      take: STALE_SESSION_BATCH_SIZE,
    })
  );

  let reaped = 0;
  let skippedByRecheck = 0;
  let skippedByContention = 0;
  let failed = 0;
  let deferred = 0;
  const sweepStart = Date.now();

  for (const candidate of candidates) {
    if (Date.now() - sweepStart > SWEEP_TIME_BUDGET_MS) {
      deferred =
        candidates.length -
        reaped -
        skippedByRecheck -
        skippedByContention -
        failed;
      break;
    }

    try {
      const didReap = await withDb.tx(
        (tx) => reapCandidate(tx, candidate, cutoff),
        { timeout: STALE_SESSION_TRANSACTION_TIMEOUT_MS }
      );
      if (didReap) {
        reaped += 1;
      } else {
        skippedByRecheck += 1;
      }
    } catch (error) {
      if (isLockTimeoutError(error)) {
        skippedByContention += 1;
      } else {
        failed += 1;
        log.error("[stale-session-reaper] reap failed", {
          artifactId: candidate.artifactId,
          error,
        });
      }
    }
  }

  const hasMore =
    candidates.length === STALE_SESSION_BATCH_SIZE || deferred > 0;

  return {
    scanned: candidates.length,
    reaped,
    skippedByRecheck,
    skippedByContention,
    failed,
    deferred,
    hasMore,
  };
}

function getStaleSessionAgeHours(): number {
  return resolvePositiveEnvNumber(
    "STALE_SESSION_AGE_HOURS",
    FALLBACK_STALE_SESSION_AGE_HOURS
  );
}

async function reapCandidate(
  tx: TransactionClient,
  candidate: StaleSessionCandidate,
  cutoff: Date
): Promise<boolean> {
  await tx.$executeRaw`SET LOCAL lock_timeout = '5s'`;
  // ISS-8200 (review): `candidate.externalSessionId` was READ OUT of
  // `SessionDetail`, so it is a STORED key. The Wire path would project it
  // again — and `projectIndexKey` is not idempotent, so an already-projected
  // key becomes a THIRD value and this sweep would lock a slot the ingest never
  // takes, which is worse than the shared slot it took before.
  await acquireSessionAdvisoryLocks(
    tx,
    candidate.externalSessionId,
    IndexKeyOrigin.Stored
  );

  const current = await tx.sessionDetail.findUnique({
    where: { artifactId: candidate.artifactId },
    select: {
      lastActivityAt: true,
      endsWithError: true,
      artifact: {
        select: {
          status: true,
          organizationId: true,
        },
      },
    },
  });

  if (
    current === null ||
    !isReapableStatus(current.artifact.status) ||
    !isStale(current, cutoff)
  ) {
    return false;
  }

  // ISS-4586: declare the orphaned session terminal from its durable
  // `ends_with_error` flag — `error` when the last desktop sync saw the run end
  // on an unrecovered error, else `inactive` (the terminal-not-failed state).
  // Absent/null flag (older desktop builds; pre-ISS-4586 rows) → `inactive`.
  // Mirrors the desktop reaper (`write-core.ts`, `session-maintenance.ts`) so web
  // and desktop agree on an orphan's outcome.
  //
  // ERROR is intentionally FINAL here: unlike the old reap-to-`abandoned` path,
  // `error` is deliberately NOT rescued by a later merged PR (see the
  // `TERMINAL_SESSION_STATUSES` doc in `@repo/api/src/types/session-status`: ERROR/
  // FAILED are not PR-rescued). A merged-PR rescue (FEA-3551) once applied to the
  // terminal-not-failed reap only, never to a session the importer last saw end
  // on an unrecovered error; ISS-6588 removed it outright, so no PR signal
  // reaches any outcome here and the error is final by construction. A reaped
  // orphan carrying both `ends_with_error = 1` and a later-merged PR therefore
  // renders "Failed", not "Completed"; the error signal outranks the PR merge.
  const reapedStatus = current.endsWithError
    ? SESSION_STATUS.ERROR
    : SESSION_STATUS.INACTIVE;
  const updated = await tx.artifact.updateMany({
    where: {
      id: candidate.artifactId,
      status: { in: REAPABLE_SESSION_STATUSES },
    },
    data: {
      status: reapedStatus,
    },
  });
  if (updated.count !== 1) {
    return false;
  }

  await tx.sessionDetail.update({
    where: { artifactId: candidate.artifactId },
    data: {
      sessionEndedAt: current.lastActivityAt,
      awaitingInputSince: null,
    },
    select: { artifactId: true },
  });
  await captureSystemSessionStatusChange({
    tx,
    organizationId: current.artifact.organizationId,
    artifactId: candidate.artifactId,
    before: current.artifact.status,
    after: reapedStatus,
  });
  return true;
}

function isReapableStatus(status: string): boolean {
  return (REAPABLE_SESSION_STATUSES as readonly string[]).includes(status);
}

function isStale(
  session: Pick<StaleSessionCandidate, "lastActivityAt">,
  cutoff: Date
): boolean {
  return session.lastActivityAt < cutoff;
}

export const FALLBACK_STALE_SESSION_AGE_HOURS = 24;

const MS_PER_HOUR = 60 * 60 * 1000;
const STALE_SESSION_BATCH_SIZE = 500;
const STALE_SESSION_TRANSACTION_TIMEOUT_MS = 30_000;
const SWEEP_TIME_BUDGET_MS = 240_000;
/**
 * The stored `artifacts.status` values a sweep may reap, matched literally by
 * the Prisma `in` clauses below — so this list is STORED vocabulary.
 *
 * ISS-10364 removed the `waiting` entry. The comment it carried set its own
 * release condition — "Remove it only once those rows are gone" — and Cosimo
 * confirmed on 2026-09-23 that no row has ever stored the value, which meets it.
 */
const REAPABLE_SESSION_STATUSES = [SESSION_STATUS.ACTIVE];

type StaleSessionCandidate = {
  artifactId: string;
  externalSessionId: string;
  lastActivityAt: Date;
};

export const staleSessionReaperService = {
  runStaleSessionSweep,
  getStaleSessionAgeHours,
};

/**
 * ISS-8804: reads the SQLSTATE through {@link getPrismaRawQuerySqlState} rather
 * than off `error.code` / `error.cause.code`.
 *
 * Both of those were dead, and were dead before the Prisma 7.10 bump too: for a
 * raw failure Prisma sets its own `P2010` on `code` and puts the driver
 * SQLSTATE in `meta`, and a `PrismaClientKnownRequestError` carries no `cause`.
 * So the only live check was the message regex — which is why this is a
 * pre-existing defect and not upgrade fallout.
 *
 * WHAT THIS DOES AND DOES NOT COVER, because the distinction decides how much
 * the regex below is still carrying. `reapCandidate` blocks in two places:
 *   - the RAW advisory-lock acquisition, which produces the `P2010` envelope
 *     this extractor reads. Covered.
 *   - the TYPED writes (`artifact.updateMany`, `sessionDetail.update`), which
 *     are not raw. Those do not arrive as `P2010`, so the extractor returns
 *     undefined and the message regex is the only thing classifying them.
 * Narrowing, not a hole — the regex already did that work — but the structured
 * read is not a replacement for it on that path, and saying otherwise would
 * overstate what changed.
 *
 * 55P03 only. `isDropContentionError` also accepts 57014, but it may: its
 * caller sets its own `statement_timeout`, so a cancel there is one it caused.
 * `reapCandidate` sets only `lock_timeout`, so any 57014 reaching here is an
 * EXTERNAL cancel — a session/role timeout, a pooler, an operator — and
 * counting that as contention would suppress the one `log.error` that says a
 * pathological reap exists.
 */
function isLockTimeoutError(error: unknown): boolean {
  if (getPrismaRawQuerySqlState(error) === "55P03") {
    return true;
  }
  if (error instanceof Error) {
    if (LOCK_TIMEOUT_MESSAGE_RE.test(error.message)) {
      return true;
    }
    if ("cause" in error && error.cause instanceof Error) {
      return LOCK_TIMEOUT_MESSAGE_RE.test(error.cause.message);
    }
  }
  return false;
}

export type StaleSessionSweepResult = {
  scanned: number;
  reaped: number;
  skippedByRecheck: number;
  skippedByContention: number;
  failed: number;
  deferred: number;
  hasMore: boolean;
};
