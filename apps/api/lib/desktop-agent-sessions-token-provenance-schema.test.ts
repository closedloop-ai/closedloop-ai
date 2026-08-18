import { AgentSessionSyncMode } from "@repo/api/src/types/agent-session";
import {
  TokenCostBasis,
  TokenCostCompleteness,
  TokenCostCompletenessReason,
  TokenSourceIdentityAvailability,
  TokenSourceIdentityUnavailableReason,
} from "@repo/api/src/types/token-cost-provenance";
import { describe, expect, it } from "vitest";
import {
  MAX_SYNCED_TOKEN_EVENTS_PER_SESSION,
  parseDesktopAgentSessionsPayload,
} from "./desktop-agent-sessions-schema";

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

  it("rejects a token-event chunk above the bounded ingest cardinality", () => {
    const payload = buildPayload(buildEvent()) as {
      sessions: Array<{ tokenEvents: unknown[] }>;
    };
    payload.sessions[0]!.tokenEvents = Array.from(
      { length: MAX_SYNCED_TOKEN_EVENTS_PER_SESSION + 1 },
      (_, index) => buildEvent({ externalEventId: `transport-${index}` })
    );

    expect(parseDesktopAgentSessionsPayload(payload).ok).toBe(false);
  });

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
