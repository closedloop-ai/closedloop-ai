import type { ArtifactStatus } from "@repo/api/src/types/artifact";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  createMockArtifact,
  createMockGenerationStatus,
  createMockPullRequest,
} from "@/__tests__/fixtures/artifacts";
import { createMockMetric } from "@/__tests__/fixtures/evaluation";
import {
  calculateAcceptanceRate,
  sortMetricsByScore,
} from "@/lib/evaluation-utils";
import { PlanMetadataPanel } from "../plan-metadata-panel";

// Mock the ExecutionLogSummary component to avoid query client dependencies
vi.mock("@/components/execution-log/execution-log-summary", () => ({
  ExecutionLogSummary: () => (
    <div data-testid="execution-log-summary">Execution Log Content</div>
  ),
}));

// Mock the StatusMetadataSection to simplify testing
vi.mock("@/components/artifact-editor/status-metadata-section", () => ({
  StatusMetadataSection: () => (
    <div data-testid="status-metadata-section">Status Section Mock</div>
  ),
}));

// Mock JudgeResultCard to simplify testing
vi.mock("../judge-result-card", () => ({
  JudgeResultCard: ({
    metric,
  }: {
    metric: { metric_name: string; score: number };
  }) => (
    <div
      data-score={metric.score}
      data-testid={`judge-card-${metric.metric_name}`}
    >
      {metric.metric_name}: {metric.score}
    </div>
  ),
}));

// Mock RatingSection to avoid Clerk auth dependencies
vi.mock("@/components/artifact-editor/rating-section", () => ({
  RatingSection: () => (
    <div data-testid="rating-section">Rating Section Mock</div>
  ),
}));

// Regex patterns for testing (hoisted to module level per Biome lint rules)
const VERSION_PATTERN = /version: v1/i;
const CREATED_PATTERN = /created:/i;
const UPDATED_PATTERN = /updated:/i;
const GITHUB_WORKFLOW_PATTERN = /view github workflow/i;
const PR_NUMBER_PATTERN = /#42:/i;
const PR_TITLE_PATTERN = /add new feature/i;

const defaultProps = {
  plan: createMockArtifact({ type: "IMPLEMENTATION_PLAN" }),
  status: "DRAFT" as ArtifactStatus,
  approver: "",
  owner: null,
  teamMembers: [],
  generationStatus: null,
  pullRequest: null,
  previewDeployment: null,
  onPreviewRefresh: vi.fn().mockResolvedValue(null),
  isPreviewRefreshing: false,
  judgesReport: null,
  onStatusChange: vi.fn(),
  onApproverChange: vi.fn(),
  onApproverBlur: vi.fn(),
  onOwnerChange: vi.fn(),
};

describe("sortMetricsByScore", () => {
  test("sorts metrics by score in ascending order (worst first)", () => {
    const metrics = [
      createMockMetric("High Score", 0.95),
      createMockMetric("Low Score", 0.3),
      createMockMetric("Medium Score", 0.7),
    ];

    const sorted = sortMetricsByScore(metrics);

    expect(sorted[0].metric_name).toBe("Low Score");
    expect(sorted[0].score).toBe(0.3);
    expect(sorted[1].metric_name).toBe("Medium Score");
    expect(sorted[1].score).toBe(0.7);
    expect(sorted[2].metric_name).toBe("High Score");
    expect(sorted[2].score).toBe(0.95);
  });

  test("handles metrics with same score (stable sort)", () => {
    const metrics = [
      createMockMetric("First", 0.8),
      createMockMetric("Second", 0.8),
      createMockMetric("Third", 0.8),
    ];

    const sorted = sortMetricsByScore(metrics);

    expect(sorted).toHaveLength(3);
    // All have same score, order should be preserved
    expect(sorted.map((m) => m.metric_name)).toEqual([
      "First",
      "Second",
      "Third",
    ]);
  });

  test("handles single metric", () => {
    const metrics = [createMockMetric("Only Metric", 0.5)];

    const sorted = sortMetricsByScore(metrics);

    expect(sorted).toHaveLength(1);
    expect(sorted[0].metric_name).toBe("Only Metric");
  });

  test("handles empty array", () => {
    const sorted = sortMetricsByScore([]);
    expect(sorted).toHaveLength(0);
  });
});

describe("calculateAcceptanceRate", () => {
  test("returns 100% when all metrics pass threshold", () => {
    const metrics = [
      createMockMetric("Accuracy", 0.9, { threshold: 0.7 }),
      createMockMetric("Completeness", 0.8, { threshold: 0.7 }),
    ];

    const result = calculateAcceptanceRate(metrics);

    expect(result.acceptedCount).toBe(2);
    expect(result.totalCount).toBe(2);
    expect(result.rate).toBe(100);
  });

  test("calculates correct rate when some metrics fail", () => {
    const metrics = [
      createMockMetric("Passing", 0.8, { threshold: 0.7 }),
      createMockMetric("Failing", 0.5, { threshold: 0.7 }),
      createMockMetric("Also Passing", 0.75, { threshold: 0.7 }),
    ];

    const result = calculateAcceptanceRate(metrics);

    expect(result.acceptedCount).toBe(2);
    expect(result.totalCount).toBe(3);
    expect(result.rate).toBeCloseTo(66.67, 1);
  });

  test("returns 0% when all metrics fail", () => {
    const metrics = [
      createMockMetric("Failing1", 0.3, { threshold: 0.7 }),
      createMockMetric("Failing2", 0.4, { threshold: 0.7 }),
    ];

    const result = calculateAcceptanceRate(metrics);

    expect(result.acceptedCount).toBe(0);
    expect(result.totalCount).toBe(2);
    expect(result.rate).toBe(0);
  });

  test("handles edge case: metric equals threshold (passes)", () => {
    const metrics = [
      createMockMetric("Exactly Threshold", 0.7, { threshold: 0.7 }),
    ];

    const result = calculateAcceptanceRate(metrics);

    expect(result.acceptedCount).toBe(1);
    expect(result.totalCount).toBe(1);
    expect(result.rate).toBe(100);
  });

  test("handles undefined metrics", () => {
    const result = calculateAcceptanceRate(undefined);

    expect(result.acceptedCount).toBe(0);
    expect(result.totalCount).toBe(0);
    expect(result.rate).toBe(0);
  });

  test("handles empty metrics array", () => {
    const result = calculateAcceptanceRate([]);

    expect(result.acceptedCount).toBe(0);
    expect(result.totalCount).toBe(0);
    expect(result.rate).toBe(0);
  });

  test("handles zero threshold (still counts toward total)", () => {
    const metrics = [
      createMockMetric("With Threshold", 0.8, { threshold: 0.7 }),
      createMockMetric("Zero Threshold", 0.9, { threshold: 0 }),
    ];

    const result = calculateAcceptanceRate(metrics);

    // Both metrics should pass (0.9 >= 0 and 0.8 >= 0.7)
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
    test("renders all collapsible sections: Properties, Execution Log, Evaluation, and Comments", () => {
      render(<PlanMetadataPanel {...defaultProps} />);

      // Check for collapsible section headings
      expect(screen.getByText("Properties")).toBeDefined();
      expect(screen.getByText("Execution Log")).toBeDefined();
      expect(screen.getByText("Evaluation")).toBeDefined();
      expect(screen.getByText("Comments")).toBeDefined();
    });

    test("Properties section is expanded by default", () => {
      render(<PlanMetadataPanel {...defaultProps} />);

      // Properties section content should be visible (StatusMetadataSection is rendered)
      expect(screen.getByTestId("status-metadata-section")).toBeDefined();
    });
  });

  describe("Details tab content", () => {
    test("renders StatusMetadataSection", () => {
      render(<PlanMetadataPanel {...defaultProps} />);
      expect(screen.getByTestId("status-metadata-section")).toBeDefined();
    });

    test("displays version information", () => {
      render(<PlanMetadataPanel {...defaultProps} />);
      expect(screen.getByText(VERSION_PATTERN)).toBeDefined();
    });

    test("displays created and updated dates", () => {
      render(<PlanMetadataPanel {...defaultProps} />);
      expect(screen.getByText(CREATED_PATTERN)).toBeDefined();
      expect(screen.getByText(UPDATED_PATTERN)).toBeDefined();
    });

    test("displays GitHub workflow link when generationStatus has htmlUrl", () => {
      render(
        <PlanMetadataPanel
          {...defaultProps}
          generationStatus={createMockGenerationStatus()}
        />
      );
      expect(screen.getByText(GITHUB_WORKFLOW_PATTERN)).toBeDefined();
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
});
