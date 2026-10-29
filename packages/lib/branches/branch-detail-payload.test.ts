import type {
  BranchPageDetail,
  BranchSession,
} from "@repo/api/src/types/branch";
import {
  BranchPhaseAttributionCompleteness,
  BranchVisibleLifecyclePhase,
} from "@repo/api/src/types/branch-phase-attribution";
import { describe, expect, it } from "vitest";
import { phaseAttributionSegment } from "./__tests__/branch-phase-attribution-fixture";
import { rollupBranchActivity } from "./activity-rollup";
import { calculateBranchDetailMetrics } from "./branch-detail-outcomes";
import { compactBranchDetailPayload } from "./branch-detail-payload";

const session: BranchSession = {
  sessionId: "s1",
  slug: null,
  name: "Build",
  harness: "claude",
  startedAt: "2026-07-01T00:00:00.000Z",
  endedAt: null,
  isPrimary: true,
  ownerUserName: null,
  branchCount: 1,
  estimatedCostUsd: 3,
  inputTokens: 10,
  outputTokens: 20,
  cacheReadTokens: 30,
  cacheWriteTokens: 40,
};

function detailFixture() {
  const detail = {
    estimatedCostUsd: 3,
    attributedCostUsd: 3,
    sessions: [
      {
        ...session,
        activitySegments: [
          {
            phase: "implement",
            startMs: 0,
            endMs: 1000,
            costUsd: 3,
            inputTokens: 10,
            outputTokens: 20,
            cacheReadTokens: 30,
            cacheWriteTokens: 40,
            confidence: 0.9,
            sourceEventIds: ["event-1"],
            costEvents: [
              { sourceEventId: "event-1", occurredAtMs: 500, costUsd: 3 },
            ],
          },
        ],
      },
    ],
    phaseAttribution: {
      coverage: {
        completeness: BranchPhaseAttributionCompleteness.Complete,
        subtotalUsd: 3,
      },
      rollups: [
        {
          phase: BranchVisibleLifecyclePhase.Build,
          estimatedCostUsd: 3,
          inputTokens: 10,
          outputTokens: 20,
          cacheReadTokens: 30,
          cacheWriteTokens: 40,
          durationMs: 1000,
          sessionCount: 1,
        },
      ],
      segments: [
        phaseAttributionSegment({
          sessionId: "s1",
          phase: BranchVisibleLifecyclePhase.Build,
          startMs: 0,
          endMs: 1000,
          estimatedCostUsd: 3,
        }),
      ],
    },
  } satisfies Pick<
    BranchPageDetail,
    "sessions" | "phaseAttribution" | "estimatedCostUsd" | "attributedCostUsd"
  >;
  const canonicalMetrics = calculateBranchDetailMetrics({
    attributedCostUsd: 3,
    phaseAttribution: detail.phaseAttribution,
    selectedCycle: null,
    selectedPrAdditions: 100,
    selectedPrDeletions: 0,
    selectedPrLocComplete: true,
  });
  return { ...detail, canonicalMetrics };
}

describe("compactBranchDetailPayload", () => {
  it("removes only per-event arrays, retaining computed metrics, rollups and activity", () => {
    const raw = detailFixture();
    const compact = compactBranchDetailPayload(raw);
    expect(compact.sessions[0]?.activitySegments[0]).not.toHaveProperty(
      "sourceEventIds"
    );
    expect(compact.sessions[0]?.activitySegments[0]).not.toHaveProperty(
      "costEvents"
    );
    expect(compact.phaseAttribution.segments[0]).not.toHaveProperty(
      "costEvents"
    );
    expect(compact.canonicalMetrics).toBe(raw.canonicalMetrics);
    expect(compact.phaseAttribution.rollups).toBe(raw.phaseAttribution.rollups);
    expect(compact.phaseAttribution.coverage).toBe(
      raw.phaseAttribution.coverage
    );
    expect(rollupBranchActivity(compact)).toEqual(rollupBranchActivity(raw));
    expect(raw.sessions[0]?.activitySegments[0]?.sourceEventIds).toEqual([
      "event-1",
    ]);
    expect(raw.phaseAttribution.segments[0]?.costEvents).toHaveLength(1);
    const {
      sourceEventIds: _sources,
      costEvents: _costs,
      ...activity
    } = raw.sessions[0]!.activitySegments[0]!;
    const { costEvents: _events, ...phase } = raw.phaseAttribution.segments[0]!;
    expect(compact.sessions[0]?.activitySegments[0]).toEqual(activity);
    expect(compact.phaseAttribution.segments[0]).toEqual(phase);
    expect(JSON.stringify(compact).length).toBeLessThan(
      JSON.stringify(raw).length
    );
  });

  it("keeps legacy optional fields omitted and preserves explicitly empty arrays", () => {
    const legacy = { sessions: [session] };
    expect(compactBranchDetailPayload(legacy)).toEqual(legacy);
    expect(compactBranchDetailPayload(legacy)).not.toHaveProperty(
      "phaseAttribution"
    );
    expect(compactBranchDetailPayload(legacy).sessions[0]).not.toHaveProperty(
      "activitySegments"
    );
    const empty = { sessions: [{ ...session, activitySegments: [] }] };
    expect(compactBranchDetailPayload(empty)).toEqual(empty);
    const raw = detailFixture();
    const once = compactBranchDetailPayload(raw);
    expect(compactBranchDetailPayload(once)).toEqual(once);
  });
});
