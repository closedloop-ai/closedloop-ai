/**
 * Unit tests for submitJudgeRating and submitJudgeRatingValidator.
 *
 * Service behavior: null return on not-found/cross-org/cross-artifact,
 * isUpdate flag on create vs update, create/update call shape.
 * Validator: boundary values for rating [0, 1], UUID check for judgeScoreId.
 */
import { EvaluationReportType } from "@repo/api/src/types/evaluation";
import { vi } from "vitest";
import {
  getMockWithDb,
  mockWithDbCall,
  mockWithDbTx,
} from "../utils/db-helpers";

vi.mock("@repo/database", () => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
}));

import {
  getUserJudgeRatings,
  submitJudgeRating,
} from "@/app/artifacts/[id]/judge-ratings/service";
import { submitJudgeRatingValidator } from "@/app/artifacts/[id]/judge-ratings/validators";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ORG_ID = "org-test";
const USER_ID = "user-test";
const ARTIFACT_ID = "artifact-test";
const JUDGE_SCORE_ID = "a0000000-0000-7000-8000-000000000001";
const EVAL_ID = "b0000000-0000-7000-8000-000000000002";

function makeJudgeScoreRecord(overrides?: {
  evaluationId?: string;
  evaluation?: { reportType: string };
  prompt?: { name: string } | null;
  metricName?: string;
}) {
  const defaultPrompt = { name: "Clarity-Judge" };
  return {
    id: JUDGE_SCORE_ID,
    evaluationId: overrides?.evaluationId ?? EVAL_ID,
    metricName: overrides?.metricName ?? "clarity_score",
    evaluation: overrides?.evaluation ?? {
      reportType: EvaluationReportType.Plan,
    },
    prompt:
      overrides && "prompt" in overrides ? overrides.prompt : defaultPrompt,
  };
}

// ---------------------------------------------------------------------------
// submitJudgeRating
// ---------------------------------------------------------------------------

describe("submitJudgeRating", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getMockWithDb().tx = vi.fn();
  });

  it("creates new rating and returns isUpdate=false", async () => {
    const db = {
      judgeScore: {
        findFirst: vi.fn().mockResolvedValue(makeJudgeScoreRecord()),
      },
      judgeHumanScore: {
        create: vi.fn().mockResolvedValue({}),
        update: vi.fn().mockResolvedValue({}),
      },
    };
    mockWithDbTx(db);

    const result = await submitJudgeRating(
      ORG_ID,
      USER_ID,
      ARTIFACT_ID,
      JUDGE_SCORE_ID,
      0.8
    );

    expect(result).toEqual({
      rating: 0.8,
      isUpdate: false,
      promptName: "clarity",
      metricName: "clarity",
      reportType: EvaluationReportType.Plan,
    });
  });

  it("updates existing rating and returns isUpdate=true", async () => {
    const uniqueViolation = Object.assign(new Error("Unique violation"), {
      code: "P2002",
    });
    const db = {
      judgeScore: {
        findFirst: vi.fn().mockResolvedValue(makeJudgeScoreRecord()),
      },
      judgeHumanScore: {
        create: vi.fn().mockRejectedValue(uniqueViolation),
        update: vi.fn().mockResolvedValue({}),
      },
    };
    mockWithDbTx(db);

    const result = await submitJudgeRating(
      ORG_ID,
      USER_ID,
      ARTIFACT_ID,
      JUDGE_SCORE_ID,
      0.6
    );

    expect(result).toEqual({
      rating: 0.6,
      isUpdate: true,
      promptName: "clarity",
      metricName: "clarity",
      reportType: EvaluationReportType.Plan,
    });
  });

  it("accepts rating = 0 (minimum boundary)", async () => {
    const db = {
      judgeScore: {
        findFirst: vi.fn().mockResolvedValue(makeJudgeScoreRecord()),
      },
      judgeHumanScore: {
        create: vi.fn().mockResolvedValue({}),
        update: vi.fn().mockResolvedValue({}),
      },
    };
    mockWithDbTx(db);

    const result = await submitJudgeRating(
      ORG_ID,
      USER_ID,
      ARTIFACT_ID,
      JUDGE_SCORE_ID,
      0
    );

    expect(result).toEqual({
      rating: 0,
      isUpdate: false,
      promptName: "clarity",
      metricName: "clarity",
      reportType: EvaluationReportType.Plan,
    });
  });

  it("accepts rating = 1 (maximum boundary)", async () => {
    const db = {
      judgeScore: {
        findFirst: vi.fn().mockResolvedValue(makeJudgeScoreRecord()),
      },
      judgeHumanScore: {
        create: vi.fn().mockResolvedValue({}),
        update: vi.fn().mockResolvedValue({}),
      },
    };
    mockWithDbTx(db);

    const result = await submitJudgeRating(
      ORG_ID,
      USER_ID,
      ARTIFACT_ID,
      JUDGE_SCORE_ID,
      1
    );

    expect(result).toEqual({
      rating: 1,
      isUpdate: false,
      promptName: "clarity",
      metricName: "clarity",
      reportType: EvaluationReportType.Plan,
    });
  });

  it("returns null when judgeScoreId is not found", async () => {
    const db = {
      judgeScore: { findFirst: vi.fn().mockResolvedValue(null) },
    };
    mockWithDbTx(db);

    const result = await submitJudgeRating(
      ORG_ID,
      USER_ID,
      ARTIFACT_ID,
      JUDGE_SCORE_ID,
      0.5
    );

    expect(result).toBeNull();
    expect(db.judgeScore.findFirst).toHaveBeenCalledOnce();
  });

  it("returns null when judgeScore belongs to a different artifact", async () => {
    const db = {
      judgeScore: { findFirst: vi.fn().mockResolvedValue(null) },
    };
    mockWithDbTx(db);

    const result = await submitJudgeRating(
      ORG_ID,
      USER_ID,
      ARTIFACT_ID,
      JUDGE_SCORE_ID,
      0.5
    );

    expect(result).toBeNull();
    expect(db.judgeScore.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: JUDGE_SCORE_ID,
          evaluation: expect.objectContaining({
            artifactId: ARTIFACT_ID,
            artifact: { organizationId: ORG_ID },
          }),
        }),
      })
    );
  });

  it("returns null when judgeScore belongs to a different organization", async () => {
    const db = {
      judgeScore: { findFirst: vi.fn().mockResolvedValue(null) },
    };
    mockWithDbTx(db);

    const result = await submitJudgeRating(
      ORG_ID,
      USER_ID,
      ARTIFACT_ID,
      JUDGE_SCORE_ID,
      0.5
    );

    expect(result).toBeNull();
    expect(db.judgeScore.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          evaluation: expect.objectContaining({
            artifact: { organizationId: ORG_ID },
          }),
        }),
      })
    );
  });

  it("calls create with correct keys and score", async () => {
    const db = {
      judgeScore: {
        findFirst: vi
          .fn()
          .mockResolvedValue(makeJudgeScoreRecord({ evaluationId: EVAL_ID })),
      },
      judgeHumanScore: {
        create: vi.fn().mockResolvedValue({}),
        update: vi.fn().mockResolvedValue({}),
      },
    };
    mockWithDbTx(db);

    await submitJudgeRating(ORG_ID, USER_ID, ARTIFACT_ID, JUDGE_SCORE_ID, 0.75);

    expect(db.judgeHumanScore.create).toHaveBeenCalledWith({
      data: {
        evaluationId: EVAL_ID,
        judgeScoreId: JUDGE_SCORE_ID,
        userId: USER_ID,
        organizationId: ORG_ID,
        score: 0.75,
      },
    });
  });

  it("returns promptName null and reportType when judge score has no linked prompt", async () => {
    const db = {
      judgeScore: {
        findFirst: vi
          .fn()
          .mockResolvedValue(makeJudgeScoreRecord({ prompt: null })),
      },
      judgeHumanScore: {
        create: vi.fn().mockResolvedValue({}),
        update: vi.fn().mockResolvedValue({}),
      },
    };
    mockWithDbTx(db);

    const result = await submitJudgeRating(
      ORG_ID,
      USER_ID,
      ARTIFACT_ID,
      JUDGE_SCORE_ID,
      0.5
    );

    expect(result).toEqual({
      rating: 0.5,
      isUpdate: false,
      promptName: null,
      metricName: "clarity",
      reportType: EvaluationReportType.Plan,
    });
  });
});

// ---------------------------------------------------------------------------
// getUserJudgeRatings
// ---------------------------------------------------------------------------

describe("getUserJudgeRatings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns empty ratings array when user has no judge ratings for artifact", async () => {
    const db = {
      judgeHumanScore: { findMany: vi.fn().mockResolvedValue([]) },
    };
    mockWithDbCall(db);

    const result = await getUserJudgeRatings(ORG_ID, USER_ID, ARTIFACT_ID);

    expect(result).toEqual({ ratings: [] });
  });

  it("returns ratings keyed by judgeScoreId", async () => {
    const db = {
      judgeHumanScore: {
        findMany: vi.fn().mockResolvedValue([
          { judgeScoreId: "js-1", score: 0.8 },
          { judgeScoreId: "js-2", score: 0.5 },
        ]),
      },
    };
    mockWithDbCall(db);

    const result = await getUserJudgeRatings(ORG_ID, USER_ID, ARTIFACT_ID);

    expect(result).toEqual({
      ratings: [
        { judgeScoreId: "js-1", rating: 0.8 },
        { judgeScoreId: "js-2", rating: 0.5 },
      ],
    });
  });

  it("scopes query by organizationId, userId, and artifactId", async () => {
    const db = {
      judgeHumanScore: { findMany: vi.fn().mockResolvedValue([]) },
    };
    mockWithDbCall(db);

    await getUserJudgeRatings(ORG_ID, USER_ID, ARTIFACT_ID);

    expect(db.judgeHumanScore.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: ORG_ID,
          userId: USER_ID,
          evaluation: { artifactId: ARTIFACT_ID },
        }),
      })
    );
  });
});

// ---------------------------------------------------------------------------
// submitJudgeRatingValidator
// ---------------------------------------------------------------------------

const VALID_UUID = "a0000000-0000-7000-8000-000000000001";

describe("submitJudgeRatingValidator", () => {
  it("accepts rating = 0 (minimum boundary)", () => {
    const result = submitJudgeRatingValidator.safeParse({
      judgeScoreId: VALID_UUID,
      rating: 0,
    });
    expect(result.success).toBe(true);
  });

  it("accepts rating = 1 (maximum boundary)", () => {
    const result = submitJudgeRatingValidator.safeParse({
      judgeScoreId: VALID_UUID,
      rating: 1,
    });
    expect(result.success).toBe(true);
  });

  it("rejects rating = 1.01 (above maximum)", () => {
    const result = submitJudgeRatingValidator.safeParse({
      judgeScoreId: VALID_UUID,
      rating: 1.01,
    });
    expect(result.success).toBe(false);
  });

  it("rejects rating = -0.01 (below minimum)", () => {
    const result = submitJudgeRatingValidator.safeParse({
      judgeScoreId: VALID_UUID,
      rating: -0.01,
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing judgeScoreId", () => {
    const result = submitJudgeRatingValidator.safeParse({ rating: 0.5 });
    expect(result.success).toBe(false);
  });

  it("rejects non-UUID judgeScoreId", () => {
    const result = submitJudgeRatingValidator.safeParse({
      judgeScoreId: "not-a-uuid",
      rating: 0.5,
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing rating", () => {
    const result = submitJudgeRatingValidator.safeParse({
      judgeScoreId: VALID_UUID,
    });
    expect(result.success).toBe(false);
  });

  it("accepts ratings with up to two decimal places", () => {
    const firstResult = submitJudgeRatingValidator.safeParse({
      judgeScoreId: VALID_UUID,
      rating: 0.3,
    });
    const secondResult = submitJudgeRatingValidator.safeParse({
      judgeScoreId: VALID_UUID,
      rating: 0.57,
    });

    expect(firstResult.success).toBe(true);
    expect(secondResult.success).toBe(true);
  });

  it("rejects ratings with more than two decimal places", () => {
    const result = submitJudgeRatingValidator.safeParse({
      judgeScoreId: VALID_UUID,
      rating: 0.333,
    });

    expect(result.success).toBe(false);
  });
});
