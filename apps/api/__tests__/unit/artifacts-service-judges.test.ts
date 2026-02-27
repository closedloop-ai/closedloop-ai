/**
 * Unit tests for artifactsService.getJudgesFeedback method.
 *
 * Tests querying JudgeScore rows for the latest evaluation of an artifact.
 * Returns Option B canonical response (JudgeFeedbackItem[]) on success.
 *
 * Uses scenario registry pattern for maintainable, DRY test structure.
 */
import type {
  JudgeFeedbackItem,
  JudgesFeedbackResponse,
} from "@repo/api/src/types/evaluation";
import {
  EvalStatus,
  EvaluationReportType,
} from "@repo/api/src/types/evaluation";
import { type Mock, vi } from "vitest";

// Mock modules before importing the service
vi.mock("@repo/database", () => ({
  withDb: vi.fn(),
  EvaluationReportType: {
    PLAN: "PLAN",
    CODE: "CODE",
  },
}));

// Import after mocking
import { withDb } from "@repo/database";
import { artifactsService } from "@/app/artifacts/service";
import {
  createMockEvaluationRow,
  createMockJudgeScoreRow,
} from "../fixtures/evaluation";

// Type alias for mocked function
const mockWithDb = withDb as unknown as Mock;

// Sample mock data matching JudgeFeedbackItem[]
const MOCK_JUDGE_SCORE_ROW = createMockJudgeScoreRow({
  caseId: "test-judge",
  score: 0.95,
  threshold: 0.8,
  justification: "Test justification",
  finalStatus: EvalStatus.Passed,
  prompt: null,
});

const EXPECTED_FEEDBACK_ITEMS: JudgeFeedbackItem[] = [
  {
    caseId: "test-judge",
    score: 0.95,
    threshold: 0.8,
    justification: "Test justification",
    finalStatus: EvalStatus.Passed,
    promptName: null,
  },
];

/**
 * Scenario configuration for parametrized testing.
 */
type ScenarioConfig = {
  name: string;
  description: string;
  setupMocks: () => void;
  expectedResult: JudgesFeedbackResponse;
};

/**
 * Scenario registry containing all test cases.
 * Each scenario defines mock setup and expected result.
 */
const SCENARIO_REGISTRY: ScenarioConfig[] = [
  {
    name: "db_success_returns_judge_feedback_items",
    description:
      "Happy path returns JudgeFeedbackItem array from JudgeScore rows",
    setupMocks: () => {
      vi.spyOn(artifactsService, "findByIdSimple").mockResolvedValue({
        id: "artifact-123",
      } as any);
      let callCount = 0;
      mockWithDb.mockImplementation((callback: any) => {
        callCount++;
        if (callCount === 1) {
          // First call: artifactEvaluation.findFirst
          return callback({
            artifactEvaluation: {
              findFirst: vi
                .fn()
                .mockResolvedValue(
                  createMockEvaluationRow({
                    id: "eval-123",
                    artifactId: "artifact-123",
                  })
                ),
            },
          });
        }
        // Second call: judgeScore.findMany
        return callback({
          judgeScore: {
            findMany: vi.fn().mockResolvedValue([MOCK_JUDGE_SCORE_ROW]),
          },
        });
      });
    },
    expectedResult: { status: "success", data: EXPECTED_FEEDBACK_ITEMS },
  },
  {
    name: "no_evaluation_returns_not_found",
    description:
      "When no evaluation exists in database, returns not_found status",
    setupMocks: () => {
      vi.spyOn(artifactsService, "findByIdSimple").mockResolvedValue({
        id: "artifact-123",
      } as any);
      mockWithDb.mockImplementation((callback: any) =>
        callback({
          artifactEvaluation: {
            findFirst: vi.fn().mockResolvedValue(null),
          },
        })
      );
    },
    expectedResult: { status: "not_found", data: null },
  },
  {
    name: "artifact_not_found_returns_not_found",
    description: "When artifact does not exist, returns not_found status",
    setupMocks: () => {
      vi.spyOn(artifactsService, "findByIdSimple").mockResolvedValue(null);
    },
    expectedResult: { status: "not_found", data: null },
  },
  {
    name: "empty_judge_scores_returns_empty_array",
    description:
      "When evaluation exists but no judge scores, returns empty array",
    setupMocks: () => {
      vi.spyOn(artifactsService, "findByIdSimple").mockResolvedValue({
        id: "artifact-123",
      } as any);
      let callCount = 0;
      mockWithDb.mockImplementation((callback: any) => {
        callCount++;
        if (callCount === 1) {
          return callback({
            artifactEvaluation: {
              findFirst: vi
                .fn()
                .mockResolvedValue(createMockEvaluationRow({ id: "eval-123" })),
            },
          });
        }
        return callback({
          judgeScore: {
            findMany: vi.fn().mockResolvedValue([]),
          },
        });
      });
    },
    expectedResult: { status: "success", data: [] },
  },
];

describe("artifactsService.getJudgesFeedback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Parametrized test using scenario registry
  describe.each(SCENARIO_REGISTRY)("$name", (scenario) => {
    it(scenario.description, async () => {
      scenario.setupMocks();

      const result = await artifactsService.getJudgesFeedback(
        "artifact-123",
        "org-123"
      );

      expect(result).toEqual(scenario.expectedResult);
    });
  });

  it("queries only plan evaluations via reportType enum", async () => {
    vi.spyOn(artifactsService, "findByIdSimple").mockResolvedValue({
      id: "artifact-123",
    } as any);

    const findFirst = vi.fn().mockResolvedValue(null);
    mockWithDb.mockImplementation((callback: any) =>
      callback({
        artifactEvaluation: { findFirst },
      })
    );

    await artifactsService.getJudgesFeedback("artifact-123", "org-123");

    expect(findFirst).toHaveBeenCalledWith({
      where: {
        artifactId: "artifact-123",
        reportType: EvaluationReportType.Plan,
      },
      orderBy: { createdAt: "desc" },
    });
  });

  it("includes promptName from linked prompt when available", async () => {
    vi.spyOn(artifactsService, "findByIdSimple").mockResolvedValue({
      id: "artifact-123",
    } as any);

    const scoreWithPrompt = createMockJudgeScoreRow({
      caseId: "dry-judge",
      score: 0.9,
      threshold: 0.75,
      justification: "DRY check passed",
      finalStatus: EvalStatus.Passed,
      prompt: { id: "prompt-123", name: "DRY Principle Judge" },
    });

    let callCount = 0;
    mockWithDb.mockImplementation((callback: any) => {
      callCount++;
      if (callCount === 1) {
        return callback({
          artifactEvaluation: {
            findFirst: vi.fn().mockResolvedValue(createMockEvaluationRow()),
          },
        });
      }
      return callback({
        judgeScore: {
          findMany: vi.fn().mockResolvedValue([scoreWithPrompt]),
        },
      });
    });

    const result = await artifactsService.getJudgesFeedback(
      "artifact-123",
      "org-123"
    );

    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.data[0].promptName).toBe("DRY Principle Judge");
      expect(result.data[0].caseId).toBe("dry-judge");
    }
  });
});

describe("artifactsService.getCodeJudgesFeedback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("queries only code evaluations via reportType enum", async () => {
    vi.spyOn(artifactsService, "findByIdSimple").mockResolvedValue({
      id: "artifact-123",
    } as any);

    const findFirst = vi.fn().mockResolvedValue(null);
    mockWithDb.mockImplementation((callback: any) =>
      callback({
        artifactEvaluation: { findFirst },
      })
    );

    await artifactsService.getCodeJudgesFeedback("artifact-123", "org-123");

    expect(findFirst).toHaveBeenCalledWith({
      where: {
        artifactId: "artifact-123",
        reportType: EvaluationReportType.Code,
      },
      orderBy: { createdAt: "desc" },
    });
  });
});
