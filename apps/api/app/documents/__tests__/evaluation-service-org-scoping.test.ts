/**
 * ISS-6745 — two-org isolation for the document rating read/write path.
 *
 * The route suite (`__tests__/api/documents-rating.test.ts`) mocks this whole
 * service away, so every "cross-org" claim it made was satisfied by its own
 * `mockResolvedValue(Result.err(Status.NotFound))` — deleting the org predicate
 * from production left it green. These tests drive the REAL service against a
 * DB fake that models per-org visibility with Prisma's own semantics (an absent
 * `where` key constrains nothing), so removing an org predicate changes the
 * observed outcome and reddens them.
 *
 * All FOUR org predicates in these two methods are covered, each by a test that
 * reddens when that predicate alone is deleted:
 *  - `upsertRating` → `documentDetail.findFirst({ where: { artifact: {
 *    organizationId, type } } })` — the gate that stops an org-A caller writing
 *    a rating row against an org-B document.
 *  - `upsertRating` → its OWN post-write `artifactRating` aggregate/count
 *    `where.organizationId`, returned to the caller as the summary. Textually
 *    identical to `getRating`'s, so proving one does not prove the other.
 *  - `getRating` → the `artifactRating` aggregate/count `where.organizationId`
 *    — the filter that stops another org's ratings leaking into the summary.
 */

import { Status } from "@repo/api/src/types/result";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", async () => {
  const { createDatabaseMockModule } = await import(
    "../../../__tests__/fixtures/mock-modules"
  );
  return createDatabaseMockModule();
});

import { ArtifactType } from "@repo/database";
import { mockWithDbAll } from "../../../__tests__/utils/db-helpers";
import { documentEvaluationService } from "../evaluation-service";

const ORG_A = "org-a";
const ORG_B = "org-b";
const USER_IN_A = "user-a";
const USER_IN_B = "user-b";
const DOC_IN_A = "doc-in-a";
const DOC_IN_B = "doc-in-b";
const BRANCH_IN_A = "branch-in-a";

type ArtifactRow = {
  id: string;
  organizationId: string;
  type: string;
  latestVersion: number;
};

type RatingRow = {
  id: string;
  artifactId: string;
  userId: string;
  organizationId: string;
  score: number;
  comment: string | null;
  artifactVersion: number | null;
  createdAt: Date;
  updatedAt: Date;
};

const ARTIFACTS: ArtifactRow[] = [
  {
    id: DOC_IN_A,
    organizationId: ORG_A,
    type: ArtifactType.DOCUMENT,
    latestVersion: 3,
  },
  {
    id: DOC_IN_B,
    organizationId: ORG_B,
    type: ArtifactType.DOCUMENT,
    latestVersion: 7,
  },
  {
    id: BRANCH_IN_A,
    organizationId: ORG_A,
    type: ArtifactType.BRANCH,
    latestVersion: 1,
  },
];

/**
 * Prisma semantics, deliberately: a key ABSENT from the `where` constrains
 * nothing. That is what makes these tests causal — drop `organizationId` from
 * the service's `where` and the foreign row starts matching.
 */
function matchesArtifactPredicate(
  row: ArtifactRow,
  predicate: { organizationId?: string; type?: string } | undefined
): boolean {
  if (!predicate) {
    return true;
  }
  if (
    predicate.organizationId !== undefined &&
    predicate.organizationId !== row.organizationId
  ) {
    return false;
  }
  return predicate.type === undefined || predicate.type === row.type;
}

function matchesRatingPredicate(
  row: RatingRow,
  predicate: { artifactId?: string; organizationId?: string }
): boolean {
  if (
    predicate.artifactId !== undefined &&
    predicate.artifactId !== row.artifactId
  ) {
    return false;
  }
  return (
    predicate.organizationId === undefined ||
    predicate.organizationId === row.organizationId
  );
}

let ratings: RatingRow[] = [];
const upsertSpy = vi.fn();

function seedRatings(): RatingRow[] {
  return [
    {
      id: "rating-b",
      artifactId: DOC_IN_B,
      userId: USER_IN_B,
      organizationId: ORG_B,
      score: 5,
      comment: "org-B only",
      artifactVersion: 7,
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-01"),
    },
    // Schema-legal: the `artifactId_userId_organizationId` unique key exists
    // precisely because rating rows for one artifactId can span orgs. Both
    // aggregate `where`s must exclude this row for an org-A caller.
    {
      id: "rating-foreign-on-a",
      artifactId: DOC_IN_A,
      userId: USER_IN_B,
      organizationId: ORG_B,
      score: 1,
      comment: "another org's row on the same artifact",
      artifactVersion: 3,
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-01"),
    },
  ];
}

function buildMockDb() {
  return {
    documentDetail: {
      findFirst: vi.fn(
        ({
          where,
        }: {
          where: {
            artifactId: string;
            artifact?: { organizationId?: string; type?: string };
          };
        }) => {
          const row = ARTIFACTS.find((a) => a.id === where.artifactId);
          if (!(row && matchesArtifactPredicate(row, where.artifact))) {
            return Promise.resolve(null);
          }
          return Promise.resolve({ latestVersion: row.latestVersion });
        }
      ),
    },
    artifactRating: {
      findUnique: vi.fn(
        ({
          where,
        }: {
          where: {
            artifactId_userId_organizationId: {
              artifactId: string;
              userId: string;
              organizationId: string;
            };
          };
        }) => {
          const key = where.artifactId_userId_organizationId;
          return Promise.resolve(
            ratings.find(
              (r) =>
                r.artifactId === key.artifactId &&
                r.userId === key.userId &&
                r.organizationId === key.organizationId
            ) ?? null
          );
        }
      ),
      upsert: vi.fn(
        (args: {
          where: {
            artifactId_userId_organizationId: {
              artifactId: string;
              userId: string;
              organizationId: string;
            };
          };
          update: Partial<RatingRow>;
          create: Omit<
            RatingRow,
            "id" | "createdAt" | "updatedAt" | "comment"
          > & { comment?: string };
        }) => {
          upsertSpy(args);
          const key = args.where.artifactId_userId_organizationId;
          const existing = ratings.find(
            (r) =>
              r.artifactId === key.artifactId &&
              r.userId === key.userId &&
              r.organizationId === key.organizationId
          );
          if (existing) {
            Object.assign(existing, args.update);
            return Promise.resolve(existing);
          }
          const created: RatingRow = {
            id: `rating-${ratings.length + 1}`,
            createdAt: new Date("2026-02-01"),
            updatedAt: new Date("2026-02-01"),
            ...args.create,
            // After the spread: Prisma stores an omitted optional comment as
            // NULL, and `RatingRow.comment` is `string | null`, never undefined.
            comment: args.create.comment ?? null,
          };
          ratings.push(created);
          return Promise.resolve(created);
        }
      ),
      aggregate: vi.fn(
        ({
          where,
        }: {
          where: { artifactId?: string; organizationId?: string };
        }) => {
          const matched = ratings.filter((r) =>
            matchesRatingPredicate(r, where)
          );
          const avg =
            matched.length === 0
              ? null
              : matched.reduce((sum, r) => sum + r.score, 0) / matched.length;
          return Promise.resolve({ _avg: { score: avg } });
        }
      ),
      count: vi.fn(
        ({
          where,
        }: {
          where: { artifactId?: string; organizationId?: string };
        }) =>
          Promise.resolve(
            ratings.filter((r) => matchesRatingPredicate(r, where)).length
          )
      ),
    },
  };
}

describe("documentEvaluationService — two-org isolation (ISS-6745)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ratings = seedRatings();
    mockWithDbAll(buildMockDb());
  });

  describe("upsertRating", () => {
    it("writes the rating when the document is in the caller's org", async () => {
      const result = await documentEvaluationService.upsertRating(
        DOC_IN_A,
        USER_IN_A,
        ORG_A,
        4,
        "in-org"
      );

      expect(result.ok).toBe(true);
      expect(upsertSpy).toHaveBeenCalledTimes(1);
      expect(
        ratings.filter(
          (r) => r.artifactId === DOC_IN_A && r.userId === USER_IN_A
        )
      ).toHaveLength(1);
    });

    it("refuses to write a rating against a document owned by another org", async () => {
      const result = await documentEvaluationService.upsertRating(
        DOC_IN_B,
        USER_IN_A,
        ORG_A,
        4,
        "cross-org write attempt"
      );

      expect(result).toEqual({ ok: false, error: Status.NotFound });
      // The decisive assertion: no row is written against the foreign document.
      expect(upsertSpy).not.toHaveBeenCalled();
      expect(
        ratings.filter(
          (r) => r.artifactId === DOC_IN_B && r.userId === USER_IN_A
        )
      ).toHaveLength(0);
    });

    it("does not leak another org's document version through the rating write", async () => {
      // DOC_IN_B.latestVersion is 7 and DOC_IN_A's is 3; a missing org
      // predicate would stamp the foreign version onto the caller's row.
      const result = await documentEvaluationService.upsertRating(
        DOC_IN_B,
        USER_IN_A,
        ORG_A,
        4
      );

      expect(result.ok).toBe(false);
      expect(
        ratings.some(
          (r) => r.organizationId === ORG_A && r.artifactVersion === 7
        )
      ).toBe(false);
    });

    it("excludes another org's ratings from the aggregate it returns", async () => {
      // `upsertRating` runs its OWN aggregate/count after the write. That
      // `where` is textually identical to `getRating`'s, so it needs its own
      // causal coverage — proving one does not prove the other.
      const result = await documentEvaluationService.upsertRating(
        DOC_IN_A,
        USER_IN_A,
        ORG_A,
        5
      );

      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      // Only the caller's own row. Without the org filter this is 2 rows,
      // averaging 3 (the seeded org-B score of 1 alongside this 5).
      expect(result.value.count).toBe(1);
      expect(result.value.average).toBe(5);
    });

    it("refuses to rate a non-DOCUMENT artifact in the caller's own org", async () => {
      const result = await documentEvaluationService.upsertRating(
        BRANCH_IN_A,
        USER_IN_A,
        ORG_A,
        4
      );

      expect(result).toEqual({ ok: false, error: Status.NotFound });
      expect(upsertSpy).not.toHaveBeenCalled();
    });
  });

  describe("getRating", () => {
    it("returns the caller's own org ratings", async () => {
      const summary = await documentEvaluationService.getRating(
        DOC_IN_B,
        USER_IN_B,
        ORG_B
      );

      expect(summary.count).toBe(1);
      expect(summary.average).toBe(5);
      expect(summary.userRating?.score).toBe(5);
    });

    it("does not surface another org's ratings for the same artifact id", async () => {
      const summary = await documentEvaluationService.getRating(
        DOC_IN_B,
        USER_IN_A,
        ORG_A
      );

      expect(summary.count).toBe(0);
      expect(summary.average).toBe(0);
      expect(summary.userRating).toBeNull();
    });
  });
});
