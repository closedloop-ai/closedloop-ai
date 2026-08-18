import type { GenerationStatus } from "@repo/api/src/types/document";
import {
  EvalStatus,
  type JudgeFeedbackItem,
} from "@repo/api/src/types/evaluation";
import { RunLoopCommand } from "@repo/api/src/types/loop";
import { describe, expect, it } from "vitest";
import {
  FEATURE_JUDGES_MATERIALIZE_GRACE_MS,
  FEATURE_JUDGES_REFETCH_POLL_MS,
  resolveFeatureJudgesRefetchInterval,
} from "../feature-judges-refetch";

const STARTED_AT = new Date("2026-07-23T17:59:00.000Z");
const COMPLETED_AT = new Date("2026-07-23T18:00:00.000Z");
const NOW = COMPLETED_AT.getTime() + 1000;

function makeStatus(
  overrides: Partial<GenerationStatus> = {}
): GenerationStatus {
  return {
    status: "SUCCESS",
    command: RunLoopCommand.EvaluateFeature,
    htmlUrl: null,
    startedAt: STARTED_AT,
    completedAt: COMPLETED_AT,
    correlationId: null,
    ...overrides,
  };
}

function makeJudge(
  overrides: Partial<JudgeFeedbackItem> = {}
): JudgeFeedbackItem {
  return {
    judgeScoreId: "js-1",
    caseId: "case-1",
    score: 1,
    threshold: 0.5,
    justification: "ok",
    finalStatus: EvalStatus.Passed,
    promptName: null,
    metricName: "feature_metric",
    // Evaluation created after the run started => belongs to this run.
    evaluationCreatedAt: COMPLETED_AT.toISOString(),
    ...overrides,
  };
}

describe("resolveFeatureJudgesRefetchInterval", () => {
  it("polls when an evaluate_feature run succeeded but judges are empty within grace", () => {
    expect(
      resolveFeatureJudgesRefetchInterval({
        generationStatus: makeStatus(),
        judges: [],
        queryStatus: "success",
        nowMs: NOW,
      })
    ).toBe(FEATURE_JUDGES_REFETCH_POLL_MS);
  });

  it("polls when the judges query is still null (awaiting) within grace", () => {
    expect(
      resolveFeatureJudgesRefetchInterval({
        generationStatus: makeStatus(),
        judges: null,
        queryStatus: "success",
        nowMs: NOW,
      })
    ).toBe(FEATURE_JUDGES_REFETCH_POLL_MS);
  });

  it("stops once the current run's judges report is populated", () => {
    expect(
      resolveFeatureJudgesRefetchInterval({
        generationStatus: makeStatus(),
        judges: [makeJudge()],
        queryStatus: "success",
        nowMs: NOW,
      })
    ).toBe(false);
  });

  it("keeps polling when only a prior run's stale judges are present (re-evaluation)", () => {
    const staleJudges = [
      makeJudge({
        // Created before the current run started => belongs to a prior run.
        evaluationCreatedAt: new Date("2026-07-23T17:00:00.000Z").toISOString(),
      }),
    ];
    expect(
      resolveFeatureJudgesRefetchInterval({
        generationStatus: makeStatus(),
        judges: staleJudges,
        queryStatus: "success",
        nowMs: NOW,
      })
    ).toBe(FEATURE_JUDGES_REFETCH_POLL_MS);
  });

  it("treats populated judges without run identity as fresh (legacy fallback)", () => {
    expect(
      resolveFeatureJudgesRefetchInterval({
        generationStatus: makeStatus(),
        judges: [makeJudge({ evaluationCreatedAt: undefined })],
        queryStatus: "success",
        nowMs: NOW,
      })
    ).toBe(false);
  });

  it("backs off when the judges query is in an error state", () => {
    expect(
      resolveFeatureJudgesRefetchInterval({
        generationStatus: makeStatus(),
        judges: [],
        queryStatus: "error",
        nowMs: NOW,
      })
    ).toBe(false);
  });

  it("stops when the run is not yet terminal", () => {
    expect(
      resolveFeatureJudgesRefetchInterval({
        generationStatus: makeStatus({ status: "RUNNING" }),
        judges: [],
        queryStatus: "success",
        nowMs: NOW,
      })
    ).toBe(false);
  });

  it("stops for a non-evaluate_feature command", () => {
    expect(
      resolveFeatureJudgesRefetchInterval({
        generationStatus: makeStatus({ command: RunLoopCommand.EvaluatePrd }),
        judges: [],
        queryStatus: "success",
        nowMs: NOW,
      })
    ).toBe(false);
  });

  it("stops when completedAt is unavailable", () => {
    expect(
      resolveFeatureJudgesRefetchInterval({
        generationStatus: makeStatus({ completedAt: null }),
        judges: [],
        queryStatus: "success",
        nowMs: NOW,
      })
    ).toBe(false);
  });

  it("stops once the grace window has elapsed so an empty result cannot poll forever", () => {
    expect(
      resolveFeatureJudgesRefetchInterval({
        generationStatus: makeStatus(),
        judges: [],
        queryStatus: "success",
        nowMs: COMPLETED_AT.getTime() + FEATURE_JUDGES_MATERIALIZE_GRACE_MS,
      })
    ).toBe(false);
  });

  it("stops when there is no generation status", () => {
    expect(
      resolveFeatureJudgesRefetchInterval({
        generationStatus: undefined,
        judges: [],
        queryStatus: "success",
        nowMs: NOW,
      })
    ).toBe(false);
  });
});
