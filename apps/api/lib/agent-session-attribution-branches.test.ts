/**
 * Branch coverage for private helpers in `agent-session-attribution.ts` that
 * the sibling `agent-session-attribution.test.ts` does not reach: the
 * org/branch dedupe filters, the same-branch-artifact merge path, the legacy
 * unique-PR fallback's own field-resolution branches, the PR-purpose
 * precedence ladder, and the artifact-usage-share early exits. Mocking
 * pattern mirrors the sibling file exactly.
 */

import {
  SessionArtifactLinkKind,
  SessionPrRelationType,
} from "@repo/api/src/types/session-artifact-link";
import { describe, expect, it, vi } from "vitest";

let pageRows: unknown[] = [];
const tokenUsageRows = vi.hoisted(() => ({ rows: [] as unknown[] }));

vi.mock("./agent-session-attribution-read", () => ({
  readSessionAttributionRecords: vi.fn(() => Promise.resolve(pageRows)),
}));

vi.mock("@repo/database", () => ({
  withDb: vi.fn((callback: (db: unknown) => unknown) =>
    callback({
      agentSessionTokenUsage: {
        findMany: vi.fn(() => Promise.resolve(tokenUsageRows.rows)),
      },
    })
  ),
}));

const {
  aggregateSessionAttributionLenses,
  aggregateArtifactUsageByTargetShare,
} = await import("./agent-session-attribution");

const ORG_ID = "org-1";
const REPO = "acme/web";
const VERIFIED_AT = new Date("2026-08-17T12:00:00.000Z");

function prDetail(prNumber: number, repositoryFullName = REPO) {
  return {
    number: prNumber,
    title: `PR ${prNumber}`,
    isCurrent: true,
    lastVerifiedAt: VERIFIED_AT,
    repositoryFullName,
    repository: { fullName: repositoryFullName },
  };
}

/** One session with a single command-derived PR ref on its own branch. */
function prOnlySession(
  sessionId: string,
  prNumber: number,
  relationTypes: SessionPrRelationType[]
) {
  const detail = prDetail(prNumber);
  return {
    artifactId: sessionId,
    inputTokens: 1n,
    outputTokens: 1n,
    cacheReadTokens: 0n,
    cacheWriteTokens: 0n,
    estimatedCost: 0,
    artifact: {
      organizationId: ORG_ID,
      sourceLinks: [
        {
          metadata: {
            linkKind: SessionArtifactLinkKind.SessionPr,
            prRefs: [{ repositoryFullName: REPO, prNumber, relationTypes }],
          },
          targetId: `branch-${sessionId}`,
          target: {
            organizationId: ORG_ID,
            branch: {
              branchName: `feat/${sessionId}`,
              repository: { fullName: REPO },
              currentPullRequestDetail: detail,
            },
            pullRequestDetails: [detail],
          },
        },
      ],
    },
  };
}

describe("dedupeSessionBranches org-scoping and branch-presence filters", () => {
  it("drops a cross-org source link and a branch-less source link, leaving no branches", async () => {
    pageRows = [
      {
        artifactId: "session-filtered",
        inputTokens: 1n,
        outputTokens: 1n,
        cacheReadTokens: 0n,
        cacheWriteTokens: 0n,
        estimatedCost: 0,
        artifact: {
          organizationId: ORG_ID,
          sourceLinks: [
            {
              // Cross-org: the link target belongs to a different org than
              // the session's own artifact, so it must never contribute.
              metadata: { linkKind: SessionArtifactLinkKind.SessionPr },
              targetId: "branch-other-org",
              target: {
                organizationId: "org-other",
                branch: {
                  branchName: "feat/other-org",
                  repository: { fullName: REPO },
                  currentPullRequestDetail: null,
                },
                pullRequestDetails: [],
              },
            },
            {
              // Same org, but the target artifact carries no branch at all
              // (e.g. a session-PR link with no linked branch).
              metadata: { linkKind: SessionArtifactLinkKind.SessionPr },
              targetId: "branch-missing",
              target: {
                organizationId: ORG_ID,
                branch: null,
                pullRequestDetails: [],
              },
            },
          ],
        },
      },
    ];

    const lenses = await aggregateSessionAttributionLenses("org-1", {});

    expect(lenses).toEqual({ byBranch: [], byPr: [] });
  });
});

describe("dedupeSessionBranches merges two source links pointing at the same branch artifact", () => {
  it("merges PR refs by identity, keeps the stronger purpose on a collision, and falls back repositoryFullName to null with no repository", async () => {
    const detailOne = prDetail(1);
    const detailTwo = prDetail(2);
    pageRows = [
      {
        artifactId: "session-merge",
        inputTokens: 4n,
        outputTokens: 2n,
        cacheReadTokens: 0n,
        cacheWriteTokens: 0n,
        estimatedCost: 0,
        artifact: {
          organizationId: ORG_ID,
          sourceLinks: [
            {
              metadata: {
                linkKind: SessionArtifactLinkKind.SessionPr,
                prRefs: [
                  {
                    repositoryFullName: REPO,
                    prNumber: 1,
                    relationTypes: [SessionPrRelationType.Reviewed],
                  },
                ],
              },
              targetId: "branch-shared",
              target: {
                organizationId: ORG_ID,
                branch: {
                  branchName: "feat/shared",
                  // No repository on the branch itself.
                  repository: null,
                  currentPullRequestDetail: detailOne,
                },
                pullRequestDetails: [detailOne, detailTwo],
              },
            },
            {
              // Second observation of the SAME branch artifact: re-declares
              // PR 1 with a weaker purpose (must not downgrade) and adds PR 2.
              metadata: {
                linkKind: SessionArtifactLinkKind.SessionPr,
                prRefs: [
                  {
                    repositoryFullName: REPO,
                    prNumber: 1,
                    relationTypes: [SessionPrRelationType.Referenced],
                  },
                  {
                    repositoryFullName: REPO,
                    prNumber: 2,
                    relationTypes: [SessionPrRelationType.Referenced],
                  },
                ],
              },
              targetId: "branch-shared",
              target: {
                organizationId: ORG_ID,
                branch: {
                  branchName: "feat/shared",
                  repository: null,
                  currentPullRequestDetail: detailOne,
                },
                pullRequestDetails: [detailOne, detailTwo],
              },
            },
          ],
        },
      },
    ];

    const lenses = await aggregateSessionAttributionLenses("org-1", {});

    expect(lenses.byBranch).toHaveLength(1);
    expect(lenses.byBranch[0]?.repositoryFullName).toBeNull();

    const byPrNumber = new Map(lenses.byPr.map((pr) => [pr.prNumber, pr]));
    expect(byPrNumber.get(1)?.purpose).toBe("reviewed");
    expect(byPrNumber.get(2)?.purpose).toBe("referenced");
  });
});

describe("uniqueLegacyPrRef field-resolution and identity-count branches", () => {
  it("skips a zero-numbered detail rather than attributing PR #0", async () => {
    // `number: 0` passes the outer `!= null` filter (0 is not null) and must
    // then fail the inner truthiness guard. The fixture leaves exactly one
    // other identity, so keeping PR #0 would make two survivors and the
    // "exactly one" guard would report no PR at all.
    pageRows = [
      legacySession("session-zero", {
        currentPullRequestDetail: {
          number: 0,
          repository: { fullName: REPO },
          repositoryFullName: null,
        },
        pullRequestDetails: [prDetail(8)],
      }),
    ];

    const lenses = await aggregateSessionAttributionLenses("org-1", {});

    expect(lenses.byPr).toHaveLength(1);
    expect(lenses.byPr[0]?.prNumber).toBe(8);
    expect(lenses.byPr[0]?.repositoryFullName).toBe(REPO);
  });

  it("drops a detail whose repository name resolves from no source in the fallback chain", async () => {
    // Both detail-level sources are absent AND `legacySession`'s branch
    // carries no repository, so every fallback is exhausted and the detail
    // must be skipped. Admitting it as an unnamed repository would be a
    // second survivor and collapse the single-identity result to none.
    pageRows = [
      legacySession("session-unresolvable", {
        currentPullRequestDetail: {
          number: 9,
          repository: null,
          repositoryFullName: null,
        },
        pullRequestDetails: [prDetail(11)],
      }),
    ];

    const lenses = await aggregateSessionAttributionLenses("org-1", {});

    expect(lenses.byPr).toHaveLength(1);
    expect(lenses.byPr[0]?.prNumber).toBe(11);
    expect(lenses.byPr[0]?.repositoryFullName).toBe(REPO);
  });

  it("walks the repositoryFullName fallback and fails closed on more than one surviving identity", async () => {
    // repository.fullName is absent, so this one resolves through the
    // detail's own repositoryFullName field.
    const viaDetailRepositoryFullName = {
      number: 8,
      repository: null,
      repositoryFullName: "legacy/repo",
    };

    pageRows = [
      legacySession("session-legacy", {
        currentPullRequestDetail: null,
        pullRequestDetails: [viaDetailRepositoryFullName, prDetail(10)],
      }),
    ];

    const lenses = await aggregateSessionAttributionLenses("org-1", {});

    // Two distinct identities survived resolution (legacy/repo#8 and
    // acme/web#10), so the "exactly one" legacy-fallback guard refuses to
    // guess and reports no PR at all for this branch. Drop the
    // repositoryFullName fallback and #8 disappears, leaving one survivor
    // and a non-empty byPr.
    expect(lenses.byPr).toEqual([]);
    expect(lenses.byBranch).toHaveLength(1);
  });
});

describe("chooseStrongerSessionPrPurpose precedence across repeated cross-session PR merges", () => {
  it("keeps the strongest purpose seen so far rather than the most recent one", async () => {
    pageRows = [
      // Identity acme/web#42: Referenced, then Reviewed (upgrades), then
      // Referenced again (must NOT downgrade back).
      prOnlySession("s1", 42, [SessionPrRelationType.Referenced]),
      prOnlySession("s2", 42, [SessionPrRelationType.Reviewed]),
      prOnlySession("s3", 42, [SessionPrRelationType.Referenced]),
      // Identity acme/web#43: Unknown, then Referenced (upgrades), then
      // Referenced again (stays, short-circuiting on the left operand).
      prOnlySession("t1", 43, []),
      prOnlySession("t2", 43, [SessionPrRelationType.Referenced]),
      prOnlySession("t3", 43, [SessionPrRelationType.Referenced]),
      // Identity acme/web#44: Unknown merged with Unknown stays Unknown.
      prOnlySession("u1", 44, []),
      prOnlySession("u2", 44, []),
    ];

    const lenses = await aggregateSessionAttributionLenses("org-1", {});

    const byPrNumber = new Map(lenses.byPr.map((pr) => [pr.prNumber, pr]));
    expect(byPrNumber.get(42)?.purpose).toBe("reviewed");
    expect(byPrNumber.get(43)?.purpose).toBe("referenced");
    expect(byPrNumber.get(44)?.purpose).toBe("unknown");
  });
});

describe("accumulateArtifactUsageSession excludes sessions with no matching target branch", () => {
  it("omits a session from totals and shares when none of its branches match the target artifact, and drops a token row with no matching session share", async () => {
    pageRows = [
      prOnlySession("session-match", 1, [SessionPrRelationType.Created]),
    ];
    // The matched session's branch artifact id, distinct from the target we
    // ask for below, so this session is dedupe-visible but not the target.
    tokenUsageRows.rows = [
      {
        agentSessionId: "session-match",
        model: "claude",
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        estimatedCost: 1,
      },
      {
        // No session ever produced a share under this id.
        agentSessionId: "session-unknown",
        model: "claude",
        inputTokens: 999,
        outputTokens: 999,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        estimatedCost: 99,
      },
    ];

    const summary = await aggregateArtifactUsageByTargetShare({
      artifactId: "artifact-1",
      artifactSlug: "ART-1",
      organizationId: ORG_ID,
      sessionArtifactIds: ["session-match"],
      targetArtifactId: "branch-does-not-exist",
    });

    // The session's only branch is `branch-session-match`, never the target,
    // so accumulateArtifactUsageSession's early return excludes it entirely.
    expect(summary.sessionCount).toBe(0);
    // Both token rows are dropped: the matched session was never added to
    // sessionShares (excluded above), and the second row's id never had one.
    expect(summary.byModel).toEqual([]);
  });
});

/**
 * One session whose single source link carries no `prRefs`, so it classifies
 * as Legacy and takes the unique-branch-PR fallback. The branch itself carries
 * no repository, leaving the last link in the repository-name fallback chain
 * exhausted for every detail the caller supplies.
 */
function legacySession(
  sessionId: string,
  details: {
    currentPullRequestDetail: unknown;
    pullRequestDetails: unknown[];
  }
) {
  return {
    artifactId: sessionId,
    inputTokens: 1n,
    outputTokens: 1n,
    cacheReadTokens: 0n,
    cacheWriteTokens: 0n,
    estimatedCost: 0,
    artifact: {
      organizationId: ORG_ID,
      sourceLinks: [
        {
          metadata: { linkKind: SessionArtifactLinkKind.SessionPr },
          targetId: `branch-${sessionId}`,
          target: {
            organizationId: ORG_ID,
            branch: {
              branchName: `feat/${sessionId}`,
              repository: null,
              currentPullRequestDetail: details.currentPullRequestDetail,
            },
            pullRequestDetails: details.pullRequestDetails,
          },
        },
      ],
    },
  };
}
