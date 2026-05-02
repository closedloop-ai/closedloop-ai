/**
 * Unit tests for documentEvaluationService.getEvaluationFeedback and getBatchJudgeScores.
 *
 * Tests the artifactEvaluation read paths that use artifactId + organizationId
 * for org-scoped queries (single `artifactId` FK after artifact cutover).
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
  ArtifactType: {
    DOCUMENT: "DOCUMENT",
    PULL_REQUEST: "PULL_REQUEST",
    DEPLOYMENT: "DEPLOYMENT",
  },
  ArtifactSubtype: {
    PRD: "PRD",
    IMPLEMENTATION_PLAN: "IMPLEMENTATION_PLAN",
    TEMPLATE: "TEMPLATE",
    FEATURE: "FEATURE",
  },
  EntityType: {
    DOCUMENT: "DOCUMENT",
    FEATURE: "FEATURE",
    EXTERNAL_LINK: "EXTERNAL_LINK",
  },
  EvaluationReportType: {
    PLAN: "PLAN",
    CODE: "CODE",
    PRD: "PRD",
  },
}));

// Import after mocking
import { withDb } from "@repo/database";
import { documentEvaluationService } from "@/app/documents/evaluation-service";
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
 * Helper to build an ArtifactEvaluation row with artifactId only
 * (no entityId/entityType after cutover).
 */
function buildEvalRow(overrides?: {
  id?: string;
  artifactId?: string;
  organizationId?: string;
  reportType?: EvaluationReportType;
  createdAt?: Date;
}) {
  const base = createMockEvaluationRow({
    id: overrides?.id,
    entityId: overrides?.artifactId,
    organizationId: overrides?.organizationId,
    reportType: overrides?.reportType,
    createdAt: overrides?.createdAt,
  });
  // After cutover, only artifactId exists (no entityId/entityType).
  return {
    id: base.id,
    artifactId: overrides?.artifactId ?? base.entityId,
    organizationId: base.organizationId,
    actionRunId: base.actionRunId,
    reportType: base.reportType,
    reportId: base.reportId,
    reportData: base.reportData,
    createdAt: base.createdAt,
  };
}

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
      mockWithDb.mockImplementation((callback: any) =>
        callback({
          artifactEvaluation: {
            findFirst: vi.fn().mockResolvedValue({
              ...buildEvalRow({
                id: "eval-123",
                artifactId: "artifact-123",
                organizationId: "org-123",
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
    name: "empty_judge_scores_returns_empty_array",
    description:
      "When evaluation exists but no judge scores, returns empty array",
    setupMocks: () => {
      mockWithDb.mockImplementation((callback: any) =>
        callback({
          artifactEvaluation: {
            findFirst: vi.fn().mockResolvedValue({
              ...buildEvalRow({
                id: "eval-123",
                artifactId: "artifact-123",
                organizationId: "org-123",
              }),
              judgeScores: [],
            }),
          },
        })
      );
    },
    expectedResult: { status: "success", data: [] },
  },
];

describe("documentEvaluationService.getEvaluationFeedback (PLAN)", () => {
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

      const result = await documentEvaluationService.getEvaluationFeedback(
        "artifact-123",
        "org-123",
        EvaluationReportType.Plan
      );

      expect(result).toEqual(scenario.expectedResult);
    });
  });

  it("returns feedback when artifactId and organizationId match (org isolation via direct column)", async () => {
    const findFirst = vi.fn().mockResolvedValue({
      ...buildEvalRow({
        id: "eval-123",
        artifactId: "artifact-123",
        organizationId: "org-123",
      }),
      judgeScores: [MOCK_JUDGE_SCORE_ROW],
    });

    mockWithDb.mockImplementation((callback: any) =>
      callback({ artifactEvaluation: { findFirst } })
    );

    const result = await documentEvaluationService.getEvaluationFeedback(
      "artifact-123",
      "org-123",
      EvaluationReportType.Plan
    );

    // Verify where clause includes artifactId and organizationId
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          artifactId: "artifact-123",
          organizationId: "org-123",
        }),
      })
    );
    expect(result).toEqual({
      status: "success",
      data: EXPECTED_FEEDBACK_ITEMS,
    });
  });

  it("returns not_found when organizationId does not match (cross-tenant isolation)", async () => {
    // Simulate the DB returning null when the org doesn't match —
    // the direct organizationId column filter excludes cross-tenant rows.
    const findFirst = vi.fn().mockResolvedValue(null);

    mockWithDb.mockImplementation((callback: any) =>
      callback({ artifactEvaluation: { findFirst } })
    );

    const result = await documentEvaluationService.getEvaluationFeedback(
      "artifact-123",
      "org-different",
      EvaluationReportType.Plan
    );

    // Confirm organizationId is passed in where clause (enforces org isolation)
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: "org-different",
        }),
      })
    );
    expect(result).toEqual({ status: "not_found", data: null });
  });

  it("queries only PLAN evaluations via reportType", async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    mockWithDb.mockImplementation((callback: any) =>
      callback({
        artifactEvaluation: { findFirst },
      })
    );

    await documentEvaluationService.getEvaluationFeedback(
      "artifact-123",
      "org-123",
      EvaluationReportType.Plan
    );

    expect(findFirst).toHaveBeenCalledWith({
      where: {
        artifactId: "artifact-123",
        organizationId: "org-123",
        reportType: EvaluationReportType.Plan,
      },
      include: {
        judgeScores: { include: { prompt: { select: { name: true } } } },
      },
      orderBy: { createdAt: "desc" },
    });
  });

  it("includes promptName from linked prompt when available", async () => {
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
            ...buildEvalRow({
              artifactId: "artifact-123",
              organizationId: "org-123",
            }),
            judgeScores: [scoreWithPrompt],
          }),
        },
      })
    );

    const result = await documentEvaluationService.getEvaluationFeedback(
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

describe("documentEvaluationService.getEvaluationFeedback (PRD)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("queries only PRD evaluations via reportType", async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    mockWithDb.mockImplementation((callback: any) =>
      callback({
        artifactEvaluation: { findFirst },
      })
    );

    await documentEvaluationService.getEvaluationFeedback(
      "artifact-123",
      "org-123",
      EvaluationReportType.Prd
    );

    expect(findFirst).toHaveBeenCalledWith({
      where: {
        artifactId: "artifact-123",
        organizationId: "org-123",
        reportType: EvaluationReportType.Prd,
      },
      include: {
        judgeScores: { include: { prompt: { select: { name: true } } } },
      },
      orderBy: { createdAt: "desc" },
    });
  });

  it("returns PRD evaluation data for PRD-type artifact", async () => {
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
            ...buildEvalRow({
              id: "eval-prd-123",
              artifactId: "artifact-prd-123",
              organizationId: "org-123",
              reportType: EvaluationReportType.Prd,
            }),
            judgeScores: [prdJudgeScoreRow],
          }),
        },
      })
    );

    const result = await documentEvaluationService.getEvaluationFeedback(
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
    mockWithDb.mockImplementation((callback: any) =>
      callback({
        artifactEvaluation: {
          findFirst: vi.fn().mockResolvedValue(null),
        },
      })
    );

    const result = await documentEvaluationService.getEvaluationFeedback(
      "artifact-123",
      "org-123",
      EvaluationReportType.Prd
    );

    expect(result).toEqual({ status: "not_found", data: null });
  });
});

describe("documentEvaluationService.getEvaluationFeedback (CODE)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("queries only CODE evaluations via reportType", async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    mockWithDb.mockImplementation((callback: any) =>
      callback({
        artifactEvaluation: { findFirst },
      })
    );

    await documentEvaluationService.getEvaluationFeedback(
      "artifact-123",
      "org-123",
      EvaluationReportType.Code
    );

    expect(findFirst).toHaveBeenCalledWith({
      where: {
        artifactId: "artifact-123",
        organizationId: "org-123",
        reportType: EvaluationReportType.Code,
      },
      include: {
        judgeScores: { include: { prompt: { select: { name: true } } } },
      },
      orderBy: { createdAt: "desc" },
    });
  });
});

describe("documentEvaluationService.getEvaluationFeedback (error path)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns error status when database throws", async () => {
    mockWithDb.mockImplementation((callback: any) =>
      callback({
        artifactEvaluation: {
          findFirst: vi.fn().mockRejectedValue(new Error("DB connection lost")),
        },
      })
    );

    const result = await documentEvaluationService.getEvaluationFeedback(
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
    mockWithDb.mockImplementation((callback: any) =>
      callback({
        artifactEvaluation: {
          findFirst: vi.fn().mockRejectedValue("unexpected string error"),
        },
      })
    );

    const result = await documentEvaluationService.getEvaluationFeedback(
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

describe("documentEvaluationService.getBatchJudgeScores", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Helper to set up the two-step mock pattern for getBatchJudgeScores.
   * First call: artifact.findMany (returns artifact IDs, DOCUMENT-typed).
   * Second call: artifactEvaluation.findMany (returns evaluations).
   */
  function setupTwoStepMock(
    artifactIds: string[],
    evaluations: ReturnType<typeof buildEvalRow>[]
  ) {
    const artifactFindMany = vi
      .fn()
      .mockResolvedValue(artifactIds.map((id) => ({ id })));
    const evaluationFindMany = vi.fn().mockResolvedValue(evaluations);

    mockWithDb
      .mockImplementationOnce((callback: any) =>
        callback({ artifact: { findMany: artifactFindMany } })
      )
      .mockImplementationOnce((callback: any) =>
        callback({ artifactEvaluation: { findMany: evaluationFindMany } })
      );

    return { artifactFindMany, evaluationFindMany };
  }

  it("uses two-step query: first fetches artifact IDs then queries evaluations by artifactId IN list", async () => {
    const { artifactFindMany, evaluationFindMany } = setupTwoStepMock(
      ["artifact-123"],
      []
    );

    await documentEvaluationService.getBatchJudgeScores(
      "project-123",
      "org-123",
      [EvaluationReportType.Plan]
    );

    // Step 1: fetch artifact IDs scoped to project + org + DOCUMENT type
    expect(artifactFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          projectId: "project-123",
          organizationId: "org-123",
          type: "DOCUMENT",
        }),
        select: { id: true },
      })
    );

    // Step 2: fetch evaluations using IN list of artifact IDs
    expect(evaluationFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          artifactId: { in: ["artifact-123"] },
        }),
      })
    );
  });

  it("groups by artifactId and keeps only latest per (artifactId, reportType) when multiple evaluations exist for same artifact", async () => {
    const olderEvaluation = {
      ...buildEvalRow({
        id: "eval-old",
        artifactId: "artifact-shared",
        organizationId: "org-123",
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
      ...buildEvalRow({
        id: "eval-new",
        artifactId: "artifact-shared",
        organizationId: "org-123",
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
    setupTwoStepMock(["artifact-shared"], [
      newerEvaluation,
      olderEvaluation,
    ] as any);

    const result = await documentEvaluationService.getBatchJudgeScores(
      "project-123",
      "org-123",
      [EvaluationReportType.Plan]
    );

    // Only one entry for "artifact-shared" — the latest is kept
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
  });

  it("org isolation: second query filters by organizationId directly (not via relation)", async () => {
    const { evaluationFindMany } = setupTwoStepMock(["artifact-123"], []);

    await documentEvaluationService.getBatchJudgeScores(
      "project-123",
      "org-456",
      [EvaluationReportType.Plan]
    );

    // Step 1 scopes artifact IDs to org-456
    // Step 2 also filters by organizationId directly for defense in depth
    expect(evaluationFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: "org-456",
        }),
      })
    );
  });

  it("forwards the provided reportTypes to the Prisma query", async () => {
    const { evaluationFindMany } = setupTwoStepMock(["artifact-123"], []);

    await documentEvaluationService.getBatchJudgeScores(
      "project-123",
      "org-123",
      [
        EvaluationReportType.Plan,
        EvaluationReportType.Prd,
        EvaluationReportType.Code,
      ]
    );

    expect(evaluationFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          reportType: {
            in: [
              EvaluationReportType.Plan,
              EvaluationReportType.Prd,
              EvaluationReportType.Code,
            ],
          },
        }),
      })
    );
  });

  it("prd_and_plan_evaluations_returns_both_artifacts — returns map with both artifactIds when evaluations of different types exist", async () => {
    const planEvaluation = {
      ...buildEvalRow({
        id: "eval-plan-1",
        artifactId: "artifact-plan-1",
        organizationId: "org-123",
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
      ...buildEvalRow({
        id: "eval-prd-1",
        artifactId: "artifact-prd-1",
        organizationId: "org-123",
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

    setupTwoStepMock(["artifact-plan-1", "artifact-prd-1"], [
      planEvaluation,
      prdEvaluation,
    ] as any);

    const result = await documentEvaluationService.getBatchJudgeScores(
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
      ...buildEvalRow({
        id: "eval-prd-2",
        artifactId: "artifact-prd-2",
        organizationId: "org-123",
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

    setupTwoStepMock(["artifact-prd-2"], [prdEvaluation] as any);

    const result = await documentEvaluationService.getBatchJudgeScores(
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
      ...buildEvalRow({
        id: "eval-code-1",
        artifactId: "artifact-code-1",
        organizationId: "org-123",
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

    setupTwoStepMock(["artifact-code-1"], [codeEvaluation] as any);

    const result = await documentEvaluationService.getBatchJudgeScores(
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

  it("returns empty object when no evaluations exist for project", async () => {
    setupTwoStepMock([], []);

    const result = await documentEvaluationService.getBatchJudgeScores(
      "project-empty",
      "org-123",
      [EvaluationReportType.Plan, EvaluationReportType.Prd]
    );

    expect(result).toEqual({});
  });

  it("plan_only_returns_correctly — PLAN evaluations populate the plan key", async () => {
    const planEvaluation = {
      ...buildEvalRow({
        id: "eval-plan-2",
        artifactId: "artifact-plan-2",
        organizationId: "org-123",
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

    setupTwoStepMock(["artifact-plan-2"], [planEvaluation] as any);

    const result = await documentEvaluationService.getBatchJudgeScores(
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
