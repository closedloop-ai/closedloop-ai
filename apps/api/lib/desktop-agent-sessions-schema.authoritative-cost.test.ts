import {
  AGENT_SESSION_SYNC_SCHEMA_VERSION,
  AgentSessionSyncMode,
} from "@repo/api/src/types/agent-session";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { describe, expect, it } from "vitest";
import { parseDesktopAgentSessionsPayload } from "./desktop-agent-sessions-schema";

/**
 * ISS-7229: the wire contract for `authoritativeCostUsd` — Claude's own reported
 * session cost, summed by the desktop from its OTel capture table.
 *
 * The asymmetry with its `sessionAnalytics.estimatedCostUsd` neighbour is the
 * whole subject. That field is `.nullable().optional()`, because a desktop `null`
 * legitimately means "nobody priced this". This one is `.optional()` ONLY, and a
 * `null` is REFUSED, because the cloud column holds figures this payload did
 * not write: the ISS-12435 backfill of the retired loop-event figures. OTel
 * capture is gated on a Labs setting and reaches a minority of sessions, so a
 * desktop that sent `null` for "I captured nothing" would erase a figure that
 * was legitimately recorded.
 *
 * Absence is therefore the ONLY way to say "no opinion", and there is
 * deliberately no wire spelling for "clear it".
 */

function payloadWithSession(session: Record<string, unknown>) {
  return {
    schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
    batchId: "0199e7a2-0000-4000-a000-000000007229",
    syncMode: AgentSessionSyncMode.Incremental,
    sessionCount: 1,
    sessions: [
      {
        externalSessionId: "iss-7229-session",
        name: "iss-7229-session",
        status: SESSION_STATUS.INACTIVE,
        startedAt: "2026-09-01T12:00:00.000Z",
        updatedAt: "2026-09-01T12:00:00.000Z",
        agents: [],
        events: [],
        tokenUsageByModel: [],
        ...session,
      },
    ],
  };
}

function parsedSession(session: Record<string, unknown>) {
  const parsed = parseDesktopAgentSessionsPayload(payloadWithSession(session));
  if (!parsed.ok) {
    throw new Error(`expected the payload to parse: ${parsed.reason}`);
  }
  if (parsed.kind !== "batch") {
    throw new Error(`expected a batch payload, got ${parsed.kind}`);
  }
  return parsed.payload.sessions[0] as Record<string, unknown>;
}

/**
 * The refusal reason for a payload the schema rejects, or `null` if it parsed.
 *
 * Returns the reason rather than asserting, so each case can assert in its own
 * body. Naming the reason is not optional decoration: with a malformed
 * `batchId` in an earlier draft of this fixture, all three refusal cases passed
 * while asserting nothing about the cost field at all. A bare
 * `expect(parsed.ok).toBe(false)` cannot tell the two apart.
 */
function refusalReason(session: Record<string, unknown>): string | null {
  const parsed = parseDesktopAgentSessionsPayload(payloadWithSession(session));
  return parsed.ok ? null : parsed.reason;
}

/**
 * A batch of `count` sessions in which exactly one — at `badIndex` — carries the
 * given cost. Batch-shaped on purpose: the defect this pins is invisible in a
 * one-session payload, because there is nothing else in the batch to lose.
 */
function parsedBatchWithOneCostAt(
  count: number,
  badIndex: number,
  costUsd: unknown
) {
  const sessions = Array.from({ length: count }, (_, index) => ({
    externalSessionId: `iss-7229-session-${index}`,
    name: `iss-7229-session-${index}`,
    status: SESSION_STATUS.INACTIVE,
    startedAt: "2026-09-01T12:00:00.000Z",
    updatedAt: "2026-09-01T12:00:00.000Z",
    agents: [],
    events: [],
    tokenUsageByModel: [],
    ...(index === badIndex ? { authoritativeCostUsd: costUsd } : {}),
  }));
  return parseDesktopAgentSessionsPayload({
    schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
    batchId: "0199e7a2-0000-4000-a000-000000007230",
    syncMode: AgentSessionSyncMode.Incremental,
    sessionCount: sessions.length,
    sessions,
  });
}

describe("authoritativeCostUsd wire contract (ISS-7229)", () => {
  it("carries a reported figure through", () => {
    expect(parsedSession({ authoritativeCostUsd: 1502.1 })).toMatchObject({
      authoritativeCostUsd: 1502.1,
    });
  });

  it("carries a reported ZERO through as a value, not an absence", () => {
    // Claude charging nothing is a measurement. A truthiness check anywhere on
    // this path would drop it and make the session read "unavailable" instead.
    expect(parsedSession({ authoritativeCostUsd: 0 })).toMatchObject({
      authoritativeCostUsd: 0,
    });
  });

  it("accepts a payload that omits the field, and leaves the key absent", () => {
    // Absence must survive as absence all the way to the apply, because that is
    // what makes the ingest's conditional spread leave a loop-projected figure
    // standing. A schema that defaulted it to 0 or null here would reintroduce
    // the overwrite this contract exists to prevent.
    expect(parsedSession({})).not.toHaveProperty("authoritativeCostUsd");
  });

  it("REFUSES an explicit null rather than accepting a silent clear", () => {
    // The data-loss guard. A desktop with no OTel capture must omit the field;
    // if one ever sends `null`, failing loudly at the boundary is the correct
    // outcome, because the alternative is erasing a real Claude-reported figure
    // that came from the loop-event projection.
    expect(refusalReason({ authoritativeCostUsd: null })).toContain(
      "authoritativeCostUsd"
    );
  });

  it("REFUSES a negative figure", () => {
    // A cost cannot be negative, and the column is a measurement rather than a
    // delta. Rejecting keeps a corrupt producer out of the estimator-drift math.
    expect(refusalReason({ authoritativeCostUsd: -1 })).toContain(
      "authoritativeCostUsd"
    );
  });

  it("REFUSES a non-finite figure", () => {
    expect(
      refusalReason({ authoritativeCostUsd: Number.POSITIVE_INFINITY })
    ).toContain("authoritativeCostUsd");
  });

  it("drops an UNSTORABLE figure without failing the field", () => {
    // Too wide for `Decimal(14, 6)`. Absence is what this field already means by
    // "no opinion", so the column keeps whatever the loop projection put there.
    //
    // `undefined`, not a missing key: a Zod transform that returns `undefined`
    // still emits the property. The two spellings are the same thing to every
    // consumer of this payload, because the ingest's `toAuthoritativeCostPatch`
    // branches on `=== undefined` and omits the column either way — which
    // `service.authoritative-cost-absence.test.ts` pins on the real write path.
    expect(
      parsedSession({ authoritativeCostUsd: 1e9 }).authoritativeCostUsd
    ).toBeUndefined();
  });

  it("lets the other 199 sessions in the batch land beside the dropped one", () => {
    // davetho on #6406. The width bound started life as `.lt()` ON THE FIELD,
    // and `route.ts` safeParses the WHOLE batch — so one oversized figure 400'd
    // every session in the request, and did it again on each retry because the
    // desktop re-sends the same number. This is the case a single-session
    // fixture cannot see.
    const parsed = parsedBatchWithOneCostAt(200, 137, 1e9);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.kind !== "batch") {
      throw new Error("expected the batch to parse");
    }
    // Not `.ok` alone: a schema that dropped the whole SESSION rather than the
    // field would also parse, and would lose session 137 silently.
    expect(parsed.payload.sessions).toHaveLength(200);
    expect(parsed.payload.sessions[137]?.authoritativeCostUsd).toBeUndefined();
    expect(parsed.payload.sessions[137]?.externalSessionId).toBe(
      "iss-7229-session-137"
    );
  });

  it("still fails the WHOLE batch on a null, which is the refusal that must stay loud", () => {
    // The asymmetry, pinned. Dropping every malformed shape would have been the
    // easy generalization, and it would have quietly retired the one guard that
    // stops a desktop from erasing a real stored figure.
    const parsed = parsedBatchWithOneCostAt(200, 137, null);
    expect(parsed.ok).toBe(false);
  });
});
