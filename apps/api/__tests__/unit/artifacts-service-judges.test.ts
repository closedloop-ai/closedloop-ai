/**
 * Unit tests for artifactsService.getJudgesFeedback method.
 *
 * Tests querying ArtifactEvaluation table for stored judges report.
 *
 * Uses scenario registry pattern for maintainable, DRY test structure.
 */
import type {
  JudgesFeedbackResponse,
  JudgesReport,
} from "@repo/api/src/types/evaluation";
import { type Mock, vi } from "vitest";

// Mock modules before importing the service
vi.mock("@repo/database", () => ({
  withDb: vi.fn(),
}));

// Import after mocking
import { withDb } from "@repo/database";
import { artifactsService } from "@/app/artifacts/service";
import { createMockEvaluationRow } from "../fixtures/evaluation";

// Type alias for mocked function
const mockWithDb = withDb as unknown as Mock;

// Sample mock data matching JudgesReport structure
const MOCK_JUDGES_REPORT: JudgesReport = {
  report_id: "test-report",
  timestamp: "2026-02-05T00:00:00Z",
  stats: [
    {
      type: "case_score",
      case_id: "test-judge",
      final_status: 1,
      metrics: [
        {
          metric_name: "test_score",
          threshold: 0.8,
          score: 0.95,
          justification: "Test justification",
        },
      ],
    },
  ],
};

/**
 * Scenario configuration for parametrized testing.
 */
type ScenarioConfig = {
  name: string;
  description: string;
  setupMocks: () => void;
  expectedResult: JudgesFeedbackResponse;
};

/**
 * Scenario registry containing all test cases.
 * Each scenario defines mock setup and expected result.
 */
const SCENARIO_REGISTRY: ScenarioConfig[] = [
  {
    name: "db_success_returns_report",
    description: "Happy path through database returns stored report",
    setupMocks: () => {
      // Mock findByIdSimple to return artifact
      vi.spyOn(artifactsService, "findByIdSimple").mockResolvedValue({
        id: "artifact-123",
      } as any);
      // Mock withDb to return evaluation row
      mockWithDb.mockImplementation((callback: any) => {
        const mockDb = {
          artifactEvaluation: {
            findFirst: vi.fn().mockResolvedValue(
              createMockEvaluationRow({
                artifactId: "artifact-123",
                reportData: MOCK_JUDGES_REPORT,
              })
            ),
          },
        };
        return callback(mockDb);
      });
    },
    expectedResult: { status: "success", data: MOCK_JUDGES_REPORT },
  },
  {
    name: "no_evaluation_returns_not_found",
    description:
      "When no evaluation exists in database, returns not_found status",
    setupMocks: () => {
      // Mock findByIdSimple to return artifact
      vi.spyOn(artifactsService, "findByIdSimple").mockResolvedValue({
        id: "artifact-123",
      } as any);
      // Mock withDb to return null (no evaluation)
      mockWithDb.mockImplementation((callback: any) => {
        const mockDb = {
          artifactEvaluation: {
            findFirst: vi.fn().mockResolvedValue(null),
          },
        };
        return callback(mockDb);
      });
    },
    expectedResult: { status: "not_found", data: null },
  },
  {
    name: "artifact_not_found_returns_not_found",
    description: "When artifact does not exist, returns not_found status",
    setupMocks: () => {
      // Mock findByIdSimple to return null
      vi.spyOn(artifactsService, "findByIdSimple").mockResolvedValue(null);
    },
    expectedResult: { status: "not_found", data: null },
  },
];

describe("artifactsService.getJudgesFeedback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Parametrized test using scenario registry
  describe.each(SCENARIO_REGISTRY)("$name", (scenario) => {
    it(scenario.description, async () => {
      // Setup mocks for this scenario
      scenario.setupMocks();

      // Execute
      const result = await artifactsService.getJudgesFeedback(
        "artifact-123",
        "org-123"
      );

      // Assert
      expect(result).toEqual(scenario.expectedResult);
    });
  });
});
