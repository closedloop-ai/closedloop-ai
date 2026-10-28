/**
 * Branch-coverage pins for app/judges-analytics/service/human-ratings.ts
 * (ISS-11280). Targets uncovered arms not already exercised by
 * apps/api/__tests__/unit/judges-analytics-human-counts.test.ts: an artifact
 * row with a null subtype dropped from idToType, a dangling PR link whose
 * source isn't in the fetched artifact set, the short-circuit empty-input
 * guards, and the non-empty branch of computeHumanStats.
 */
import { LinkType } from "@repo/api/src/types/artifact";
import { DocumentType } from "@repo/api/src/types/document";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockDbWith } from "@/__tests__/support/judges-analytics/service.test-helpers";

vi.mock("@repo/database", () => ({
  withDb: vi.fn(),
  ArtifactType: {
    DOCUMENT: "DOCUMENT",
    BRANCH: "BRANCH",
    DEPLOYMENT: "DEPLOYMENT",
  },
}));

import {
  computeHumanStats,
  getCodeHumanCountsByType,
  getCodeHumanRatingsByArtifact,
  getHumanCountsByType,
} from "@/app/judges-analytics/service/human-ratings";

describe("getHumanCountsByType — dangling/malformed row tolerance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("drops an artifact row with a null subtype from the type map", async () => {
    const mockDb = {
      artifact: {
        findMany: vi.fn().mockResolvedValue([
          { id: "a1", subtype: DocumentType.Prd },
          // pins current behavior; looks odd because a null-subtype row is
          // silently excluded from idToType rather than surfaced as an error
          { id: "a2", subtype: null },
        ]),
      },
      artifactRating: {
        findMany: vi.fn().mockResolvedValue([
          { artifactId: "a1", comment: "counted" },
          { artifactId: "a2", comment: "dropped, no type" },
        ]),
      },
    };
    mockDbWith(mockDb);

    const { humanRatingsByType } = await getHumanCountsByType(
      "org-1",
      new Date("2026-01-01"),
      new Date("2026-01-31"),
      [DocumentType.Prd]
    );

    expect(humanRatingsByType.get(DocumentType.Prd)).toBe(1);
    // No `null` key was added for the dropped row — a mutant that never
    // filters null-subtype rows out of idToType would count "a2" under a
    // literal `null` type instead of leaving it untracked.
    expect(Array.from(humanRatingsByType.keys())).toEqual([DocumentType.Prd]);
  });
});

describe("getCodeHumanCountsByType — link/lookup edge cases", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns empty maps without querying the DB when types is empty", async () => {
    const artifactFindMany = vi.fn();
    mockDbWith({ artifact: { findMany: artifactFindMany } });

    const { humanRatingsByType, humanCommentsByType } =
      await getCodeHumanCountsByType(
        "org-1",
        new Date("2026-01-01"),
        new Date("2026-01-31"),
        []
      );

    expect(humanRatingsByType.size).toBe(0);
    expect(humanCommentsByType.size).toBe(0);
    expect(artifactFindMany).not.toHaveBeenCalled();
  });

  it("returns zeroed maps when the org has no matching artifacts at all", async () => {
    const mockDb = {
      artifact: { findMany: vi.fn().mockResolvedValue([]) },
      artifactLink: { findMany: vi.fn() },
      artifactRating: { findMany: vi.fn() },
    };
    mockDbWith(mockDb);

    const { humanRatingsByType } = await getCodeHumanCountsByType(
      "org-1",
      new Date("2026-01-01"),
      new Date("2026-01-31"),
      [DocumentType.Prd]
    );

    expect(humanRatingsByType.get(DocumentType.Prd)).toBe(0);
    expect(mockDb.artifactLink.findMany).not.toHaveBeenCalled();
  });

  it("returns zeroed maps when artifacts exist but carry a null subtype", async () => {
    // artifacts.length !== 0 (so the artifacts.length === 0 short-circuit
    // isn't taken), but the only row has subtype: null, so idToType ends up
    // empty and no PR link lookup can attribute anything.
    const mockDb = {
      artifact: {
        findMany: vi.fn().mockResolvedValue([{ id: "a1", subtype: null }]),
      },
      artifactLink: { findMany: vi.fn().mockResolvedValue([]) },
      artifactRating: { findMany: vi.fn() },
    };
    mockDbWith(mockDb);

    const { humanRatingsByType, humanCommentsByType } =
      await getCodeHumanCountsByType(
        "org-1",
        new Date("2026-01-01"),
        new Date("2026-01-31"),
        [DocumentType.Prd]
      );

    expect(humanRatingsByType.get(DocumentType.Prd)).toBe(0);
    expect(humanCommentsByType.get(DocumentType.Prd)).toBe(0);
    // pins current behavior; looks odd because the (empty) idToType from an
    // all-null-subtype artifact set still drives an unconditional PR-link
    // lookup with an empty sourceId filter, instead of short-circuiting.
    expect(mockDb.artifactLink.findMany).toHaveBeenCalledTimes(1);
    // The sourceId filter is empty because "a1" (null subtype) was actually
    // excluded from idToType — a mutant that stops filtering null-subtype
    // rows would bind "a1" here instead.
    expect(mockDb.artifactLink.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ sourceId: { in: [] } }),
      })
    );
    expect(mockDb.artifactRating.findMany).not.toHaveBeenCalled();
  });

  it("returns zeroed maps when no PRODUCES links exist for the plan artifacts", async () => {
    const mockDb = {
      artifact: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ id: "a1", subtype: DocumentType.Prd }]),
      },
      artifactLink: { findMany: vi.fn().mockResolvedValue([]) },
      artifactRating: { findMany: vi.fn() },
    };
    mockDbWith(mockDb);

    const { humanRatingsByType } = await getCodeHumanCountsByType(
      "org-1",
      new Date("2026-01-01"),
      new Date("2026-01-31"),
      [DocumentType.Prd]
    );

    expect(humanRatingsByType.get(DocumentType.Prd)).toBe(0);
    expect(mockDb.artifactRating.findMany).not.toHaveBeenCalled();
  });

  it("drops a PR link whose sourceId is not one of the fetched plan artifacts, and returns zeros when every link dangles", async () => {
    // prLinks.length > 0, but every link's sourceId is unknown to idToType,
    // so prIdToType never gains an entry (size stays 0) and the ratings
    // query is skipped entirely.
    const mockDb = {
      artifact: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ id: "a1", subtype: DocumentType.Prd }]),
      },
      artifactLink: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ sourceId: "a-unrelated", targetId: "pr-1" }]),
      },
      artifactRating: { findMany: vi.fn() },
    };
    mockDbWith(mockDb);

    const { humanRatingsByType } = await getCodeHumanCountsByType(
      "org-1",
      new Date("2026-01-01"),
      new Date("2026-01-31"),
      [DocumentType.Prd]
    );

    expect(humanRatingsByType.get(DocumentType.Prd)).toBe(0);
    expect(mockDb.artifactRating.findMany).not.toHaveBeenCalled();
    // The PRODUCES-link lookup is org-scoped and bounded to the plan artifact
    // ids the artifact query resolved (never "a-unrelated").
    expect(mockDb.artifactLink.findMany).toHaveBeenCalledWith({
      where: {
        organizationId: "org-1",
        sourceId: { in: ["a1"] },
        linkType: LinkType.Produces,
        target: { type: "BRANCH" },
      },
      select: { sourceId: true, targetId: true },
    });
  });
});

describe("getCodeHumanRatingsByArtifact — empty-input short circuits", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns an empty map without touching the DB when artifactIds is empty", async () => {
    const artifactLinkFindMany = vi.fn();
    mockDbWith({ artifactLink: { findMany: artifactLinkFindMany } });

    const result = await getCodeHumanRatingsByArtifact(
      "org-1",
      new Date("2026-01-01"),
      new Date("2026-01-31"),
      []
    );

    expect(result.size).toBe(0);
    expect(artifactLinkFindMany).not.toHaveBeenCalled();
  });

  it("returns an empty map when no PR links exist, without querying ratings", async () => {
    const mockDb = {
      artifactLink: { findMany: vi.fn().mockResolvedValue([]) },
      artifactRating: { findMany: vi.fn() },
    };
    mockDbWith(mockDb);

    const result = await getCodeHumanRatingsByArtifact(
      "org-1",
      new Date("2026-01-01"),
      new Date("2026-01-31"),
      ["a1"]
    );

    expect(result.size).toBe(0);
    expect(mockDb.artifactRating.findMany).not.toHaveBeenCalled();
  });

  it("drops a rating keyed to a PR artifactId the link query never returned", async () => {
    // collectNormalizedScores's getKey is prIdToArtifactId.get(...), which is
    // undefined for "pr-orphan" — the `key === undefined` guard must skip it.
    const mockDb = {
      artifactLink: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ sourceId: "a1", targetId: "pr-1" }]),
      },
      artifactRating: {
        findMany: vi.fn().mockResolvedValue([
          { artifactId: "pr-1", score: 5 },
          { artifactId: "pr-orphan", score: 1 },
        ]),
      },
    };
    mockDbWith(mockDb);

    const result = await getCodeHumanRatingsByArtifact(
      "org-1",
      new Date("2026-01-01"),
      new Date("2026-01-31"),
      ["a1"]
    );

    expect(Object.fromEntries(result)).toEqual({ a1: [1] });
    // The ratings fetch is org-scoped and bounded to the PR ids the link
    // query resolved (never "pr-orphan", which was never a link target).
    expect(mockDb.artifactRating.findMany).toHaveBeenCalledWith({
      where: {
        organizationId: "org-1",
        artifactId: { in: ["pr-1"] },
        createdAt: {
          gte: new Date("2026-01-01"),
          lte: new Date("2026-01-31"),
        },
      },
      select: { artifactId: true, score: true },
    });
  });
});

describe("computeHumanStats — non-empty score pool", () => {
  it("computes min/max/mean/stdDev from pooled normalized scores", () => {
    const scores = [0.2, 0.4, 0.6, 0.8];
    const result = computeHumanStats(scores);

    expect(result.humanMin).toBe(0.2);
    expect(result.humanMax).toBe(0.8);
    // Literal population mean/stdDev for [0.2, 0.4, 0.6, 0.8]: mean 0.5,
    // variance 0.05 (deviations squared: 0.09, 0.01, 0.01, 0.09 / 4).
    expect(result.humanMean).toBeCloseTo(0.5, 12);
    expect(result.humanStdDev).toBeCloseTo(0.223_606_797_749_978_96, 12);
  });
});

describe("computeHumanStats — empty score pool", () => {
  it("returns all-null stats instead of Infinity/-Infinity/NaN from an empty pool", () => {
    // Without the `scores.length === 0` guard, this would compute
    // Math.min(...[]) = Infinity, Math.max(...[]) = -Infinity, and a NaN or
    // 0 mean/stdDev depending on computeMean/computeStdDev's own empty
    // handling — none of which is the documented "no data" contract.
    expect(computeHumanStats([])).toEqual({
      humanMin: null,
      humanMax: null,
      humanMean: null,
      humanStdDev: null,
    });
  });
});
