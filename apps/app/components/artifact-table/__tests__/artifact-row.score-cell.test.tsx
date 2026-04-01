import { ArtifactStatus, ArtifactType } from "@repo/api/src/types/artifact";
import { Priority } from "@repo/api/src/types/common";
import {
  type BatchJudgeScoresResponse,
  EvalStatus,
  EvaluationReportType,
} from "@repo/api/src/types/evaluation";
import { FeatureStatus } from "@repo/api/src/types/feature";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// Mock next/navigation — ArtifactRow uses useRouter and useParams
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

// Import after mocks
import type { ArtifactWithWorkstream } from "@repo/api/src/types/artifact";
import type { FeatureWithWorkstream } from "@repo/api/src/types/feature";
import type { ArtifactRowItem } from "@/components/artifact-table/artifact-row";
import {
  ArtifactRow,
  RowEditContext,
} from "@/components/artifact-table/artifact-row";
import { ArtifactColumn as Col } from "@/hooks/use-column-visibility";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const makePrdArtifact = (
  overrides?: Partial<ArtifactWithWorkstream>
): ArtifactWithWorkstream => ({
  id: "artifact-prd-1",
  organizationId: "org-1",
  workstreamId: null,
  projectId: "project-1",
  type: ArtifactType.Prd,
  title: "Test PRD",
  slug: "prd-1",
  fileName: null,
  status: ArtifactStatus.Draft,
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
  overrides?: Partial<ArtifactWithWorkstream>
): ArtifactWithWorkstream => ({
  ...makePrdArtifact(),
  id: "artifact-plan-1",
  type: ArtifactType.ImplementationPlan,
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
  status: FeatureStatus.NotStarted,
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

// BatchJudgeScoresResponse with PRD score=0.85 and Plan score=0.72
const makeJudgeScores = (): BatchJudgeScoresResponse => ({
  "artifact-prd-1": {
    [EvaluationReportType.Prd]: [
      {
        judgeScoreId: "score-1",
        caseId: "case-1",
        score: 0.85,
        threshold: 0.7,
        justification: "Good PRD",
        finalStatus: EvalStatus.Passed,
        promptName: null,
        metricName: "completeness",
      },
    ],
    [EvaluationReportType.Plan]: null,
    [EvaluationReportType.Code]: null,
  },
  "artifact-plan-1": {
    [EvaluationReportType.Plan]: [
      {
        judgeScoreId: "score-2",
        caseId: "case-2",
        score: 0.72,
        threshold: 0.7,
        justification: "Adequate plan",
        finalStatus: EvalStatus.Passed,
        promptName: null,
        metricName: "clarity",
      },
    ],
    [EvaluationReportType.Prd]: null,
    [EvaluationReportType.Code]: null,
  },
});

function renderWithContext(
  item: ArtifactRowItem,
  judgeScores?: BatchJudgeScoresResponse
) {
  return render(
    <ArtifactRow
      editHandlers={{ judgeScores }}
      item={item}
      visibleColumns={[Col.Score]}
    />
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ScoreCell — renders score from judgeScores context", () => {
  it("renders '85%' for a PRD artifact with a 0.85 score in judgeScores", () => {
    const item: ArtifactRowItem = { kind: "artifact", data: makePrdArtifact() };

    renderWithContext(item, makeJudgeScores());

    expect(screen.getByText("85%")).toBeInTheDocument();
  });

  it("renders '72%' for a Plan artifact with a 0.72 score in judgeScores", () => {
    const item: ArtifactRowItem = {
      kind: "artifact",
      data: makePlanArtifact(),
    };

    renderWithContext(item, makeJudgeScores());

    expect(screen.getByText("72%")).toBeInTheDocument();
  });

  it("renders a dash for a feature item regardless of judgeScores", () => {
    const item: ArtifactRowItem = { kind: "feature", data: makeFeature() };

    renderWithContext(item, makeJudgeScores());

    // The em dash is the Unicode character U+2014
    expect(screen.getByText("\u2014")).toBeInTheDocument();
  });

  it("renders a dash for all artifact types when judgeScores is absent from context", () => {
    const prdItem: ArtifactRowItem = {
      kind: "artifact",
      data: makePrdArtifact(),
    };

    renderWithContext(prdItem, undefined);

    expect(screen.getByText("\u2014")).toBeInTheDocument();
    expect(screen.queryByText("85%")).not.toBeInTheDocument();
  });

  it("renders a dash when judgeScores is set on an outer RowEditContext.Provider but not passed via editHandlers", () => {
    // ArtifactRow always wraps children with its own RowEditContext.Provider using
    // editHandlers. An outer provider is overridden, so judgeScores never reaches
    // ScoreCell unless passed through editHandlers.
    const item: ArtifactRowItem = { kind: "artifact", data: makePrdArtifact() };
    const judgeScores = makeJudgeScores();

    render(
      <RowEditContext.Provider value={{ judgeScores }}>
        <ArtifactRow item={item} visibleColumns={[Col.Score]} />
      </RowEditContext.Provider>
    );

    expect(screen.getByText("\u2014")).toBeInTheDocument();
  });
});
