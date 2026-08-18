import {
  DISPLAYED_SESSION_STATUS,
  SESSION_STATUS,
} from "@repo/api/src/types/session-status";
import { SessionOrigin, type TransactionClient, withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { acquireSessionAdvisoryLocks } from "./service/advisory-locks";
import { resolvePositiveEnvNumber } from "./service/env-config";

const LOCK_TIMEOUT_MESSAGE_RE = /lock timeout/i;

async function runStaleSessionSweep(): Promise<StaleSessionSweepResult> {
  const cutoff = new Date(Date.now() - getStaleSessionAgeHours() * MS_PER_HOUR);
  const candidates = await withDb((db) =>
    db.sessionDetail.findMany({
      where: {
        origin: SessionOrigin.DESKTOP_SYNC,
        artifact: {
          is: {
            status: { in: REAPABLE_SESSION_STATUSES },
          },
        },
        OR: [
          { lastActivityAt: { lt: cutoff } },
          { lastActivityAt: null, sessionStartedAt: { lt: cutoff } },
        ],
      },
      select: {
        artifactId: true,
        externalSessionId: true,
        lastActivityAt: true,
        sessionStartedAt: true,
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
  await acquireSessionAdvisoryLocks(tx, candidate.externalSessionId);

  const current = await tx.sessionDetail.findUnique({
    where: { artifactId: candidate.artifactId },
    select: {
      lastActivityAt: true,
      sessionStartedAt: true,
      endsWithError: true,
      artifact: {
        select: {
          status: true,
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
      sessionEndedAt: current.lastActivityAt ?? current.sessionStartedAt,
      awaitingInputSince: null,
    },
  });
  return true;
}

function isReapableStatus(status: string): boolean {
  return (REAPABLE_SESSION_STATUSES as readonly string[]).includes(status);
}

function isStale(
  session: Pick<StaleSessionCandidate, "lastActivityAt" | "sessionStartedAt">,
  cutoff: Date
): boolean {
  const activityAt = session.lastActivityAt ?? session.sessionStartedAt;
  return activityAt < cutoff;
}

export const FALLBACK_STALE_SESSION_AGE_HOURS = 24;

const MS_PER_HOUR = 60 * 60 * 1000;
const STALE_SESSION_BATCH_SIZE = 500;
const STALE_SESSION_TRANSACTION_TIMEOUT_MS = 30_000;
const SWEEP_TIME_BUDGET_MS = 240_000;
/**
 * The stored `artifacts.status` values a sweep may reap, matched literally by
 * the Prisma `in` clauses below — so this list is STORED vocabulary, and the
 * `DISPLAYED_SESSION_STATUS.WAITING` entry in it is deliberate rather than a
 * miscategorization the ISS-5592 split missed (thadeusb, #5007).
 *
 * `waiting` is display vocabulary that nothing is SUPPOSED to store. ISS-5981
 * closed the cloud write path — the ingest now folds every incoming status, so
 * no NEW row can carry it — but rows written before that were not backfilled and
 * still can. Such a row is a live run that can go silent like any other, so
 * dropping this entry would strand exactly those rows as permanently unreapable.
 * Remove it only once those rows are gone; the constant being display-typed is
 * not on its own a reason, and neither is ISS-5981 being closed.
 */
const REAPABLE_SESSION_STATUSES = [
  SESSION_STATUS.ACTIVE,
  DISPLAYED_SESSION_STATUS.WAITING,
];

type StaleSessionCandidate = {
  artifactId: string;
  externalSessionId: string;
  lastActivityAt: Date | null;
  sessionStartedAt: Date;
};

export const staleSessionReaperService = {
  runStaleSessionSweep,
  getStaleSessionAgeHours,
};

function isLockTimeoutError(error: unknown): boolean {
  if (error instanceof Error) {
    if ("code" in error && error.code === "55P03") {
      return true;
    }
    if (LOCK_TIMEOUT_MESSAGE_RE.test(error.message)) {
      return true;
    }
    if ("cause" in error && error.cause instanceof Error) {
      if ("code" in error.cause && error.cause.code === "55P03") {
        return true;
      }
      if (LOCK_TIMEOUT_MESSAGE_RE.test(error.cause.message)) {
        return true;
      }
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
