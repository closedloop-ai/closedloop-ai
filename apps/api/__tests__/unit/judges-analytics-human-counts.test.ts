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
type RatingRow = { artifactId: string; comment: string | null };

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
};

/** Converts Map to plain object for stable equality assertions. */
function mapToObject(m: Map<string, number>): Record<string, number> {
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
