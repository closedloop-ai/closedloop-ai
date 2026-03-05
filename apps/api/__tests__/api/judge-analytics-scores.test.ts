/**
 * Route handler tests for judge analytics score comparison and ratings submission.
 *
 * Tests GET /judges-analytics/[promptName]/scores and
 * POST /artifacts/[artifactId]/judge-ratings with mocked services.
 */
import { ArtifactType } from "@repo/api/src/types/artifact";
import { EvaluationReportType } from "@repo/api/src/types/evaluation";
import { vi } from "vitest";
import {
  GET as ratingsGET,
  POST as ratingsPOST,
} from "@/app/artifacts/[id]/judge-ratings/route";
import {
  getUserJudgeRatings,
  submitJudgeRating,
} from "@/app/artifacts/[id]/judge-ratings/service";
import { GET as scoresGET } from "@/app/judges-analytics/[promptName]/scores/route";
import { judgesAnalyticsService } from "@/app/judges-analytics/service";
import type { AuthContext } from "@/lib/auth/with-auth";
import {
  createMockRequest,
  createMockRouteContext,
  createTestAuthContext,
} from "../utils/auth-helpers";

// ---------------------------------------------------------------------------
// Auth mock
// ---------------------------------------------------------------------------

let mockAuthContext: AuthContext;

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth: (handler: any) => async (request: any, context: any) =>
    handler(mockAuthContext, request, context.params),
}));

vi.mock("@/app/judges-analytics/service");
vi.mock("@/app/artifacts/[id]/judge-ratings/service");

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

function makeJudgeScoreRow(overrides = {}) {
  return {
    judgeScoreId: "js-artifact-1",
    artifactId: "artifact-1",
    artifactType: ArtifactType.ImplementationPlan,
    artifactTitle: "My Plan",
    artifactSlug: "my-plan",
    judgeScore: 0.8,
    avgUserRating: 0.8,
    userRatingCount: 0,
    delta: 0,
    evaluatedAt: "2026-01-15T00:00:00.000Z",
    ...overrides,
  };
}

function makeJudgeScoresResponse(overrides = {}) {
  return {
    rows: [makeJudgeScoreRow()],
    totalArtifacts: 1,
    ratedArtifacts: 0,
    coveragePct: 0,
    pagination: { page: 1, pageSize: 20, totalRows: 1, totalPages: 1 },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// GET /judges-analytics/[promptName]/scores
// ---------------------------------------------------------------------------

describe("GET /api/judges-analytics/[promptName]/scores", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthContext = createTestAuthContext();
  });

  it("returns 200 with paginated JudgeScoreRow list for valid params", async () => {
    const mockData = makeJudgeScoresResponse();
    vi.mocked(judgesAnalyticsService.getJudgeScores).mockResolvedValue(
      mockData as any
    );

    const request = createMockRequest({
      url: "http://localhost:3002/api/judges-analytics/clarity/scores?reportType=PLAN&page=1&pageSize=20",
    });
    const response = await scoresGET(
      request,
      createMockRouteContext({ promptName: "clarity" })
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.success).toBe(true);
    expect(json.data.rows).toHaveLength(1);
    expect(json.data.pagination.page).toBe(1);
    expect(judgesAnalyticsService.getJudgeScores).toHaveBeenCalledWith(
      mockAuthContext.user.organizationId,
      "clarity",
      "PLAN",
      1,
      20
    );
  });

  it("returns 400 when reportType is missing", async () => {
    const request = createMockRequest({
      url: "http://localhost:3002/api/judges-analytics/clarity/scores",
    });
    const response = await scoresGET(
      request,
      createMockRouteContext({ promptName: "clarity" })
    );

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.success).toBe(false);
    expect(judgesAnalyticsService.getJudgeScores).not.toHaveBeenCalled();
  });

  it("returns 400 when page is not a positive integer", async () => {
    const request = createMockRequest({
      url: "http://localhost:3002/api/judges-analytics/clarity/scores?reportType=PLAN&page=0",
    });
    const response = await scoresGET(
      request,
      createMockRouteContext({ promptName: "clarity" })
    );

    expect(response.status).toBe(400);
    expect(judgesAnalyticsService.getJudgeScores).not.toHaveBeenCalled();
  });

  it("returns 400 when promptName is not canonical (contains hyphens)", async () => {
    const request = createMockRequest({
      url: "http://localhost:3002/api/judges-analytics/clarity-judge/scores?reportType=PLAN",
    });
    const response = await scoresGET(
      request,
      createMockRouteContext({ promptName: "clarity-judge" })
    );

    expect(response.status).toBe(400);
    expect(judgesAnalyticsService.getJudgeScores).not.toHaveBeenCalled();
  });

  it("returns 404 when judge is not found (service returns null)", async () => {
    vi.mocked(judgesAnalyticsService.getJudgeScores).mockResolvedValue(null);

    const request = createMockRequest({
      url: "http://localhost:3002/api/judges-analytics/unknown_judge/scores?reportType=PLAN",
    });
    const response = await scoresGET(
      request,
      createMockRouteContext({ promptName: "unknown_judge" })
    );

    expect(response.status).toBe(404);
  });

  it("returns 200 with page 2 results and correct pagination", async () => {
    const mockData = makeJudgeScoresResponse({
      pagination: { page: 2, pageSize: 10, totalRows: 25, totalPages: 3 },
    });
    vi.mocked(judgesAnalyticsService.getJudgeScores).mockResolvedValue(
      mockData as any
    );

    const request = createMockRequest({
      url: "http://localhost:3002/api/judges-analytics/clarity/scores?reportType=PLAN&page=2&pageSize=10",
    });
    const response = await scoresGET(
      request,
      createMockRouteContext({ promptName: "clarity" })
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.data.pagination.page).toBe(2);
    expect(judgesAnalyticsService.getJudgeScores).toHaveBeenCalledWith(
      mockAuthContext.user.organizationId,
      "clarity",
      "PLAN",
      2,
      10
    );
  });

  it("returns 500 for unexpected errors", async () => {
    vi.mocked(judgesAnalyticsService.getJudgeScores).mockRejectedValue(
      new Error("Database error")
    );

    const request = createMockRequest({
      url: "http://localhost:3002/api/judges-analytics/clarity/scores?reportType=PLAN",
    });
    const response = await scoresGET(
      request,
      createMockRouteContext({ promptName: "clarity" })
    );

    expect(response.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// POST /artifacts/[artifactId]/judge-ratings
// ---------------------------------------------------------------------------

const ARTIFACT_ID = "artifact-test";
const JUDGE_SCORE_ID = "a0000000-0000-7000-8000-000000000001";

describe("POST /api/artifacts/[artifactId]/judge-ratings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthContext = createTestAuthContext();
  });

  it("returns 200 with saved rating on valid request", async () => {
    vi.mocked(submitJudgeRating).mockResolvedValue({
      rating: 0.75,
      isUpdate: false,
      promptName: "clarity",
      reportType: EvaluationReportType.Plan,
    });

    const request = createMockRequest({
      url: `http://localhost:3002/api/artifacts/${ARTIFACT_ID}/judge-ratings`,
      method: "POST",
      body: { judgeScoreId: JUDGE_SCORE_ID, rating: 0.75 },
    });
    const response = await ratingsPOST(
      request,
      createMockRouteContext({ id: ARTIFACT_ID })
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.success).toBe(true);
    expect(json.data).toEqual({
      rating: 0.75,
      isUpdate: false,
      promptName: "clarity",
      reportType: EvaluationReportType.Plan,
    });
    expect(submitJudgeRating).toHaveBeenCalledWith(
      mockAuthContext.user.organizationId,
      mockAuthContext.user.id,
      ARTIFACT_ID,
      JUDGE_SCORE_ID,
      0.75
    );
  });

  it("returns 200 with isUpdate=true when updating existing rating", async () => {
    vi.mocked(submitJudgeRating).mockResolvedValue({
      rating: 0.5,
      isUpdate: true,
      promptName: "clarity",
      reportType: EvaluationReportType.Plan,
    });

    const request = createMockRequest({
      url: `http://localhost:3002/api/artifacts/${ARTIFACT_ID}/judge-ratings`,
      method: "POST",
      body: { judgeScoreId: JUDGE_SCORE_ID, rating: 0.5 },
    });
    const response = await ratingsPOST(
      request,
      createMockRouteContext({ id: ARTIFACT_ID })
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.data.isUpdate).toBe(true);
  });

  it("returns 400 when rating > 1", async () => {
    const request = createMockRequest({
      url: `http://localhost:3002/api/artifacts/${ARTIFACT_ID}/judge-ratings`,
      method: "POST",
      body: { judgeScoreId: JUDGE_SCORE_ID, rating: 1.01 },
    });
    const response = await ratingsPOST(
      request,
      createMockRouteContext({ id: ARTIFACT_ID })
    );

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.success).toBe(false);
    expect(submitJudgeRating).not.toHaveBeenCalled();
  });

  it("returns 400 when rating < 0", async () => {
    const request = createMockRequest({
      url: `http://localhost:3002/api/artifacts/${ARTIFACT_ID}/judge-ratings`,
      method: "POST",
      body: { judgeScoreId: JUDGE_SCORE_ID, rating: -0.01 },
    });
    const response = await ratingsPOST(
      request,
      createMockRouteContext({ id: ARTIFACT_ID })
    );

    expect(response.status).toBe(400);
    expect(submitJudgeRating).not.toHaveBeenCalled();
  });

  it("returns 400 when judgeScoreId is missing", async () => {
    const request = createMockRequest({
      url: `http://localhost:3002/api/artifacts/${ARTIFACT_ID}/judge-ratings`,
      method: "POST",
      body: { rating: 0.5 },
    });
    const response = await ratingsPOST(
      request,
      createMockRouteContext({ id: ARTIFACT_ID })
    );

    expect(response.status).toBe(400);
    expect(submitJudgeRating).not.toHaveBeenCalled();
  });

  it("returns 404 when judgeScoreId does not belong to artifact", async () => {
    vi.mocked(submitJudgeRating).mockResolvedValue(null);

    const request = createMockRequest({
      url: `http://localhost:3002/api/artifacts/${ARTIFACT_ID}/judge-ratings`,
      method: "POST",
      body: { judgeScoreId: JUDGE_SCORE_ID, rating: 0.5 },
    });
    const response = await ratingsPOST(
      request,
      createMockRouteContext({ id: ARTIFACT_ID })
    );

    expect(response.status).toBe(404);
    const json = await response.json();
    expect(json.success).toBe(false);
  });

  it("returns 500 for unexpected errors", async () => {
    vi.mocked(submitJudgeRating).mockRejectedValue(new Error("DB failure"));

    const request = createMockRequest({
      url: `http://localhost:3002/api/artifacts/${ARTIFACT_ID}/judge-ratings`,
      method: "POST",
      body: { judgeScoreId: JUDGE_SCORE_ID, rating: 0.5 },
    });
    const response = await ratingsPOST(
      request,
      createMockRouteContext({ id: ARTIFACT_ID })
    );

    expect(response.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// GET /artifacts/[artifactId]/judge-ratings
// ---------------------------------------------------------------------------

describe("GET /api/artifacts/[artifactId]/judge-ratings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthContext = createTestAuthContext();
  });

  it("returns 200 with user judge ratings", async () => {
    vi.mocked(getUserJudgeRatings).mockResolvedValue({
      ratings: [
        { judgeScoreId: "js-1", rating: 0.8 },
        { judgeScoreId: "js-2", rating: 0.5 },
      ],
    });

    const request = createMockRequest({
      url: `http://localhost:3002/api/artifacts/${ARTIFACT_ID}/judge-ratings`,
    });
    const response = await ratingsGET(
      request,
      createMockRouteContext({ id: ARTIFACT_ID })
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.success).toBe(true);
    expect(json.data.ratings).toHaveLength(2);
    expect(getUserJudgeRatings).toHaveBeenCalledWith(
      mockAuthContext.user.organizationId,
      mockAuthContext.user.id,
      ARTIFACT_ID
    );
  });

  it("returns 200 with empty ratings array when user has no ratings", async () => {
    vi.mocked(getUserJudgeRatings).mockResolvedValue({ ratings: [] });

    const request = createMockRequest({
      url: `http://localhost:3002/api/artifacts/${ARTIFACT_ID}/judge-ratings`,
    });
    const response = await ratingsGET(
      request,
      createMockRouteContext({ id: ARTIFACT_ID })
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.data.ratings).toEqual([]);
  });

  it("returns 500 for unexpected errors", async () => {
    vi.mocked(getUserJudgeRatings).mockRejectedValue(new Error("DB failure"));

    const request = createMockRequest({
      url: `http://localhost:3002/api/artifacts/${ARTIFACT_ID}/judge-ratings`,
    });
    const response = await ratingsGET(
      request,
      createMockRouteContext({ id: ARTIFACT_ID })
    );

    expect(response.status).toBe(500);
  });
});
