/**
 * The distinct-PR counts behind the Delivery deltas and the merge rate
 * (ISS-5411, moved into SQL by ISS-5624).
 *
 * These two counts describe populations the Delivery endpoint holds no rows
 * for, so they cannot reuse the merged-PR row scan's dedupe. They used to pair
 * an exact `count()` with a capped identity scan and subtract the duplicates
 * that scan could see — up to 25,000 rows shipped and sorted per call, twice
 * per request, to produce one integer, and only ever an approximation once the
 * cap bound. They now count distinct identities in Postgres.
 *
 * The cases below drive the real query path against a fake `$queryRaw` and
 * assert on the statement it emits: that the row scan is gone, that the count
 * is taken as the DB reports it, that the identity expression mirrors
 * `projectedPrIdentity`, and that each caller keeps its own scope and window.
 */

import { GitHubPRState } from "@repo/api/src/types/github";
import { InsightsScope } from "@repo/api/src/types/insights";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", async () =>
  (await import("@/__tests__/support/insights/service.test-db")).databaseMock()
);

import { withDb } from "@repo/database";
import {
  flattenRawSql,
  ORG,
} from "@/__tests__/support/insights/service.test-db";
import {
  countClosedPrs,
  countDistinctPriorMergedPrs,
} from "./merged-pr-queries";

const USER = "user-1";
const TEAM = "team-1";
const CTX = { organizationId: ORG, userId: USER, scope: InsightsScope.Org };
const START = new Date("2026-05-01T00:00:00.000Z");
const END = new Date("2026-06-01T00:00:00.000Z");

type Recorded = { text: string; values: unknown[] };

/**
 * A Prisma double that answers every statement with `n`, records the SQL it was
 * handed, and fails loudly on the row scan this issue removed — a `findMany`
 * here means the count went back to materializing identities.
 */
function recordingDb(recorded: Recorded[], n = 0) {
  return {
    $queryRaw: (sql: unknown) => {
      recorded.push(flattenRawSql(sql));
      return Promise.resolve([{ n }]);
    },
    pullRequestDetail: {
      count: () =>
        Promise.reject(new Error("unexpected pullRequestDetail.count")),
      findMany: () =>
        Promise.reject(new Error("unexpected pullRequestDetail.findMany")),
    },
  };
}

function mockDb(recorded: Recorded[], n = 0): void {
  vi.mocked(withDb).mockImplementation((cb) =>
    Promise.resolve(cb(recordingDb(recorded, n) as never))
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("countDistinctPrs — one aggregate, no row scan (ISS-5624)", () => {
  it("issues a single statement per count and reports what the DB returned", async () => {
    const recorded: Recorded[] = [];
    mockDb(recorded, 7);

    // The fake rejects `count`/`findMany`, so reaching either would surface
    // here rather than as a silently different number.
    await expect(countClosedPrs(CTX, START, END)).resolves.toBe(7);

    expect(recorded).toHaveLength(1);
    // The whole point of the change: one row on the wire, no ordered slice to
    // co-locate twins inside, so no cap to under-report above.
    expect(recorded[0].text).toContain("SELECT COUNT(*)::int AS n");
    expect(recorded[0].text).toContain("SELECT DISTINCT");
    expect(recorded[0].text).not.toContain("ORDER BY");
    expect(recorded[0].text).not.toContain("LIMIT");
  });

  it("mirrors projectedPrIdentity's precedence and its truthiness guard", async () => {
    const recorded: Recorded[] = [];
    mockDb(recorded);

    await countClosedPrs(CTX, START, END);

    const { text } = recorded[0];
    // Same four tiers, in the same order: a repo full name case-folded with the
    // number, then the installation-repo surrogate, then the github node id,
    // then the row's own primary key.
    const tiers = ["'repo:'", "'repoId:'", "'gh:'", "'row:'"].map((tier) =>
      text.indexOf(tier)
    );
    expect(tiers.every((index) => index >= 0)).toBe(true);
    expect([...tiers].sort((a, b) => a - b)).toEqual(tiers);
    expect(text).toContain("lower(p.repository_full_name)");
    // The TS original tests truthiness, so an empty string falls through to the
    // next tier. A bare IS NOT NULL would key an empty repo name as `repo:#7`
    // and collapse every such row in the org onto one identity.
    expect(text).toContain("NULLIF(p.repository_full_name, '')");
    expect(text).toContain("NULLIF(p.github_id, '')");
    // The `#`||number component is what makes this identity PER-PR rather than
    // per-repo. Everything above it still holds if it is dropped, and the counts
    // then collapse every PR in a repo onto one identity — a silent 1-per-repo
    // prior/closed count. Pinned per tier, since each carries its own copy.
    expect(text).toContain(
      "lower(p.repository_full_name) || '#' || p.number::text"
    );
    expect(text).toContain("p.repository_id::text || '#' || p.number::text");
  });
});

describe("countDistinctPriorMergedPrs", () => {
  it("windows the prior merged population half-open on merged_at", async () => {
    const recorded: Recorded[] = [];
    mockDb(recorded, 3);

    await expect(countDistinctPriorMergedPrs(CTX, START, END)).resolves.toBe(3);

    const { text, values } = recorded[0];
    // Half-open [start, end) so the prior window cannot double-count the
    // boundary instant with the current one.
    expect(text).toContain("p.merged_at >= ");
    expect(text).toContain("p.merged_at < ");
    expect(text).not.toContain("p.merged_at <= ");
    expect(values).toContain(GitHubPRState.Merged);
    expect(values).toContain(START);
    expect(values).toContain(END);
  });

  it("reports no prior pull requests when there is no prior window", async () => {
    const recorded: Recorded[] = [];
    mockDb(recorded);

    await expect(countDistinctPriorMergedPrs(CTX, null, END)).resolves.toBe(0);

    expect(vi.mocked(withDb)).not.toHaveBeenCalled();
    expect(recorded).toEqual([]);
  });
});

describe("countClosedPrs", () => {
  it("windows the closed side on the branch artifact, never the nullable closedAt", async () => {
    const recorded: Recorded[] = [];
    mockDb(recorded);

    await countClosedPrs(CTX, START, END);

    const { text, values } = recorded[0];
    // FEA-3208: `closed_at` is nullable, so windowing on it silently drops a
    // genuinely-CLOSED PR whose timestamp was never populated and inflates the
    // merge rate. The null-safe analogue is the branch artifact's created_at.
    expect(text).toContain("a.created_at >= ");
    expect(text).toContain("a.created_at <= ");
    expect(text).not.toContain("p.closed_at");
    expect(values).toContain(GitHubPRState.Closed);
  });
});

describe("the distinct-PR counts' tenant scope", () => {
  it("scopes org-wide reads to the organization", async () => {
    const recorded: Recorded[] = [];
    mockDb(recorded);

    await countClosedPrs(CTX, START, END);

    expect(recorded[0].text).toContain("a.organization_id = ");
    expect(recorded[0].values).toContain(ORG);
    expect(recorded[0].values).not.toContain(USER);
  });

  it("narrows the Me scope to the requesting user's artifacts", async () => {
    const recorded: Recorded[] = [];
    mockDb(recorded);

    await countClosedPrs({ ...CTX, scope: InsightsScope.Me }, START, END);

    expect(recorded[0].text).toContain("a.created_by_id = ");
    expect(recorded[0].values).toContain(ORG);
    expect(recorded[0].values).toContain(USER);
  });

  it("narrows the Team scope to that team's members", async () => {
    const recorded: Recorded[] = [];
    mockDb(recorded);

    await countClosedPrs(
      { ...CTX, scope: InsightsScope.Team, teamId: TEAM },
      START,
      END
    );

    expect(recorded[0].text).toContain("FROM team_members tm");
    expect(recorded[0].values).toContain(TEAM);
    // These are tenant reads (apps/api/AGENTS.md): the team filter narrows WITHIN
    // an org, it does not replace the org bound. Asserting only `team_members`
    // stays green if the Team branch loses `a.organization_id`, which would let a
    // count span organizations — the worst outcome available in this file.
    expect(recorded[0].text).toContain("a.organization_id");
    expect(recorded[0].values).toContain(ORG);
  });

  it("matches nothing for a Team scope with no team", async () => {
    const recorded: Recorded[] = [];
    mockDb(recorded);

    await countClosedPrs({ ...CTX, scope: InsightsScope.Team }, START, END);

    // Mirrors artifactScope's `id: { in: [] }` — a team-less team scope reads
    // as no artifacts, never as the whole org.
    expect(recorded[0].text).toContain("false");
    expect(recorded[0].values).not.toContain(ORG);
  });
});
