/**
 * Unit tests for getHumanCountsByType -- fetches human ratings and comments
 * counts per artifact type within an org and date range.
 *
 * Uses scenario-registry pattern with describe.each for parametrized execution.
 */
import { ArtifactType } from "@repo/api/src/types/artifact";
import { vi } from "vitest";

vi.mock("@repo/database", () => ({
  withDb: vi.fn(),
}));

import { withDb } from "@repo/database";
import { getHumanCountsByType } from "@/app/judges-analytics/service";

// ---------------------------------------------------------------------------
// Helper types
// ---------------------------------------------------------------------------

type ArtifactRow = { id: string; type: ArtifactType };
type RatingRow = { artifactId: string; comment: string | null; score: number };

type ScenarioConfig = {
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
  expectedRatingScoreByType: Record<string, number | null>;
};

/** Converts Map to plain object for stable equality assertions. */
function mapToObject(
  m: Map<string, number | null> | Map<string, number>
): Record<string, number | null> {
  return Object.fromEntries(m);
}

// ---------------------------------------------------------------------------
// Scenario registry
// ---------------------------------------------------------------------------

const SCENARIO_REGISTRY: ScenarioConfig[] = [
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
    expectedRatingScoreByType: {},
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
    expectedRatingScoreByType: {},
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
    expectedRatingScoreByType: {},
  },
  {
    name: "single_rating_with_comment",
    description: "One rating with comment increments both counts",
    organizationId: "org-1",
    startDate: new Date("2026-01-01"),
    endDate: new Date("2026-01-31"),
    types: [ArtifactType.Prd],
    artifacts: [{ id: "a1", type: ArtifactType.Prd }],
    ratings: [{ artifactId: "a1", comment: "Looks good", score: 3 }],
    expectedRatings: { [ArtifactType.Prd]: 1 },
    expectedComments: { [ArtifactType.Prd]: 1 },
    expectedRatingScoreByType: { [ArtifactType.Prd]: 0.6 },
  },
  {
    name: "rating_without_comment",
    description: "Rating with null comment only increments ratings count",
    organizationId: "org-1",
    startDate: new Date("2026-01-01"),
    endDate: new Date("2026-01-31"),
    types: [ArtifactType.Prd],
    artifacts: [{ id: "a1", type: ArtifactType.Prd }],
    ratings: [{ artifactId: "a1", comment: null, score: 3 }],
    expectedRatings: { [ArtifactType.Prd]: 1 },
    expectedComments: { [ArtifactType.Prd]: 0 },
    expectedRatingScoreByType: { [ArtifactType.Prd]: 0.6 },
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
    ratings: [{ artifactId: "a1", comment: "   ", score: 3 }],
    expectedRatings: { [ArtifactType.Prd]: 1 },
    expectedComments: { [ArtifactType.Prd]: 0 },
    expectedRatingScoreByType: { [ArtifactType.Prd]: 0.6 },
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
      { artifactId: "a1", comment: "PRD feedback", score: 3 },
      { artifactId: "a2", comment: "Plan feedback", score: 3 },
      { artifactId: "a1", comment: "Another PRD comment", score: 3 },
    ],
    expectedRatings: {
      [ArtifactType.Prd]: 2,
      [ArtifactType.ImplementationPlan]: 1,
    },
    expectedComments: {
      [ArtifactType.Prd]: 2,
      [ArtifactType.ImplementationPlan]: 1,
    },
    expectedRatingScoreByType: {
      [ArtifactType.Prd]: 0.6,
      [ArtifactType.ImplementationPlan]: 0.6,
    },
  },
  {
    name: "single_rating_min_score",
    description: "PRD formula boundary: score=1 yields 0.2 average",
    organizationId: "org-1",
    startDate: new Date("2026-01-01"),
    endDate: new Date("2026-01-31"),
    types: [ArtifactType.Prd],
    artifacts: [{ id: "a1", type: ArtifactType.Prd }],
    ratings: [{ artifactId: "a1", comment: null, score: 1 }],
    expectedRatings: { [ArtifactType.Prd]: 1 },
    expectedComments: { [ArtifactType.Prd]: 0 },
    expectedRatingScoreByType: { [ArtifactType.Prd]: 0.2 },
  },
  {
    name: "single_rating_max_score",
    description: "PRD formula boundary: score=5 yields 1.0 average",
    organizationId: "org-1",
    startDate: new Date("2026-01-01"),
    endDate: new Date("2026-01-31"),
    types: [ArtifactType.Prd],
    artifacts: [{ id: "a1", type: ArtifactType.Prd }],
    ratings: [{ artifactId: "a1", comment: null, score: 5 }],
    expectedRatings: { [ArtifactType.Prd]: 1 },
    expectedComments: { [ArtifactType.Prd]: 0 },
    expectedRatingScoreByType: { [ArtifactType.Prd]: 1.0 },
  },
  {
    name: "multiple_ratings_different_scores",
    description:
      "Two ratings with scores 2 and 4: (2/5 + 4/5) / 2 = (0.4 + 0.8) / 2 = 0.6",
    organizationId: "org-1",
    startDate: new Date("2026-01-01"),
    endDate: new Date("2026-01-31"),
    types: [ArtifactType.Prd],
    artifacts: [{ id: "a1", type: ArtifactType.Prd }],
    ratings: [
      { artifactId: "a1", comment: null, score: 2 },
      { artifactId: "a1", comment: null, score: 4 },
    ],
    expectedRatings: { [ArtifactType.Prd]: 2 },
    expectedComments: { [ArtifactType.Prd]: 0 },
    expectedRatingScoreByType: { [ArtifactType.Prd]: 0.6 },
  },
  {
    name: "mixed_types_one_with_ratings_one_without",
    description:
      "One artifact type (PRD) has ratings, another (ImplementationPlan) has none",
    organizationId: "org-1",
    startDate: new Date("2026-01-01"),
    endDate: new Date("2026-01-31"),
    types: [ArtifactType.Prd, ArtifactType.ImplementationPlan],
    artifacts: [
      { id: "a1", type: ArtifactType.Prd },
      { id: "a2", type: ArtifactType.ImplementationPlan },
    ],
    ratings: [{ artifactId: "a1", comment: null, score: 3 }],
    expectedRatings: {
      [ArtifactType.Prd]: 1,
      [ArtifactType.ImplementationPlan]: 0,
    },
    expectedComments: {
      [ArtifactType.Prd]: 0,
      [ArtifactType.ImplementationPlan]: 0,
    },
    expectedRatingScoreByType: { [ArtifactType.Prd]: 0.6 },
  },
];

// ---------------------------------------------------------------------------
// Parametrized test
// ---------------------------------------------------------------------------

describe("getHumanCountsByType", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe.each(SCENARIO_REGISTRY)("$name", (scenario) => {
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

      const {
        humanRatingsByType,
        humanCommentsByType,
        humanRatingScoreByType,
      } = await getHumanCountsByType(
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
      expect(
        mapToObject(humanRatingScoreByType as Map<string, number | null>)
      ).toEqual(scenario.expectedRatingScoreByType);
    });
  });
});
