import { Priority } from "@repo/api/src/types/common";
import { DocumentStatus, DocumentType } from "@repo/api/src/types/document";
import { EvalStatus } from "@repo/api/src/types/evaluation";
import { ProjectStatus } from "@repo/api/src/types/project";
import { cleanup, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock next/navigation — DocumentRow uses useRouter and useParams
vi.mock("next/navigation", () => ({
  useRouter: vi.fn(() => ({ push: vi.fn(), replace: vi.fn() })),
  usePathname: vi.fn(() => "/"),
  useSearchParams: vi.fn(
    () =>
      new URLSearchParams() as unknown as ReturnType<
        typeof import("next/navigation").useSearchParams
      >
  ),
  useParams: vi.fn(() => ({})),
}));

const mockUsePlanJudgesFeedback = vi.fn();
const mockUsePrdJudgesFeedback = vi.fn();
const mockUseFeatureJudgesFeedback = vi.fn();

vi.mock("@/hooks/queries/use-judges", () => ({
  useFeatureJudgesFeedback: (...args: unknown[]) =>
    mockUseFeatureJudgesFeedback(...args),
  usePlanJudgesFeedback: (...args: unknown[]) =>
    mockUsePlanJudgesFeedback(...args),
  usePrdJudgesFeedback: (...args: unknown[]) =>
    mockUsePrdJudgesFeedback(...args),
  useCodeJudgesFeedback: vi.fn(),
}));

// Import after mocks
import type { DocumentWithWorkstream } from "@repo/api/src/types/document";
import type { ProjectWithDetails } from "@repo/api/src/types/project";
import type { DocumentRowItem } from "@/components/document-table/document-row";
import { DocumentRow } from "@/components/document-table/document-row";
import { DocumentColumn as Col } from "@/hooks/use-column-visibility";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const makePrdArtifact = (
  overrides?: Partial<DocumentWithWorkstream>
): DocumentWithWorkstream => ({
  id: "artifact-prd-1",
  organizationId: "org-1",
  workstreamId: null,
  projectId: "project-1",
  type: DocumentType.Prd,
  title: "Test PRD",
  slug: "prd-1",
  fileName: null,
  status: DocumentStatus.Draft,
  priority: Priority.Medium,
  latestVersion: 1,
  createdById: "user-1",
  assigneeId: null,
  assignee: null,
  approverId: null,
  approver: null,
  tokenUsage: null,
  targetRepo: null,
  targetBranch: null,
  templateForType: null,
  sortOrder: null,
  createdAt: new Date("2024-01-01"),
  updatedAt: new Date("2024-01-02"),
  ...overrides,
});

const makePlanArtifact = (
  overrides?: Partial<DocumentWithWorkstream>
): DocumentWithWorkstream => ({
  ...makePrdArtifact(),
  id: "artifact-plan-1",
  type: DocumentType.ImplementationPlan,
  title: "Test Plan",
  slug: "plan-1",
  ...overrides,
});

const makeFeature = (
  overrides?: Partial<DocumentWithWorkstream>
): DocumentWithWorkstream => ({
  ...makePrdArtifact(),
  id: "feature-1",
  type: DocumentType.Feature,
  title: "Test Feature",
  slug: "feature-1",
  status: DocumentStatus.Draft,
  project: { id: "project-1", name: "Test Project", teams: [] },
  ...overrides,
});

const makeProject = (
  overrides?: Partial<ProjectWithDetails>
): ProjectWithDetails => ({
  id: "project-1",
  organizationId: "org-1",
  name: "Test Project",
  description: null,
  priority: Priority.Medium,
  status: ProjectStatus.InProgress,
  assigneeId: null,
  createdById: "user-1",
  slug: "project-1",
  targetDate: null,
  codebaseSummary: null,
  lastIndexedAt: null,
  settings: {},
  sortOrder: null,
  createdAt: new Date("2024-01-01"),
  updatedAt: new Date("2024-01-02"),
  completionPercentage: 0,
  teams: [],
  ...overrides,
});

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

    const item: DocumentRowItem = { kind: "artifact", data: makePrdArtifact() };
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
      kind: "artifact",
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

    const item: DocumentRowItem = { kind: "feature", data: makeFeature() };
    renderScoreColumn(item);

    expect(screen.getByText("92%")).toBeInTheDocument();
    expect(screen.queryByText("\u2014")).not.toBeInTheDocument();
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

    const item: DocumentRowItem = { kind: "artifact", data: makePrdArtifact() };
    renderScoreColumn(item);

    expect(screen.getByText("\u2014")).toBeInTheDocument();
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

    const item: DocumentRowItem = { kind: "artifact", data: makePrdArtifact() };
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
        item: { kind: "artifact", data: makePrdArtifact() },
        prdId: "artifact-prd-1",
        planId: "",
        featureId: "",
      },
      {
        item: { kind: "artifact", data: makePlanArtifact() },
        prdId: "",
        planId: "artifact-plan-1",
        featureId: "",
      },
      {
        item: { kind: "feature", data: makeFeature() },
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
