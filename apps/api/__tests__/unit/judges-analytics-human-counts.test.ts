/**
 * Unit tests for getHumanCountsByType and getHumanRatingsByArtifact.
 *
 * Uses scenario-registry pattern with describe.each for parametrized execution.
 */
import { ArtifactType } from "@repo/api/src/types/artifact";
import { vi } from "vitest";

vi.mock("@repo/database", () => ({
  withDb: vi.fn(),
}));

import { withDb } from "@repo/database";
import {
  getHumanCountsByType,
  getHumanRatingsByArtifact,
} from "@/app/judges-analytics/service";

// ---------------------------------------------------------------------------
// Helper types
// ---------------------------------------------------------------------------

type ArtifactRow = { id: string; type: ArtifactType };
type RatingRow = { artifactId: string; comment: string | null };

type CountScenarioConfig = {
  name: string;
  description: string;
  organizationId: string;
  startDate: Date;
  endDate: Date;
  types: ArtifactType[];
  artifacts: ArtifactRow[];
  ratings: RatingRow[];
  expectedRatings: Record<string, number>;
  expectedComments: Record<string, number>;
};

/** Converts Map to plain object for stable equality assertions. */
function mapToObject(m: Map<string, number>): Record<string, number> {
  return Object.fromEntries(m);
}

// ---------------------------------------------------------------------------
// getHumanCountsByType scenarios
// ---------------------------------------------------------------------------

const COUNT_SCENARIOS: CountScenarioConfig[] = [
  {
    name: "empty_types",
    description: "Empty types returns empty maps",
    organizationId: "org-1",
    startDate: new Date("2026-01-01"),
    endDate: new Date("2026-01-31"),
    types: [],
    artifacts: [],
    ratings: [],
    expectedRatings: {},
    expectedComments: {},
  },
  {
    name: "no_artifacts_in_org",
    description: "No artifacts yields zeros for all types",
    organizationId: "org-1",
    startDate: new Date("2026-01-01"),
    endDate: new Date("2026-01-31"),
    types: [ArtifactType.Prd],
    artifacts: [],
    ratings: [],
    expectedRatings: { [ArtifactType.Prd]: 0 },
    expectedComments: { [ArtifactType.Prd]: 0 },
  },
  {
    name: "artifacts_exist_no_ratings_in_range",
    description: "Artifacts but no ratings in range yields zeros",
    organizationId: "org-1",
    startDate: new Date("2026-01-01"),
    endDate: new Date("2026-01-31"),
    types: [ArtifactType.Prd],
    artifacts: [{ id: "a1", type: ArtifactType.Prd }],
    ratings: [],
    expectedRatings: { [ArtifactType.Prd]: 0 },
    expectedComments: { [ArtifactType.Prd]: 0 },
  },
  {
    name: "single_rating_with_comment",
    description: "One rating with comment increments both counts",
    organizationId: "org-1",
    startDate: new Date("2026-01-01"),
    endDate: new Date("2026-01-31"),
    types: [ArtifactType.Prd],
    artifacts: [{ id: "a1", type: ArtifactType.Prd }],
    ratings: [{ artifactId: "a1", comment: "Looks good" }],
    expectedRatings: { [ArtifactType.Prd]: 1 },
    expectedComments: { [ArtifactType.Prd]: 1 },
  },
  {
    name: "rating_without_comment",
    description: "Rating with null comment only increments ratings count",
    organizationId: "org-1",
    startDate: new Date("2026-01-01"),
    endDate: new Date("2026-01-31"),
    types: [ArtifactType.Prd],
    artifacts: [{ id: "a1", type: ArtifactType.Prd }],
    ratings: [{ artifactId: "a1", comment: null }],
    expectedRatings: { [ArtifactType.Prd]: 1 },
    expectedComments: { [ArtifactType.Prd]: 0 },
  },
  {
    name: "rating_with_empty_comment",
    description:
      "Rating with empty/whitespace comment only increments ratings count",
    organizationId: "org-1",
    startDate: new Date("2026-01-01"),
    endDate: new Date("2026-01-31"),
    types: [ArtifactType.Prd],
    artifacts: [{ id: "a1", type: ArtifactType.Prd }],
    ratings: [{ artifactId: "a1", comment: "   " }],
    expectedRatings: { [ArtifactType.Prd]: 1 },
    expectedComments: { [ArtifactType.Prd]: 0 },
  },
  {
    name: "multiple_types_partitioned",
    description: "Ratings counted in correct type buckets",
    organizationId: "org-1",
    startDate: new Date("2026-01-01"),
    endDate: new Date("2026-01-31"),
    types: [ArtifactType.Prd, ArtifactType.ImplementationPlan],
    artifacts: [
      { id: "a1", type: ArtifactType.Prd },
      { id: "a2", type: ArtifactType.ImplementationPlan },
    ],
    ratings: [
      { artifactId: "a1", comment: "PRD feedback" },
      { artifactId: "a2", comment: "Plan feedback" },
      { artifactId: "a1", comment: "Another PRD comment" },
    ],
    expectedRatings: {
      [ArtifactType.Prd]: 2,
      [ArtifactType.ImplementationPlan]: 1,
    },
    expectedComments: {
      [ArtifactType.Prd]: 2,
      [ArtifactType.ImplementationPlan]: 1,
    },
  },
];

describe("getHumanCountsByType", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe.each(COUNT_SCENARIOS)("$name", (scenario) => {
    it(scenario.description, async () => {
      const mockDb = {
        artifact: { findMany: vi.fn().mockResolvedValue(scenario.artifacts) },
        artifactRating: {
          findMany: vi.fn().mockResolvedValue(scenario.ratings),
        },
      };
      vi.mocked(withDb).mockImplementation((callback) =>
        Promise.resolve(
          callback(
            mockDb as unknown as Parameters<Parameters<typeof withDb>[0]>[0]
          )
        )
      );

      const { humanRatingsByType, humanCommentsByType } =
        await getHumanCountsByType(
          scenario.organizationId,
          scenario.startDate,
          scenario.endDate,
          scenario.types
        );

      expect(mapToObject(humanRatingsByType as Map<string, number>)).toEqual(
        scenario.expectedRatings
      );
      expect(mapToObject(humanCommentsByType as Map<string, number>)).toEqual(
        scenario.expectedComments
      );
    });
  });
});

// ---------------------------------------------------------------------------
// getHumanRatingsByArtifact scenarios
// ---------------------------------------------------------------------------

type ScoreRatingRow = { artifactId: string; score: number };
type ScoreScenario = {
  name: string;
  description: string;
  ratings: ScoreRatingRow[];
  artifactIds: string[];
  expected: Record<string, number>;
};

const SCORE_SCENARIOS: ScoreScenario[] = [
  {
    name: "empty_artifacts",
    description: "No artifact IDs returns empty map",
    ratings: [],
    artifactIds: [],
    expected: {},
  },
  {
    name: "no_ratings",
    description: "Artifacts with no ratings returns empty map",
    ratings: [],
    artifactIds: ["a1"],
    expected: {},
  },
  {
    name: "single_rating_score_3",
    description: "Single rating score=3 yields 0.6 (3/5)",
    ratings: [{ artifactId: "a1", score: 3 }],
    artifactIds: ["a1"],
    expected: { a1: 0.6 },
  },
  {
    name: "min_score",
    description: "score=1 yields 0.2 (1/5)",
    ratings: [{ artifactId: "a1", score: 1 }],
    artifactIds: ["a1"],
    expected: { a1: 0.2 },
  },
  {
    name: "max_score",
    description: "score=5 yields 1.0 (5/5)",
    ratings: [{ artifactId: "a1", score: 5 }],
    artifactIds: ["a1"],
    expected: { a1: 1.0 },
  },
  {
    name: "multiple_ratings_same_artifact",
    description:
      "Two ratings scores 2,4 on same artifact: avg = (2/5 + 4/5)/2 = 0.6",
    ratings: [
      { artifactId: "a1", score: 2 },
      { artifactId: "a1", score: 4 },
    ],
    artifactIds: ["a1"],
    expected: { a1: 0.6 },
  },
  {
    name: "multiple_artifacts",
    description: "Different artifacts get independent scores",
    ratings: [
      { artifactId: "a1", score: 5 },
      { artifactId: "a2", score: 1 },
    ],
    artifactIds: ["a1", "a2"],
    expected: { a1: 1.0, a2: 0.2 },
  },
];

describe("getHumanRatingsByArtifact", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe.each(SCORE_SCENARIOS)("$name", (scenario) => {
    it(scenario.description, async () => {
      const mockDb = {
        artifactRating: {
          findMany: vi.fn().mockResolvedValue(scenario.ratings),
        },
      };
      vi.mocked(withDb).mockImplementation((callback) =>
        Promise.resolve(
          callback(
            mockDb as unknown as Parameters<Parameters<typeof withDb>[0]>[0]
          )
        )
      );

      const result = await getHumanRatingsByArtifact(
        "org-1",
        new Date("2026-01-01"),
        new Date("2026-01-31"),
        scenario.artifactIds
      );

      const actual = Object.fromEntries(result);
      for (const [key, expectedVal] of Object.entries(scenario.expected)) {
        expect(actual[key]).toBeCloseTo(expectedVal, 10);
      }
      expect(Object.keys(actual)).toHaveLength(
        Object.keys(scenario.expected).length
      );
    });
  });
});
