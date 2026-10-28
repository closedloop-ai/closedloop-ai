/**
 * The Delivery view's merged-PR population queries.
 *
 * The distinct-PR count (ISS-5411, moved into SQL by ISS-5624) is what the
 * profile's PRs-landed figure still reads; the Delivery tiles read the shared
 * fold instead (ISS-12408, `delivery-pull-request-facts.test.ts`). The cases
 * drive the real query path against a fake `$queryRaw` and assert on the
 * statement it emits: that the row scan is gone, that the count is taken as the
 * DB reports it, that the identity expression mirrors `projectedPrIdentity`,
 * and that the scan keeps its scope and window.
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
  censusMergedPrVerification,
  countDistinctMergedPrsFrom,
  fetchMergedPrs,
  MERGED_PR_SCAN_CAP,
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

// The org-wide scope arm, which compares the column to a BOUND org id. The
// membership EXISTS's `al.`/`sa.` columns have no word boundary before their `a`,
// and the Wrote EXISTS compares `a.organization_id` to another column, not to a
// bound value (ISS-11589).
const TENANT_SCOPE_ARM_RE = /\ba\.organization_id = ::uuid/;

describe("countDistinctPrs — one aggregate, no row scan (ISS-5624; the profile's PRs landed)", () => {
  it("issues a single statement per count and reports what the DB returned", async () => {
    const recorded: Recorded[] = [];
    mockDb(recorded, 7);

    // The fake rejects `count`/`findMany`, so reaching either would surface
    // here rather than as a silently different number.
    await expect(countDistinctMergedPrsFrom(CTX, START)).resolves.toBe(7);

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

    await countDistinctMergedPrsFrom(CTX, START);

    const { text } = recorded[0];
    // Same four tiers, in the same order: an installed or row repo full name
    // case-folded with the number, then the installation-repo surrogate, then
    // the github node id, then the row's own primary key.
    const tiers = ["'repo:'", "'repoId:'", "'gh:'", "'row:'"].map((tier) =>
      text.indexOf(tier)
    );
    expect(tiers.every((index) => index >= 0)).toBe(true);
    expect([...tiers].sort((a, b) => a - b)).toEqual(tiers);
    expect(text).toContain("LEFT JOIN github_installation_repositories");
    expect(text.indexOf("NULLIF(pr_repository.full_name, '')")).toBeLessThan(
      text.indexOf("NULLIF(p.repository_full_name, '')")
    );
    expect(text).toContain("lower(COALESCE(");
    // The TS original tests truthiness, so an empty string falls through to the
    // next tier. A bare IS NOT NULL would key an empty repo name as `repo:#7`
    // and collapse every such row in the org onto one identity.
    expect(text).toContain("NULLIF(p.repository_full_name, '')");
    expect(text).toContain("NULLIF(pr_repository.full_name, '')");
    expect(text).toContain("NULLIF(p.github_id, '')");
    // The `#`||number component is what makes this identity PER-PR rather than
    // per-repo. Everything above it still holds if it is dropped, and the counts
    // then collapse every PR in a repo onto one identity — a silent 1-per-repo
    // prior/closed count. Pinned per tier, since each carries its own copy.
    expect(text).toContain(")) || '#' || p.number::text");
    expect(text).toContain("p.repository_id::text || '#' || p.number::text");
  });
});

describe("fetchMergedPrs", () => {
  it("applies exact org merged-PR admission before capping the materialized scan", async () => {
    const admitted = mergedPrRow({ id: "admitted-pr", number: 1 });
    const recorded: Recorded[] = [];
    const queryRaw = vi.fn((sql: unknown) => {
      recorded.push(flattenRawSql(sql));
      return Promise.resolve([{ id: admitted.id }]);
    });
    const findMany = vi.fn((args: unknown) => {
      expect(args).toMatchObject({
        where: { id: { in: [admitted.id] } },
      });
      return Promise.resolve([admitted]);
    });
    vi.mocked(withDb).mockImplementation((cb) =>
      Promise.resolve(
        cb({
          $queryRaw: queryRaw,
          pullRequestDetail: { findMany },
        } as never)
      )
    );

    await expect(fetchMergedPrs(CTX, START, END)).resolves.toEqual([admitted]);

    expect(queryRaw).toHaveBeenCalledOnce();
    expect(recorded[0].text).toContain("SELECT p.id");
    expect(recorded[0].text).toContain("FROM pull_request_detail p");
    expect(recorded[0].text).toContain("FROM artifact_links al");
    expect(recorded[0].text).toContain("ORDER BY p.merged_at DESC");
    expect(recorded[0].text).toContain("LIMIT ");
    expect(recorded[0].values).toContain(MERGED_PR_SCAN_CAP);
    expect(findMany).toHaveBeenCalledOnce();
  });

  it("skips hydration when the admitted scan is empty", async () => {
    const queryRaw = vi.fn().mockResolvedValue([]);
    const findMany = vi.fn();
    vi.mocked(withDb).mockImplementation((cb) =>
      Promise.resolve(
        cb({
          $queryRaw: queryRaw,
          pullRequestDetail: { findMany },
        } as never)
      )
    );

    await expect(fetchMergedPrs(CTX, START, END)).resolves.toEqual([]);

    expect(findMany).not.toHaveBeenCalled();
  });
});

describe("the Wrote-session scope (ISS-11589)", () => {
  it("restricts the PR population to a Branch a session wrote to", async () => {
    const recorded: Recorded[] = [];
    mockDb(recorded);

    await countDistinctMergedPrsFrom(CTX, START);

    expect(recorded).toHaveLength(1);
    for (const statement of recorded) {
      expect(statement.text).toContain("al.branch_participation = ");
    }
  });
});

describe("the distinct-PR counts' tenant scope", () => {
  it("scopes org-wide reads to the organization", async () => {
    const recorded: Recorded[] = [];
    mockDb(recorded);

    await countDistinctMergedPrsFrom(CTX, START);

    expect(recorded[0].text).toContain("a.organization_id = ");
    expect(recorded[0].values).toContain(ORG);
    expect(recorded[0].values).not.toContain(USER);
  });

  it("narrows the Me scope to the requesting user's artifacts", async () => {
    const recorded: Recorded[] = [];
    mockDb(recorded);

    await countDistinctMergedPrsFrom(
      { ...CTX, scope: InsightsScope.Me },
      START
    );

    expect(recorded[0].text).toContain("a.created_by_id = ");
    expect(recorded[0].values).toContain(ORG);
    expect(recorded[0].values).toContain(USER);
  });

  it("narrows the Team scope to that team's members", async () => {
    const recorded: Recorded[] = [];
    mockDb(recorded);

    await countDistinctMergedPrsFrom(
      { ...CTX, scope: InsightsScope.Team, teamId: TEAM },
      START
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

    await countDistinctMergedPrsFrom(
      { ...CTX, scope: InsightsScope.Team },
      START
    );

    // Mirrors artifactScope's `id: { in: [] }` — a team-less team scope reads
    // as no artifacts, never as the whole org. The org id IS bound in the
    // statement since cr-96292 — the membership EXISTS is org-scoped
    // (`al.organization_id`) for index reachability — so the pin is on the
    // scope arm's text: it must stay `false` and never emit the tenant-wide
    // `a.organization_id` arm (the membership EXISTS's `al.`/`sa.` org checks
    // are different columns and deliberately survive this assertion).
    expect(recorded[0].text).toContain("false");
    expect(recorded[0].text).not.toMatch(TENANT_SCOPE_ARM_RE);
  });
});

function mergedPrRow(overrides: Partial<ReturnType<typeof baseMergedPrRow>>) {
  return { ...baseMergedPrRow(), ...overrides };
}

function baseMergedPrRow() {
  return {
    id: "pr-1",
    number: 1,
    githubId: "github-pr-1",
    mergedAt: new Date("2026-05-15T00:00:00.000Z"),
    prState: GitHubPRState.Merged,
    lastVerifiedAt: new Date("2026-05-15T01:00:00.000Z"),
    repositoryId: "repo-1",
    repositoryFullName: "closedloop-ai/closedloop-ai",
    branchArtifactId: "branch-1",
    repository: {
      name: "closedloop-ai",
      fullName: "closedloop-ai/closedloop-ai",
    },
    branchArtifact: {
      id: "branch-1",
      createdAt: new Date("2026-05-14T00:00:00.000Z"),
      _count: { pullRequestDetails: 2 },
    },
    additions: 10,
    deletions: 2,
  };
}

/**
 * ISS-8424: the verification census. Its whole job is to see the rows the
 * org-merged population EXCLUDES, so the one thing it must not do is apply the
 * verified predicate to BOTH probes — that would make the two answers equal by
 * construction and the unmeasured state unreachable.
 */
const VERIFIED_CLAUSE_RE = /p\.last_verified_at IS NOT NULL/g;

describe("censusMergedPrVerification", () => {
  it("probes session linkage and verification separately, in one statement", async () => {
    const recorded: Recorded[] = [];
    mockDb(recorded);

    await censusMergedPrVerification(CTX, START, END);

    // One statement, not two round trips.
    expect(recorded).toHaveLength(1);
    const text = recorded[0]?.text ?? "";
    // Exactly ONE mention, in the verified probe. Two would mean the linked
    // probe had been given the verified predicate as well.
    expect(text.match(VERIFIED_CLAUSE_RE)).toHaveLength(1);
    expect(text).toContain('AS "hasSessionLinkedMergedPrs"');
    expect(text).toContain('AS "hasVerifiedMergedPrs"');
    // EXISTS, not an outer COUNT: the caller only asks whether each population
    // is non-empty. The legacy one-branch fallback still carries its scoped
    // sibling COUNT inside the shared membership predicate.
    expect(text).not.toContain("SELECT COUNT(*)::int AS n");
    // The session-link arm the population is defined by is still applied, so
    // the census speaks about the same universe the tiles do.
    expect(text).toContain("FROM artifact_links al");
    // Windowed like every other merged-PR read in the response.
    expect(text).toContain("p.merged_at >=");
  });

  it("reports both probes as the DB returned them", async () => {
    vi.mocked(withDb).mockImplementation((cb) =>
      Promise.resolve(
        cb({
          $queryRaw: () =>
            Promise.resolve([
              { hasSessionLinkedMergedPrs: true, hasVerifiedMergedPrs: false },
            ]),
        } as never)
      )
    );

    await expect(censusMergedPrVerification(CTX, START, END)).resolves.toEqual({
      hasSessionLinkedMergedPrs: true,
      hasVerifiedMergedPrs: false,
    });
  });

  it("reads an empty result as false on both sides rather than throwing", async () => {
    vi.mocked(withDb).mockImplementation((cb) =>
      Promise.resolve(cb({ $queryRaw: () => Promise.resolve([]) } as never))
    );

    // False on BOTH sides is the pre-ISS-8424 render, not the unmeasured one:
    // a census that could not be taken must not blank a live dashboard.
    await expect(censusMergedPrVerification(CTX, START, END)).resolves.toEqual({
      hasSessionLinkedMergedPrs: false,
      hasVerifiedMergedPrs: false,
    });
  });

  it("scopes the census to the requesting tenant", async () => {
    const recorded: Recorded[] = [];
    mockDb(recorded);

    await censusMergedPrVerification(CTX, START, END);

    // The emitted TEXT, not just the bound values (cr, review-soul): the
    // session-link EXISTS binds the org id twice on its own, so a values-only
    // assertion stays green with `artifactScopeSql` deleted outright.
    expect(recorded[0]?.text).toMatch(TENANT_SCOPE_ARM_RE);
    expect(recorded[0]?.values).toContain(ORG);
  });

  it("narrows a Me-scope census to the requesting user", async () => {
    const recorded: Recorded[] = [];
    mockDb(recorded);

    await censusMergedPrVerification(
      { ...CTX, scope: InsightsScope.Me },
      START,
      END
    );

    // Without this the census would decide measured/unmeasured from rows the
    // reader's own scope never counts.
    expect(recorded[0]?.text).toContain("a.created_by_id");
    expect(recorded[0]?.values).toContain(USER);
  });

  it("windows the census on the range the merged reads take", async () => {
    const recorded: Recorded[] = [];
    mockDb(recorded);

    await censusMergedPrVerification(CTX, START, END);

    // An all-time census would let one old verified row make a window whose
    // merges are all unverified print a confident 0.
    expect(recorded[0]?.text).toContain("p.merged_at >=");
    expect(recorded[0]?.values).toContain(START);
    expect(recorded[0]?.values).toContain(END);
  });
});
