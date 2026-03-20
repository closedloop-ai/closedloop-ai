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
    PRD: "PRD",
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
    judgeScoreId: "judge-score-123",
    caseId: "test-judge",
    metricName: "test-judge",
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
      mockWithDb.mockImplementation((callback: any) =>
        callback({
          artifactEvaluation: {
            findFirst: vi.fn().mockResolvedValue({
              ...createMockEvaluationRow({
                id: "eval-123",
                artifactId: "artifact-123",
              }),
              judgeScores: [MOCK_JUDGE_SCORE_ROW],
            }),
          },
        })
      );
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
      mockWithDb.mockImplementation((callback: any) =>
        callback({
          artifactEvaluation: {
            findFirst: vi.fn().mockResolvedValue({
              ...createMockEvaluationRow({ id: "eval-123" }),
              judgeScores: [],
            }),
          },
        })
      );
    },
    expectedResult: { status: "success", data: [] },
  },
];

describe("artifactsService.getEvaluationFeedback (PLAN)", () => {
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

      const result = await artifactsService.getEvaluationFeedback(
        "artifact-123",
        "org-123",
        EvaluationReportType.Plan
      );

      expect(result).toEqual(scenario.expectedResult);
    });
  });

  it("queries only PLAN evaluations via reportType", async () => {
    vi.spyOn(artifactsService, "findByIdSimple").mockResolvedValue({
      id: "artifact-123",
    } as any);

    const findFirst = vi.fn().mockResolvedValue(null);
    mockWithDb.mockImplementation((callback: any) =>
      callback({
        artifactEvaluation: { findFirst },
      })
    );

    await artifactsService.getEvaluationFeedback(
      "artifact-123",
      "org-123",
      EvaluationReportType.Plan
    );

    expect(findFirst).toHaveBeenCalledWith({
      where: {
        artifactId: "artifact-123",
        reportType: EvaluationReportType.Plan,
      },
      include: {
        judgeScores: { include: { prompt: { select: { name: true } } } },
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

    mockWithDb.mockImplementation((callback: any) =>
      callback({
        artifactEvaluation: {
          findFirst: vi.fn().mockResolvedValue({
            ...createMockEvaluationRow(),
            judgeScores: [scoreWithPrompt],
          }),
        },
      })
    );

    const result = await artifactsService.getEvaluationFeedback(
      "artifact-123",
      "org-123",
      EvaluationReportType.Plan
    );

    expect(result).toEqual({
      status: "success",
      data: [
        expect.objectContaining({
          promptName: "DRY Principle Judge",
          caseId: "dry-judge",
        }),
      ],
    });
  });
});

describe("artifactsService.getEvaluationFeedback (PRD)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("queries only PRD evaluations via reportType", async () => {
    vi.spyOn(artifactsService, "findByIdSimple").mockResolvedValue({
      id: "artifact-123",
    } as any);

    const findFirst = vi.fn().mockResolvedValue(null);
    mockWithDb.mockImplementation((callback: any) =>
      callback({
        artifactEvaluation: { findFirst },
      })
    );

    await artifactsService.getEvaluationFeedback(
      "artifact-123",
      "org-123",
      EvaluationReportType.Prd
    );

    expect(findFirst).toHaveBeenCalledWith({
      where: {
        artifactId: "artifact-123",
        reportType: EvaluationReportType.Prd,
      },
      include: {
        judgeScores: { include: { prompt: { select: { name: true } } } },
      },
      orderBy: { createdAt: "desc" },
    });
  });

  it("returns PRD evaluation data for PRD-type artifact", async () => {
    vi.spyOn(artifactsService, "findByIdSimple").mockResolvedValue({
      id: "artifact-prd-123",
    } as any);

    const prdJudgeScoreRow = createMockJudgeScoreRow({
      caseId: "prd-judge",
      score: 0.88,
      threshold: 0.75,
      justification: "PRD is well-structured",
      finalStatus: EvalStatus.Passed,
      prompt: null,
    });

    mockWithDb.mockImplementation((callback: any) =>
      callback({
        artifactEvaluation: {
          findFirst: vi.fn().mockResolvedValue({
            ...createMockEvaluationRow({
              id: "eval-prd-123",
              artifactId: "artifact-prd-123",
              reportType: EvaluationReportType.Prd,
            }),
            judgeScores: [prdJudgeScoreRow],
          }),
        },
      })
    );

    const result = await artifactsService.getEvaluationFeedback(
      "artifact-prd-123",
      "org-123",
      EvaluationReportType.Prd
    );

    expect(result).toEqual({
      status: "success",
      data: [
        expect.objectContaining({
          caseId: "prd-judge",
          score: 0.88,
          finalStatus: EvalStatus.Passed,
        }),
      ],
    });
  });

  it("returns not_found when no PRD evaluation exists", async () => {
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

    const result = await artifactsService.getEvaluationFeedback(
      "artifact-123",
      "org-123",
      EvaluationReportType.Prd
    );

    expect(result).toEqual({ status: "not_found", data: null });
  });
});

describe("artifactsService.getEvaluationFeedback (CODE)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("queries only CODE evaluations via reportType", async () => {
    vi.spyOn(artifactsService, "findByIdSimple").mockResolvedValue({
      id: "artifact-123",
    } as any);

    const findFirst = vi.fn().mockResolvedValue(null);
    mockWithDb.mockImplementation((callback: any) =>
      callback({
        artifactEvaluation: { findFirst },
      })
    );

    await artifactsService.getEvaluationFeedback(
      "artifact-123",
      "org-123",
      EvaluationReportType.Code
    );

    expect(findFirst).toHaveBeenCalledWith({
      where: {
        artifactId: "artifact-123",
        reportType: EvaluationReportType.Code,
      },
      include: {
        judgeScores: { include: { prompt: { select: { name: true } } } },
      },
      orderBy: { createdAt: "desc" },
    });
  });
});

describe("artifactsService.getEvaluationFeedback (error path)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns error status when database throws", async () => {
    vi.spyOn(artifactsService, "findByIdSimple").mockResolvedValue({
      id: "artifact-123",
    } as any);

    mockWithDb.mockImplementation((callback: any) =>
      callback({
        artifactEvaluation: {
          findFirst: vi.fn().mockRejectedValue(new Error("DB connection lost")),
        },
      })
    );

    const result = await artifactsService.getEvaluationFeedback(
      "artifact-123",
      "org-123",
      EvaluationReportType.Plan
    );

    expect(result).toEqual({
      status: "error",
      error: "DB connection lost",
    });
  });

  it("returns error status with stringified error when non-Error is thrown", async () => {
    vi.spyOn(artifactsService, "findByIdSimple").mockResolvedValue({
      id: "artifact-123",
    } as any);

    mockWithDb.mockImplementation((callback: any) =>
      callback({
        artifactEvaluation: {
          findFirst: vi.fn().mockRejectedValue("unexpected string error"),
        },
      })
    );

    const result = await artifactsService.getEvaluationFeedback(
      "artifact-123",
      "org-123",
      EvaluationReportType.Plan
    );

    expect(result).toEqual({
      status: "error",
      error: "unexpected string error",
    });
  });
});

describe("artifactsService.getBatchJudgeScores", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("forwards the provided reportTypes to the Prisma query", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    mockWithDb.mockImplementation((callback: any) =>
      callback({ artifactEvaluation: { findMany } })
    );

    await artifactsService.getBatchJudgeScores("project-123", "org-123", [
      EvaluationReportType.Plan,
      EvaluationReportType.Prd,
      EvaluationReportType.Code,
    ]);

    expect(findMany).toHaveBeenCalledWith({
      where: {
        reportType: {
          in: [
            EvaluationReportType.Plan,
            EvaluationReportType.Prd,
            EvaluationReportType.Code,
          ],
        },
        artifact: { projectId: "project-123", organizationId: "org-123" },
      },
      include: {
        judgeScores: { include: { prompt: { select: { name: true } } } },
      },
      orderBy: { createdAt: "desc" },
    });
  });

  it("prd_and_plan_evaluations_returns_both_artifacts — returns map with both artifactIds when evaluations of different types exist", async () => {
    const planEvaluation = {
      ...createMockEvaluationRow({
        id: "eval-plan-1",
        artifactId: "artifact-plan-1",
        reportType: EvaluationReportType.Plan,
      }),
      judgeScores: [
        createMockJudgeScoreRow({
          id: "score-plan-1",
          caseId: "plan-judge",
          score: 0.9,
          threshold: 0.8,
          justification: "Plan looks good",
          finalStatus: EvalStatus.Passed,
          prompt: null,
        }),
      ],
    };

    const prdEvaluation = {
      ...createMockEvaluationRow({
        id: "eval-prd-1",
        artifactId: "artifact-prd-1",
        reportType: EvaluationReportType.Prd,
      }),
      judgeScores: [
        createMockJudgeScoreRow({
          id: "score-prd-1",
          caseId: "prd-judge",
          score: 0.85,
          threshold: 0.8,
          justification: "PRD is solid",
          finalStatus: EvalStatus.Passed,
          prompt: null,
        }),
      ],
    };

    mockWithDb.mockImplementation((callback: any) =>
      callback({
        artifactEvaluation: {
          findMany: vi.fn().mockResolvedValue([planEvaluation, prdEvaluation]),
        },
      })
    );

    const result = await artifactsService.getBatchJudgeScores(
      "project-123",
      "org-123",
      [EvaluationReportType.Plan, EvaluationReportType.Prd]
    );

    expect(Object.keys(result)).toContain("artifact-plan-1");
    expect(result["artifact-plan-1"][EvaluationReportType.Plan]).toHaveLength(
      1
    );
    expect(result["artifact-plan-1"][EvaluationReportType.Prd]).toBeNull();
    expect(result["artifact-plan-1"][EvaluationReportType.Code]).toBeNull();
    expect(Object.keys(result)).toContain("artifact-prd-1");
    expect(result["artifact-prd-1"][EvaluationReportType.Prd]).toHaveLength(1);
    expect(result["artifact-prd-1"][EvaluationReportType.Plan]).toBeNull();
    expect(result["artifact-prd-1"][EvaluationReportType.Code]).toBeNull();
  });

  it("prd_only_evaluation_returns_correct_entry — returns map with PRD artifactId when only PRD evaluation exists", async () => {
    const prdEvaluation = {
      ...createMockEvaluationRow({
        id: "eval-prd-2",
        artifactId: "artifact-prd-2",
        reportType: EvaluationReportType.Prd,
      }),
      judgeScores: [
        createMockJudgeScoreRow({
          id: "score-prd-2",
          caseId: "prd-clarity-judge",
          score: 0.88,
          threshold: 0.75,
          justification: "PRD clarity is high",
          finalStatus: EvalStatus.Passed,
          prompt: null,
        }),
      ],
    };

    mockWithDb.mockImplementation((callback: any) =>
      callback({
        artifactEvaluation: {
          findMany: vi.fn().mockResolvedValue([prdEvaluation]),
        },
      })
    );

    const result = await artifactsService.getBatchJudgeScores(
      "project-123",
      "org-123",
      [EvaluationReportType.Prd]
    );

    expect(Object.keys(result)).toContain("artifact-prd-2");
    expect(result["artifact-prd-2"][EvaluationReportType.Prd]).toHaveLength(1);
    expect(result["artifact-prd-2"][EvaluationReportType.Prd]![0].caseId).toBe(
      "prd-clarity-judge"
    );
    expect(result["artifact-prd-2"][EvaluationReportType.Plan]).toBeNull();
    expect(result["artifact-prd-2"][EvaluationReportType.Code]).toBeNull();
  });

  it("code_evaluation_populates_code_key — CODE evaluations are stored under the code key", async () => {
    const codeEvaluation = {
      ...createMockEvaluationRow({
        id: "eval-code-1",
        artifactId: "artifact-code-1",
        reportType: EvaluationReportType.Code,
      }),
      judgeScores: [
        createMockJudgeScoreRow({
          id: "score-code-1",
          caseId: "dry-judge",
          score: 0.95,
          threshold: 0.8,
          justification: "DRY principle respected",
          finalStatus: EvalStatus.Passed,
          prompt: null,
        }),
      ],
    };

    mockWithDb.mockImplementation((callback: any) =>
      callback({
        artifactEvaluation: {
          findMany: vi.fn().mockResolvedValue([codeEvaluation]),
        },
      })
    );

    const result = await artifactsService.getBatchJudgeScores(
      "project-123",
      "org-123",
      [EvaluationReportType.Code]
    );

    expect(Object.keys(result)).toContain("artifact-code-1");
    expect(result["artifact-code-1"][EvaluationReportType.Code]).toHaveLength(
      1
    );
    expect(
      result["artifact-code-1"][EvaluationReportType.Code]![0].caseId
    ).toBe("dry-judge");
    expect(result["artifact-code-1"][EvaluationReportType.Plan]).toBeNull();
    expect(result["artifact-code-1"][EvaluationReportType.Prd]).toBeNull();
  });

  it("keeps only the latest evaluation per type when multiple evaluations exist for same artifact", async () => {
    const olderEvaluation = {
      ...createMockEvaluationRow({
        id: "eval-old",
        artifactId: "artifact-shared",
        reportType: EvaluationReportType.Plan,
        createdAt: new Date("2024-01-01"),
      }),
      judgeScores: [
        createMockJudgeScoreRow({
          caseId: "old-judge",
          score: 0.5,
          threshold: 0.8,
          justification: "Old evaluation",
          finalStatus: EvalStatus.Passed,
          prompt: null,
        }),
      ],
    };

    const newerEvaluation = {
      ...createMockEvaluationRow({
        id: "eval-new",
        artifactId: "artifact-shared",
        reportType: EvaluationReportType.Plan,
        createdAt: new Date("2024-06-01"),
      }),
      judgeScores: [
        createMockJudgeScoreRow({
          caseId: "new-judge",
          score: 0.95,
          threshold: 0.8,
          justification: "New evaluation",
          finalStatus: EvalStatus.Passed,
          prompt: null,
        }),
      ],
    };

    // Prisma returns results ordered by createdAt desc — newer first
    mockWithDb.mockImplementation((callback: any) =>
      callback({
        artifactEvaluation: {
          findMany: vi
            .fn()
            .mockResolvedValue([newerEvaluation, olderEvaluation]),
        },
      })
    );

    const result = await artifactsService.getBatchJudgeScores(
      "project-123",
      "org-123",
      [EvaluationReportType.Plan]
    );

    expect(Object.keys(result)).toHaveLength(1);
    expect(Object.keys(result)).toContain("artifact-shared");
    expect(result["artifact-shared"][EvaluationReportType.Plan]).toHaveLength(
      1
    );
    expect(
      result["artifact-shared"][EvaluationReportType.Plan]![0].caseId
    ).toBe("new-judge");
    expect(result["artifact-shared"][EvaluationReportType.Plan]![0].score).toBe(
      0.95
    );
    expect(result["artifact-shared"][EvaluationReportType.Prd]).toBeNull();
    expect(result["artifact-shared"][EvaluationReportType.Code]).toBeNull();
  });

  it("returns empty object when no evaluations exist for project", async () => {
    mockWithDb.mockImplementation((callback: any) =>
      callback({
        artifactEvaluation: {
          findMany: vi.fn().mockResolvedValue([]),
        },
      })
    );

    const result = await artifactsService.getBatchJudgeScores(
      "project-empty",
      "org-123",
      [EvaluationReportType.Plan, EvaluationReportType.Prd]
    );

    expect(result).toEqual({});
  });

  it("plan_only_returns_correctly — PLAN evaluations populate the plan key", async () => {
    const planEvaluation = {
      ...createMockEvaluationRow({
        id: "eval-plan-2",
        artifactId: "artifact-plan-2",
        reportType: EvaluationReportType.Plan,
      }),
      judgeScores: [
        createMockJudgeScoreRow({
          id: "score-plan-2",
          caseId: "plan-structure-judge",
          score: 0.92,
          threshold: 0.8,
          justification: "Plan structure is clear",
          finalStatus: EvalStatus.Passed,
          prompt: null,
        }),
      ],
    };

    mockWithDb.mockImplementation((callback: any) =>
      callback({
        artifactEvaluation: {
          findMany: vi.fn().mockResolvedValue([planEvaluation]),
        },
      })
    );

    const result = await artifactsService.getBatchJudgeScores(
      "project-123",
      "org-123",
      [EvaluationReportType.Plan]
    );

    expect(Object.keys(result)).toContain("artifact-plan-2");
    expect(result["artifact-plan-2"][EvaluationReportType.Plan]).toHaveLength(
      1
    );
    expect(
      result["artifact-plan-2"][EvaluationReportType.Plan]![0].caseId
    ).toBe("plan-structure-judge");
    expect(result["artifact-plan-2"][EvaluationReportType.Plan]![0].score).toBe(
      0.92
    );
    expect(result["artifact-plan-2"][EvaluationReportType.Prd]).toBeNull();
    expect(result["artifact-plan-2"][EvaluationReportType.Code]).toBeNull();
  });
});
