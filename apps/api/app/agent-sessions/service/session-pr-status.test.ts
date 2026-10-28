/**
 * `toSessionPullRequestProjection` (ISS-11280 branch top-up) — this file's
 * first direct-unit coverage. The `agentSessionsService` route-level suites
 * (`projections.pull-requests.test.ts` and siblings) already drive this
 * function's main authored/legacy-dedup paths through the full
 * `findSessions` DB harness; this file calls it directly with a minimal
 * `AgentSessionListRecord`-shaped fixture to reach the producer-independent
 * repository-identity fallback inside `resolveTrustedPrDetail`, which none of
 * those route-level fixtures exercises (they always carry a `repository`
 * relation on both the branch and the PR detail).
 */
import { PullRequestState } from "@repo/api/src/types/document";
import {
  SessionArtifactLinkKind,
  SessionPrRelationType,
} from "@repo/api/src/types/session-artifact-link";
import { SessionPrLifecycleStatus } from "@repo/lib/session-trace/derivation";
import { describe, expect, it } from "vitest";
import type { AgentSessionListRecord } from "./records";
import { toSessionPullRequestProjection } from "./session-pr-status";

/**
 * `toSessionPullRequestProjection` reads only `pullRequests`, `repositoryFullName`,
 * and `artifact.sourceLinks` off its `AgentSessionListRecord` argument, so this
 * fixture deliberately types `sourceLinks` loosely rather than against the full
 * Prisma-generated select shape — every case below builds a minimal source link
 * with only the fields the function under test actually reads.
 */
function listRecord(overrides: {
  repositoryFullName?: string | null;
  pullRequests?: unknown[];
  artifact: { sourceLinks: unknown[] };
}): AgentSessionListRecord {
  return {
    pullRequests: [],
    repositoryFullName: null,
    ...overrides,
  } as unknown as AgentSessionListRecord;
}

describe("toSessionPullRequestProjection — producer-independent repository identity", () => {
  it("trusts a current PR detail resolved via repositoryFullName when neither side carries a `repository` relation", () => {
    // FEA-2732: a repo-less (non-App) PR has no `repository` relation on
    // either the branch or its PR detail, so `resolveTrustedPrDetail` must
    // fall back to the producer-independent `repositoryFullName` scalar on
    // BOTH sides rather than treating an absent relation as a repo mismatch.
    const record = listRecord({
      repositoryFullName: "acme/web",
      artifact: {
        sourceLinks: [
          {
            metadata: {
              linkKind: SessionArtifactLinkKind.SessionPr,
              relationTypes: [SessionPrRelationType.Created],
              repositoryFullName: "acme/web",
              prNumber: 55,
              source: "DETERMINISTIC",
              confidence: 1.0,
              extractorVersion: 1,
            },
            target: {
              branch: {
                currentPullRequestDetail: {
                  number: 55,
                  title: "Trusted via repositoryFullName",
                  prState: PullRequestState.Open,
                  closedAt: null,
                  mergedAt: null,
                  lastVerifiedAt: new Date("2026-05-20T17:09:00.000Z"),
                  isCurrent: true,
                  repositoryFullName: "acme/web",
                },
              },
            },
          },
        ],
      },
    });

    const result = toSessionPullRequestProjection(record);

    expect(result).toEqual({
      prs: [
        {
          num: 55,
          title: "Trusted via repositoryFullName",
          status: SessionPrLifecycleStatus.Open,
        },
      ],
      verifiedMergedCount: 0,
    });
  });

  it("does NOT trust the detail when the repo-less fallback disagrees with the link's declared repository", () => {
    // The mirror of the case above: same absent `repository` relations, but
    // the PR detail's producer-independent repo does not match the one the
    // session's own link declares, so the fallback must still reject it
    // rather than admitting a same-number PR from a different repository.
    const record = listRecord({
      repositoryFullName: "acme/web",
      artifact: {
        sourceLinks: [
          {
            metadata: {
              linkKind: SessionArtifactLinkKind.SessionPr,
              relationTypes: [SessionPrRelationType.Created],
              repositoryFullName: "acme/web",
              prNumber: 55,
              source: "DETERMINISTIC",
              confidence: 1.0,
              extractorVersion: 1,
            },
            target: {
              branch: {
                currentPullRequestDetail: {
                  number: 55,
                  title: "Wrong-repo detail",
                  prState: PullRequestState.Merged,
                  closedAt: null,
                  mergedAt: new Date("2026-05-20T17:10:00.000Z"),
                  lastVerifiedAt: new Date("2026-05-20T17:09:00.000Z"),
                  isCurrent: true,
                  repositoryFullName: "acme/other",
                },
              },
            },
          },
        ],
      },
    });

    const result = toSessionPullRequestProjection(record);

    expect(result).toEqual({
      prs: [
        {
          num: 55,
          title: "PR #55",
          status: SessionPrLifecycleStatus.Unknown,
        },
      ],
      verifiedMergedCount: 0,
    });
  });
});

describe("toSessionPullRequestProjection — historical pullRequestDetails repo fallback", () => {
  it("resolves a historical PR detail's repo from the BRANCH's repository when the detail itself carries neither, and skips a candidate with no PR number", () => {
    // FEA-4317: the branch's `pullRequestDetails[]` is the historical set —
    // separate from `currentPullRequestDetail` — that a session's authored-PR
    // placeholder (seeded with an Unknown status because the current pointer
    // carries no trusted detail) is later enriched against. `repository` is
    // absent on both the branch and the detail, so both
    // `collectVerifiedPrDetailsFromLink` (the enrichment pass) and
    // `collectBranchReachablePrEvidence` (the adjudication pass) must fall
    // back through `detail.repositoryFullName` to the branch's own
    // `repository.fullName` to resolve an identity at all. A sibling entry
    // with no PR number is included to pin that it is skipped rather than
    // crashing the loop.
    const record = listRecord({
      artifact: {
        sourceLinks: [
          {
            metadata: {
              linkKind: SessionArtifactLinkKind.SessionPr,
              relationTypes: [SessionPrRelationType.Created],
              repositoryFullName: "acme/web",
              prNumber: 77,
              source: "DETERMINISTIC",
              confidence: 1.0,
              extractorVersion: 1,
            },
            target: {
              branch: {
                repository: { fullName: "acme/web" },
                currentPullRequestDetail: null,
              },
              pullRequestDetails: [
                {
                  number: 77,
                  title: null,
                  prState: undefined,
                  closedAt: null,
                  mergedAt: new Date("2026-05-20T17:10:00.000Z"),
                  lastVerifiedAt: new Date("2026-05-20T17:09:00.000Z"),
                  isCurrent: false,
                },
                {
                  // No `number` at all: must be skipped, not crash the loop.
                  number: null,
                  title: "bogus",
                  prState: null,
                  closedAt: null,
                  mergedAt: null,
                  lastVerifiedAt: new Date("2026-05-20T17:09:00.000Z"),
                  isCurrent: false,
                },
              ],
            },
          },
        ],
      },
    });

    const result = toSessionPullRequestProjection(record);

    // pins current behavior: the historical detail's `mergedAt` alone (with a
    // `null` prState, since the fallback above only ever supplies `null`, not
    // a real GitHub state) is enough for the verified pass to settle the PR
    // as Merged, even though it started as an Unknown placeholder. Title
    // falls all the way through to `sessionPrWithLifecycle`'s own "PR #<n>"
    // default, since both the historical detail and the seeded placeholder
    // carry a null title.
    expect(result).toEqual({
      prs: [
        {
          num: 77,
          title: "PR #77",
          status: SessionPrLifecycleStatus.Merged,
        },
      ],
      verifiedMergedCount: 1,
    });
  });
});

describe("toSessionPullRequestProjection — ISS-4768 phantom-PR admission gate", () => {
  it("drops a legacy blob PR that a link adjudicated as Reviewed rather than Authored", () => {
    // The session's own link SPEAKS about PR #99 (it reviewed it), which is
    // enough to adjudicate the identity, but a review is not authorship — so
    // the desktop-reported legacy blob entry for the same PR must be dropped
    // rather than rendered as this session's own output.
    const record = listRecord({
      repositoryFullName: "acme/web",
      pullRequests: [
        {
          num: 99,
          title: "Phantom PR",
          status: SessionPrLifecycleStatus.Merged,
        },
      ],
      artifact: {
        sourceLinks: [
          {
            metadata: {
              linkKind: SessionArtifactLinkKind.SessionPr,
              relationTypes: [SessionPrRelationType.Reviewed],
              repositoryFullName: "acme/web",
              prNumber: 99,
              source: "DETERMINISTIC",
              confidence: 1.0,
              extractorVersion: 1,
            },
            target: {
              branch: {
                repository: { fullName: "acme/web" },
                currentPullRequestDetail: null,
              },
            },
          },
        ],
      },
    });

    const result = toSessionPullRequestProjection(record);

    expect(result).toEqual({ prs: [], verifiedMergedCount: 0 });
  });
});
