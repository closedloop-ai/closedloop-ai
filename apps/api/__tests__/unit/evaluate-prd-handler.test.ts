/**
 * Unit tests for the EVALUATE_PRD command handler.
 *
 * Uses the shared evaluation handler test factory — all evaluation handlers
 * share identical behavior via createEvaluationHandler.
 */
import { vi } from "vitest";

// --- Mocks (must come before imports — Vitest hoists these) ---

vi.mock("@repo/database", () => ({
  EvaluationReportType: {
    PRD: "PRD",
  },
  EntityType: {
    ARTIFACT: "ARTIFACT",
    FEATURE: "FEATURE",
    EXTERNAL_LINK: "EXTERNAL_LINK",
  },
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
}));

vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/loops/loop-artifact-ingestion", () => ({
  parseJsonArtifact: vi.fn(),
  upsertEvaluationWithJudgeScores: vi.fn(),
}));

vi.mock("@/lib/loops/loop-state", () => ({
  downloadArtifactFile: vi.fn(),
}));

vi.mock("@/lib/judge-score-fanout", () => ({
  fanOutJudgeScores: vi.fn().mockResolvedValue(undefined),
}));

// --- Imports (after mocks) ---

import { LoopCommand } from "@repo/api/src/types/loop";
import { EvaluationReportType } from "@repo/database";
import { evaluatePrdHandler } from "@/lib/loops/loop-commands/evaluate-prd-handler";
import { registerEvaluationHandlerTests } from "../utils/evaluation-handler-test-factory";

registerEvaluationHandlerTests({
  handler: evaluatePrdHandler,
  reportType: EvaluationReportType.PRD,
  artifactId: "prd-artifact-1",
  fileName: "prd-judges.json",
  reportId: "prd-report-1",
  judgeName: "clarity-judge",
  judgeScore: 0.88,
  command: LoopCommand.EvaluatePrd,
  s3StateKey: "org/loops/loop-prd/run-1",
});
