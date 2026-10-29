import { EvaluationReportType } from "@repo/api/src/types/evaluation";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import JudgeDetailPage from "../[metricName]/page";

const mockUseJudgeDetail = vi.fn();
const mockUseParams = vi.fn();

vi.mock("@repo/app/judges-analytics/hooks/use-judges-analytics", () => ({
  useJudgeDetail: (promptName: string, reportType: EvaluationReportType) =>
    mockUseJudgeDetail(promptName, reportType),
}));

vi.mock("@/components/feature-flag-route-gate", () => ({
  FeatureFlagRouteGate: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => "/test-org/judges-analytics/clarity",
  useSearchParams: () => new URLSearchParams("reportType=PLAN"),
  useParams: () => mockUseParams(),
}));

vi.mock("@repo/auth/client", () => ({
  useOrganization: () => ({
    organization: { slug: "test-org" },
    isLoaded: true,
  }),
  useAuth: () => ({ isSignedIn: true }),
}));

function judgeNotFound() {
  return { data: undefined, isLoading: false, isError: false, error: null };
}

afterEach(() => {
  cleanup();
  mockUseJudgeDetail.mockReset();
  mockUseParams.mockReset();
});

/**
 * ISS-8534. `decodeURIComponent` throws `URIError` on a malformed escape, and
 * the bare call sat in the render of a `"use client"` component — so the route
 * blanked to the error boundary instead of reaching the not-found alert it
 * already carries two lines below.
 */
describe("JudgeDetailPage - malformed metricName param", () => {
  test("renders the existing not-found alert instead of throwing", () => {
    mockUseParams.mockReturnValue({ orgSlug: "test-org", metricName: "%" });
    mockUseJudgeDetail.mockReturnValue(judgeNotFound());

    render(<JudgeDetailPage />);

    expect(screen.getByText("Judge not found")).toBeInTheDocument();
    expect(
      screen.getByText("The requested judge could not be found.")
    ).toBeInTheDocument();
  });

  test("falls back to the RAW segment, so the lookup misses rather than querying an empty name", () => {
    mockUseParams.mockReturnValue({ orgSlug: "test-org", metricName: "%" });
    mockUseJudgeDetail.mockReturnValue(judgeNotFound());

    render(<JudgeDetailPage />);

    expect(mockUseJudgeDetail).toHaveBeenCalledWith(
      "%",
      EvaluationReportType.Plan
    );
  });

  test("still decodes a well-formed escaped segment", () => {
    mockUseParams.mockReturnValue({
      orgSlug: "test-org",
      metricName: "code%20quality",
    });
    mockUseJudgeDetail.mockReturnValue(judgeNotFound());

    render(<JudgeDetailPage />);

    expect(mockUseJudgeDetail).toHaveBeenCalledWith(
      "code quality",
      EvaluationReportType.Plan
    );
  });
});
