import { EvalStatus } from "@repo/api/src/types/evaluation";
import { cleanup, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "./render-with-nav";

vi.mock(
  "@repo/app/documents/hooks/use-artifact-favorites",
  async () => await import("./__mocks__/use-artifact-favorites")
);

const mockUsePlanJudgesFeedback = vi.fn();
const mockUsePrdJudgesFeedback = vi.fn();
const mockUseFeatureJudgesFeedback = vi.fn();

vi.mock("@repo/app/judges-analytics/hooks/use-judges", () => ({
  useFeatureJudgesFeedback: (...args: unknown[]) =>
    mockUseFeatureJudgesFeedback(...args),
  usePlanJudgesFeedback: (...args: unknown[]) =>
    mockUsePlanJudgesFeedback(...args),
  usePrdJudgesFeedback: (...args: unknown[]) =>
    mockUsePrdJudgesFeedback(...args),
  useCodeJudgesFeedback: vi.fn(),
}));

import type { DocumentRowItem } from "@repo/app/documents/components/table/document-row";
import { DocumentRow } from "@repo/app/documents/components/table/document-row";
import { DocumentColumn as Col } from "@repo/app/shared/hooks/use-column-visibility";
import {
  makeArtifact,
  makeFeatureArtifact,
  makePlanArtifact,
} from "@repo/app/shared/test-fixtures/documents";
// Import after mocks
import { makeProject } from "@repo/app/shared/test-fixtures/project";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const makePrdArtifact = (overrides?: Parameters<typeof makeArtifact>[0]) =>
  makeArtifact({ id: "artifact-prd-1", ...overrides });

const prdFeedbackItem = {
  judgeScoreId: "score-1",
  caseId: "case-1",
  score: 0.85,
  threshold: 0.7,
  justification: "Good PRD",
  finalStatus: EvalStatus.Passed,
  promptName: null,
  metricName: "completeness",
};

const planFeedbackItem = {
  judgeScoreId: "score-2",
  caseId: "case-2",
  score: 0.72,
  threshold: 0.7,
  justification: "Adequate plan",
  finalStatus: EvalStatus.Passed,
  promptName: null,
  metricName: "clarity",
};

const featureFeedbackItem = {
  judgeScoreId: "score-3",
  caseId: "case-3",
  score: 0.92,
  threshold: 0.7,
  justification: "Strong feature",
  finalStatus: EvalStatus.Passed,
  promptName: null,
  metricName: "feature_quality",
};

function renderScoreColumn(item: DocumentRowItem) {
  return render(<DocumentRow item={item} visibleColumns={[Col.Score]} />);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ScoreCell — per-artifact judge hooks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUsePlanJudgesFeedback.mockReturnValue({
      data: null,
      isLoading: false,
    });
    mockUsePrdJudgesFeedback.mockReturnValue({
      data: null,
      isLoading: false,
    });
    mockUseFeatureJudgesFeedback.mockReturnValue({
      data: null,
      isLoading: false,
    });
  });

  it("renders '85%' for a PRD artifact from usePrdJudgesFeedback data", () => {
    mockUsePrdJudgesFeedback.mockReturnValue({
      data: [prdFeedbackItem],
      isLoading: false,
    });
    mockUsePlanJudgesFeedback.mockReturnValue({
      data: null,
      isLoading: false,
    });

    const item: DocumentRowItem = { kind: "document", data: makePrdArtifact() };
    renderScoreColumn(item);

    expect(screen.getByText("85%")).toBeInTheDocument();
  });

  it("renders '72%' for a Plan artifact from usePlanJudgesFeedback data", () => {
    mockUsePlanJudgesFeedback.mockReturnValue({
      data: [planFeedbackItem],
      isLoading: false,
    });
    mockUsePrdJudgesFeedback.mockReturnValue({
      data: null,
      isLoading: false,
    });

    const item: DocumentRowItem = {
      kind: "document",
      data: makePlanArtifact(),
    };
    renderScoreColumn(item);

    expect(screen.getByText("72%")).toBeInTheDocument();
  });

  it("renders '92%' for a feature item from useFeatureJudgesFeedback data", () => {
    mockUseFeatureJudgesFeedback.mockReturnValue({
      data: [featureFeedbackItem],
      isLoading: false,
    });

    const item: DocumentRowItem = {
      kind: "document",
      data: makeFeatureArtifact(),
    };
    renderScoreColumn(item);

    expect(screen.getByText("92%")).toBeInTheDocument();
    expect(screen.queryByText("—")).not.toBeInTheDocument();
  });

  it("renders a dash when PRD feedback is absent", () => {
    mockUsePrdJudgesFeedback.mockReturnValue({
      data: null,
      isLoading: false,
    });
    mockUsePlanJudgesFeedback.mockReturnValue({
      data: null,
      isLoading: false,
    });

    const item: DocumentRowItem = { kind: "document", data: makePrdArtifact() };
    renderScoreColumn(item);

    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.queryByText("85%")).not.toBeInTheDocument();
  });

  it("shows a loading spinner while PRD feedback is loading", () => {
    mockUsePrdJudgesFeedback.mockReturnValue({
      data: undefined,
      isLoading: true,
    });
    mockUsePlanJudgesFeedback.mockReturnValue({
      data: null,
      isLoading: false,
    });

    const item: DocumentRowItem = { kind: "document", data: makePrdArtifact() };
    const { container } = renderScoreColumn(item);

    expect(container.querySelector(".animate-spin")).toBeInTheDocument();
  });

  it("enables only the judge hook that matches the row type", () => {
    const cases: Array<{
      item: DocumentRowItem;
      prdId: string;
      planId: string;
      featureId: string;
    }> = [
      {
        item: { kind: "document", data: makePrdArtifact() },
        prdId: "artifact-prd-1",
        planId: "",
        featureId: "",
      },
      {
        item: { kind: "document", data: makePlanArtifact() },
        prdId: "",
        planId: "artifact-plan-1",
        featureId: "",
      },
      {
        item: { kind: "document", data: makeFeatureArtifact() },
        prdId: "",
        planId: "",
        featureId: "feature-1",
      },
      {
        item: { kind: "project", data: makeProject() },
        prdId: "",
        planId: "",
        featureId: "",
      },
    ];

    for (const { item, prdId, planId, featureId } of cases) {
      vi.clearAllMocks();
      renderScoreColumn(item);

      expect(mockUsePrdJudgesFeedback).toHaveBeenCalledWith(prdId);
      expect(mockUsePlanJudgesFeedback).toHaveBeenCalledWith(planId);
      expect(mockUseFeatureJudgesFeedback).toHaveBeenCalledWith(featureId);

      cleanup();
    }
  });
});
