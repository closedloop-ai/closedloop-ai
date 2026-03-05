/**
 * Unit tests for submitJudgeRating and submitJudgeRatingValidator.
 *
 * Service behavior: null return on not-found/cross-org/cross-artifact,
 * isUpdate flag on create vs update, upsert call shape.
 * Validator: boundary values for rating [0, 1], UUID check for judgeScoreId.
 */
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
  artifactId?: string;
  organizationId?: string;
  evaluationId?: string;
}) {
  return {
    id: JUDGE_SCORE_ID,
    evaluationId: overrides?.evaluationId ?? EVAL_ID,
    evaluation: {
      artifactId: overrides?.artifactId ?? ARTIFACT_ID,
      artifact: { organizationId: overrides?.organizationId ?? ORG_ID },
    },
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
        findUnique: vi.fn().mockResolvedValue(makeJudgeScoreRecord()),
      },
      judgeHumanScore: {
        findUnique: vi.fn().mockResolvedValue(null),
        upsert: vi.fn().mockResolvedValue({}),
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

    expect(result).toEqual({ rating: 0.8, isUpdate: false });
  });

  it("updates existing rating and returns isUpdate=true", async () => {
    const db = {
      judgeScore: {
        findUnique: vi.fn().mockResolvedValue(makeJudgeScoreRecord()),
      },
      judgeHumanScore: {
        findUnique: vi.fn().mockResolvedValue({ id: "existing-rating" }),
        upsert: vi.fn().mockResolvedValue({}),
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

    expect(result).toEqual({ rating: 0.6, isUpdate: true });
  });

  it("accepts rating = 0 (minimum boundary)", async () => {
    const db = {
      judgeScore: {
        findUnique: vi.fn().mockResolvedValue(makeJudgeScoreRecord()),
      },
      judgeHumanScore: {
        findUnique: vi.fn().mockResolvedValue(null),
        upsert: vi.fn().mockResolvedValue({}),
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

    expect(result).toEqual({ rating: 0, isUpdate: false });
  });

  it("accepts rating = 1 (maximum boundary)", async () => {
    const db = {
      judgeScore: {
        findUnique: vi.fn().mockResolvedValue(makeJudgeScoreRecord()),
      },
      judgeHumanScore: {
        findUnique: vi.fn().mockResolvedValue(null),
        upsert: vi.fn().mockResolvedValue({}),
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

    expect(result).toEqual({ rating: 1, isUpdate: false });
  });

  it("returns null when judgeScoreId is not found", async () => {
    const db = {
      judgeScore: { findUnique: vi.fn().mockResolvedValue(null) },
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
    expect(db.judgeScore.findUnique).toHaveBeenCalledOnce();
  });

  it("returns null when judgeScore belongs to a different artifact", async () => {
    const db = {
      judgeScore: {
        findUnique: vi
          .fn()
          .mockResolvedValue(
            makeJudgeScoreRecord({ artifactId: "different-artifact" })
          ),
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

    expect(result).toBeNull();
  });

  it("returns null when judgeScore belongs to a different organization", async () => {
    const db = {
      judgeScore: {
        findUnique: vi
          .fn()
          .mockResolvedValue(
            makeJudgeScoreRecord({ organizationId: "other-org" })
          ),
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

    expect(result).toBeNull();
  });

  it("calls upsert with correct keys and score", async () => {
    const db = {
      judgeScore: {
        findUnique: vi
          .fn()
          .mockResolvedValue(makeJudgeScoreRecord({ evaluationId: EVAL_ID })),
      },
      judgeHumanScore: {
        findUnique: vi.fn().mockResolvedValue(null),
        upsert: vi.fn().mockResolvedValue({}),
      },
    };
    mockWithDbTx(db);

    await submitJudgeRating(ORG_ID, USER_ID, ARTIFACT_ID, JUDGE_SCORE_ID, 0.75);

    expect(db.judgeHumanScore.upsert).toHaveBeenCalledWith({
      where: {
        judgeScoreId_userId_organizationId: {
          judgeScoreId: JUDGE_SCORE_ID,
          userId: USER_ID,
          organizationId: ORG_ID,
        },
      },
      create: {
        evaluationId: EVAL_ID,
        judgeScoreId: JUDGE_SCORE_ID,
        userId: USER_ID,
        organizationId: ORG_ID,
        score: 0.75,
      },
      update: { score: 0.75 },
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
});
