import {
  DEFAULT_BATCH_SIZE,
  ensurePerfComputeTarget,
  type ImportDeps,
  type ImportSummary,
  importSnapshot,
} from "../../perf-import-desktop-snapshot";
import {
  retryUnacknowledgedSessions,
  StallPolicy,
} from "./acknowledgement-retry";
import { readActivityMetricsBySession } from "./activity-metrics";
import {
  type CorpusShift,
  type CorpusShiftTally,
  shiftWireSession,
} from "./corpus-shift";
import {
  type ResolveSessionOwner,
  readSessionsByOwner,
} from "./session-owners";

/**
 * ISS-12017: ingest the golden Desktop store's sessions into the local-trusted
 * org through `handleDesktopAgentSessionsEvent`, reusing the perf lane's import
 * core (`importSnapshot`) with the corpus shift applied to each mapped session
 * and the store's activity-metrics rollup attached, which the perf mapping does
 * not send.
 */

/** Pseudo-stage name the run summary and the seed coverage files use for this step. */
export const GOLDEN_IMPORT_STEP = "golden-import";

/** The models the ingest fold fills from the golden sessions. */
export const GOLDEN_IMPORT_MODELS = [
  "AgentSessionEvent",
  "AgentSessionTokenEvent",
  "AgentSessionTokenUsage",
  "AgentSessionUsageRollup",
  "AgentSessionActivityMetrics",
  "AgentSessionActivitySegment",
  "AgentComponentSessionUsage",
] as const;

export type GoldenImportSummary = {
  readonly sessionsRead: number;
  readonly sessionsPersisted: number;
  readonly rejected: number;
};

/**
 * ISS-12135: each person's sessions go in under that person's user and own
 * compute target (`session-owners.ts`), one import per person, so a teammate's
 * session belongs to the teammate rather than to the signed-in person.
 */
export async function ingestGoldenCorpus(
  input: {
    storePath: string;
    organizationId: string;
    resolveOwner: ResolveSessionOwner;
    shift: CorpusShift;
    log: (message: string) => void;
  },
  deps: Pick<ImportDeps, "handle"> = {}
): Promise<GoldenImportSummary> {
  const tally: CorpusShiftTally = { clampedToNow: 0 };
  const activityMetrics = readActivityMetricsBySession(input.storePath);
  const rejections: ImportSummary["rejections"][number][] = [];
  let sessionsRead = 0;
  let sessionsPersisted = 0;
  for (const [login, sessionIds] of readSessionsByOwner(input.storePath)) {
    const owner = await input.resolveOwner(login);
    const identity = {
      organizationId: input.organizationId,
      userId: owner.userId,
    };
    const computeTargetId = await ensurePerfComputeTarget(
      identity,
      owner.machineName
    );
    const summary = await importSnapshot(
      {
        snapshot: input.storePath,
        identity,
        computeTargetId,
        batchSize: DEFAULT_BATCH_SIZE,
      },
      {
        // A caller's own `handle` owns its retry (`session-links.ts` re-sends
        // only the sessions it delivered); otherwise the fold is wrapped here.
        ...(deps.handle
          ? { handle: deps.handle }
          : {
              wrapHandle: (fold) =>
                retryUnacknowledgedSessions(fold, input.log, StallPolicy.Stop),
            }),
        log: input.log,
        includeSession: (id) => sessionIds.has(id),
        transformSession: (session) => {
          const metrics = activityMetrics.get(
            String(session.externalSessionId)
          );
          const shifted = shiftWireSession(session, input.shift, tally);
          return {
            ...shifted,
            ...(metrics === undefined ? {} : { activityMetrics: metrics }),
          };
        },
      }
    );
    sessionsRead += summary.sessionsRead;
    sessionsPersisted += summary.sessionsPersisted;
    rejections.push(...summary.rejections);
  }
  // A caller's own `handle` chooses which sessions it delivers, so it reports
  // its own count: `sessionsRead` covers every store session, sent or not.
  if (!deps.handle) {
    input.log(
      `golden import: ${sessionsPersisted}/${sessionsRead} sessions persisted, shift ${input.shift.shiftMs}ms, ${tally.clampedToNow} timestamp(s) clamped to now`
    );
  }
  if (rejections.length > 0) {
    const reasons = rejections
      .map((rejection) => `${rejection.reason}: ${rejection.detail ?? ""}`)
      .join("; ");
    throw new Error(
      `golden import rejected ${rejections.length} batch(es): ${reasons}`
    );
  }
  return { sessionsRead, sessionsPersisted, rejected: rejections.length };
}
