/**
 * Unit tests for the EVALUATE_CODE command handler.
 *
 * Uses the shared evaluation handler test factory — all evaluation handlers
 * share identical behavior via createEvaluationHandler.
 */
import { vi } from "vitest";

// --- Mocks (must come before imports — Vitest hoists these) ---

vi.mock("@repo/database", () => ({
  EvaluationReportType: {
    CODE: "CODE",
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
import { evaluateCodeHandler } from "@/lib/loops/loop-commands/evaluate-code-handler";
import { registerEvaluationHandlerTests } from "../utils/evaluation-handler-test-factory";

registerEvaluationHandlerTests({
  handler: evaluateCodeHandler,
  reportType: "CODE",
  artifactId: "code-artifact-1",
  fileName: "code-judges.json",
  reportId: "code-report-1",
  judgeName: "correctness-judge",
  judgeScore: 0.92,
  command: LoopCommand.EvaluateCode,
  s3StateKey: "org/loops/loop-code/run-1",
});
