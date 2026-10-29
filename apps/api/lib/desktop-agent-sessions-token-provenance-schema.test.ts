import { AgentSessionSyncMode } from "@repo/api/src/types/agent-session";
import {
  TokenCostBasis,
  TokenCostCompleteness,
  TokenCostCompletenessReason,
  TokenSourceIdentityAvailability,
  TokenSourceIdentityUnavailableReason,
} from "@repo/api/src/types/token-cost-provenance";
import { describe, expect, it } from "vitest";
import { parseDesktopAgentSessionsPayload } from "./desktop-agent-sessions-schema";

const TRANSPORT_ID = "transport:session-1:usage-1";

describe("desktop token provenance sync schema (ISS-4882)", () => {
  it("preserves omission for legacy producers", () => {
    const parsed = parseDesktopAgentSessionsPayload(buildPayload(buildEvent()));

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.payload.sessions[0]?.tokenEvents?.[0]).not.toHaveProperty(
        "sourceIdentity"
      );
      expect(parsed.payload.sessions[0]?.tokenEvents?.[0]).not.toHaveProperty(
        "costSummary"
      );
    }
  });

  it("retains validated provenance and both additive cost lanes", () => {
    const sourceIdentity = {
      availability: TokenSourceIdentityAvailability.Available,
      scheme: "provider-record-v1",
      sourceRecordIds: ["request-1", "usage-1"],
    } as const;
    const costSummary = {
      completeness: TokenCostCompleteness.Complete,
      subtotalUsd: 1.25,
      lanes: [
        {
          basis: TokenCostBasis.SubscriptionEquivalent,
          subtotalUsd: 0.75,
        },
        { basis: TokenCostBasis.ApiEstimated, subtotalUsd: 0.5 },
      ],
    } as const;
    const parsed = parseDesktopAgentSessionsPayload(
      buildPayload(buildEvent({ sourceIdentity, costSummary }))
    );

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.payload.sessions[0]?.tokenEvents?.[0]).toMatchObject({
        externalEventId: TRANSPORT_ID,
        sourceIdentity,
        costSummary,
      });
    }
  });

  it("accepts truthful unavailable evidence without a fabricated subtotal", () => {
    const parsed = parseDesktopAgentSessionsPayload(
      buildPayload(
        buildEvent({
          sourceIdentity: {
            availability: TokenSourceIdentityAvailability.Unavailable,
            reason: TokenSourceIdentityUnavailableReason.LegacyRecord,
          },
          costSummary: {
            completeness: TokenCostCompleteness.Unavailable,
            reason: TokenCostCompletenessReason.LegacyRecord,
          },
        })
      )
    );

    expect(parsed.ok).toBe(true);
  });

  it.each([
    [
      "malformed available identity",
      {
        sourceIdentity: {
          availability: TokenSourceIdentityAvailability.Available,
          scheme: "provider-record-v1",
          sourceRecordIds: [],
        },
      },
    ],
    [
      "non-reconciling lanes",
      {
        costSummary: {
          completeness: TokenCostCompleteness.Partial,
          reason: TokenCostCompletenessReason.PricingIncomplete,
          subtotalUsd: 2,
          lanes: [
            {
              basis: TokenCostBasis.SubscriptionEquivalent,
              subtotalUsd: 1,
            },
          ],
        },
      },
    ],
    ["legacy cost above cloud precision", { estimatedCostUsd: 100_000_000 }],
    [
      "summary cost above cloud precision",
      {
        costSummary: {
          completeness: TokenCostCompleteness.Complete,
          subtotalUsd: 100_000_000,
        },
      },
    ],
  ])("rejects %s", (_name, overrides) => {
    const parsed = parseDesktopAgentSessionsPayload(
      buildPayload(buildEvent(overrides))
    );

    expect(parsed.ok).toBe(false);
  });

  it("projects known provenance and drops unknown additive keys", () => {
    const parsed = parseDesktopAgentSessionsPayload(
      buildPayload(
        buildEvent({
          sourceIdentity: {
            availability: TokenSourceIdentityAvailability.Unavailable,
            reason: TokenSourceIdentityUnavailableReason.LegacyRecord,
            provider: "future-provider-metadata",
          },
          costSummary: {
            completeness: TokenCostCompleteness.Complete,
            subtotalUsd: 1,
            futurePricingMetadata: true,
          },
        })
      )
    );

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const event = parsed.payload.sessions[0]?.tokenEvents?.[0];
      expect(event?.sourceIdentity).toEqual({
        availability: TokenSourceIdentityAvailability.Unavailable,
        reason: TokenSourceIdentityUnavailableReason.LegacyRecord,
      });
      expect(event?.costSummary).toEqual({
        completeness: TokenCostCompleteness.Complete,
        subtotalUsd: 1,
      });
    }
  });

  it.each([
    ["future identity variant", { sourceIdentity: { availability: "future" } }],
    ["future cost variant", { costSummary: { completeness: "future" } }],
    [
      "future cost lane",
      {
        costSummary: {
          completeness: TokenCostCompleteness.Complete,
          subtotalUsd: 1,
          lanes: [{ basis: "future", subtotalUsd: 1 }],
        },
      },
    ],
  ])("drops %s without rejecting the token event", (_name, overrides) => {
    const parsed = parseDesktopAgentSessionsPayload(
      buildPayload(buildEvent(overrides))
    );

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const event = parsed.payload.sessions[0]?.tokenEvents?.[0];
      expect(event).not.toHaveProperty("sourceIdentity");
      expect(event).not.toHaveProperty("costSummary");
    }
  });

  // ISS-8051: the retired cap was 10,000, so 10,001 crosses the old boundary by
  // exactly one. Pinned as a literal, never derived from a constant, so deleting
  // or reintroducing one cannot move the case this test actually exercises.
  // The explicit timeout is for payload SIZE, not for a suspected hang: sanitizing
  // and validating ten thousand token events is linear work that outruns the
  // default 5s budget on a loaded host (measured 0.4s idle, 2.7-6.8s under load
  // here). 30s is ~5x the worst measurement — enough headroom for a slow runner,
  // and deliberately NOT so large that a future parse regression turns a fast red
  // into a multi-minute CI stall.
  it("accepts and preserves a token-event array past the retired 10,000 cap", () => {
    const overCapEventCount = 10_001;
    const payload = buildPayload(buildEvent()) as {
      sessions: Array<{ tokenEvents: unknown[] }>;
    };
    payload.sessions[0]!.tokenEvents = Array.from(
      { length: overCapEventCount },
      (_, index) => buildEvent({ externalEventId: `transport-${index}` })
    );

    const parsed = parseDesktopAgentSessionsPayload(payload);

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const tokenEvents = parsed.payload.sessions[0]?.tokenEvents;
      // In FULL: not merely accepted, and not silently shortened to the old cap.
      expect(tokenEvents).toHaveLength(overCapEventCount);
      expect(tokenEvents?.at(-1)?.externalEventId).toBe(
        `transport-${overCapEventCount - 1}`
      );
    }
  }, 30_000);

  it("rejects a transport identity that is not already normalized", () => {
    const parsed = parseDesktopAgentSessionsPayload(
      buildPayload(buildEvent({ externalEventId: ` ${TRANSPORT_ID} ` }))
    );

    expect(parsed.ok).toBe(false);
  });
});

function buildEvent(overrides: Record<string, unknown> = {}) {
  return {
    externalEventId: TRANSPORT_ID,
    model: "provider-neutral-model",
    inputTokens: 10,
    outputTokens: 20,
    cacheReadTokens: 30,
    cacheWriteTokens: 40,
    createdAt: "2026-08-02T12:00:00.000Z",
    ...overrides,
  };
}

function buildPayload(event: Record<string, unknown>): unknown {
  return {
    schemaVersion: 2,
    batchId: "00000000-0000-4000-8000-000000000001",
    syncMode: AgentSessionSyncMode.Incremental,
    sessionCount: 1,
    sessions: [
      {
        externalSessionId: "session-1",
        status: "active",
        startedAt: "2026-08-02T11:00:00.000Z",
        updatedAt: "2026-08-02T12:00:00.000Z",
        agents: [],
        events: [],
        tokenUsageByModel: [],
        tokenEvents: [event],
      },
    ],
  };
}
