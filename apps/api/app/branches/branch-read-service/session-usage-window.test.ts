import { BranchParticipationKind } from "@repo/api/src/types/branch";
import {
  aggregateBranchCostCompleteness,
  BranchCostCompleteness,
  BranchCostCompletenessReason,
  type BranchCostEvidenceContribution,
  branchCostEvidenceByteBudget,
  branchCostEvidenceFixedRowBytes,
  branchCostEvidenceRetainedBytes,
  branchCostEvidenceRowBudget,
} from "@repo/api/src/types/branch-usage";
import {
  SessionArtifactLinkKind,
  SessionPrRelationType,
} from "@repo/api/src/types/session-artifact-link";
import {
  TokenCostCompleteness,
  TokenSourceIdentityAvailability,
} from "@repo/api/src/types/token-cost-provenance";
import { describe, expect, it, vi } from "vitest";
import { resolveSessionEventEvidence } from "../branch-session-cost-evidence";
import {
  getSessionUsageByBranch,
  type LinkedSession,
  type SessionUsageClient,
} from "./session-usage-window";

describe("Branch session cost evidence", () => {
  it("projects complete mixed-lane evidence on the all-time path", async () => {
    const { db, eventEvidenceQuery } = makeClient();
    const evidence: BranchCostEvidenceContribution[] = [];

    await getSessionUsageByBranch(db, "org-1", ["branch-1"], {
      costEvidenceOut: evidence,
    });

    expect(eventEvidenceQuery).toHaveBeenCalledOnce();
    const evidenceSql = renderSql(eventEvidenceQuery.mock.calls[0]?.[0]);
    expect(evidenceSql).toContain('event.source_identity AS "sourceIdentity"');
    expect(evidenceSql).toContain(
      'event.cost_completeness AS "costCompleteness"'
    );
    expect(aggregateBranchCostCompleteness(evidence)).toEqual({
      completeness: BranchCostCompleteness.Complete,
      subtotalUsd: 3,
      lanes: { subscriptionEquivalentCost: 1, apiEstimatedCost: 2 },
    });
  });

  it("does not compare a bounded event cohort with lifetime rollups", async () => {
    const { db } = makeClient({
      lifetimeInputTokens: 100,
      eventInputTokens: 1,
    });
    const evidence: BranchCostEvidenceContribution[] = [];

    await getSessionUsageByBranch(db, "org-1", ["branch-1"], {
      dateWindow: { startDate: new Date("2026-06-01T00:00:00.000Z") },
      costEvidenceOut: evidence,
    });

    expect(aggregateBranchCostCompleteness(evidence).completeness).toBe(
      BranchCostCompleteness.Complete
    );
  });

  it("preserves the unwindowed fast path when completeness is not requested", async () => {
    const { db, eventEvidenceQuery } = makeClient();

    await getSessionUsageByBranch(db, "org-1", ["branch-1"]);

    expect(eventEvidenceQuery).not.toHaveBeenCalled();
  });

  it("requires persisted SessionDetail before hydrating branch usage", async () => {
    const { artifactLinkFindMany, db } = makeClient();

    await getSessionUsageByBranch(db, "org-1", ["branch-1"]);

    expect(artifactLinkFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          source: expect.objectContaining({ session: { isNot: null } }),
        }),
      })
    );
  });

  it("treats an explicit-zero legacy session as partial rather than empty", async () => {
    const { db } = makeClient({ events: [], estimatedCost: 0 });
    const evidence: BranchCostEvidenceContribution[] = [];

    await getSessionUsageByBranch(db, "org-1", ["branch-1"], {
      costEvidenceOut: evidence,
    });

    expect(aggregateBranchCostCompleteness(evidence)).toEqual({
      completeness: BranchCostCompleteness.Partial,
      reason: BranchCostCompletenessReason.CoverageIncomplete,
      subtotalUsd: 0,
    });
  });

  it("retains a lifetime fallback when event evidence has no subtotal", async () => {
    const { db } = makeClient({
      estimatedCost: 3,
      events: [eventFixture({ estimatedCost: null, costCompleteness: null })],
    });
    const evidence: BranchCostEvidenceContribution[] = [];

    await getSessionUsageByBranch(db, "org-1", ["branch-1"], {
      costEvidenceOut: evidence,
    });

    expect(aggregateBranchCostCompleteness(evidence)).toEqual({
      completeness: BranchCostCompleteness.Partial,
      reason: BranchCostCompletenessReason.CoverageIncomplete,
      subtotalUsd: 3,
    });
  });

  it("retains a valid lifetime fallback when tokens are malformed and events are unpriced", async () => {
    const { db } = makeClient({
      lifetimeInputTokens: -1,
      estimatedCost: 5,
      events: [eventFixture({ estimatedCost: null, costCompleteness: null })],
    });
    const evidence: BranchCostEvidenceContribution[] = [];

    await getSessionUsageByBranch(db, "org-1", ["branch-1"], {
      costEvidenceOut: evidence,
    });

    expect(aggregateBranchCostCompleteness(evidence)).toEqual({
      completeness: BranchCostCompleteness.Partial,
      reason: BranchCostCompletenessReason.Malformed,
      subtotalUsd: 5,
    });
  });

  it("isolates bounded evidence from malformed lifetime cost", async () => {
    const { db } = makeClient({ estimatedCost: -1 });
    const allTimeEvidence: BranchCostEvidenceContribution[] = [];
    const boundedEvidence: BranchCostEvidenceContribution[] = [];

    await getSessionUsageByBranch(db, "org-1", ["branch-1"], {
      costEvidenceOut: allTimeEvidence,
    });
    await getSessionUsageByBranch(db, "org-1", ["branch-1"], {
      dateWindow: { startDate: new Date("2026-06-01T00:00:00.000Z") },
      costEvidenceOut: boundedEvidence,
    });

    expect(aggregateBranchCostCompleteness(allTimeEvidence)).toEqual({
      completeness: BranchCostCompleteness.Partial,
      reason: BranchCostCompletenessReason.Malformed,
      subtotalUsd: 3,
      lanes: { subscriptionEquivalentCost: 1, apiEstimatedCost: 2 },
    });
    expect(aggregateBranchCostCompleteness(boundedEvidence)).toEqual({
      completeness: BranchCostCompleteness.Complete,
      subtotalUsd: 3,
      lanes: { subscriptionEquivalentCost: 1, apiEstimatedCost: 2 },
    });
  });

  it("compares lifetime token coverage exactly above the safe-number limit", async () => {
    const large = BigInt(Number.MAX_SAFE_INTEGER) + 10n;
    const { db } = makeClient({
      lifetimeInputTokens: large,
      events: [eventFixture({ inputTokens: large - 1n })],
    });
    const evidence: BranchCostEvidenceContribution[] = [];

    await getSessionUsageByBranch(db, "org-1", ["branch-1"], {
      costEvidenceOut: evidence,
    });

    expect(aggregateBranchCostCompleteness(evidence)).toMatchObject({
      completeness: BranchCostCompleteness.Partial,
      reason: BranchCostCompletenessReason.CoverageIncomplete,
    });
  });

  it.each([
    3, 0,
  ])("keeps captured subtotal %s while marking corrupt token totals malformed", async (subtotalUsd) => {
    const { db } = makeClient({
      lifetimeInputTokens: 0,
      estimatedCost: subtotalUsd,
      events: [
        eventFixture({
          inputTokens: -1,
          estimatedCost: subtotalUsd,
          subscriptionEquivalentCost: subtotalUsd,
          apiEstimatedCost: 0,
        }),
      ],
    });
    const evidence: BranchCostEvidenceContribution[] = [];

    await getSessionUsageByBranch(db, "org-1", ["branch-1"], {
      dateWindow: { startDate: new Date("2026-06-01T00:00:00.000Z") },
      costEvidenceOut: evidence,
    });

    expect(aggregateBranchCostCompleteness(evidence)).toEqual({
      completeness: BranchCostCompleteness.Partial,
      reason: BranchCostCompletenessReason.Malformed,
      subtotalUsd,
      lanes: {
        subscriptionEquivalentCost: subtotalUsd,
        apiEstimatedCost: 0,
      },
    });
  });

  it("keeps matching mixed priced and unpriced events pricing-incomplete", async () => {
    const { db } = makeClient({
      lifetimeInputTokens: 2,
      events: [
        eventFixture({ sourceRecordId: "priced" }),
        eventFixture({
          sourceRecordId: "unpriced",
          estimatedCost: null,
          costCompleteness: null,
        }),
      ],
    });
    const evidence: BranchCostEvidenceContribution[] = [];

    await getSessionUsageByBranch(db, "org-1", ["branch-1"], {
      costEvidenceOut: evidence,
    });

    expect(aggregateBranchCostCompleteness(evidence)).toMatchObject({
      completeness: BranchCostCompleteness.Partial,
      reason: BranchCostCompletenessReason.PricingIncomplete,
      subtotalUsd: 3,
    });
  });

  it("aggregates the full bounded event population for legacy numeric totals", async () => {
    const events = Array.from({ length: 1001 }, (_, index) => {
      const id = `event-${index.toString().padStart(4, "0")}`;
      return eventFixture({ id, sourceRecordId: id });
    });
    const { db, eventEvidenceQuery } = makeClient({
      events,
      lifetimeInputTokens: 1001,
    });
    const evidence: BranchCostEvidenceContribution[] = [];

    const usage = await getSessionUsageByBranch(db, "org-1", ["branch-1"], {
      dateWindow: { startDate: new Date("2026-06-01T00:00:00.000Z") },
      costEvidenceOut: evidence,
    });

    expect(usage.get("branch-1")).toMatchObject({
      inputTokens: 1001,
      estimatedCostUsd: 3003,
    });
    expect(aggregateBranchCostCompleteness(evidence)).toMatchObject({
      completeness: BranchCostCompleteness.Complete,
      subtotalUsd: 3003,
    });
    expect(eventEvidenceQuery).toHaveBeenCalledTimes(1);
  });

  it("bounds retained evidence request-wide without truncating numeric aggregation", async () => {
    const events = Array.from({ length: 10_001 }, (_, index) =>
      eventFixture({ id: `event-${index}` })
    );
    const { db, eventEvidenceQuery } = makeClient({
      events,
      lifetimeInputTokens: 10_001,
    });
    const evidence: BranchCostEvidenceContribution[] = [];

    const usage = await getSessionUsageByBranch(db, "org-1", ["branch-1"], {
      dateWindow: { startDate: new Date("2026-06-01T00:00:00.000Z") },
      costEvidenceOut: evidence,
    });

    expect(usage.get("branch-1")).toMatchObject({
      inputTokens: 10_001,
      estimatedCostUsd: 30_003,
    });
    expect(aggregateBranchCostCompleteness(evidence)).toMatchObject({
      completeness: BranchCostCompleteness.Partial,
      reason: BranchCostCompletenessReason.CoverageIncomplete,
      subtotalUsd: 30_003,
    });
    expect(eventEvidenceQuery).toHaveBeenCalledTimes(1);
  });

  it("does not let valid event costs mask a malformed row after overflow", async () => {
    const events = Array.from(
      { length: branchCostEvidenceRowBudget + 1 },
      (_, index) =>
        eventFixture({
          id: `event-${index}`,
          estimatedCost: maskedMalformedCost(index),
        })
    );
    const { db } = makeClient({
      events,
      lifetimeInputTokens: events.length,
    });
    const evidence: BranchCostEvidenceContribution[] = [];

    await getSessionUsageByBranch(db, "org-1", ["branch-1"], {
      dateWindow: { startDate: new Date("2026-06-01T00:00:00.000Z") },
      costEvidenceOut: evidence,
    });

    expect(aggregateBranchCostCompleteness(evidence)).toEqual({
      completeness: BranchCostCompleteness.Unavailable,
      reason: BranchCostCompletenessReason.Malformed,
    });
  });

  it("preserves a valid lifetime subtotal when all-time overflow evidence is malformed", async () => {
    const events = Array.from(
      { length: branchCostEvidenceRowBudget + 1 },
      (_, index) =>
        eventFixture({
          id: `event-${index}`,
          estimatedCost: maskedMalformedCost(index),
        })
    );
    const { db } = makeClient({
      events,
      estimatedCost: 1,
      lifetimeInputTokens: events.length,
    });
    const evidence: BranchCostEvidenceContribution[] = [];

    await getSessionUsageByBranch(db, "org-1", ["branch-1"], {
      costEvidenceOut: evidence,
    });

    expect(aggregateBranchCostCompleteness(evidence)).toEqual({
      completeness: BranchCostCompleteness.Partial,
      reason: BranchCostCompletenessReason.Malformed,
      subtotalUsd: 1,
    });
  });

  it("detects offsetting malformed token rows after all-time overflow", async () => {
    const events = Array.from(
      { length: branchCostEvidenceRowBudget + 1 },
      (_, index) =>
        eventFixture({
          id: `event-${index}`,
          inputTokens: maskedMalformedCost(index),
          estimatedCost: index === 0 ? 1 : 0,
        })
    );
    const { db } = makeClient({
      events,
      estimatedCost: 1,
      lifetimeInputTokens: 1,
    });
    const evidence: BranchCostEvidenceContribution[] = [];

    await getSessionUsageByBranch(db, "org-1", ["branch-1"], {
      costEvidenceOut: evidence,
    });

    expect(aggregateBranchCostCompleteness(evidence)).toEqual({
      completeness: BranchCostCompleteness.Partial,
      reason: BranchCostCompletenessReason.Malformed,
      subtotalUsd: 1,
    });
  });

  it("marks malformed lifetime token aggregates on normal and overflow reads", async () => {
    for (const events of [
      [eventFixture({ estimatedCost: 3 })],
      Array.from({ length: branchCostEvidenceRowBudget + 1 }, (_, index) =>
        eventFixture({
          id: `event-${index}`,
          estimatedCost: index === 0 ? 3 : 0,
        })
      ),
    ]) {
      const { db } = makeClient({
        events,
        estimatedCost: 3,
        lifetimeInputTokens: -1,
      });
      const evidence: BranchCostEvidenceContribution[] = [];

      await getSessionUsageByBranch(db, "org-1", ["branch-1"], {
        costEvidenceOut: evidence,
      });

      expect(aggregateBranchCostCompleteness(evidence)).toMatchObject({
        completeness: BranchCostCompleteness.Partial,
        reason: BranchCostCompletenessReason.Malformed,
        subtotalUsd: 3,
      });
    }
  });

  it("marks matching-token lifetime and event cost divergence incomplete", async () => {
    const { db } = makeClient({
      events: [eventFixture({ estimatedCost: 3 })],
      estimatedCost: 100,
      lifetimeInputTokens: 1,
    });
    const allTimeEvidence: BranchCostEvidenceContribution[] = [];
    const boundedEvidence: BranchCostEvidenceContribution[] = [];

    await getSessionUsageByBranch(db, "org-1", ["branch-1"], {
      costEvidenceOut: allTimeEvidence,
    });
    await getSessionUsageByBranch(db, "org-1", ["branch-1"], {
      dateWindow: { startDate: new Date("2026-06-01T00:00:00.000Z") },
      costEvidenceOut: boundedEvidence,
    });

    expect(aggregateBranchCostCompleteness(allTimeEvidence)).toEqual({
      completeness: BranchCostCompleteness.Partial,
      reason: BranchCostCompletenessReason.CoverageIncomplete,
      subtotalUsd: 3,
      lanes: { subscriptionEquivalentCost: 1, apiEstimatedCost: 2 },
    });
    expect(aggregateBranchCostCompleteness(boundedEvidence)).toEqual({
      completeness: BranchCostCompleteness.Complete,
      subtotalUsd: 3,
      lanes: { subscriptionEquivalentCost: 1, apiEstimatedCost: 2 },
    });
  });

  it("returns complete zero for an observed empty bounded cohort", async () => {
    const { db } = makeClient({
      events: [],
      estimatedCost: 3,
      lifetimeInputTokens: 1,
    });
    const evidence: BranchCostEvidenceContribution[] = [];

    await getSessionUsageByBranch(db, "org-1", ["branch-1"], {
      dateWindow: { startDate: new Date("2026-06-01T00:00:00.000Z") },
      costEvidenceOut: evidence,
    });

    expect(aggregateBranchCostCompleteness(evidence)).toEqual({
      completeness: BranchCostCompleteness.Complete,
      subtotalUsd: 0,
      lanes: { subscriptionEquivalentCost: 0, apiEstimatedCost: 0 },
    });
  });

  it("rejects an oversized identity before materializing evidence JSON", async () => {
    const { db, eventEvidenceQuery } = makeClient({
      sourceIdentityBytes: branchCostEvidenceByteBudget,
    });
    const evidence: BranchCostEvidenceContribution[] = [];

    await getSessionUsageByBranch(db, "org-1", ["branch-1"], {
      dateWindow: { startDate: new Date("2026-06-01T00:00:00.000Z") },
      costEvidenceOut: evidence,
    });

    expect(eventEvidenceQuery).toHaveBeenCalledTimes(1);
    const evidenceSql = renderSql(eventEvidenceQuery.mock.calls[0]?.[0]);
    const sizeCte = evidenceSql.split("), stats AS")[0] ?? "";
    expect(sizeCte).toContain("octet_length(event.source_identity::text)");
    expect(renderSqlValues(eventEvidenceQuery.mock.calls[0]?.[0])).toContain(
      branchCostEvidenceFixedRowBytes
    );
    expect(sizeCte).not.toContain('AS "sourceIdentity"');
    expect(sizeCte).not.toContain('AS "costCompleteness"');
    expect(evidenceSql).toContain('AS "sourceIdentity"');
    expect(evidenceSql).toContain('AS "costCompleteness"');
    expect(aggregateBranchCostCompleteness(evidence)).toEqual({
      completeness: BranchCostCompleteness.Partial,
      reason: BranchCostCompletenessReason.CoverageIncomplete,
      subtotalUsd: 3,
    });
  });

  it.each([
    ["just below", branchCostEvidenceByteBudget - 1, false],
    ["at", branchCostEvidenceByteBudget, false],
    ["above", branchCostEvidenceByteBudget + 1, true],
  ] as const)("classifies %s the shared byte cap", async (_label, retainedBytes, exceeded) => {
    const { db } = makeClient({
      sourceIdentityBytes: retainedBytes - branchCostEvidenceFixedRowBytes,
    });
    const evidence: BranchCostEvidenceContribution[] = [];

    await getSessionUsageByBranch(db, "org-1", ["branch-1"], {
      costEvidenceOut: evidence,
    });

    expect(aggregateBranchCostCompleteness(evidence)).toEqual(
      exceeded
        ? {
            completeness: BranchCostCompleteness.Partial,
            reason: BranchCostCompletenessReason.CoverageIncomplete,
            subtotalUsd: 3,
          }
        : {
            completeness: BranchCostCompleteness.Complete,
            subtotalUsd: 3,
            lanes: {
              subscriptionEquivalentCost: 1,
              apiEstimatedCost: 2,
            },
          }
    );
  });

  it("degrades when aggregate and materialized evidence observe different populations", async () => {
    const { db, eventGroupBy } = makeClient();
    eventGroupBy.mockResolvedValueOnce([
      {
        agentSessionId: "session-1",
        _sum: {
          inputTokens: 1n,
          outputTokens: 0n,
          cacheReadTokens: 0n,
          cacheWriteTokens: 0n,
          estimatedCost: 3,
        },
        _count: { _all: 2 },
      },
    ]);
    const evidence: BranchCostEvidenceContribution[] = [];

    await getSessionUsageByBranch(db, "org-1", ["branch-1"], {
      dateWindow: { startDate: new Date("2026-06-01T00:00:00.000Z") },
      costEvidenceOut: evidence,
    });

    expect(aggregateBranchCostCompleteness(evidence)).toEqual({
      completeness: BranchCostCompleteness.Partial,
      reason: BranchCostCompletenessReason.CoverageIncomplete,
      subtotalUsd: 3,
    });
  });

  it("keeps later malformed precedence when an earlier session mismatches", async () => {
    const events = [
      eventFixture({ agentSessionId: "session-1", estimatedCost: 3 }),
      eventFixture({
        agentSessionId: "session-2",
        inputTokens: -1,
        estimatedCost: 5,
      }),
    ];
    const { db, eventGroupBy } = makeClient({ events });
    eventGroupBy.mockResolvedValueOnce([
      eventAggregate("session-1", 1n, 3, 2),
      eventAggregate("session-2", -1n, 5, 1),
    ]);

    const result = await resolveSessionEventEvidence(
      db,
      "org-1",
      [linkedSession("session-1", 3), linkedSession("session-2", 5)],
      { startDate: new Date("2026-06-01T00:00:00.000Z") }
    );

    expect(aggregateBranchCostCompleteness(result.contributions)).toEqual({
      completeness: BranchCostCompleteness.Partial,
      reason: BranchCostCompletenessReason.Malformed,
      subtotalUsd: 8,
    });
  });

  it("excludes metadata-reviewed legacy links from evidence and totals", async () => {
    const { db, eventEvidenceQuery } = makeClient({
      branchParticipation: null,
      metadata: {
        linkKind: SessionArtifactLinkKind.SessionBranch,
        relationTypes: [SessionPrRelationType.Reviewed],
      },
    });
    const evidence: BranchCostEvidenceContribution[] = [];

    const usage = await getSessionUsageByBranch(db, "org-1", ["branch-1"], {
      costEvidenceOut: evidence,
    });

    expect(usage.get("branch-1")?.estimatedCostUsd).toBe(0);
    expect(aggregateBranchCostCompleteness(evidence)).toEqual({
      completeness: BranchCostCompleteness.Complete,
      subtotalUsd: 0,
      lanes: { subscriptionEquivalentCost: 0, apiEstimatedCost: 0 },
    });
    expect(eventEvidenceQuery).not.toHaveBeenCalled();
  });

  it.each([
    5, 0,
  ])("retains an all-time lifetime fallback after evidence overflow (%s)", async (estimatedCost) => {
    const events = Array.from({ length: 10_001 }, (_, index) =>
      eventFixture({ id: `event-${index}` })
    );
    const { db } = makeClient({
      events,
      estimatedCost,
      lifetimeInputTokens: 10_001,
    });
    const evidence: BranchCostEvidenceContribution[] = [];

    await getSessionUsageByBranch(db, "org-1", ["branch-1"], {
      costEvidenceOut: evidence,
    });

    expect(aggregateBranchCostCompleteness(evidence)).toEqual({
      completeness: BranchCostCompleteness.Partial,
      reason: BranchCostCompletenessReason.CoverageIncomplete,
      subtotalUsd: estimatedCost,
    });
  });

  it("uses the same coverage fallback for all-time and equivalent bounded overflow", async () => {
    const events = Array.from({ length: 10_001 }, (_, index) =>
      eventFixture({
        id: `event-${index}`,
        estimatedCost: index === 0 ? 3 : 0,
      })
    );
    const { db } = makeClient({
      events,
      estimatedCost: 3,
      lifetimeInputTokens: 10_001,
    });
    const allTimeEvidence: BranchCostEvidenceContribution[] = [];
    const boundedEvidence: BranchCostEvidenceContribution[] = [];

    await getSessionUsageByBranch(db, "org-1", ["branch-1"], {
      costEvidenceOut: allTimeEvidence,
    });
    await getSessionUsageByBranch(db, "org-1", ["branch-1"], {
      dateWindow: { startDate: new Date("2026-06-01T00:00:00.000Z") },
      costEvidenceOut: boundedEvidence,
    });

    const expected = {
      completeness: BranchCostCompleteness.Partial,
      reason: BranchCostCompletenessReason.CoverageIncomplete,
      subtotalUsd: 3,
    };
    expect(aggregateBranchCostCompleteness(allTimeEvidence)).toEqual(expected);
    expect(aggregateBranchCostCompleteness(boundedEvidence)).toEqual(expected);
  });
});

function makeClient(
  options: {
    lifetimeInputTokens?: bigint | number;
    eventInputTokens?: bigint | number;
    estimatedCost?: number;
    events?: ReturnType<typeof eventFixture>[];
    lifetimeEvents?: ReturnType<typeof eventFixture>[];
    sourceIdentityBytes?: number;
    branchParticipation?: BranchParticipationKind | null;
    metadata?: Record<string, unknown>;
  } = {}
) {
  const lifetimeInputTokens = options.lifetimeInputTokens ?? 1;
  const eventInputTokens = options.eventInputTokens ?? lifetimeInputTokens;
  const events = options.events ?? [
    eventFixture({ inputTokens: eventInputTokens }),
  ];
  const lifetimeEvents =
    options.lifetimeEvents ??
    (options.events === undefined && lifetimeInputTokens !== eventInputTokens
      ? [eventFixture({ inputTokens: lifetimeInputTokens })]
      : events);
  const retainedBytes = events.reduce(
    (total, event) =>
      total +
      branchCostEvidenceRetainedBytes(
        options.sourceIdentityBytes ??
          Buffer.byteLength(JSON.stringify(event.sourceIdentity)) +
            Buffer.byteLength(
              JSON.stringify({
                completeness: event.costCompleteness,
                reason: event.costCompletenessReason,
                subscriptionEquivalentCost: event.subscriptionEquivalentCost,
                apiEstimatedCost: event.apiEstimatedCost,
              })
            )
      ),
    0
  );
  const eventEvidenceQuery = vi
    .fn()
    .mockResolvedValue(mockCloudEvidenceRows(events, retainedBytes));
  const eventGroupBy = vi
    .fn()
    .mockImplementation((args) =>
      Promise.resolve(
        eventAggregateRows(
          "eventCreatedAt" in (args?.where ?? {}) ? events : lifetimeEvents
        )
      )
    );
  const artifactLinkFindMany = vi.fn().mockResolvedValue([
    {
      targetId: "branch-1",
      sourceId: "session-1",
      branchParticipation:
        options.branchParticipation === undefined
          ? BranchParticipationKind.Wrote
          : options.branchParticipation,
      metadata: options.metadata ?? {
        linkKind: SessionArtifactLinkKind.SessionBranch,
      },
      source: {
        name: "Canonical session",
        slug: "canonical-session",
        session: {
          artifactId: "session-1",
          externalSessionId: "external-1",
          harness: "claude",
          sessionStartedAt: new Date("2026-06-10T10:00:00.000Z"),
          sessionEndedAt: null,
          estimatedCost: options.estimatedCost ?? 3,
          inputTokens: lifetimeInputTokens,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          userId: null,
        },
      },
    },
  ]);
  const db = {
    $queryRaw: eventEvidenceQuery,
    artifactLink: {
      findMany: artifactLinkFindMany,
    },
    agentSessionTokenEvent: {
      findMany: vi.fn(),
      groupBy: eventGroupBy,
    },
  } as unknown as SessionUsageClient;
  return { artifactLinkFindMany, db, eventEvidenceQuery, eventGroupBy };
}

function cloudEvidenceMetadataRow(
  evidenceCount: number,
  retainedBytes: number
) {
  return {
    id: null,
    agentSessionId: null,
    eventCreatedAt: null,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    estimatedCost: null,
    sourceIdentity: null,
    costCompleteness: null,
    costCompletenessReason: null,
    subscriptionEquivalentCost: null,
    apiEstimatedCost: null,
    evidenceBytes: null,
    evidenceCount,
    retainedBytes,
  };
}

function eventAggregateRows(events: ReturnType<typeof eventFixture>[]) {
  if (events.length === 0) {
    return [];
  }
  return [
    {
      agentSessionId: "session-1",
      _sum: {
        inputTokens: sumEventField(events, "inputTokens"),
        outputTokens: 0n,
        cacheReadTokens: 0n,
        cacheWriteTokens: 0n,
        estimatedCost: events.reduce(
          (total, event) => total + (event.estimatedCost ?? 0),
          0
        ),
      },
      _min: {
        inputTokens: minimumEventToken(events, "inputTokens"),
        outputTokens: minimumEventToken(events, "outputTokens"),
        cacheReadTokens: minimumEventToken(events, "cacheReadTokens"),
        cacheWriteTokens: minimumEventToken(events, "cacheWriteTokens"),
        estimatedCost: minimumEventCost(events),
      },
      _count: {
        _all: events.length,
        estimatedCost: events.filter((event) => event.estimatedCost !== null)
          .length,
      },
    },
  ];
}

function mockCloudEvidenceRows(
  events: ReturnType<typeof eventFixture>[],
  retainedBytes: number
) {
  if (
    events.length > branchCostEvidenceRowBudget ||
    retainedBytes > branchCostEvidenceByteBudget
  ) {
    return [cloudEvidenceMetadataRow(events.length, retainedBytes)];
  }
  if (events.length === 0) {
    return [cloudEvidenceMetadataRow(0, 0)];
  }
  return events.map((event) => ({
    ...event,
    evidenceBytes: branchCostEvidenceFixedRowBytes,
    evidenceCount: events.length,
    retainedBytes,
  }));
}

function renderSql(query: unknown): string {
  if (typeof query !== "object" || query === null || !("sql" in query)) {
    return "";
  }
  return String(query.sql);
}

function renderSqlValues(query: unknown): unknown[] {
  if (typeof query !== "object" || query === null || !("values" in query)) {
    return [];
  }
  return Array.isArray(query.values) ? query.values : [];
}

function sumEventField(
  events: ReturnType<typeof eventFixture>[],
  field: "inputTokens"
): bigint {
  return events.reduce((total, event) => total + BigInt(event[field]), 0n);
}

function minimumEventCost(
  events: ReturnType<typeof eventFixture>[]
): number | null {
  let minimum: number | null = null;
  for (const event of events) {
    if (event.estimatedCost !== null) {
      minimum =
        minimum === null
          ? event.estimatedCost
          : Math.min(minimum, event.estimatedCost);
    }
  }
  return minimum;
}

function minimumEventToken(
  events: ReturnType<typeof eventFixture>[],
  field: "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens"
): bigint | null {
  let minimum: bigint | null = null;
  for (const event of events) {
    const value = BigInt(event[field]);
    minimum = minimum === null || value < minimum ? value : minimum;
  }
  return minimum;
}

function maskedMalformedCost(index: number): number {
  if (index === 0) {
    return -1;
  }
  if (index === 1) {
    return 2;
  }
  return 0;
}

function eventFixture(
  overrides: Partial<{
    agentSessionId: string;
    inputTokens: bigint | number;
    id: string;
    estimatedCost: number | null;
    costCompleteness: string | null;
    sourceRecordId: string;
    subscriptionEquivalentCost: number;
    apiEstimatedCost: number;
  }> = {}
) {
  return {
    id: overrides.id ?? "event-1",
    agentSessionId: overrides.agentSessionId ?? "session-1",
    eventCreatedAt: new Date("2026-06-10T10:00:00.000Z"),
    inputTokens: overrides.inputTokens ?? 1,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    estimatedCost:
      overrides.estimatedCost === undefined ? 3 : overrides.estimatedCost,
    sourceIdentity: {
      availability: TokenSourceIdentityAvailability.Available,
      scheme: "claude-jsonl",
      sourceRecordIds: [overrides.sourceRecordId ?? "record-1"],
    },
    costCompleteness:
      overrides.costCompleteness === undefined
        ? TokenCostCompleteness.Complete
        : overrides.costCompleteness,
    costCompletenessReason: null,
    subscriptionEquivalentCost: overrides.subscriptionEquivalentCost ?? 1,
    apiEstimatedCost: overrides.apiEstimatedCost ?? 2,
  };
}

function eventAggregate(
  agentSessionId: string,
  inputTokens: bigint,
  estimatedCost: number,
  count: number
) {
  return {
    agentSessionId,
    _sum: {
      inputTokens,
      outputTokens: 0n,
      cacheReadTokens: 0n,
      cacheWriteTokens: 0n,
      estimatedCost,
    },
    _count: { _all: count },
  };
}

function linkedSession(
  artifactId: string,
  estimatedCost: number,
  inputTokens: bigint | number = 0n,
  // ISS-5445 — defaults to null (no captured mode ⇒ unknown ledger, counted in
  // the total and in NEITHER sub-bucket), which is what these pre-existing
  // fixtures already assumed before the ledger split existed.
  billingMode: string | null = null
): LinkedSession {
  return {
    artifactId,
    externalSessionId: artifactId,
    harness: "claude",
    sessionStartedAt: new Date("2026-06-10T10:00:00.000Z"),
    sessionEndedAt: null,
    estimatedCost,
    inputTokens,
    outputTokens: 0n,
    cacheReadTokens: 0n,
    cacheWriteTokens: 0n,
    billingMode,
    userId: null,
  };
}
