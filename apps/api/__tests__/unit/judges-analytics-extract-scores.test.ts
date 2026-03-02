/**
 * Unit tests for aggregateJudgeScoreRows -- the pure aggregation function that
 * converts JudgeScore rows into a nested Map keyed by
 * ArtifactType -> caseId -> { scores, artifactIds }.
 *
 * Uses scenario-registry pattern with describe.each for parametrized execution.
 */
import { ArtifactType } from "@repo/api/src/types/artifact";
import { vi } from "vitest";

vi.mock("@repo/database", async () => {
  const { createDatabaseMock } = await import("../fixtures/database-mock");
  return createDatabaseMock();
});

import {
  aggregateJudgeScoreRows,
  type JudgeScoreInput,
} from "@/app/judges-analytics/service";
import { normalizeJudgeName } from "@/lib/judge-name-utils";

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

/** Builds a JudgeScoreInput ready for aggregateJudgeScoreRows. */
function buildJudgeScoreInput(
  artifactId: string,
  type: ArtifactType,
  caseId: string,
  score: number
): JudgeScoreInput {
  return {
    caseId,
    score,
    evaluation: {
      artifactId,
      artifact: { type },
    },
  };
}

// ---------------------------------------------------------------------------
// Result assertion helpers
// ---------------------------------------------------------------------------

type FlatResult = {
  type: ArtifactType;
  judgeName: string;
  scores: number[];
  artifactIds: string[];
};

/**
 * Converts the nested Map returned by aggregateJudgeScoreRows into a flat, sorted
 * array so deep equality assertions are order-insensitive and readable.
 */
function flattenResults(
  map: Map<
    ArtifactType,
    Map<string, { scores: number[]; artifactIds: Set<string> }>
  >
): FlatResult[] {
  const flat: FlatResult[] = [];
  for (const [type, judgeMap] of map) {
    for (const [judgeName, data] of judgeMap) {
      flat.push({
        type,
        judgeName,
        scores: [...data.scores],
        artifactIds: [...data.artifactIds].sort(),
      });
    }
  }
  return flat.sort((a, b) =>
    a.type === b.type
      ? a.judgeName.localeCompare(b.judgeName)
      : a.type.localeCompare(b.type)
  );
}

// ---------------------------------------------------------------------------
// Scenario registry
// ---------------------------------------------------------------------------

type ScenarioConfig = {
  name: string;
  description: string;
  judgeScores: JudgeScoreInput[];
  expected: FlatResult[];
};

const SCENARIO_REGISTRY: ScenarioConfig[] = [
  // 1. Base case
  {
    name: "empty_judge_scores",
    description: "Returns an empty Map when given no judge score rows",
    judgeScores: [],
    expected: [],
  },

  // 2. Happy path -- single row, single judge
  {
    name: "single_row_single_judge",
    description: "One JudgeScore row produces a single Map entry",
    judgeScores: [
      buildJudgeScoreInput("a1", ArtifactType.Prd, "judge-A", 0.85),
    ],
    expected: [
      {
        type: ArtifactType.Prd,
        judgeName: "judge-A",
        scores: [0.85],
        artifactIds: ["a1"],
      },
    ],
  },

  // 3. Multiple rows -- same type, same judge
  {
    name: "multiple_rows_same_type_same_judge",
    description:
      "Scores accumulate and artifact IDs are de-duplicated within the same judge",
    judgeScores: [
      buildJudgeScoreInput(
        "a1",
        ArtifactType.ImplementationPlan,
        "judge-B",
        0.7
      ),
      buildJudgeScoreInput(
        "a2",
        ArtifactType.ImplementationPlan,
        "judge-B",
        0.9
      ),
      // Duplicate artifact ID -- should NOT duplicate in artifactIds set
      buildJudgeScoreInput(
        "a1",
        ArtifactType.ImplementationPlan,
        "judge-B",
        0.6
      ),
    ],
    expected: [
      {
        type: ArtifactType.ImplementationPlan,
        judgeName: "judge-B",
        scores: [0.7, 0.9, 0.6],
        artifactIds: ["a1", "a2"],
      },
    ],
  },

  // 4. Multiple types and judges
  {
    name: "multiple_types_and_judges",
    description:
      "Rows spanning different types and judges produce correctly partitioned Map entries",
    judgeScores: [
      buildJudgeScoreInput("a1", ArtifactType.Prd, "judge-A", 0.8),
      buildJudgeScoreInput("a1", ArtifactType.Prd, "judge-B", 0.75),
      buildJudgeScoreInput(
        "a2",
        ArtifactType.ImplementationPlan,
        "judge-A",
        0.9
      ),
    ],
    expected: [
      {
        type: ArtifactType.ImplementationPlan,
        judgeName: "judge-A",
        scores: [0.9],
        artifactIds: ["a2"],
      },
      {
        type: ArtifactType.Prd,
        judgeName: "judge-A",
        scores: [0.8],
        artifactIds: ["a1"],
      },
      {
        type: ArtifactType.Prd,
        judgeName: "judge-B",
        scores: [0.75],
        artifactIds: ["a1"],
      },
    ],
  },

  // 5. Production-style naming (case IDs as-is)
  {
    name: "realistic_production_naming",
    description:
      "Production-style case IDs (dry-judge, solid-isp-dip-judge) are used as-is for judge names",
    judgeScores: [
      buildJudgeScoreInput("a1", ArtifactType.Prd, "dry-judge", 0.92),
      buildJudgeScoreInput("a1", ArtifactType.Prd, "solid-isp-dip-judge", 0.87),
    ],
    expected: [
      {
        type: ArtifactType.Prd,
        judgeName: "dry-judge",
        scores: [0.92],
        artifactIds: ["a1"],
      },
      {
        type: ArtifactType.Prd,
        judgeName: "solid-isp-dip-judge",
        scores: [0.87],
        artifactIds: ["a1"],
      },
    ],
  },

  // 6. Same judge, multiple artifacts
  {
    name: "same_judge_multiple_artifacts",
    description:
      "Multiple artifacts with the same judge accumulate correctly with unique artifact IDs",
    judgeScores: [
      buildJudgeScoreInput(
        "a1",
        ArtifactType.ImplementationPlan,
        "clarity-judge",
        0.8
      ),
      buildJudgeScoreInput(
        "a2",
        ArtifactType.ImplementationPlan,
        "clarity-judge",
        0.9
      ),
      buildJudgeScoreInput(
        "a3",
        ArtifactType.ImplementationPlan,
        "clarity-judge",
        0.7
      ),
    ],
    expected: [
      {
        type: ArtifactType.ImplementationPlan,
        judgeName: "clarity-judge",
        scores: [0.8, 0.9, 0.7],
        artifactIds: ["a1", "a2", "a3"],
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Parametrized test
// ---------------------------------------------------------------------------

describe("aggregateJudgeScoreRows", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe.each(SCENARIO_REGISTRY)("$name", (scenario) => {
    it(scenario.description, () => {
      const result = aggregateJudgeScoreRows(scenario.judgeScores);
      const flat = flattenResults(result);
      expect(flat).toEqual(scenario.expected);
    });
  });
});

describe("normalizeJudgeName", () => {
  const NORMALIZATION_TEST_CASES = {
    "hyphen-suffix": ["clarity-judge", "clarity"],
    "underscore-judge-suffix": ["brevity_judge", "brevity"],
    "uppercase-with-suffix": ["Clarity-Judge", "clarity"],
    "score-suffix": ["clarity_score", "clarity"],
    "hyphen-score-suffix": ["clarity-score", "clarity"],
    "multi-word-hyphenated": ["dry-judge", "dry"],
    "complex-hyphenated": ["solid-isp-dip-judge", "solid_isp_dip"],
    "no-suffix": ["clarity", "clarity"],
  } as const satisfies Record<string, readonly [string, string]>;

  it.each(
    Object.entries(NORMALIZATION_TEST_CASES)
  )("%s: normalizeJudgeName(%p) → %p", (_, [input, expected]) => {
    expect(normalizeJudgeName(input)).toBe(expected);
  });
});
