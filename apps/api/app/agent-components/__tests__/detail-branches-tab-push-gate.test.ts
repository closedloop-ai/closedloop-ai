/**
 * ISS-8148 (PRD-683 D7), behind the `branch-push-evidence-exclusion` flag:
 * with the gate ON the agent-component detail excludes a branch with no push
 * evidence from BOTH attribution reads — the branches tab and the usage-row
 * branch-name fallback — and with it OFF both keep the pre-ISS-8148
 * population. The fake findMany HONORS the query's `target.branch` predicate
 * over seeded pushed/unpushed rows — dropping the filter at the call site
 * returns the local-only row and fails the matching assertion, so this cannot
 * go green on wiring alone. Since ISS-9114 one read serves both halves, so the
 * two populations agree by construction rather than by two matching predicates.
 */
import { ArtifactType } from "@repo/api/src/types/artifact";
import { SessionArtifactLinkKind } from "@repo/api/src/types/session-artifact-link";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listByArtifactIds: vi.fn(),
  artifactLinkFindMany: vi.fn(),
}));

vi.mock("../../agent-sessions/service", () => ({
  agentSessionsService: { listByArtifactIds: mocks.listByArtifactIds },
}));

import { resolveDetailSessionTabs } from "../service/detail-session-tabs";

const ORGANIZATION_ID = "org-push-gate";

type SeededBranchRow = {
  evidence: {
    firstPushedAt: Date | null;
    pushSource: string | null;
    /** A `pull_request_detail` row keyed to this branch's artifact exists. */
    hasPullRequestRow: boolean;
  };
  row: {
    target: {
      id: string;
      slug: string | null;
      branch: {
        artifactId: string;
        branchName: string;
        repositoryFullName: string | null;
        baseBranch: string | null;
        lastActivityAt: Date | null;
        firstPushedAt: Date | null;
      };
    };
  };
};

function seededBranch(
  artifactId: string,
  branchName: string,
  evidence: SeededBranchRow["evidence"]
): SeededBranchRow {
  return {
    evidence,
    row: {
      target: {
        id: artifactId,
        slug: null,
        branch: {
          artifactId,
          branchName,
          repositoryFullName: "acme/web",
          baseBranch: null,
          lastActivityAt: null,
          firstPushedAt: evidence.firstPushedAt,
        },
      },
    },
  };
}

const SEEDED: SeededBranchRow[] = [
  seededBranch("branch-pushed", "feat/pushed", {
    firstPushedAt: new Date("2026-08-20T00:00:00.000Z"),
    pushSource: "session",
    hasPullRequestRow: false,
  }),
  seededBranch("branch-pr", "feat/with-pr", {
    firstPushedAt: null,
    pushSource: null,
    hasPullRequestRow: true,
  }),
  seededBranch("branch-local", "feat/local-only", {
    firstPushedAt: null,
    pushSource: null,
    hasPullRequestRow: false,
  }),
];

/** Session → branch links the attribution query joins. */
const LINKED_SESSIONS: ReadonlyArray<readonly [string, string]> = [
  ["session-pushed", "branch-pushed"],
  ["session-local", "branch-local"],
  ["session-pr", "branch-pr"],
];

/**
 * ISS-9114: one read now answers both halves, so a seeded row carries the UNION
 * projection — the link's `sourceId`/`metadata` for the branch-name map plus the
 * target identity the branches tab renders.
 */
function attributionRow(sourceId: string, seeded: SeededBranchRow) {
  return {
    sourceId,
    metadata: {
      linkKind: SessionArtifactLinkKind.SessionBranch,
      branchName: seeded.row.target.branch.branchName,
    },
    target: {
      id: seeded.row.target.id,
      slug: seeded.row.target.slug,
      type: ArtifactType.Branch,
      branch: seeded.row.target.branch,
    },
  };
}

/**
 * A RelatesTo link to a non-Branch target. The merged read's `where` only
 * constrains `target.type` under the push gate, so with the gate OFF this row
 * comes back and must be dropped from the branches tab — the narrowing the
 * second query used to do in SQL.
 */
const NON_BRANCH_ROW = {
  sourceId: "session-pushed",
  metadata: { linkKind: SessionArtifactLinkKind.SessionBranch },
  target: {
    id: "doc-1",
    slug: "doc-1",
    type: ArtifactType.Document,
    branch: null,
  },
};

/** Apply the query's `target.branch` predicate the way Postgres would. */
function matchesPushEvidence(
  evidence: SeededBranchRow["evidence"],
  branchWhere: {
    OR?: Array<{
      firstPushedAt?: { not?: unknown };
      pushSource?: { in?: string[] };
      artifact?: { pullRequestDetails?: { some?: unknown } };
    }>;
  }
): boolean {
  const arms = branchWhere.OR;
  if (!Array.isArray(arms)) {
    return true;
  }
  return arms.some((arm) => {
    if (arm.firstPushedAt) {
      return (
        evidence.firstPushedAt !== null &&
        (!arm.pushSource?.in ||
          (evidence.pushSource !== null &&
            arm.pushSource.in.includes(evidence.pushSource)))
      );
    }
    // The branch-scoped PR-row scan (ISS-8148 review): a PR row keyed to this
    // branch's artifact, never the unconstrained current-PR pointer.
    if (arm.artifact?.pullRequestDetails?.some !== undefined) {
      return evidence.hasPullRequestRow;
    }
    return false;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listByArtifactIds.mockResolvedValue([]);
  mocks.artifactLinkFindMany.mockImplementation(
    (args: {
      where?: {
        target?: { type?: string; branch?: { is?: Record<string, unknown> } };
      };
    }) => {
      const targetWhere = args?.where?.target;
      const branchWhere = targetWhere?.branch?.is ?? {};
      const surviving = SEEDED.filter((seeded) =>
        matchesPushEvidence(seeded.evidence, branchWhere)
      );
      const branchRows = LINKED_SESSIONS.flatMap(([sourceId, artifactId]) => {
        const seeded = surviving.find(
          (s) => s.row.target.branch.artifactId === artifactId
        );
        return seeded ? [attributionRow(sourceId, seeded)] : [];
      });
      // Flag OFF sends no target predicate at all, so the non-Branch link is in
      // scope; flag ON narrows to Branch targets in SQL.
      if (targetWhere?.type === ArtifactType.Branch) {
        return Promise.resolve(branchRows);
      }
      return Promise.resolve([NON_BRANCH_ROW, ...branchRows]);
    }
  );
});

describe("ISS-8148 detail branchesTab push gate", () => {
  it("renders push-evidenced branches and excludes the local-only row", async () => {
    const db = {
      artifactLink: { findMany: mocks.artifactLinkFindMany },
    } as unknown as Parameters<typeof resolveDetailSessionTabs>[0];

    const { branchesTab } = await resolveDetailSessionTabs(
      db,
      ORGANIZATION_ID,
      new Map([["session-1", 1]]),
      true
    );

    const names = branchesTab.map((row) => row.branchName).sort();
    expect(names).toEqual(["feat/pushed", "feat/with-pr"]);
  });

  it("keeps the pre-ISS-8148 population when the flag is off", async () => {
    const db = {
      artifactLink: { findMany: mocks.artifactLinkFindMany },
    } as unknown as Parameters<typeof resolveDetailSessionTabs>[0];

    const { branchesTab, usageSessions } = await resolveDetailSessionTabs(
      db,
      ORGANIZATION_ID,
      new Map([
        ["session-pushed", 2],
        ["session-local", 3],
      ]),
      false
    );

    expect(branchesTab.map((row) => row.branchName).sort()).toEqual([
      "feat/local-only",
      "feat/pushed",
      "feat/with-pr",
    ]);
    const bySession = new Map(
      usageSessions.map((row) => [row.sessionId, row.branchName])
    );
    expect(bySession.get("session-local")).toBe("feat/local-only");
  });

  it("drops the excluded branch's name from usageSessions while keeping the pushed one", async () => {
    const db = {
      artifactLink: { findMany: mocks.artifactLinkFindMany },
    } as unknown as Parameters<typeof resolveDetailSessionTabs>[0];

    const { usageSessions } = await resolveDetailSessionTabs(
      db,
      ORGANIZATION_ID,
      new Map([
        ["session-pushed", 2],
        ["session-local", 3],
      ]),
      true
    );

    const bySession = new Map(
      usageSessions.map((row) => [row.sessionId, row.branchName])
    );
    expect(bySession.get("session-pushed")).toBe("feat/pushed");
    // The gate on the attribution query is what nulls this: removing
    // `branchPushEvidenceWhere()` from the branchLinks read renders
    // "feat/local-only" here and fails the assertion.
    expect(bySession.get("session-local")).toBeNull();
  });
});

/**
 * ISS-9114: the branch-name map and the branches tab were two
 * `artifactLink.findMany` calls over the same `{ organizationId, sourceId in …,
 * linkType }` core, differing only in `select` and re-joined in JS. One read
 * with the union projection answers both.
 */
const EXPECTED_ATTRIBUTION_READS = 1;

describe("ISS-9114 branch attribution read count", () => {
  it("resolves both attribution payloads from ONE artifactLink read", async () => {
    const db = {
      artifactLink: { findMany: mocks.artifactLinkFindMany },
    } as unknown as Parameters<typeof resolveDetailSessionTabs>[0];

    const { branchesTab, usageSessions } = await resolveDetailSessionTabs(
      db,
      ORGANIZATION_ID,
      new Map([["session-pushed", 1]]),
      true
    );

    expect(mocks.artifactLinkFindMany).toHaveBeenCalledTimes(
      EXPECTED_ATTRIBUTION_READS
    );
    // Both halves are still populated off that single read.
    expect(branchesTab.map((row) => row.branchName).sort()).toEqual([
      "feat/pushed",
      "feat/with-pr",
    ]);
    expect(usageSessions).toEqual([
      {
        sessionId: "session-pushed",
        branchName: "feat/pushed",
        invocationCount: 1,
      },
    ]);
  });
});
