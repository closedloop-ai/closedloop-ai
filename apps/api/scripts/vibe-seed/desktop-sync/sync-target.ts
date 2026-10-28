import { VIBE_SEED_MACHINE_NAME } from "@repo/api/src/vibe-seed-corpus";
import { withDb } from "@repo/database";
import { ensurePerfComputeTarget } from "../../perf-import-desktop-snapshot";
import { openSnapshot } from "../../perf-import-desktop-snapshot-reads";
import type { CorpusShift } from "../core/corpus-shift";
import type { VibeSeedContext } from "../stage";

/**
 * ISS-12017: the device every Desktop sync lane in the vibe seed reports from.
 *
 * It is the compute target the golden ingest attributed the sessions to, so a
 * lane that resolves a session by `(computeTargetId, externalSessionId)` (the
 * invocation, telemetry, and transcript lanes all do) finds the ingested row,
 * exactly as it would for the signed-in Desktop that uploaded those sessions.
 */
export type DesktopSyncTarget = {
  readonly organizationId: string;
  readonly userId: string;
  readonly computeTargetId: string;
  /** The local-trusted user signs in without Clerk. */
  readonly clerkUserId: null;
  readonly storePath: string;
  readonly shift: CorpusShift;
  readonly now: Date;
  readonly log: (message: string) => void;
};

export async function resolveDesktopSyncTarget(
  context: VibeSeedContext,
  stageName: string
): Promise<DesktopSyncTarget> {
  if (context.desktopStorePath === null) {
    throw new Error(
      `${stageName} replays the golden Desktop store's sync lanes; the run has no store`
    );
  }
  const computeTargetId = await ensurePerfComputeTarget(
    { organizationId: context.organizationId, userId: context.userId },
    VIBE_SEED_MACHINE_NAME
  );
  return {
    organizationId: context.organizationId,
    userId: context.userId,
    computeTargetId,
    clerkUserId: null,
    storePath: context.desktopStorePath,
    shift: { shiftMs: context.corpusShiftMs, nowMs: context.now.getTime() },
    now: context.now,
    log: context.log,
  };
}

/** A machine's sync target with the golden sessions the import put on it. */
export type OwnedDesktopSyncTarget = DesktopSyncTarget & {
  readonly externalSessionIds: ReadonlySet<string>;
};

/**
 * ISS-12135: every machine the golden import put the store's sessions on (the
 * signed-in person's and each teammate's, never a machine holding only the
 * base seed's own sessions), for the lanes whose rows belong to a session:
 * a session's transcript, telemetry and invocations sync from the machine the
 * session ran on, as each person's own Desktop would send them.
 */
export async function resolveDesktopSyncTargets(
  context: VibeSeedContext,
  stageName: string
): Promise<OwnedDesktopSyncTarget[]> {
  const base = await resolveDesktopSyncTarget(context, stageName);
  const targets = await withDb((db) =>
    db.computeTarget.findMany({
      where: {
        organizationId: context.organizationId,
        sessionDetails: { some: {} },
      },
      orderBy: { machineName: "asc" },
      select: {
        id: true,
        userId: true,
        sessionDetails: { select: { externalSessionId: true } },
      },
    })
  );
  const corpusSessionIds = readStoreSessionIds(base.storePath);
  return targets.flatMap((target) => {
    const externalSessionIds = new Set(
      target.sessionDetails
        .map((session) => session.externalSessionId)
        .filter((id) => corpusSessionIds.has(id))
    );
    return externalSessionIds.size === 0
      ? []
      : [
          {
            ...base,
            computeTargetId: target.id,
            userId: target.userId,
            externalSessionIds,
          },
        ];
  });
}

/** The Desktop store's session ids: the golden sessions, not the base seed's own. */
function readStoreSessionIds(storePath: string): ReadonlySet<string> {
  const db = openSnapshot(storePath);
  try {
    return new Set(
      db
        .prepare("SELECT id FROM sessions")
        .all()
        .map((row) => String(row.id))
    );
  } finally {
    db.close();
  }
}
