/**
 * Merged-PR LOC on the Delivery insights (PLN-1535 M4).
 *
 * Split out of `service.test.ts` rather than added to it: that file is a
 * grandfathered over-size module the repo's shrink-only rule forbids growing,
 * and these three cases are one cohesive concern -- what the KLOC sum, the
 * PR-size median, and the unsized-PR coverage count do when a merged PR's
 * projection carries no diff stats. `null` there means UNKNOWN, never zero, and
 * that is the property this file exists to pin.
 */

import { GitHubPRState as ApiGitHubPRState } from "@repo/api/src/types/github";
import { InsightsPeriod, InsightsScope } from "@repo/api/src/types/insights";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", async () =>
  (await import("@/__tests__/support/insights/service.test-db")).databaseMock()
);

import { withDb } from "@repo/database";
import { makeFakeDb, ORG } from "@/__tests__/support/insights/service.test-db";
import { insightsService } from "./service";

const USER = "user-1";
const ORG_CTX = { organizationId: ORG, userId: USER, scope: InsightsScope.Org };
const NOW = new Date("2026-06-09T12:00:00.000Z");
const HOUR = 3_600_000;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("insightsService.getDelivery — merged-PR LOC", () => {
  it("medians PR size over PRs with a KNOWN size, excluding unsized ones (FEA-2988 / PLN-1535 M4)", async () => {
    const mergedAt = new Date("2026-06-08T00:00:00.000Z");
    const openedAt = new Date(mergedAt.getTime() - 2 * HOUR);
    const { db } = makeFakeDb({
      mergedPrs: [
        {
          mergedAt,
          prState: ApiGitHubPRState.Merged,
          id: "pr-1",
          number: 1,
          githubId: "gh-1",
          additions: 100,
          deletions: 0,
          repositoryId: "r1",
          repositoryFullName: "acme/symphony-alpha",
          branchArtifactId: "b1",
          repository: { name: "symphony-alpha" },
          branchArtifact: { createdAt: openedAt },
        },
        {
          mergedAt,
          prState: ApiGitHubPRState.Merged,
          id: "pr-2",
          number: 2,
          githubId: "gh-2",
          additions: 300,
          deletions: 0,
          repositoryId: "r2",
          repositoryFullName: "acme/web",
          branchArtifactId: "b2",
          repository: { name: "web" },
          branchArtifact: { createdAt: openedAt },
        },
        {
          // PLN-1535 M4: unsized — the projection carries no diff stats for it.
          // Previously this was expressed as a branch whose file cache was not
          // Fresh; the size now lives on the PR row itself.
          mergedAt,
          prState: ApiGitHubPRState.Merged,
          id: "pr-3",
          number: 3,
          githubId: "gh-3",
          additions: null,
          deletions: null,
          repositoryId: "r3",
          repositoryFullName: "acme/docs",
          branchArtifactId: "b3",
          repository: { name: "docs" },
          branchArtifact: { createdAt: openedAt },
        },
      ],
      counts: () => 0,
    });
    vi.mocked(withDb).mockImplementation((cb) =>
      Promise.resolve(cb(db as never))
    );

    const result = await insightsService.getDelivery(
      ORG_CTX,
      InsightsPeriod.Quarter,
      NOW
    );

    // Median over sized PRs only: [100, 300] → 200. Folding the unsized PR in
    // as 0 would median [0, 100, 300] → 100.
    const prSize = result.kpis.find((k) => k.key === "pr-size");
    expect(prSize?.value).toBe(200);

    // KLOC sums the sized PRs: 400 / 1000. The unsized PR is EXCLUDED rather
    // than contributing 0 — it is reported as coverage instead, so the tile
    // never silently understates while looking complete.
    const kloc = result.kpis.find((k) => k.key === "kloc");
    expect(kloc?.value).toBe(0.4);
    const unsized = result.kpis.find((k) => k.key === "mergedPrsWithoutLoc");
    expect(unsized?.value).toBe(1);
    expect(result.kpis.find((k) => k.key === "mergedPrsScanned")?.value).toBe(
      3
    );

    // ISS-5414: both tiles' captions quote that coverage, so the caveat the two
    // internal KPIs carry actually reaches a reader. 3 scanned, 1 unsized → 2.
    expect(kloc?.sub).toBe(
      "thousand lines landed · sized 2 of 3 deduped merged PRs scanned"
    );
    expect(prSize?.sub).toBe(
      "lines changed · sized 2 of 3 deduped merged PRs scanned"
    );
  });

  it("counts a known-zero PR as 0 in the PR-size median (FEA-2988 / PLN-1535 M4)", async () => {
    const mergedAt = new Date("2026-06-08T00:00:00.000Z");
    const openedAt = new Date(mergedAt.getTime() - 2 * HOUR);
    const { db } = makeFakeDb({
      mergedPrs: [
        {
          // Both counts present and zero: a PR that touched no lines has a
          // KNOWN size of 0 and must count toward the median, unlike an unsized
          // PR which is excluded entirely.
          mergedAt,
          prState: ApiGitHubPRState.Merged,
          id: "pr-0",
          number: 10,
          githubId: "gh-10",
          additions: 0,
          deletions: 0,
          repositoryId: "r0",
          repositoryFullName: "acme/docs",
          branchArtifactId: "b0",
          repository: { name: "docs" },
          branchArtifact: { createdAt: openedAt },
        },
        {
          mergedAt,
          prState: ApiGitHubPRState.Merged,
          id: "pr-1",
          number: 11,
          githubId: "gh-11",
          additions: 100,
          deletions: 0,
          repositoryId: "r1",
          repositoryFullName: "acme/symphony-alpha",
          branchArtifactId: "b1",
          repository: { name: "symphony-alpha" },
          branchArtifact: { createdAt: openedAt },
        },
        {
          mergedAt,
          prState: ApiGitHubPRState.Merged,
          id: "pr-2",
          number: 12,
          githubId: "gh-12",
          additions: 300,
          deletions: 0,
          repositoryId: "r2",
          repositoryFullName: "acme/web",
          branchArtifactId: "b2",
          repository: { name: "web" },
          branchArtifact: { createdAt: openedAt },
        },
      ],
      counts: () => 0,
    });
    vi.mocked(withDb).mockImplementation((cb) =>
      Promise.resolve(cb(db as never))
    );

    const result = await insightsService.getDelivery(
      ORG_CTX,
      InsightsPeriod.Quarter,
      NOW
    );

    // Median over [0, 100, 300] → 100. Dropping the known-zero PR as if its
    // size were unknown would median [100, 300] → 200.
    const prSize = result.kpis.find((k) => k.key === "pr-size");
    expect(prSize?.value).toBe(100);
    const unsized = result.kpis.find((k) => k.key === "mergedPrsWithoutLoc");
    expect(unsized?.value).toBe(0);
  });

  it("reports KLOC as unavailable, not zero, when no merged PR is sized (PLN-1535 M4)", async () => {
    const mergedAt = new Date("2026-06-08T00:00:00.000Z");
    const openedAt = new Date(mergedAt.getTime() - 2 * HOUR);
    const { db } = makeFakeDb({
      mergedPrs: [
        {
          mergedAt,
          prState: ApiGitHubPRState.Merged,
          id: "pr-1",
          number: 1,
          githubId: "gh-1",
          additions: null,
          deletions: null,
          repositoryId: "r1",
          repositoryFullName: "acme/symphony-alpha",
          branchArtifactId: "b1",
          repository: { name: "symphony-alpha" },
          branchArtifact: { createdAt: openedAt },
        },
      ],
      counts: () => 0,
    });
    vi.mocked(withDb).mockImplementation((cb) =>
      Promise.resolve(cb(db as never))
    );

    const result = await insightsService.getDelivery(
      ORG_CTX,
      InsightsPeriod.Quarter,
      NOW
    );

    // "0.0 thousand lines landed" over a PR that certainly landed lines is the
    // unavailable-as-real-zero conflation; null renders the em dash instead.
    expect(result.kpis.find((k) => k.key === "kloc")?.value).toBeNull();
    expect(result.kpis.find((k) => k.key === "mergedKloc")?.value).toBeNull();
    expect(
      result.kpis.find((k) => k.key === "mergedPrsWithoutLoc")?.value
    ).toBe(1);

    // ISS-5414: the caption is what separates "—" meaning "nothing merged" from
    // "—" meaning "we cannot size anything we merged". Zero coverage is stated,
    // not implied by the missing value.
    expect(result.kpis.find((k) => k.key === "kloc")?.sub).toBe(
      "thousand lines landed · sized 0 of 1 deduped merged PRs scanned"
    );
    expect(result.kpis.find((k) => k.key === "pr-size")?.sub).toBe(
      "lines changed · sized 0 of 1 deduped merged PRs scanned"
    );
  });

  it("leaves both captions unqualified when no merged PR was scanned (ISS-5414)", async () => {
    const { db } = makeFakeDb({ mergedPrs: [], counts: () => 0 });
    vi.mocked(withDb).mockImplementation((cb) =>
      Promise.resolve(cb(db as never))
    );

    const result = await insightsService.getDelivery(
      ORG_CTX,
      InsightsPeriod.Quarter,
      NOW
    );

    // An empty window has no population for the figure to be a share of, so
    // "sized 0 of 0 merged PRs" would be noise, not a caveat.
    expect(result.kpis.find((k) => k.key === "kloc")?.sub).toBe(
      "thousand lines landed"
    );
    expect(result.kpis.find((k) => k.key === "pr-size")?.sub).toBe(
      "lines changed"
    );
    expect(result.kpis.find((k) => k.key === "mergedPrsScanned")?.value).toBe(
      0
    );
  });
});
