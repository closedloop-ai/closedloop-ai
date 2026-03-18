import type {
  BatchJudgeScoresResponse,
  JudgesFeedbackResponse,
} from "@repo/api/src/types/evaluation";
import {
  EvalStatus,
  EvaluationReportType,
} from "@repo/api/src/types/evaluation";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { createMockJudgeFeedbackItem } from "@/__tests__/fixtures/evaluation";
import {
  judgesKeys,
  useCodeJudgesFeedback,
  useJudgesFeedback,
  usePrdJudgesFeedback,
  useProjectJudgeScores,
} from "../use-judges";
import { createWrapper } from "./test-utils";

// ---------------------------------------------------------------------------
// Mock
// ---------------------------------------------------------------------------

const mockApiClient = {
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
};

vi.mock("@/hooks/use-api-client", () => ({
  useApiClient: () => mockApiClient,
}));

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

function buildSuccessResponse(
  overrides?: Partial<{ caseId: string; score: number }>
): JudgesFeedbackResponse {
  return {
    status: "success",
    data: [
      createMockJudgeFeedbackItem({
        caseId: overrides?.caseId ?? "test-judge",
        score: overrides?.score ?? 0.9,
      }),
    ],
  };
}

// ---------------------------------------------------------------------------
// Tests — useJudgesFeedback
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useJudgesFeedback", () => {
  test("fetches judge feedback for artifact and returns data on success", async () => {
    const response = buildSuccessResponse({
      caseId: "clarity-judge",
      score: 0.88,
    });
    mockApiClient.get.mockResolvedValueOnce(response);

    const { result } = renderHook(() => useJudgesFeedback("artifact-abc"), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockApiClient.get).toHaveBeenCalledWith(
      "/artifacts/artifact-abc/plan-judges"
    );
    expect(result.current.data).toHaveLength(1);
    expect(result.current.data?.[0].caseId).toBe("clarity-judge");
    expect(result.current.data?.[0].score).toBe(0.88);
  });

  test("returns null when API response has not_found status", async () => {
    const notFoundResponse: JudgesFeedbackResponse = {
      status: "not_found",
      data: null,
    };
    mockApiClient.get.mockResolvedValueOnce(notFoundResponse);

    const { result } = renderHook(() => useJudgesFeedback("artifact-missing"), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toBeNull();
  });

  test("returns null when API response has error status", async () => {
    const errorResponse: JudgesFeedbackResponse = {
      status: "error",
      error: "Database unavailable",
    };
    mockApiClient.get.mockResolvedValueOnce(errorResponse);

    const { result } = renderHook(() => useJudgesFeedback("artifact-error"), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toBeNull();
  });

  test("does not fetch when artifactId is empty string", () => {
    renderHook(() => useJudgesFeedback(""), {
      wrapper: createWrapper(),
    });

    expect(mockApiClient.get).not.toHaveBeenCalled();
  });

  test("handles API transport error", async () => {
    mockApiClient.get.mockRejectedValueOnce(new Error("Network timeout"));

    const { result } = renderHook(() => useJudgesFeedback("artifact-abc"), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(result.current.error).toBeInstanceOf(Error);
    expect((result.current.error as Error).message).toBe("Network timeout");
  });

  test("uses correct query key", () => {
    expect(judgesKeys.detail("artifact-xyz")).toEqual([
      "judges",
      "detail",
      "artifact-xyz",
    ]);
  });

  test("returns empty array when evaluation exists but has no judge scores", async () => {
    const emptyResponse: JudgesFeedbackResponse = {
      status: "success",
      data: [],
    };
    mockApiClient.get.mockResolvedValueOnce(emptyResponse);

    const { result } = renderHook(() => useJudgesFeedback("artifact-abc"), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Tests — usePrdJudgesFeedback
// ---------------------------------------------------------------------------

describe("usePrdJudgesFeedback", () => {
  test("fetches PRD judge feedback using prd-judges endpoint", async () => {
    const response = buildSuccessResponse({
      caseId: "prd-clarity-judge",
      score: 0.88,
    });
    mockApiClient.get.mockResolvedValueOnce(response);

    const { result } = renderHook(() => usePrdJudgesFeedback("artifact-abc"), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockApiClient.get).toHaveBeenCalledWith(
      "/artifacts/artifact-abc/prd-judges"
    );
    expect(result.current.data?.[0].caseId).toBe("prd-clarity-judge");
  });

  test("does not fetch when artifactId is empty string", () => {
    renderHook(() => usePrdJudgesFeedback(""), {
      wrapper: createWrapper(),
    });

    expect(mockApiClient.get).not.toHaveBeenCalled();
  });

  test("uses a distinct query key from useJudgesFeedback and useCodeJudgesFeedback", () => {
    const prdKey = judgesKeys.prdDetail("artifact-xyz");
    const planKey = judgesKeys.detail("artifact-xyz");
    const codeKey = judgesKeys.codeDetail("artifact-xyz");

    expect(prdKey).toEqual(["judges", "prd-detail", "artifact-xyz"]);
    expect(prdKey).not.toEqual(planKey);
    expect(prdKey).not.toEqual(codeKey);
  });
});

// ---------------------------------------------------------------------------
// Tests — useCodeJudgesFeedback
// ---------------------------------------------------------------------------

describe("useCodeJudgesFeedback", () => {
  test("fetches code judge feedback using code-judges endpoint", async () => {
    const response = buildSuccessResponse({
      caseId: "dry-principle-judge",
      score: 0.95,
    });
    mockApiClient.get.mockResolvedValueOnce(response);

    const { result } = renderHook(() => useCodeJudgesFeedback("artifact-abc"), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockApiClient.get).toHaveBeenCalledWith(
      "/artifacts/artifact-abc/code-judges"
    );
    expect(result.current.data?.[0].caseId).toBe("dry-principle-judge");
  });

  test("does not fetch when artifactId is empty string", () => {
    renderHook(() => useCodeJudgesFeedback(""), {
      wrapper: createWrapper(),
    });

    expect(mockApiClient.get).not.toHaveBeenCalled();
  });

  test("uses a distinct query key from useJudgesFeedback", () => {
    const codeKey = judgesKeys.codeDetail("artifact-xyz");
    const planKey = judgesKeys.detail("artifact-xyz");

    expect(codeKey).toEqual(["judges", "code-detail", "artifact-xyz"]);
    expect(codeKey).not.toEqual(planKey);
  });
});

// ---------------------------------------------------------------------------
// Tests — useProjectJudgeScores
// ---------------------------------------------------------------------------

describe("useProjectJudgeScores", () => {
  test("fetches batch judge scores for project and returns map with plan/prd shape", async () => {
    const mockResponse: BatchJudgeScoresResponse = {
      "artifact-plan-1": {
        [EvaluationReportType.Plan]: [
          createMockJudgeFeedbackItem({
            caseId: "plan-quality-judge",
            score: 0.9,
            finalStatus: EvalStatus.Passed,
          }),
        ],
        [EvaluationReportType.Prd]: null,
        [EvaluationReportType.Code]: null,
      },
      "artifact-prd-1": {
        [EvaluationReportType.Plan]: null,
        [EvaluationReportType.Prd]: [
          createMockJudgeFeedbackItem({
            caseId: "prd-clarity-judge",
            score: 0.85,
            finalStatus: EvalStatus.Passed,
          }),
        ],
        [EvaluationReportType.Code]: null,
      },
    };

    mockApiClient.get.mockResolvedValueOnce(mockResponse);

    const { result } = renderHook(() => useProjectJudgeScores("project-abc"), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockApiClient.get).toHaveBeenCalledWith(
      "/artifacts/judge-scores?projectId=project-abc"
    );
    expect(result.current.data).toEqual(mockResponse);
    expect(Object.keys(result.current.data ?? {})).toContain("artifact-plan-1");
    expect(
      result.current.data?.["artifact-plan-1"][EvaluationReportType.Plan]?.[0]
        .caseId
    ).toBe("plan-quality-judge");
    expect(
      result.current.data?.["artifact-plan-1"][EvaluationReportType.Prd]
    ).toBeNull();
    expect(Object.keys(result.current.data ?? {})).toContain("artifact-prd-1");
    expect(
      result.current.data?.["artifact-prd-1"][EvaluationReportType.Prd]?.[0]
        .caseId
    ).toBe("prd-clarity-judge");
    expect(
      result.current.data?.["artifact-prd-1"][EvaluationReportType.Plan]
    ).toBeNull();
  });

  test("URL-encodes projectId in query parameter", async () => {
    mockApiClient.get.mockResolvedValueOnce({});

    const { result } = renderHook(
      () => useProjectJudgeScores("project with spaces"),
      { wrapper: createWrapper() }
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockApiClient.get).toHaveBeenCalledWith(
      "/artifacts/judge-scores?projectId=project%20with%20spaces"
    );
  });

  test("returns empty map when no evaluations exist for project", async () => {
    mockApiClient.get.mockResolvedValueOnce({});

    const { result } = renderHook(
      () => useProjectJudgeScores("project-empty"),
      { wrapper: createWrapper() }
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toEqual({});
  });

  test("does not fetch when projectId is empty string", () => {
    renderHook(() => useProjectJudgeScores(""), {
      wrapper: createWrapper(),
    });

    expect(mockApiClient.get).not.toHaveBeenCalled();
  });

  test("handles API transport error", async () => {
    mockApiClient.get.mockRejectedValueOnce(new Error("Server error"));

    const { result } = renderHook(() => useProjectJudgeScores("project-abc"), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(result.current.error).toBeInstanceOf(Error);
  });

  test("uses correct query key scoped to project", () => {
    expect(judgesKeys.byProject("project-xyz")).toEqual([
      "judges",
      "by-project",
      "project-xyz",
    ]);
  });
});
