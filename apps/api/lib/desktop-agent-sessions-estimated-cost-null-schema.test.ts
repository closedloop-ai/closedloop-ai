/**
 * ISS-7813: a NULL whole-session cost SURVIVES the sync ingress.
 *
 * `sessions.cost_usd_estimated` on the desktop is nullable on purpose — NULL is
 * "nobody priced this", which is not the same fact as a real $0.00 — and this
 * ticket makes the cloud column able to hold that distinction. When the producer
 * is flipped onto that column (ISS-7818) it will emit `estimatedCostUsd: null` as
 * a VALUE rather than omitting the field.
 *
 * It does NOT do so yet, and that is the point of testing this now: the ingress
 * has to accept the value BEFORE anything sends one, or the first build that does
 * meets a boundary that rejects it. This file is the expand step's proof.
 *
 * `syncedAgentSessionAnalyticsSchema` is the only thing standing between that
 * value and the database, and the blast radius of getting it wrong is the whole
 * batch, not the field: `parseDesktopAgentSessionsPayload` safeParses the entire
 * payload with no per-session salvage, so one unpriced session would reject up
 * to 200 healthy ones — deterministically, on every retry, until they
 * dead-letter. Sessions that were never priced are precisely the population this
 * ticket exists for, so that failure would target exactly the rows it means to
 * fix, and would do it silently: the persistence tests call
 * `persistSessionChildren` with an in-process object and never cross this
 * schema, so nothing else in the suite goes red.
 *
 * This file is that missing boundary. The round-trip below fails the moment
 * `.nullable()` leaves the field, and so does `tsc`: dropping it collapses the
 * parsed union to `number | undefined`, which `PRODUCER_COST_VALUES` is then
 * unassignable to. That is worth having because the ordinary keys-covered guards
 * cannot catch it — they prove key PRESENCE and this is a nullability question —
 * and because `parseDesktopAgentSessionsPayload` casts its output to the contract
 * type, so nothing else compares the two at all.
 *
 * What that construct does NOT catch, stated plainly so nobody trusts it further
 * than it goes: if the PRODUCER union widens (a new variant on
 * `SyncedAgentSessionAnalytics["estimatedCostUsd"]`), the four sampled literals
 * stay assignable both ways and nothing goes red until a human adds the new value
 * here. It guards the schema against narrowing, not the contract against growing.
 *
 * DB-free: exercises only `parseDesktopAgentSessionsPayload` (the pure ingress
 * contract), matching its sibling schema suites.
 */
import type { SyncedAgentSessionAnalytics } from "@repo/api/src/types/agent-session";
import { AgentSessionSyncMode } from "@repo/api/src/types/agent-session";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  parseDesktopAgentSessionsPayload,
  type syncedAgentSessionAnalyticsSchema,
} from "./desktop-agent-sessions-schema";

const AGENT_SESSION_SYNC_SCHEMA_VERSION = 2 as const;

type ParsedAnalyticsCost = z.infer<
  typeof syncedAgentSessionAnalyticsSchema
>["estimatedCostUsd"];

/**
 * Every value `SyncedAgentSessionAnalytics.estimatedCostUsd` may carry, typed as
 * what the SCHEMA parses to.
 *
 * The value of this list is mostly its TYPE, in two directions. The annotation
 * fails `tsc` if the schema stops parsing one of these — dropping `.nullable()`
 * narrows the parsed union to `number | undefined` and this array no longer fits.
 * The `satisfies` clause fails if a value listed here is one the producer cannot
 * actually emit. Neither direction covers the producer union GROWING; see the
 * file docstring.
 */
const PRODUCER_COST_VALUES: ParsedAnalyticsCost[] = [
  9.99,
  0,
  null,
  undefined,
] satisfies SyncedAgentSessionAnalytics["estimatedCostUsd"][];

function buildAnalytics(extras: Record<string, unknown>): unknown {
  return {
    isHuman: true,
    humanTurns: 2,
    agentTurns: 3,
    eventCount: 5,
    toolInvocations: 1,
    errorEvents: 0,
    inputTokens: 100,
    outputTokens: 200,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    ...extras,
  };
}

function buildSession(
  externalSessionId: string,
  analyticsExtras: Record<string, unknown>
): unknown {
  return {
    externalSessionId,
    status: "active",
    startedAt: "2026-08-23T10:00:00.000Z",
    updatedAt: "2026-08-23T11:00:00.000Z",
    agents: [],
    events: [],
    tokenUsageByModel: [],
    sessionAnalytics: buildAnalytics(analyticsExtras),
  };
}

function buildPayload(sessions: readonly unknown[]): unknown {
  return {
    schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
    batchId: "00000000-0000-4000-8000-000000000001",
    syncMode: AgentSessionSyncMode.Incremental,
    sessionCount: sessions.length,
    sessions,
  };
}

describe("desktop sync schema — null whole-session cost (ISS-7813)", () => {
  it("round-trips an unpriced session's null cost as null", () => {
    const parsed = parseDesktopAgentSessionsPayload(
      buildPayload([buildSession("sess-1", { estimatedCostUsd: null })])
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      // null, NOT 0 and NOT undefined: the persist path branches on all three,
      // and folding any pair together is the conflation this ticket removes.
      expect(
        parsed.payload.sessions[0].sessionAnalytics?.estimatedCostUsd
      ).toBeNull();
    }
  });

  it("round-trips a priced session's cost intact", () => {
    const parsed = parseDesktopAgentSessionsPayload(
      buildPayload([buildSession("sess-1", { estimatedCostUsd: 9.99 })])
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(
        parsed.payload.sessions[0].sessionAnalytics?.estimatedCostUsd
      ).toBe(9.99);
    }
  });

  it("preserves omission for a desktop build predating this ticket", () => {
    const parsed = parseDesktopAgentSessionsPayload(
      buildPayload([buildSession("sess-1", {})])
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      // Absent, NOT null — an older client must leave whatever was last written
      // rather than blanking it, which is what the persist path's
      // `!== undefined` guard keys on.
      expect(
        parsed.payload.sessions[0].sessionAnalytics?.estimatedCostUsd
      ).toBeUndefined();
    }
  });

  it("accepts a real $0.00 cost, which is a different fact from null", () => {
    const parsed = parseDesktopAgentSessionsPayload(
      buildPayload([buildSession("sess-1", { estimatedCostUsd: 0 })])
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(
        parsed.payload.sessions[0].sessionAnalytics?.estimatedCostUsd
      ).toBe(0);
    }
  });

  it("lets one unpriced session through WITHOUT rejecting the rest of the batch", () => {
    // The regression that matters. The parse is whole-batch with no per-session
    // salvage, so an unaccepted null does not lose one field — it loses every
    // session travelling with it.
    const parsed = parseDesktopAgentSessionsPayload(
      buildPayload([
        buildSession("sess-priced", { estimatedCostUsd: 4.5 }),
        buildSession("sess-unpriced", { estimatedCostUsd: null }),
        buildSession("sess-also-priced", { estimatedCostUsd: 1.25 }),
      ])
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.payload.sessions).toHaveLength(3);
      expect(
        parsed.payload.sessions.map(
          (session) => session.sessionAnalytics?.estimatedCostUsd
        )
      ).toEqual([4.5, null, 1.25]);
    }
  });

  it("accepts every value the producer type can emit", () => {
    for (const estimatedCostUsd of PRODUCER_COST_VALUES) {
      const parsed = parseDesktopAgentSessionsPayload(
        buildPayload([buildSession("sess-1", { estimatedCostUsd })])
      );
      expect(parsed.ok).toBe(true);
    }
  });

  it("still rejects a negative cost", () => {
    const parsed = parseDesktopAgentSessionsPayload(
      buildPayload([buildSession("sess-1", { estimatedCostUsd: -1 })])
    );
    expect(parsed.ok).toBe(false);
  });

  it("still rejects a non-finite cost", () => {
    const parsed = parseDesktopAgentSessionsPayload(
      buildPayload([
        buildSession("sess-1", { estimatedCostUsd: Number.POSITIVE_INFINITY }),
      ])
    );
    expect(parsed.ok).toBe(false);
  });
});
