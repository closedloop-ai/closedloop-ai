import { randomUUID } from "node:crypto";
import type { handleDesktopAgentSessionsEvent } from "@/lib/desktop-agent-sessions-handler";
import { FixedWindowRateLimiter } from "@/lib/fixed-window-rate-limiter";
import { isRecord } from "@/lib/type-guards";

type IngestFold = typeof handleDesktopAgentSessionsEvent;

/** What a delivery round that acknowledges nothing new does. */
export const StallPolicy = {
  /** Throw, naming the sessions still unacknowledged. */
  Fail: "fail",
  /** Log them and return what was acknowledged. */
  Stop: "stop",
} as const;

export type StallPolicy = (typeof StallPolicy)[keyof typeof StallPolicy];

/**
 * ISS-12054: deliver a golden batch to the ingest fold until every session in
 * it is acknowledged.
 *
 * The fold persists a batch within a work budget and leaves the tail it did not
 * reach out of `acceptedSessionIds`, for the sender to re-send (the production
 * Desktop does, through its `ack_omitted` retry). The seed used to take one
 * pass as complete, so a slower machine persisted 20 of 23 linked sessions and
 * failed later, in GitHub session-link verification. This re-sends ONLY the
 * sessions the fold has not acknowledged, round after round, and fails with the
 * ids still missing as soon as a round acknowledges none of them. The budget
 * itself is the fold's and is not changed here.
 *
 * What a round with no progress does is the caller's `onStall`. The fold also
 * withholds ids for causes a re-send cannot clear (`SessionOmissionCause`: a
 * slice that threw, a pending or too-new revision, a monitored-activity retry),
 * so the base golden import STOPS there and keeps the short count it always
 * had, while the session-link re-delivery, which verifies every linked session
 * afterwards, FAILS with the ids.
 *
 * A batch that did not ask for `acceptedSessionIds`, and a rejected batch, are
 * returned as the fold answered them: there is nothing to retry against, and a
 * rejection is reported by the caller.
 */
export function retryUnacknowledgedSessions(
  fold: IngestFold,
  log: (message: string) => void,
  onStall: StallPolicy
): IngestFold {
  return async (payload, context, deps = {}) => {
    const first = await fold(payload, context, deps);
    const batch = readBatch(payload);
    if (!(first.accepted && first.acceptedSessionIds && batch)) {
      return first;
    }
    const { sessions } = batch;
    const acknowledged = new Set<string>();
    let pending = sessions;
    let answered = first.acceptedSessionIds;
    // The import sizes its limiter to one request per batch, so the re-sends get
    // their own: at most one round per session, since each must make progress.
    const retryDeps = {
      ...deps,
      rateLimiter: new FixedWindowRateLimiter({
        maxRequests: sessions.length + 1,
      }),
    };
    for (let round = 1; ; round += 1) {
      const progress = acknowledge(pending, answered, acknowledged);
      pending = pending.filter(
        (session) => !acknowledged.has(sessionId(session))
      );
      if (pending.length === 0) {
        return { accepted: true, acceptedSessionIds: [...acknowledged] };
      }
      if (progress === 0) {
        const stalled = `the ingest fold acknowledged none of the ${pending.length} remaining golden session(s) on delivery ${round}: ${pending.map(sessionId).join(", ")}`;
        if (onStall === StallPolicy.Fail) {
          throw new Error(stalled);
        }
        log(`${stalled}; leaving them unpersisted`);
        return { accepted: true, acceptedSessionIds: [...acknowledged] };
      }
      log(
        `delivery ${round}: ${pending.length} golden session(s) unacknowledged; re-sending only those`
      );
      const retry = await fold(
        {
          ...batch.payload,
          batchId: randomUUID(),
          sessionCount: pending.length,
          sessions: pending,
        },
        context,
        retryDeps
      );
      if (!retry.accepted) {
        return retry;
      }
      answered = retry.acceptedSessionIds ?? [];
    }
  };
}

/** Adds the answered ids that name a pending session; returns how many were new. */
function acknowledge(
  pending: Record<string, unknown>[],
  answered: readonly string[],
  acknowledged: Set<string>
): number {
  const pendingIds = new Set(pending.map(sessionId));
  let added = 0;
  for (const id of answered) {
    if (pendingIds.has(id) && !acknowledged.has(id)) {
      acknowledged.add(id);
      added += 1;
    }
  }
  return added;
}

function readBatch(payload: unknown): {
  payload: Record<string, unknown>;
  sessions: Record<string, unknown>[];
} | null {
  if (!(isRecord(payload) && Array.isArray(payload.sessions))) {
    return null;
  }
  return { payload, sessions: payload.sessions.filter(isRecord) };
}

function sessionId(session: Record<string, unknown>): string {
  return String(session.externalSessionId);
}
