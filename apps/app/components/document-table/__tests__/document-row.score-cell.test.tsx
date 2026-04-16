import { Priority } from "@repo/api/src/types/common";
import { DocumentStatus, DocumentType } from "@repo/api/src/types/document";
import { EvalStatus } from "@repo/api/src/types/evaluation";
import { FeatureStatus } from "@repo/api/src/types/feature";
import { render, screen } from "@testing-library/react";
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

vi.mock("@/hooks/queries/use-judges", () => ({
  usePlanJudgesFeedback: (...args: unknown[]) =>
    mockUsePlanJudgesFeedback(...args),
  usePrdJudgesFeedback: (...args: unknown[]) =>
    mockUsePrdJudgesFeedback(...args),
  useCodeJudgesFeedback: vi.fn(),
}));

// Import after mocks
import type { DocumentWithWorkstream } from "@repo/api/src/types/document";
import type { FeatureWithWorkstream } from "@repo/api/src/types/feature";
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
  overrides?: Partial<FeatureWithWorkstream>
): FeatureWithWorkstream => ({
  id: "feature-1",
  organizationId: "org-1",
  workstreamId: null,
  projectId: "project-1",
  title: "Test Feature",
  slug: "feature-1",
  description: null,
  status: FeatureStatus.Draft,
  priority: Priority.Medium,
  assigneeId: null,
  assignee: null,
  createdById: "user-1",
  createdBy: null,
  createdAt: new Date("2024-01-01"),
  updatedAt: new Date("2024-01-02"),
  project: { id: "project-1", name: "Test Project", teams: [] },
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

    expect(mockUsePrdJudgesFeedback).toHaveBeenCalledWith("artifact-prd-1");
    expect(mockUsePlanJudgesFeedback).toHaveBeenCalledWith("");
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

    expect(mockUsePlanJudgesFeedback).toHaveBeenCalledWith("artifact-plan-1");
    expect(mockUsePrdJudgesFeedback).toHaveBeenCalledWith("");
    expect(screen.getByText("72%")).toBeInTheDocument();
  });

  it("renders a dash for a feature item; judge hooks run with empty id (disabled)", () => {
    mockUsePlanJudgesFeedback.mockReturnValue({
      data: null,
      isLoading: false,
    });
    mockUsePrdJudgesFeedback.mockReturnValue({
      data: null,
      isLoading: false,
    });

    const item: DocumentRowItem = { kind: "feature", data: makeFeature() };
    renderScoreColumn(item);

    expect(mockUsePlanJudgesFeedback).toHaveBeenCalledWith("");
    expect(mockUsePrdJudgesFeedback).toHaveBeenCalledWith("");
    expect(screen.getByText("\u2014")).toBeInTheDocument();
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
});
