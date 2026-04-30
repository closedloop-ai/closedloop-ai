/**
 * Unit tests for the EVALUATE_FEATURE command handler.
 *
 * Uses the shared evaluation handler test factory — all evaluation handlers
 * share identical behavior via createEvaluationHandler.
 */
import { vi } from "vitest";

// --- Mocks (must come before imports — Vitest hoists these) ---

vi.mock("@repo/database", () => ({
  ArtifactType: {
    DOCUMENT: "DOCUMENT",
    PULL_REQUEST: "PULL_REQUEST",
    DEPLOYMENT: "DEPLOYMENT",
  },
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
}));

vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/loops/loop-document-ingestion", () => ({
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

import { EvaluationReportType } from "@repo/api/src/types/evaluation";
import { LoopCommand } from "@repo/api/src/types/loop";
import { evaluateFeatureHandler } from "@/lib/loops/loop-commands/evaluate-feature-handler";
import { registerEvaluationHandlerTests } from "../utils/evaluation-handler-test-factory";

registerEvaluationHandlerTests({
  handler: evaluateFeatureHandler,
  reportType: EvaluationReportType.Feature,
  documentId: "feature-artifact-1",
  fileName: "feature-judges.json",
  reportId: "feature-report-1",
  judgeName: "feature-quality-judge",
  judgeScore: 0.85,
  command: LoopCommand.EvaluateFeature,
  s3StateKey: "org/loops/loop-feature/run-1",
});
