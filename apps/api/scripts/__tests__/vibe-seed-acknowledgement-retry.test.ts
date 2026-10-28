/**
 * ISS-12054: the vibe seed re-sends what the ingest fold left unacknowledged.
 *
 * The fold here is a fake that persists a fixed number of sessions per call,
 * the way the production fold stops at its work budget, so each case can say
 * exactly which sessions every delivery carried.
 */
import {
  type DesktopAgentSessionsAck,
  DesktopAgentSessionsAckReason,
} from "@repo/api/src/types/agent-session";
import { describe, expect, it } from "vitest";
import type { handleDesktopAgentSessionsEvent } from "@/lib/desktop-agent-sessions-handler";
import { isRecord } from "@/lib/type-guards";
import {
  retryUnacknowledgedSessions,
  StallPolicy,
} from "../vibe-seed/core/acknowledgement-retry";

type Fold = typeof handleDesktopAgentSessionsEvent;

const CONTEXT = {
  organizationId: "org-1",
  userId: "user-1",
  targetId: "target-1",
};
const SESSION_IDS = ["s1", "s2", "s3", "s4", "s5"];

describe("retryUnacknowledgedSessions", () => {
  it("re-sends only the unacknowledged sessions until every one is acknowledged", async () => {
    const fold = budgetedFold([3, 1, 1]);
    const retrying = retryUnacknowledgedSessions(
      fold.handle,
      () => undefined,
      StallPolicy.Fail
    );

    const ack = await retrying(batch(SESSION_IDS), CONTEXT);

    expect(ack).toEqual({ accepted: true, acceptedSessionIds: SESSION_IDS });
    expect(fold.deliveries).toEqual([SESSION_IDS, ["s4", "s5"], ["s5"]]);
  });

  it("gives every re-send a fresh batch id and a matching session count", async () => {
    const fold = budgetedFold([4, 1]);
    const retrying = retryUnacknowledgedSessions(
      fold.handle,
      () => undefined,
      StallPolicy.Fail
    );
    const first = batch(SESSION_IDS);

    await retrying(first, CONTEXT);

    const resent = fold.payloads[1];
    expect(resent?.batchId).not.toBe(first.batchId);
    expect(resent?.sessionCount).toBe(1);
  });

  it("fails naming the remaining sessions when a delivery acknowledges none of them", async () => {
    const fold = budgetedFold([3, 0]);
    const retrying = retryUnacknowledgedSessions(
      fold.handle,
      () => undefined,
      StallPolicy.Fail
    );

    await expect(retrying(batch(SESSION_IDS), CONTEXT)).rejects.toThrow(
      "acknowledged none of the 2 remaining golden session(s) on delivery 2: s4, s5"
    );
    expect(fold.deliveries).toHaveLength(2);
  });

  it("under Stop, keeps what it got and logs the rest instead of failing", async () => {
    const fold = budgetedFold([3, 0]);
    const logged: string[] = [];
    const retrying = retryUnacknowledgedSessions(
      fold.handle,
      (message) => logged.push(message),
      StallPolicy.Stop
    );

    const ack = await retrying(batch(SESSION_IDS), CONTEXT);

    expect(ack).toEqual({
      accepted: true,
      acceptedSessionIds: ["s1", "s2", "s3"],
    });
    expect(fold.deliveries).toEqual([SESSION_IDS, ["s4", "s5"]]);
    expect(logged.at(-1)).toContain("on delivery 2: s4, s5");
  });

  it("fails on the first delivery when it acknowledges nothing", async () => {
    const fold = budgetedFold([0]);
    const retrying = retryUnacknowledgedSessions(
      fold.handle,
      () => undefined,
      StallPolicy.Fail
    );

    await expect(retrying(batch(["s1"]), CONTEXT)).rejects.toThrow(
      "acknowledged none of the 1 remaining golden session(s) on delivery 1: s1"
    );
  });

  it("returns a rejection as the fold gave it, without re-sending", async () => {
    const rejection: DesktopAgentSessionsAck = {
      accepted: false,
      reason: DesktopAgentSessionsAckReason.ValidationFailed,
    };
    const deliveries: unknown[] = [];
    const retrying = retryUnacknowledgedSessions(
      (payload) => {
        deliveries.push(payload);
        return Promise.resolve(rejection);
      },
      () => undefined,
      StallPolicy.Fail
    );

    await expect(retrying(batch(SESSION_IDS), CONTEXT)).resolves.toBe(
      rejection
    );
    expect(deliveries).toHaveLength(1);
  });

  it("does not count an id the batch never sent as progress", async () => {
    let call = 0;
    const retrying = retryUnacknowledgedSessions(
      () => {
        call += 1;
        return Promise.resolve({
          accepted: true,
          acceptedSessionIds: call === 1 ? ["s1"] : ["not-sent"],
        });
      },
      () => undefined,
      StallPolicy.Fail
    );

    await expect(retrying(batch(["s1", "s2"]), CONTEXT)).rejects.toThrow(
      "on delivery 2: s2"
    );
  });
});

/** A fold that persists the next budget's worth of sessions, in order, per call. */
function budgetedFold(budgets: number[]) {
  const deliveries: string[][] = [];
  const payloads: Record<string, unknown>[] = [];
  const handle: Fold = (payload) => {
    if (!(isRecord(payload) && Array.isArray(payload.sessions))) {
      throw new Error("the fold was handed a batch without sessions");
    }
    payloads.push(payload);
    const ids = payload.sessions.map((session) =>
      isRecord(session) ? String(session.externalSessionId) : ""
    );
    deliveries.push(ids);
    const budget = budgets[deliveries.length - 1] ?? 0;
    return Promise.resolve({
      accepted: true,
      acceptedSessionIds: ids.slice(0, budget),
    });
  };
  return { deliveries, handle, payloads };
}

function batch(ids: string[]): Record<string, unknown> {
  return {
    batchId: crypto.randomUUID(),
    sessionCount: ids.length,
    sessions: ids.map((externalSessionId) => ({ externalSessionId })),
    wantsAcceptedSessionIds: true,
  };
}
