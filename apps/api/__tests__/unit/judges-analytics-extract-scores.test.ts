/**
 * Unit tests for extractJudgeScores — the pure aggregation function that
 * converts raw evaluation records into a nested Map keyed by
 * ArtifactSubtype → judgeName → { scores, artifactIds }.
 *
 * Uses scenario-registry pattern with describe.each for parametrized execution.
 */
import { ArtifactSubtype } from "@repo/api/src/types/artifact";
import { vi } from "vitest";

vi.mock("@repo/database", async () => {
  const { createDatabaseMock } = await import("../fixtures/database-mock");
  return createDatabaseMock();
});

import {
  type EvaluationInput,
  extractJudgeScores,
} from "@/app/judges-analytics/service";
import { buildCaseScore, buildMetric } from "../fixtures/evaluation";

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

/** Builds an EvaluationInput ready for extractJudgeScores. */
function buildEvaluation(
  artifactId: string,
  subtype: ArtifactSubtype,
  reportData: unknown
): EvaluationInput {
  return { artifactId, artifact: { subtype }, reportData };
}

// ---------------------------------------------------------------------------
// Result assertion helpers
// ---------------------------------------------------------------------------

type FlatResult = {
  subtype: ArtifactSubtype;
  judgeName: string;
  scores: number[];
  artifactIds: string[];
};

/**
 * Converts the nested Map returned by extractJudgeScores into a flat, sorted
 * array so deep equality assertions are order-insensitive and readable.
 */
function flattenResults(
  map: Map<
    ArtifactSubtype,
    Map<string, { scores: number[]; artifactIds: Set<string> }>
  >
): FlatResult[] {
  const flat: FlatResult[] = [];
  for (const [subtype, judgeMap] of map) {
    for (const [judgeName, data] of judgeMap) {
      flat.push({
        subtype,
        judgeName,
        scores: [...data.scores],
        artifactIds: [...data.artifactIds].sort(),
      });
    }
  }
  return flat.sort((a, b) =>
    a.subtype === b.subtype
      ? a.judgeName.localeCompare(b.judgeName)
      : a.subtype.localeCompare(b.subtype)
  );
}

// ---------------------------------------------------------------------------
// Scenario registry
// ---------------------------------------------------------------------------

type ScenarioConfig = {
  name: string;
  description: string;
  evaluations: EvaluationInput[];
  expected: FlatResult[];
};

const SCENARIO_REGISTRY: ScenarioConfig[] = [
  // 1. Base case
  {
    name: "empty_evaluations",
    description: "Returns an empty Map when given no evaluations",
    evaluations: [],
    expected: [],
  },

  // 2. Invalid reportData variants
  {
    name: "invalid_report_data_skipped",
    description:
      "Evaluations with null, non-object, or stats-missing reportData are silently skipped",
    evaluations: [
      buildEvaluation("a1", ArtifactSubtype.Prd, null),
      buildEvaluation("a2", ArtifactSubtype.Prd, "not-an-object"),
      buildEvaluation("a3", ArtifactSubtype.Prd, { noStats: true }),
      buildEvaluation("a4", ArtifactSubtype.Prd, { stats: "not-an-array" }),
    ],
    expected: [],
  },

  // 3. No matching metric
  {
    name: "no_matching_metric_skipped",
    description:
      "CaseScore whose metrics do not include a metric_name matching case_id is skipped",
    evaluations: [
      buildEvaluation("a1", ArtifactSubtype.Prd, {
        report_id: "r1",
        timestamp: "2026-01-01T00:00:00Z",
        stats: [
          {
            type: "case_score",
            case_id: "judge-A",
            final_status: 3,
            metrics: [
              buildMetric({
                metric_name: "completely_different_name",
                score: 0.9,
              }),
            ],
          },
        ],
      }),
    ],
    expected: [],
  },

  // 4. Happy path — single evaluation, single judge
  {
    name: "single_evaluation_single_judge",
    description:
      "One evaluation with one matching metric produces a single Map entry",
    evaluations: [
      buildEvaluation("a1", ArtifactSubtype.Prd, {
        report_id: "r1",
        timestamp: "2026-01-01T00:00:00Z",
        stats: [buildCaseScore("judge-A", 0.85)],
      }),
    ],
    expected: [
      {
        subtype: ArtifactSubtype.Prd,
        judgeName: "judge-A",
        scores: [0.85],
        artifactIds: ["a1"],
      },
    ],
  },

  // 5. Multiple evaluations — same subtype, same judge
  {
    name: "multiple_evaluations_same_subtype_same_judge",
    description:
      "Scores accumulate and artifact IDs are de-duplicated within the same judge",
    evaluations: [
      buildEvaluation("a1", ArtifactSubtype.Issue, {
        report_id: "r1",
        timestamp: "2026-01-01T00:00:00Z",
        stats: [buildCaseScore("judge-B", 0.7)],
      }),
      buildEvaluation("a2", ArtifactSubtype.Issue, {
        report_id: "r2",
        timestamp: "2026-01-02T00:00:00Z",
        stats: [buildCaseScore("judge-B", 0.9)],
      }),
      // Duplicate artifact ID — should NOT duplicate in artifactIds set
      buildEvaluation("a1", ArtifactSubtype.Issue, {
        report_id: "r3",
        timestamp: "2026-01-03T00:00:00Z",
        stats: [buildCaseScore("judge-B", 0.6)],
      }),
    ],
    expected: [
      {
        subtype: ArtifactSubtype.Issue,
        judgeName: "judge-B",
        scores: [0.7, 0.9, 0.6],
        artifactIds: ["a1", "a2"],
      },
    ],
  },

  // 6. Multiple subtypes and judges
  {
    name: "multiple_subtypes_and_judges",
    description:
      "Evaluations spanning different subtypes and judges produce correctly partitioned Map entries",
    evaluations: [
      buildEvaluation("a1", ArtifactSubtype.Prd, {
        report_id: "r1",
        timestamp: "2026-01-01T00:00:00Z",
        stats: [
          buildCaseScore("judge-A", 0.8),
          buildCaseScore("judge-B", 0.75),
        ],
      }),
      buildEvaluation("a2", ArtifactSubtype.ImplementationPlan, {
        report_id: "r2",
        timestamp: "2026-01-02T00:00:00Z",
        stats: [buildCaseScore("judge-A", 0.9)],
      }),
    ],
    expected: [
      {
        subtype: ArtifactSubtype.ImplementationPlan,
        judgeName: "judge-A",
        scores: [0.9],
        artifactIds: ["a2"],
      },
      {
        subtype: ArtifactSubtype.Prd,
        judgeName: "judge-A",
        scores: [0.8],
        artifactIds: ["a1"],
      },
      {
        subtype: ArtifactSubtype.Prd,
        judgeName: "judge-B",
        scores: [0.75],
        artifactIds: ["a1"],
      },
    ],
  },

  // 7. Mixed valid and invalid
  {
    name: "mixed_valid_and_invalid_evaluations",
    description:
      "Only valid evaluations contribute to results when mixed with invalid ones",
    evaluations: [
      // Invalid — null reportData
      buildEvaluation("a1", ArtifactSubtype.Prd, null),
      // Valid
      buildEvaluation("a2", ArtifactSubtype.Prd, {
        report_id: "r1",
        timestamp: "2026-01-01T00:00:00Z",
        stats: [buildCaseScore("judge-A", 0.95)],
      }),
      // Invalid — no matching metric
      buildEvaluation("a3", ArtifactSubtype.Issue, {
        report_id: "r2",
        timestamp: "2026-01-01T00:00:00Z",
        stats: [
          {
            type: "case_score",
            case_id: "judge-X",
            final_status: 3,
            metrics: [buildMetric({ metric_name: "wrong_name", score: 0.5 })],
          },
        ],
      }),
      // Valid
      buildEvaluation("a4", ArtifactSubtype.Issue, {
        report_id: "r3",
        timestamp: "2026-01-01T00:00:00Z",
        stats: [buildCaseScore("judge-C", 0.88)],
      }),
    ],
    expected: [
      {
        subtype: ArtifactSubtype.Issue,
        judgeName: "judge-C",
        scores: [0.88],
        artifactIds: ["a4"],
      },
      {
        subtype: ArtifactSubtype.Prd,
        judgeName: "judge-A",
        scores: [0.95],
        artifactIds: ["a2"],
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Parametrized test
// ---------------------------------------------------------------------------

describe("extractJudgeScores", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe.each(SCENARIO_REGISTRY)("$name", (scenario) => {
    it(scenario.description, () => {
      const result = extractJudgeScores(scenario.evaluations);
      const flat = flattenResults(result);
      expect(flat).toEqual(scenario.expected);
    });
  });
});
