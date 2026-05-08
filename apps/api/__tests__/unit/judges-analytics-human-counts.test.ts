/**
 * Unit tests for getHumanCountsByType and getHumanRatingsByArtifact.
 *
 * After artifact cutover:
 * - document → artifact (with `subtype` instead of `type`)
 * - documentRating → artifactRating (field: artifactId)
 * - pullRequestRating → artifactRating (merged, same table, rows for PR-typed artifacts)
 * - gitHubPullRequest → artifact (type=PULL_REQUEST) linked via ArtifactLink
 */
import { DocumentType } from "@repo/api/src/types/document";
import { vi } from "vitest";

vi.mock("@repo/database", () => ({
  withDb: vi.fn(),
  ArtifactType: {
    DOCUMENT: "DOCUMENT",
    PULL_REQUEST: "PULL_REQUEST",
    DEPLOYMENT: "DEPLOYMENT",
  },
  ArtifactSubtype: {
    PRD: "PRD",
    IMPLEMENTATION_PLAN: "IMPLEMENTATION_PLAN",
    TEMPLATE: "TEMPLATE",
    FEATURE: "FEATURE",
  },
}));

import { withDb } from "@repo/database";
import {
  getCodeHumanCountsByType,
  getCodeHumanRatingsByArtifact,
  getHumanCountsByType,
  getHumanRatingsByArtifact,
} from "@/app/judges-analytics/service";

// ---------------------------------------------------------------------------
// Helper types
// ---------------------------------------------------------------------------

// Artifact rows are stored with `subtype` after the cutover
type ArtifactRow = { id: string; subtype: DocumentType };
type RatingRow = { artifactId: string; comment: string | null };

type CountScenarioConfig = {
  name: string;
  description: string;
  organizationId: string;
  startDate: Date;
  endDate: Date;
  types: DocumentType[];
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
    types: [DocumentType.Prd],
    artifacts: [],
    ratings: [],
    expectedRatings: { [DocumentType.Prd]: 0 },
    expectedComments: { [DocumentType.Prd]: 0 },
  },
  {
    name: "artifacts_exist_no_ratings_in_range",
    description: "Artifacts but no ratings in range yields zeros",
    organizationId: "org-1",
    startDate: new Date("2026-01-01"),
    endDate: new Date("2026-01-31"),
    types: [DocumentType.Prd],
    artifacts: [{ id: "a1", subtype: DocumentType.Prd }],
    ratings: [],
    expectedRatings: { [DocumentType.Prd]: 0 },
    expectedComments: { [DocumentType.Prd]: 0 },
  },
  {
    name: "single_rating_with_comment",
    description: "One rating with comment increments both counts",
    organizationId: "org-1",
    startDate: new Date("2026-01-01"),
    endDate: new Date("2026-01-31"),
    types: [DocumentType.Prd],
    artifacts: [{ id: "a1", subtype: DocumentType.Prd }],
    ratings: [{ artifactId: "a1", comment: "Looks good" }],
    expectedRatings: { [DocumentType.Prd]: 1 },
    expectedComments: { [DocumentType.Prd]: 1 },
  },
  {
    name: "rating_without_comment",
    description: "Rating with null comment only increments ratings count",
    organizationId: "org-1",
    startDate: new Date("2026-01-01"),
    endDate: new Date("2026-01-31"),
    types: [DocumentType.Prd],
    artifacts: [{ id: "a1", subtype: DocumentType.Prd }],
    ratings: [{ artifactId: "a1", comment: null }],
    expectedRatings: { [DocumentType.Prd]: 1 },
    expectedComments: { [DocumentType.Prd]: 0 },
  },
  {
    name: "rating_with_empty_comment",
    description:
      "Rating with empty/whitespace comment only increments ratings count",
    organizationId: "org-1",
    startDate: new Date("2026-01-01"),
    endDate: new Date("2026-01-31"),
    types: [DocumentType.Prd],
    artifacts: [{ id: "a1", subtype: DocumentType.Prd }],
    ratings: [{ artifactId: "a1", comment: "   " }],
    expectedRatings: { [DocumentType.Prd]: 1 },
    expectedComments: { [DocumentType.Prd]: 0 },
  },
  {
    name: "multiple_types_partitioned",
    description: "Ratings counted in correct type buckets",
    organizationId: "org-1",
    startDate: new Date("2026-01-01"),
    endDate: new Date("2026-01-31"),
    types: [DocumentType.Prd, DocumentType.ImplementationPlan],
    artifacts: [
      { id: "a1", subtype: DocumentType.Prd },
      { id: "a2", subtype: DocumentType.ImplementationPlan },
    ],
    ratings: [
      { artifactId: "a1", comment: "PRD feedback" },
      { artifactId: "a2", comment: "Plan feedback" },
      { artifactId: "a1", comment: "Another PRD comment" },
    ],
    expectedRatings: {
      [DocumentType.Prd]: 2,
      [DocumentType.ImplementationPlan]: 1,
    },
    expectedComments: {
      [DocumentType.Prd]: 2,
      [DocumentType.ImplementationPlan]: 1,
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
  expected: Record<string, number[]>;
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
    description: "Single rating score=3 yields [0.6]",
    ratings: [{ artifactId: "a1", score: 3 }],
    artifactIds: ["a1"],
    expected: { a1: [0.6] },
  },
  {
    name: "min_score",
    description: "score=1 yields [0.2]",
    ratings: [{ artifactId: "a1", score: 1 }],
    artifactIds: ["a1"],
    expected: { a1: [0.2] },
  },
  {
    name: "max_score",
    description: "score=5 yields [1.0]",
    ratings: [{ artifactId: "a1", score: 5 }],
    artifactIds: ["a1"],
    expected: { a1: [1.0] },
  },
  {
    name: "multiple_ratings_same_artifact",
    description: "Two ratings on same artifact: [0.4, 0.8]",
    ratings: [
      { artifactId: "a1", score: 2 },
      { artifactId: "a1", score: 4 },
    ],
    artifactIds: ["a1"],
    expected: { a1: [0.4, 0.8] },
  },
  {
    name: "multiple_artifacts",
    description: "Different artifacts get independent score arrays",
    ratings: [
      { artifactId: "a1", score: 5 },
      { artifactId: "a2", score: 1 },
    ],
    artifactIds: ["a1", "a2"],
    expected: { a1: [1.0], a2: [0.2] },
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
      for (const [key, expectedScores] of Object.entries(scenario.expected)) {
        expect(actual[key]).toHaveLength(expectedScores.length);
        for (let i = 0; i < expectedScores.length; i++) {
          expect(actual[key][i]).toBeCloseTo(expectedScores[i], 10);
        }
      }
      expect(Object.keys(actual)).toHaveLength(
        Object.keys(scenario.expected).length
      );
    });
  });
});

describe("getCodeHumanCountsByType", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("counts pull request ratings/comments per artifact type via ArtifactLink → PR artifact → ArtifactRating", async () => {
    // After cutover: artifacts are queried with `subtype`, PR artifacts are
    // linked via ArtifactLink (source = plan, target = PR), and PR ratings
    // are rows in ArtifactRating keyed by the PR artifact id.
    const mockDb = {
      artifact: {
        findMany: vi.fn().mockResolvedValue([
          { id: "a1", subtype: DocumentType.ImplementationPlan },
          { id: "a2", subtype: DocumentType.Prd },
        ]),
      },
      artifactLink: {
        findMany: vi.fn().mockResolvedValue([
          { sourceId: "a1", targetId: "pr-1" },
          { sourceId: "a1", targetId: "pr-2" },
          { sourceId: "a2", targetId: "pr-3" },
        ]),
      },
      artifactRating: {
        findMany: vi.fn().mockResolvedValue([
          { artifactId: "pr-1", comment: "looks good" },
          { artifactId: "pr-2", comment: " " },
          { artifactId: "pr-3", comment: "great" },
        ]),
      },
    };

    vi.mocked(withDb).mockImplementation((callback) =>
      Promise.resolve(
        callback(
          mockDb as unknown as Parameters<Parameters<typeof withDb>[0]>[0]
        )
      )
    );

    const result = await getCodeHumanCountsByType(
      "org-1",
      new Date("2026-01-01"),
      new Date("2026-01-31"),
      [DocumentType.ImplementationPlan, DocumentType.Prd]
    );

    expect(
      mapToObject(result.humanRatingsByType as Map<string, number>)
    ).toEqual({
      [DocumentType.ImplementationPlan]: 2,
      [DocumentType.Prd]: 1,
    });
    expect(
      mapToObject(result.humanCommentsByType as Map<string, number>)
    ).toEqual({
      [DocumentType.ImplementationPlan]: 1,
      [DocumentType.Prd]: 1,
    });
  });
});

describe("getCodeHumanRatingsByArtifact", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("normalizes PR ratings (via ArtifactLink) and maps them back to source artifacts", async () => {
    const mockDb = {
      artifactLink: {
        findMany: vi.fn().mockResolvedValue([
          { sourceId: "a1", targetId: "pr-1" },
          { sourceId: "a1", targetId: "pr-2" },
          { sourceId: "a2", targetId: "pr-3" },
        ]),
      },
      artifactRating: {
        findMany: vi.fn().mockResolvedValue([
          { artifactId: "pr-1", score: 5 },
          { artifactId: "pr-2", score: 3 },
          { artifactId: "pr-3", score: 1 },
        ]),
      },
    };

    vi.mocked(withDb).mockImplementation((callback) =>
      Promise.resolve(
        callback(
          mockDb as unknown as Parameters<Parameters<typeof withDb>[0]>[0]
        )
      )
    );

    const result = await getCodeHumanRatingsByArtifact(
      "org-1",
      new Date("2026-01-01"),
      new Date("2026-01-31"),
      ["a1", "a2"]
    );

    const actual = Object.fromEntries(result);
    expect(actual.a1).toEqual([1, 0.6]);
    expect(actual.a2).toEqual([0.2]);
  });
});
