import assert from "node:assert/strict";
import {
  BranchLifecycleBoundaryKind,
  BranchLifecyclePhase,
  type BranchLifecyclePhaseSegment,
} from "@repo/api/src/types/branch";
import { describe, test } from "vitest";
import type { SyncedAgentSession } from "../src/main/agent-sync/agent-session-sync-contract.js";
import { toEnrichedBranchSession } from "../src/main/branch/branch-session-projection.js";
import type { BranchSessionTokenRow } from "../src/main/database/branch-reads.js";

describe("Desktop Branch session projection", () => {
  test("sums token models and omits optional evidence when it was not loaded", () => {
    const result = toEnrichedBranchSession(
      makeSession({
        name: "Coverage session",
        endedAt: "2026-08-20T01:00:00.000Z",
        tokenUsageByModel: [
          usage({ inputTokens: 1, outputTokens: 2 }),
          usage({
            model: "model-b",
            inputTokens: 10,
            outputTokens: 20,
            cacheReadTokens: 30,
            cacheWriteTokens: 40,
          }),
        ],
      }),
      true,
      2,
      undefined,
      undefined
    );

    assert.equal(result.sessionId, "session-1");
    assert.equal(result.name, "Coverage session");
    assert.equal(result.isPrimary, true);
    assert.equal(result.branchCount, 2);
    assert.equal(result.inputTokens, 11);
    assert.equal(result.outputTokens, 22);
    assert.equal(result.cacheReadTokens, 30);
    assert.equal(result.cacheWriteTokens, 40);
    assert.equal(Object.hasOwn(result, "evenSplitCostUsd"), false);
    assert.equal(Object.hasOwn(result, "phaseSegments"), false);
    assert.equal(Object.hasOwn(result, "activitySegments"), false);
  });

  test("preserves optional zero cost, non-empty phases, and an explicitly empty tiling", () => {
    const phases: BranchLifecyclePhaseSegment[] = [
      {
        sequence: 0,
        phase: BranchLifecyclePhase.Build,
        startedAt: "2026-08-20T00:00:00.000Z",
        endedAt: "2026-08-20T01:00:00.000Z",
        startBoundary: { kind: BranchLifecycleBoundaryKind.BranchWrite },
      },
    ];
    const tokenRow: BranchSessionTokenRow = {
      sessionId: "session-1",
      branchCount: 1,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsdEstimated: 0,
      evenSplitCostUsd: 0,
    };

    const result = toEnrichedBranchSession(
      makeSession({ activitySegmentRows: [], tokenEvents: [] }),
      false,
      1,
      phases,
      tokenRow
    );

    assert.equal(result.evenSplitCostUsd, 0);
    assert.deepEqual(result.phaseSegments, phases);
    assert.deepEqual(result.activitySegments, []);
  });

  test("attributes only events inside valid half-open activity spans", () => {
    const startMs = Date.parse("2026-08-20T00:00:00.000Z");
    const result = toEnrichedBranchSession(
      makeSession({
        activitySegmentRows: [
          {
            phase: "implement",
            startMs,
            endMs: startMs + 60_000,
            confidence: 0.8,
            evidenceLayers: [],
            version: 1,
          },
        ],
        tokenEvents: [
          {
            externalEventId: "event-in",
            model: "model-a",
            inputTokens: 3,
            outputTokens: 4,
            cacheReadTokens: 5,
            cacheWriteTokens: 6,
            estimatedCostUsd: 0.25,
            createdAt: new Date(startMs + 30_000).toISOString(),
          },
          {
            externalEventId: "event-end",
            model: "model-a",
            inputTokens: 30,
            outputTokens: 40,
            cacheReadTokens: 50,
            cacheWriteTokens: 60,
            estimatedCostUsd: 2.5,
            createdAt: new Date(startMs + 60_000).toISOString(),
          },
        ],
      }),
      false,
      1,
      [],
      undefined
    );

    assert.deepEqual(result.activitySegments, [
      {
        phase: "implement",
        startMs,
        endMs: startMs + 60_000,
        costUsd: 0.25,
        inputTokens: 3,
        outputTokens: 4,
        cacheReadTokens: 5,
        cacheWriteTokens: 6,
        sourceEventIds: ["event-in"],
        costEvents: [
          {
            sourceEventId: "event-in",
            occurredAtMs: startMs + 30_000,
            costUsd: 0.25,
          },
        ],
        confidence: 0.8,
      },
    ]);
    assert.equal(Object.hasOwn(result, "phaseSegments"), false);
  });
});

function makeSession(
  overrides: Partial<SyncedAgentSession> = {}
): SyncedAgentSession {
  return {
    externalSessionId: "session-1",
    name: null,
    status: "completed",
    harness: "claude",
    model: "model-a",
    startedAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
    endedAt: null,
    metadata: null,
    agents: [],
    events: [],
    tokenUsageByModel: [],
    ...overrides,
  } as SyncedAgentSession;
}

function usage(
  overrides: Partial<SyncedAgentSession["tokenUsageByModel"][number]> = {}
): SyncedAgentSession["tokenUsageByModel"][number] {
  return {
    model: "model-a",
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    ...overrides,
  };
}
