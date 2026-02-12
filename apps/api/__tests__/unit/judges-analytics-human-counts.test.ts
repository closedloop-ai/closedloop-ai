/**
 * Unit tests for getHumanCountsBySubtype — fetches human ratings and comments
 * counts per artifact subtype within an org and date range.
 *
 * Uses scenario-registry pattern with describe.each for parametrized execution.
 */
import { ArtifactSubtype } from "@repo/api/src/types/artifact";
import { vi } from "vitest";

vi.mock("@repo/database", () => ({
  withDb: vi.fn(),
}));

import { withDb } from "@repo/database";
import { getHumanCountsBySubtype } from "@/app/judges-analytics/service";

// ---------------------------------------------------------------------------
// Helper types
// ---------------------------------------------------------------------------

type ArtifactRow = { id: string; subtype: ArtifactSubtype };
type RatingRow = { artifactId: string; comment: string | null };

type ScenarioConfig = {
  name: string;
  description: string;
  organizationId: string;
  startDate: Date;
  endDate: Date;
  subtypes: ArtifactSubtype[];
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
    name: "empty_subtypes",
    description: "Empty subtypes returns empty maps",
    organizationId: "org-1",
    startDate: new Date("2026-01-01"),
    endDate: new Date("2026-01-31"),
    subtypes: [],
    artifacts: [],
    ratings: [],
    expectedRatings: {},
    expectedComments: {},
  },
  {
    name: "no_artifacts_in_org",
    description: "No artifacts yields zeros for all subtypes",
    organizationId: "org-1",
    startDate: new Date("2026-01-01"),
    endDate: new Date("2026-01-31"),
    subtypes: [ArtifactSubtype.Prd],
    artifacts: [],
    ratings: [],
    expectedRatings: { [ArtifactSubtype.Prd]: 0 },
    expectedComments: { [ArtifactSubtype.Prd]: 0 },
  },
  {
    name: "artifacts_exist_no_ratings_in_range",
    description: "Artifacts but no ratings in range yields zeros",
    organizationId: "org-1",
    startDate: new Date("2026-01-01"),
    endDate: new Date("2026-01-31"),
    subtypes: [ArtifactSubtype.Prd],
    artifacts: [{ id: "a1", subtype: ArtifactSubtype.Prd }],
    ratings: [],
    expectedRatings: { [ArtifactSubtype.Prd]: 0 },
    expectedComments: { [ArtifactSubtype.Prd]: 0 },
  },
  {
    name: "single_rating_with_comment",
    description: "One rating with comment increments both counts",
    organizationId: "org-1",
    startDate: new Date("2026-01-01"),
    endDate: new Date("2026-01-31"),
    subtypes: [ArtifactSubtype.Prd],
    artifacts: [{ id: "a1", subtype: ArtifactSubtype.Prd }],
    ratings: [{ artifactId: "a1", comment: "Looks good" }],
    expectedRatings: { [ArtifactSubtype.Prd]: 1 },
    expectedComments: { [ArtifactSubtype.Prd]: 1 },
  },
  {
    name: "rating_without_comment",
    description: "Rating with null comment only increments ratings count",
    organizationId: "org-1",
    startDate: new Date("2026-01-01"),
    endDate: new Date("2026-01-31"),
    subtypes: [ArtifactSubtype.Prd],
    artifacts: [{ id: "a1", subtype: ArtifactSubtype.Prd }],
    ratings: [{ artifactId: "a1", comment: null }],
    expectedRatings: { [ArtifactSubtype.Prd]: 1 },
    expectedComments: { [ArtifactSubtype.Prd]: 0 },
  },
  {
    name: "rating_with_empty_comment",
    description:
      "Rating with empty/whitespace comment only increments ratings count",
    organizationId: "org-1",
    startDate: new Date("2026-01-01"),
    endDate: new Date("2026-01-31"),
    subtypes: [ArtifactSubtype.Prd],
    artifacts: [{ id: "a1", subtype: ArtifactSubtype.Prd }],
    ratings: [{ artifactId: "a1", comment: "   " }],
    expectedRatings: { [ArtifactSubtype.Prd]: 1 },
    expectedComments: { [ArtifactSubtype.Prd]: 0 },
  },
  {
    name: "multiple_subtypes_partitioned",
    description: "Ratings counted in correct subtype buckets",
    organizationId: "org-1",
    startDate: new Date("2026-01-01"),
    endDate: new Date("2026-01-31"),
    subtypes: [ArtifactSubtype.Prd, ArtifactSubtype.Issue],
    artifacts: [
      { id: "a1", subtype: ArtifactSubtype.Prd },
      { id: "a2", subtype: ArtifactSubtype.Issue },
    ],
    ratings: [
      { artifactId: "a1", comment: "PRD feedback" },
      { artifactId: "a2", comment: "Issue feedback" },
      { artifactId: "a1", comment: "Another PRD comment" },
    ],
    expectedRatings: {
      [ArtifactSubtype.Prd]: 2,
      [ArtifactSubtype.Issue]: 1,
    },
    expectedComments: {
      [ArtifactSubtype.Prd]: 2,
      [ArtifactSubtype.Issue]: 1,
    },
  },
];

// ---------------------------------------------------------------------------
// Parametrized test
// ---------------------------------------------------------------------------

describe("getHumanCountsBySubtype", () => {
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

      const { humanRatingsBySubtype, humanCommentsBySubtype } =
        await getHumanCountsBySubtype(
          scenario.organizationId,
          scenario.startDate,
          scenario.endDate,
          scenario.subtypes
        );

      expect(mapToObject(humanRatingsBySubtype as Map<string, number>)).toEqual(
        scenario.expectedRatings
      );
      expect(
        mapToObject(humanCommentsBySubtype as Map<string, number>)
      ).toEqual(scenario.expectedComments);
    });
  });
});
