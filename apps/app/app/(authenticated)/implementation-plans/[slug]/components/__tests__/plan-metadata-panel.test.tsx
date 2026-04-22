import type { DocumentDetail } from "@repo/api/src/types/document";
import type { JudgeFeedbackItem } from "@repo/api/src/types/evaluation";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  createMockDocument,
  createMockGenerationStatus,
  createMockPullRequest,
} from "@/__tests__/fixtures/documents";
import { createMockJudgeFeedbackItem } from "@/__tests__/fixtures/evaluation";
import {
  calculateAcceptanceRate,
  sortJudgeFeedbackItemsByScore,
} from "@/lib/evaluation-utils";
import { PlanMetadataPanel } from "../plan-metadata-panel";

// Mock usePerformanceData to avoid query client dependencies
vi.mock("@/hooks/queries/use-performance", () => ({
  usePerformanceData: () => ({
    data: undefined,
    isLoading: false,
    error: null,
  }),
}));

// Mock JudgeResultCard to simplify testing
vi.mock("../judge-result-card", () => ({
  JudgeResultCard: ({ item }: { item: JudgeFeedbackItem }) => (
    <div data-score={item.score} data-testid={`judge-card-${item.caseId}`}>
      {item.caseId}: {item.score}
    </div>
  ),
}));

// Mock RatingSection to avoid Clerk auth dependencies
vi.mock("@/components/document-editor/rating-section", () => ({
  RatingSection: () => (
    <div data-testid="rating-section">Rating Section Mock</div>
  ),
}));

// Mock useDocumentsByProject to avoid Clerk auth dependencies
vi.mock("@/hooks/queries/use-documents", () => ({
  useDocumentsByProject: () => ({
    data: [],
    isLoading: false,
    error: null,
  }),
}));

// Mock entity links hooks to avoid Clerk auth dependencies
vi.mock("@/hooks/queries/use-entity-links", () => ({
  useLinkedEntities: () => ({
    data: [],
    isLoading: false,
    error: null,
  }),
  useCreateEntityLink: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
  useDeleteEntityLink: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
}));

// Mock pull request rating hooks to avoid Clerk auth dependencies
vi.mock("@/hooks/queries/use-pull-request-rating", () => ({
  usePullRequestRating: () => ({
    data: null,
    isLoading: false,
    error: null,
  }),
  useSubmitPullRequestRating: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
}));

// Regex patterns for testing (hoisted to module level per Biome lint rules)
const PR_NUMBER_PATTERN = /#42:/i;
const PR_TITLE_PATTERN = /add new feature/i;

const createMockPlan = (overrides?: Partial<DocumentDetail>): DocumentDetail =>
  ({
    ...createMockDocument({ type: "IMPLEMENTATION_PLAN" }),
    version: {
      id: "version-1",
      documentId: "artifact-123",
      version: 1,
      content: "# Plan content",
      createdById: null,
      createdAt: new Date("2024-01-15T10:00:00Z"),
    },
    ...overrides,
  }) as DocumentDetail;

const defaultProps = {
  plan: createMockPlan(),
  generationStatus: null,
  pullRequest: null,
  previewDeployment: null,
  onPreviewRefresh: vi.fn().mockResolvedValue(null),
  isPreviewRefreshing: false,
  codeJudgeItems: null,
};

describe("sortJudgeFeedbackItemsByScore", () => {
  test("sorts items by score in ascending order (worst first)", () => {
    const items = [
      createMockJudgeFeedbackItem({ caseId: "High Score", score: 0.95 }),
      createMockJudgeFeedbackItem({ caseId: "Low Score", score: 0.3 }),
      createMockJudgeFeedbackItem({ caseId: "Medium Score", score: 0.7 }),
    ];

    const sorted = sortJudgeFeedbackItemsByScore(items);

    expect(sorted[0].caseId).toBe("Low Score");
    expect(sorted[0].score).toBe(0.3);
    expect(sorted[1].caseId).toBe("Medium Score");
    expect(sorted[1].score).toBe(0.7);
    expect(sorted[2].caseId).toBe("High Score");
    expect(sorted[2].score).toBe(0.95);
  });

  test("handles items with same score (stable sort)", () => {
    const items = [
      createMockJudgeFeedbackItem({ caseId: "First", score: 0.8 }),
      createMockJudgeFeedbackItem({ caseId: "Second", score: 0.8 }),
      createMockJudgeFeedbackItem({ caseId: "Third", score: 0.8 }),
    ];

    const sorted = sortJudgeFeedbackItemsByScore(items);

    expect(sorted).toHaveLength(3);
    // All have same score, order should be preserved
    expect(sorted.map((m) => m.caseId)).toEqual(["First", "Second", "Third"]);
  });

  test("handles single item", () => {
    const items = [
      createMockJudgeFeedbackItem({ caseId: "Only Judge", score: 0.5 }),
    ];

    const sorted = sortJudgeFeedbackItemsByScore(items);

    expect(sorted).toHaveLength(1);
    expect(sorted[0].caseId).toBe("Only Judge");
  });

  test("handles empty array", () => {
    const sorted = sortJudgeFeedbackItemsByScore([]);
    expect(sorted).toHaveLength(0);
  });
});

describe("calculateAcceptanceRate", () => {
  test("returns 100% when all items pass threshold", () => {
    const items = [
      createMockJudgeFeedbackItem({
        caseId: "Accuracy",
        score: 0.9,
        threshold: 0.7,
      }),
      createMockJudgeFeedbackItem({
        caseId: "Completeness",
        score: 0.8,
        threshold: 0.7,
      }),
    ];

    const result = calculateAcceptanceRate(items);

    expect(result.acceptedCount).toBe(2);
    expect(result.totalCount).toBe(2);
    expect(result.rate).toBe(100);
  });

  test("calculates correct rate when some items fail", () => {
    const items = [
      createMockJudgeFeedbackItem({
        caseId: "Passing",
        score: 0.8,
        threshold: 0.7,
      }),
      createMockJudgeFeedbackItem({
        caseId: "Failing",
        score: 0.5,
        threshold: 0.7,
      }),
      createMockJudgeFeedbackItem({
        caseId: "Also Passing",
        score: 0.75,
        threshold: 0.7,
      }),
    ];

    const result = calculateAcceptanceRate(items);

    expect(result.acceptedCount).toBe(2);
    expect(result.totalCount).toBe(3);
    expect(result.rate).toBeCloseTo(66.67, 1);
  });

  test("returns 0% when all items fail", () => {
    const items = [
      createMockJudgeFeedbackItem({
        caseId: "Failing1",
        score: 0.3,
        threshold: 0.7,
      }),
      createMockJudgeFeedbackItem({
        caseId: "Failing2",
        score: 0.4,
        threshold: 0.7,
      }),
    ];

    const result = calculateAcceptanceRate(items);

    expect(result.acceptedCount).toBe(0);
    expect(result.totalCount).toBe(2);
    expect(result.rate).toBe(0);
  });

  test("handles edge case: item score equals threshold (passes)", () => {
    const items = [createMockJudgeFeedbackItem({ score: 0.7, threshold: 0.7 })];

    const result = calculateAcceptanceRate(items);

    expect(result.acceptedCount).toBe(1);
    expect(result.totalCount).toBe(1);
    expect(result.rate).toBe(100);
  });

  test("handles undefined items", () => {
    const result = calculateAcceptanceRate(undefined);

    expect(result.acceptedCount).toBe(0);
    expect(result.totalCount).toBe(0);
    expect(result.rate).toBe(0);
  });

  test("handles empty items array", () => {
    const result = calculateAcceptanceRate([]);

    expect(result.acceptedCount).toBe(0);
    expect(result.totalCount).toBe(0);
    expect(result.rate).toBe(0);
  });

  test("handles zero threshold (still counts toward total)", () => {
    const items = [
      createMockJudgeFeedbackItem({
        caseId: "With Threshold",
        score: 0.8,
        threshold: 0.7,
      }),
      createMockJudgeFeedbackItem({
        caseId: "Zero Threshold",
        score: 0.9,
        threshold: 0,
      }),
    ];

    const result = calculateAcceptanceRate(items);

    // Both items should pass (0.9 >= 0 and 0.8 >= 0.7)
    expect(result.acceptedCount).toBe(2);
    expect(result.totalCount).toBe(2);
    expect(result.rate).toBe(100);
  });
});

describe("PlanMetadataPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  describe("Section structure", () => {
    test("renders plan-specific sections: Code Evaluation and Rating", () => {
      render(<PlanMetadataPanel {...defaultProps} />);

      expect(screen.getByText("Code Evaluation")).toBeDefined();
      expect(screen.getByText("Rating")).toBeDefined();
    });
  });

  describe("Generation content", () => {
    test("displays loop link when generationStatus has loop source", () => {
      render(
        <PlanMetadataPanel
          {...defaultProps}
          generationStatus={createMockGenerationStatus({
            source: "loop",
            loopId: "loop-abc",
          })}
        />
      );
      expect(screen.getByText("View loop details")).toBeDefined();
    });

    test("displays pull request info when pullRequest is provided", () => {
      render(
        <PlanMetadataPanel
          {...defaultProps}
          pullRequest={createMockPullRequest()}
        />
      );
      expect(screen.getByText(PR_NUMBER_PATTERN)).toBeDefined();
      expect(screen.getByText(PR_TITLE_PATTERN)).toBeDefined();
    });
  });

  describe("Additional repositories", () => {
    const loopGenerationStatus = createMockGenerationStatus({
      source: "loop",
      loopId: "loop-abc",
    });

    test("renders each repo fullName and branch when additionalRepos is non-empty", () => {
      render(
        <PlanMetadataPanel
          {...defaultProps}
          additionalRepos={[
            { fullName: "org/repo-one", branch: "main" },
            { fullName: "org/repo-two", branch: "feature-branch" },
          ]}
          generationStatus={loopGenerationStatus}
        />
      );

      expect(screen.getByText("org/repo-one")).toBeDefined();
      expect(screen.getByText("(main)")).toBeDefined();
      expect(screen.getByText("org/repo-two")).toBeDefined();
      expect(screen.getByText("(feature-branch)")).toBeDefined();
    });

    test("does not render additional repos section when additionalRepos is absent", () => {
      render(
        <PlanMetadataPanel
          {...defaultProps}
          generationStatus={loopGenerationStatus}
        />
      );

      expect(screen.queryByText("Additional Repositories")).toBeNull();
    });
  });
});
