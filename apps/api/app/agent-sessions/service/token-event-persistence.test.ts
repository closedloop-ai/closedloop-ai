import type {
  SyncedAgentSession,
  SyncedAgentSessionTokenEvent,
} from "@repo/api/src/types/agent-session";
import {
  TokenCostBasis,
  TokenCostCompleteness,
  TokenCostCompletenessReason,
  TokenSourceIdentityAvailability,
  TokenSourceIdentityUnavailableReason,
} from "@repo/api/src/types/token-cost-provenance";
import { PARENT_AGENT_EXTERNAL_ID } from "@repo/api/src/types/token-event-agent-owner";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionUpsertTx } from "./records";
import { SessionSyncMetric } from "./session-sync-metrics";
import {
  persistSessionTokenEvents,
  toTokenEventCostEvidence,
} from "./token-event-persistence";

const metrics = vi.hoisted(() => ({ emitTelemetryMetric: vi.fn() }));
vi.mock("@repo/observability/telemetry/metrics", () => metrics);
/** ISS-12552: the sync request's answer; on unless a case says off. */
const flag = vi.hoisted(() => ({ on: true }));
vi.mock("@/lib/attribution-evidence-policy-feature", () => ({
  isAttributionEvidenceReadOnForOrganization: vi.fn(() => flag.on),
}));

const ARTIFACT_ID = "019fa111-1111-7111-8111-111111111111";
const ORGANIZATION_ID = "019fa222-2222-7222-8222-222222222222";

describe("token-event persistence (ISS-4882)", () => {
  it("maps omitted cost to null and preserves explicit zero", () => {
    expect(toTokenEventCostEvidence(buildTokenEvent())).toEqual({
      estimatedCost: null,
      costCompleteness: null,
      costCompletenessReason: null,
      subscriptionEquivalentCost: null,
      apiEstimatedCost: null,
    });
    expect(
      toTokenEventCostEvidence(buildTokenEvent({ estimatedCostUsd: 0 }))
        .estimatedCost
    ).toBe(0);
  });

  it("maps unavailable evidence to null without fabricating a zero", () => {
    expect(
      toTokenEventCostEvidence(
        buildTokenEvent({
          costSummary: {
            completeness: TokenCostCompleteness.Unavailable,
            reason: TokenCostCompletenessReason.LegacyRecord,
          },
        })
      )
    ).toEqual({
      estimatedCost: null,
      costCompleteness: TokenCostCompleteness.Unavailable,
      costCompletenessReason: TokenCostCompletenessReason.LegacyRecord,
      subscriptionEquivalentCost: null,
      apiEstimatedCost: null,
    });
  });

  it("persists subscription-equivalent and API-estimated lanes additively", () => {
    expect(
      toTokenEventCostEvidence(
        buildTokenEvent({
          costSummary: {
            completeness: TokenCostCompleteness.Complete,
            subtotalUsd: 1.25,
            lanes: [
              {
                basis: TokenCostBasis.SubscriptionEquivalent,
                subtotalUsd: 0.75,
              },
              { basis: TokenCostBasis.ApiEstimated, subtotalUsd: 0.5 },
            ],
          },
        })
      )
    ).toEqual({
      estimatedCost: 1.25,
      costCompleteness: TokenCostCompleteness.Complete,
      costCompletenessReason: null,
      subscriptionEquivalentCost: 0.75,
      apiEstimatedCost: 0.5,
    });
  });

  it("quantizes additive lanes without breaking their persisted subtotal", () => {
    const evidence = toTokenEventCostEvidence(
      buildTokenEvent({
        costSummary: {
          completeness: TokenCostCompleteness.Complete,
          subtotalUsd: 0.000_000_8,
          lanes: [
            {
              basis: TokenCostBasis.SubscriptionEquivalent,
              subtotalUsd: 0.000_000_4,
            },
            {
              basis: TokenCostBasis.ApiEstimated,
              subtotalUsd: 0.000_000_4,
            },
          ],
        },
      })
    );

    expect(evidence.estimatedCost).toBe(0.000_001);
    expect(evidence.subscriptionEquivalentCost).toBe(0);
    expect(evidence.apiEstimatedCost).toBe(0.000_001);
    expect(
      (evidence.subscriptionEquivalentCost ?? 0) +
        (evidence.apiEstimatedCost ?? 0)
    ).toBe(evidence.estimatedCost);
  });

  it("writes validated provenance and nullable cost on first insert", async () => {
    const event = buildTokenEvent({
      sourceIdentity: {
        availability: TokenSourceIdentityAvailability.Unavailable,
        reason: TokenSourceIdentityUnavailableReason.LegacyRecord,
      },
    });
    const { tx, createMany, findMany, executeRawUnsafe } = buildTx([event]);

    await persistSessionTokenEvents(
      tx,
      ARTIFACT_ID,
      ORGANIZATION_ID,
      buildSession([event]),
      false
    );

    expect(createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          agentSessionId: ARTIFACT_ID,
          externalEventId: event.externalEventId,
          estimatedCost: null,
          sourceIdentity: event.sourceIdentity,
        }),
      ],
      skipDuplicates: true,
    });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          agentSessionId: ARTIFACT_ID,
          session: { artifact: { organizationId: ORGANIZATION_ID } },
        }),
      })
    );
    expect(executeRawUnsafe).not.toHaveBeenCalled();
  });

  it("keeps exact replay idempotent and updates only supplied fresh evidence", async () => {
    const event = buildTokenEvent({
      estimatedCostUsd: 1,
      sourceIdentity: {
        availability: TokenSourceIdentityAvailability.Available,
        scheme: "provider-record-v1",
        sourceRecordIds: ["record-1"],
      },
      costSummary: {
        completeness: TokenCostCompleteness.Partial,
        reason: TokenCostCompletenessReason.PricingIncomplete,
        subtotalUsd: 0.75,
        lanes: [
          {
            basis: TokenCostBasis.SubscriptionEquivalent,
            subtotalUsd: 0.75,
          },
        ],
      },
    });
    const { tx, createMany, executeRawUnsafe } = buildTx([event]);

    await persistSessionTokenEvents(
      tx,
      ARTIFACT_ID,
      ORGANIZATION_ID,
      buildSession([event, event]),
      true
    );

    expect(createMany.mock.calls[0]?.[0].data).toHaveLength(1);
    expect(executeRawUnsafe).toHaveBeenCalledTimes(2);
    for (const call of executeRawUnsafe.mock.calls) {
      expect(call.at(-1)).toBe(ORGANIZATION_ID);
      expect(String(call[0])).toContain("artifacts.organization_id");
    }
    const costCall = executeRawUnsafe.mock.calls[1] ?? [];
    expect(costCall).toContain(0.75);
    expect(costCall).toContain(TokenCostCompleteness.Partial);
    expect(costCall).toContain(TokenCostCompletenessReason.PricingIncomplete);
  });

  it("does not clear stored provenance when a fresh legacy replay omits it", async () => {
    const event = buildTokenEvent({ estimatedCostUsd: 0.5 });
    const { tx, executeRawUnsafe } = buildTx([event]);

    await persistSessionTokenEvents(
      tx,
      ARTIFACT_ID,
      ORGANIZATION_ID,
      buildSession([event]),
      true
    );

    expect(executeRawUnsafe).toHaveBeenCalledTimes(1);
    expect(String(executeRawUnsafe.mock.calls[0]?.[0])).toContain(
      "CASE WHEN v.has_summary"
    );
    expect(String(executeRawUnsafe.mock.calls[0]?.[0])).toContain(
      "v.has_summary OR t.cost_completeness IS NULL"
    );
    expect(executeRawUnsafe.mock.calls[0]).toContain(false);
  });

  it("merges duplicate mutable evidence so later omission cannot erase it", async () => {
    const enriched = buildTokenEvent({
      sourceIdentity: {
        availability: TokenSourceIdentityAvailability.Available,
        scheme: "provider-record-v1",
        sourceRecordIds: ["record-1"],
      },
      costSummary: {
        completeness: TokenCostCompleteness.Complete,
        subtotalUsd: 0.5,
      },
    });
    const omitted = buildTokenEvent();
    const { tx, createMany, executeRawUnsafe } = buildTx([enriched]);

    await persistSessionTokenEvents(
      tx,
      ARTIFACT_ID,
      ORGANIZATION_ID,
      buildSession([enriched, omitted]),
      true
    );

    expect(createMany.mock.calls[0]?.[0].data).toEqual([
      expect.objectContaining({
        sourceIdentity: enriched.sourceIdentity,
        estimatedCost: 0.5,
        costCompleteness: TokenCostCompleteness.Complete,
      }),
    ]);
    expect(executeRawUnsafe).toHaveBeenCalledTimes(2);
  });

  it("fails before writing when one payload reuses a transport id for different immutable content", async () => {
    const first = buildTokenEvent();
    const collision = buildTokenEvent({ inputTokens: first.inputTokens + 1 });
    const { tx, createMany } = buildTx([]);

    await expect(
      persistSessionTokenEvents(
        tx,
        ARTIFACT_ID,
        ORGANIZATION_ID,
        buildSession([first, collision]),
        false
      )
    ).rejects.toThrow("token_event_transport_identity_collision");
    expect(createMany).not.toHaveBeenCalled();
  });

  it("fails closed when a concurrent row under the transport id has different content", async () => {
    const event = buildTokenEvent();
    const { tx } = buildTx([buildTokenEvent({ outputTokens: 999 })]);

    await expect(
      persistSessionTokenEvents(
        tx,
        ARTIFACT_ID,
        ORGANIZATION_ID,
        buildSession([event]),
        false
      )
    ).rejects.toThrow("token_event_transport_identity_collision");
  });

  it("keeps equal content with different transport ids as distinct rows", async () => {
    const first = buildTokenEvent();
    const second = buildTokenEvent({ externalEventId: "transport-2" });
    const { tx, createMany } = buildTx([first, second]);

    await persistSessionTokenEvents(
      tx,
      ARTIFACT_ID,
      ORGANIZATION_ID,
      buildSession([first, second]),
      false
    );

    expect(createMany.mock.calls[0]?.[0].data).toHaveLength(2);
  });

  it("bounds insert and immutable verification queries", async () => {
    const events = Array.from({ length: 501 }, (_, index) =>
      buildTokenEvent({ externalEventId: `transport-${index}` })
    );
    const { tx, createMany, findMany } = buildTx(events);

    await persistSessionTokenEvents(
      tx,
      ARTIFACT_ID,
      ORGANIZATION_ID,
      buildSession(events),
      false
    );

    expect(createMany).toHaveBeenCalledTimes(2);
    expect(findMany).toHaveBeenCalledTimes(2);
    expect(createMany.mock.calls.map((call) => call[0].data.length)).toEqual([
      500, 1,
    ]);
    expect(
      findMany.mock.calls.map((call) => call[0].where.externalEventId.in.length)
    ).toEqual([500, 1]);
  });
});

function buildTokenEvent(
  overrides: Partial<SyncedAgentSessionTokenEvent> = {}
): SyncedAgentSessionTokenEvent {
  return {
    externalEventId: "transport-1",
    model: "provider-neutral-model",
    inputTokens: 10,
    outputTokens: 20,
    cacheReadTokens: 30,
    cacheWriteTokens: 40,
    createdAt: "2026-08-02T12:00:00.000Z",
    ...overrides,
  };
}

function buildSession(tokenEvents: SyncedAgentSessionTokenEvent[]) {
  return { tokenEvents } as SyncedAgentSession;
}

function buildTx(persistedEvents: SyncedAgentSessionTokenEvent[]) {
  const createMany = vi
    .fn()
    .mockResolvedValue({ count: persistedEvents.length });
  const findMany = vi.fn().mockImplementation(({ where }) => {
    const ids = new Set(where.externalEventId.in);
    return Promise.resolve(
      persistedEvents
        .filter((event) => ids.has(event.externalEventId))
        .map((event) => ({
          externalEventId: event.externalEventId,
          agentExternalId: event.agentExternalId ?? null,
          model: event.model,
          inputTokens: BigInt(event.inputTokens),
          outputTokens: BigInt(event.outputTokens),
          cacheReadTokens: BigInt(event.cacheReadTokens),
          cacheWriteTokens: BigInt(event.cacheWriteTokens),
          eventCreatedAt: new Date(event.createdAt),
        }))
    );
  });
  const executeRawUnsafe = vi.fn().mockResolvedValue(0);
  const updateMany = vi.fn().mockResolvedValue({ count: 0 });
  const tx = {
    agentSessionTokenEvent: { createMany, findMany, updateMany },
    $executeRawUnsafe: executeRawUnsafe,
  } as unknown as AgentSessionUpsertTx;
  return { tx, createMany, findMany, updateMany, executeRawUnsafe };
}

/** The owner UPDATE's (externalEventId, owner) pairs, or [] when none ran. */
function ownerWrites(executeRawUnsafe: ReturnType<typeof vi.fn>) {
  const call = executeRawUnsafe.mock.calls.find((args) =>
    String(args[0]).includes("SET agent_external_id")
  );
  return call ? call.slice(2, -1) : [];
}

describe("token-event agent owner (ISS-12552, PRD-800)", () => {
  afterEach(() => {
    flag.on = true;
  });

  async function persist(
    stored: SyncedAgentSessionTokenEvent[],
    incoming: SyncedAgentSessionTokenEvent[]
  ) {
    const harness = buildTx(stored);
    await persistSessionTokenEvents(
      harness.tx,
      ARTIFACT_ID,
      ORGANIZATION_ID,
      buildSession(incoming),
      true
    );
    return harness;
  }

  it("replaces a stored owner with a different incoming one, without rejecting the event", async () => {
    // Counterfactual of the retired "rejects a different owner" case: the
    // owner is mutable evidence now, so a re-attributed event is accepted.
    const { executeRawUnsafe } = await persist(
      [buildTokenEvent({ agentExternalId: "agent-lane" })],
      [buildTokenEvent({ agentExternalId: "agent-other" })]
    );

    expect(ownerWrites(executeRawUnsafe)).toEqual([
      "transport-1",
      "agent-other",
    ]);
    expect(metrics.emitTelemetryMetric).toHaveBeenCalledWith(
      expect.objectContaining({
        metric: SessionSyncMetric.TokenEventAgentOwnerChanged,
        level: "info",
        status: "info",
        count: 1,
      })
    );
  });

  it("leaves a stored owner when an older client omits the field", async () => {
    const { executeRawUnsafe } = await persist(
      [
        buildTokenEvent({ agentExternalId: "agent-lane" }),
        buildTokenEvent({
          externalEventId: "transport-2",
          agentExternalId: "agent-lane",
        }),
      ],
      [
        buildTokenEvent(),
        buildTokenEvent({
          externalEventId: "transport-2",
          agentExternalId: null,
        }),
      ]
    );

    expect(ownerWrites(executeRawUnsafe)).toEqual([]);
  });

  it("clears a stored owner when the client states the main agent", async () => {
    const { executeRawUnsafe } = await persist(
      [buildTokenEvent({ agentExternalId: "agent-lane" })],
      [buildTokenEvent({ agentExternalId: PARENT_AGENT_EXTERNAL_ID })]
    );

    expect(ownerWrites(executeRawUnsafe)).toEqual(["transport-1", null]);
  });

  it("fills an owner the stored row lacks, and logs the fill as a change (PRD-800)", async () => {
    const { executeRawUnsafe } = await persist(
      [buildTokenEvent()],
      [buildTokenEvent({ agentExternalId: "agent-lane" })]
    );

    expect(ownerWrites(executeRawUnsafe)).toEqual([
      "transport-1",
      "agent-lane",
    ]);
    expect(metrics.emitTelemetryMetric).toHaveBeenCalledWith(
      expect.objectContaining({
        metric: SessionSyncMetric.TokenEventAgentOwnerChanged,
        count: 1,
      })
    );
  });

  it("stores the main agent's first insert as no owner", async () => {
    const { createMany } = await persist(
      [buildTokenEvent()],
      [buildTokenEvent({ agentExternalId: PARENT_AGENT_EXTERNAL_ID })]
    );

    expect(createMany.mock.calls[0]?.[0].data).toEqual([
      expect.objectContaining({ agentExternalId: null }),
    ]);
  });

  it("stores a new event's sent owner, and the main agent as no owner, while the flag is off", async () => {
    flag.on = false;
    const { createMany } = await persist(
      [buildTokenEvent(), buildTokenEvent({ externalEventId: "transport-2" })],
      [
        buildTokenEvent({ agentExternalId: "agent-lane" }),
        buildTokenEvent({
          externalEventId: "transport-2",
          agentExternalId: PARENT_AGENT_EXTERNAL_ID,
        }),
      ]
    );

    expect(createMany.mock.calls[0]?.[0].data).toEqual([
      expect.objectContaining({ agentExternalId: "agent-lane" }),
      expect.objectContaining({ agentExternalId: null }),
    ]);
  });

  it("keeps a stored owner the client moved to the main agent while the flag is off", async () => {
    flag.on = false;
    const { executeRawUnsafe } = await persist(
      [buildTokenEvent({ agentExternalId: "agent-lane" })],
      [buildTokenEvent({ agentExternalId: PARENT_AGENT_EXTERNAL_ID })]
    );

    expect(ownerWrites(executeRawUnsafe)).toEqual([]);
  });

  it("keeps a stored owner the client changed, without rejecting the event, while the flag is off", async () => {
    flag.on = false;
    const { executeRawUnsafe } = await persist(
      [buildTokenEvent({ agentExternalId: "agent-lane" })],
      [buildTokenEvent({ agentExternalId: "agent-other" })]
    );

    expect(ownerWrites(executeRawUnsafe)).toEqual([]);
    expect(metrics.emitTelemetryMetric).not.toHaveBeenCalledWith(
      expect.objectContaining({
        metric: SessionSyncMetric.TokenEventAgentOwnerChanged,
      })
    );
  });

  it("keeps the owner when one payload repeats an event with and without it", async () => {
    const { createMany } = await persist(
      [buildTokenEvent({ agentExternalId: "agent-lane" })],
      [buildTokenEvent({ agentExternalId: "agent-lane" }), buildTokenEvent()]
    );

    expect(createMany.mock.calls[0]?.[0].data).toEqual([
      expect.objectContaining({ agentExternalId: "agent-lane" }),
    ]);
  });
});
