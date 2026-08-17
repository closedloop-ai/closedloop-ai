// FEA-4317: historical merged-PR resolution for the session→PR projection.
// A session can link a PR that is no longer its branch's CURRENT detail — a newer
// PR was raised from the same reused branch, moving `currentPullRequestDetail` to
// the new PR. The historical PR's verified merged/open/closed lifecycle lives only
// in the branch Artifact's historical `pullRequestDetails[]` set. These tests pin
// that `toSessionPullRequestProjection` resolves each linked PR to its OWN detail
// (current OR historical), preserving a verified historical `merged` outcome
// instead of erasing it back to `Unknown`. Split out of
// projections.pull-requests.test.ts to keep that file under the size ceiling.

import { ArtifactType } from "@repo/api/src/types/artifact";
import { PullRequestState } from "@repo/api/src/types/document";
import {
  SessionArtifactLinkKind,
  SessionPrRelationType,
} from "@repo/api/src/types/session-artifact-link";
import { SessionPrLifecycleStatus } from "@repo/lib/session-trace/derivation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildSessionListRecord,
  installDb,
} from "@/__tests__/support/agent-sessions/service.test-harness";
import { agentSessionsService } from "../service";

vi.mock("@repo/database", async () => {
  const { databaseModuleMock } = await import(
    "@/__tests__/support/agent-sessions/service.test-mocks"
  );
  return databaseModuleMock();
});

vi.mock("@repo/observability/telemetry/metrics", async () => {
  const { telemetryModuleMock } = await import(
    "@/__tests__/support/agent-sessions/service.test-mocks"
  );
  return telemetryModuleMock();
});

const REPO = "closedloop-ai/symphony-alpha";
const VERIFIED_AT = new Date("2026-07-26T09:01:00.000Z");
const MERGED_AT = new Date("2026-07-26T09:00:00.000Z");
// FEA-4317 (wongk review): the PR-opened timestamp. Present only when a producer
// actually OBSERVED the PR's lifecycle (webhook / `gh` fetch / App backfill), so a
// genuinely-observed OPEN detail carries it and can resolve to Open — while a
// desktop bare-ref default-OPEN row (no lifecycle signal at all) cannot.
const OPENED_AT = new Date("2026-07-26T08:00:00.000Z");

// A verified `currentPullRequestDetail` (the branch's current PR pointer).
// Defaults `githubCreatedAt` so a genuinely-observed current pointer carries the
// lifecycle-observed signal; pass `null` to model a default-only unobserved row.
function currentPrDetail(input: {
  number: number;
  title: string;
  prState: PullRequestState;
  mergedAt?: Date | null;
  closedAt?: Date | null;
  lastVerifiedAt?: Date | null;
  githubCreatedAt?: Date | null;
}) {
  return {
    number: input.number,
    title: input.title,
    prState: input.prState,
    closedAt: input.closedAt ?? null,
    mergedAt: input.mergedAt ?? null,
    lastVerifiedAt:
      input.lastVerifiedAt === undefined ? VERIFIED_AT : input.lastVerifiedAt,
    githubCreatedAt:
      input.githubCreatedAt === undefined ? OPENED_AT : input.githubCreatedAt,
    isCurrent: true,
    repository: { fullName: REPO },
  };
}

// A row in the branch Artifact's historical `pullRequestDetails[]` set: a
// superseded PR (`isCurrent: false`) whose verified lifecycle lives only here.
function historicalPrDetail(input: {
  number: number;
  title: string;
  prState: PullRequestState;
  mergedAt?: Date | null;
  closedAt?: Date | null;
  lastVerifiedAt?: Date | null;
  githubCreatedAt?: Date | null;
}) {
  return {
    number: input.number,
    title: input.title,
    prState: input.prState,
    closedAt: input.closedAt ?? null,
    mergedAt: input.mergedAt ?? null,
    lastVerifiedAt:
      input.lastVerifiedAt === undefined ? VERIFIED_AT : input.lastVerifiedAt,
    githubCreatedAt:
      input.githubCreatedAt === undefined ? OPENED_AT : input.githubCreatedAt,
    isCurrent: false,
    additions: null,
    deletions: null,
    repositoryFullName: REPO,
    repository: { fullName: REPO },
  };
}

// A session→PR sourceLink whose branch carries BOTH a current pointer and a
// historical `pullRequestDetails[]` set — the reused-branch shape FEA-4317 targets.
function reusedBranchSourceLink(input: {
  prNumber: number;
  relationType?: SessionPrRelationType;
  current: ReturnType<typeof currentPrDetail>;
  historical: ReturnType<typeof historicalPrDetail>[];
}) {
  return {
    metadata: {
      linkKind: SessionArtifactLinkKind.SessionPr,
      relationTypes: [input.relationType ?? SessionPrRelationType.Created],
      repositoryFullName: REPO,
      prNumber: input.prNumber,
      source: "DETERMINISTIC",
      confidence: 1.0,
      extractorVersion: 1,
    },
    target: {
      name: "reused-branch/head-ref",
      type: ArtifactType.Branch,
      branch: {
        repository: { fullName: REPO },
        currentPullRequestDetail: input.current,
      },
      pullRequestDetails: input.historical,
    },
  };
}

describe("agentSessionsService historical merged-PR projection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // The core FEA-4317 case: a session linked to a historical merged PR #1 from a
  // branch that has since moved its current pointer to an open PR #2. The legacy
  // JSON reports #1 as a bare unknown ref. #1's merged state must resolve from its
  // OWN historical detail, not be erased to "unknown" because it is no longer
  // current. It counts exactly once.
  it("resolves a historical merged PR from the branch's historical detail set", async () => {
    installDb({
      sessionDetail: {
        findMany: vi.fn().mockResolvedValue([
          buildSessionListRecord({
            branch: "reused-branch/head-ref",
            pullRequests: [
              // Desktop-reported bare ref for the older PR #1 → "unknown".
              {
                num: 1,
                title: "PR #1",
                status: SessionPrLifecycleStatus.Unknown,
              },
            ],
            artifact: {
              name: "Reused-branch session",
              status: "completed",
              slug: "SES-HIST",
              project: null,
              sourceLinks: [
                reusedBranchSourceLink({
                  prNumber: 1,
                  // The branch's CURRENT PR is the newer open #2...
                  current: currentPrDetail({
                    number: 2,
                    title: "Newer open PR",
                    prState: PullRequestState.Open,
                  }),
                  // ...and #1's verified MERGED state lives in the historical set.
                  historical: [
                    historicalPrDetail({
                      number: 1,
                      title: "Historical merged PR",
                      prState: PullRequestState.Merged,
                      mergedAt: MERGED_AT,
                    }),
                  ],
                }),
              ],
            },
          }),
        ]),
        count: vi.fn().mockResolvedValue(1),
      },
    });

    const result = await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: {},
    });

    expect(result.items[0]?.prs).toEqual([
      {
        num: 1,
        title: "Historical merged PR",
        status: SessionPrLifecycleStatus.Merged,
      },
    ]);
    expect(result.items[0]?.prsMerged).toBe(1);
  });

  // Re-import / stored-status variation: after a re-sync the legacy JSON may carry
  // a stale `merged` claim for the historical PR. The unverified sanitizer first
  // downgrades that to "unknown" (it was never verified from the desktop side),
  // and the historical-detail pass then RE-verifies it back to merged from the
  // PR's own row. The outcome is stable regardless of the stored legacy status.
  it("re-verifies a re-imported legacy merged historical PR from its own detail", async () => {
    installDb({
      sessionDetail: {
        findMany: vi.fn().mockResolvedValue([
          buildSessionListRecord({
            branch: "reused-branch/head-ref",
            pullRequests: [
              // Re-import left a stale `merged` claim on the historical PR.
              {
                num: 1,
                title: "Legacy #1 title",
                status: SessionPrLifecycleStatus.Merged,
              },
            ],
            artifact: {
              name: "Re-imported session",
              status: "completed",
              slug: "SES-REIMPORT",
              project: null,
              sourceLinks: [
                reusedBranchSourceLink({
                  prNumber: 1,
                  current: currentPrDetail({
                    number: 2,
                    title: "Newer open PR",
                    prState: PullRequestState.Open,
                  }),
                  historical: [
                    historicalPrDetail({
                      number: 1,
                      title: "Historical merged PR",
                      prState: PullRequestState.Merged,
                      mergedAt: MERGED_AT,
                    }),
                  ],
                }),
              ],
            },
          }),
        ]),
        count: vi.fn().mockResolvedValue(1),
      },
    });

    const result = await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: {},
    });

    expect(result.items[0]?.prs).toEqual([
      {
        num: 1,
        title: "Historical merged PR",
        status: SessionPrLifecycleStatus.Merged,
      },
    ]);
    expect(result.items[0]?.prsMerged).toBe(1);
  });

  // Hydration-timing variation: the SAME PR is reachable via BOTH the current
  // pointer and the historical set on the same (or multiple) link(s). It must be
  // settled exactly once — never listed or counted twice.
  it("counts a PR reachable via both current and historical detail exactly once", async () => {
    installDb({
      sessionDetail: {
        findMany: vi.fn().mockResolvedValue([
          buildSessionListRecord({
            branch: "reused-branch/head-ref",
            pullRequests: [
              {
                num: 1,
                title: "PR #1",
                status: SessionPrLifecycleStatus.Unknown,
              },
            ],
            artifact: {
              name: "Overlap session",
              status: "completed",
              slug: "SES-OVERLAP",
              project: null,
              sourceLinks: [
                reusedBranchSourceLink({
                  prNumber: 1,
                  // PR #1 is BOTH the current pointer AND present in history.
                  current: currentPrDetail({
                    number: 1,
                    title: "Merged PR #1 (current)",
                    prState: PullRequestState.Merged,
                    mergedAt: MERGED_AT,
                  }),
                  historical: [
                    historicalPrDetail({
                      number: 1,
                      title: "Merged PR #1 (historical)",
                      prState: PullRequestState.Merged,
                      mergedAt: MERGED_AT,
                    }),
                  ],
                }),
              ],
            },
          }),
        ]),
        count: vi.fn().mockResolvedValue(1),
      },
    });

    const result = await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: {},
    });

    expect(result.items[0]?.prs).toEqual([
      {
        num: 1,
        title: "Merged PR #1 (current)",
        status: SessionPrLifecycleStatus.Merged,
      },
    ]);
    expect(result.items[0]?.prsMerged).toBe(1);
  });

  // A session linked to a historical MERGED #1 AND the current OPEN #2 (both bare
  // legacy refs) surfaces each at its own verified state: #1 merged (once), #2
  // open — the merged count is 1, not 0 (erased) and not 2 (double-counted).
  it("surfaces a historical merged PR and a current open PR each at its own state", async () => {
    installDb({
      sessionDetail: {
        findMany: vi.fn().mockResolvedValue([
          buildSessionListRecord({
            branch: "reused-branch/head-ref",
            pullRequests: [
              {
                num: 1,
                title: "PR #1",
                status: SessionPrLifecycleStatus.Unknown,
              },
              {
                num: 2,
                title: "PR #2",
                status: SessionPrLifecycleStatus.Unknown,
              },
            ],
            artifact: {
              name: "Two-PR session",
              status: "completed",
              slug: "SES-TWO",
              project: null,
              sourceLinks: [
                // ISS-4768: the session AUTHORED both PRs on the reused branch —
                // one CREATED link each, which is the shape a two-PR session
                // actually produces. Previously only #2 was linked and #1 rode in
                // on the branch's historical set alone; that is branch-inherited
                // attribution, not authorship, and the ISS-4768 gate now drops it
                // (see "does not surface a blob PR the session only inherited from
                // its branch"). Linking #1 keeps this test on its real subject:
                // each authored PR resolving to its OWN verified state.
                reusedBranchSourceLink({
                  prNumber: 1,
                  current: currentPrDetail({
                    number: 2,
                    title: "Newer open PR",
                    prState: PullRequestState.Open,
                  }),
                  historical: [
                    historicalPrDetail({
                      number: 1,
                      title: "Historical merged PR",
                      prState: PullRequestState.Merged,
                      mergedAt: MERGED_AT,
                    }),
                  ],
                }),
                reusedBranchSourceLink({
                  prNumber: 2,
                  current: currentPrDetail({
                    number: 2,
                    title: "Newer open PR",
                    prState: PullRequestState.Open,
                  }),
                  historical: [
                    historicalPrDetail({
                      number: 1,
                      title: "Historical merged PR",
                      prState: PullRequestState.Merged,
                      mergedAt: MERGED_AT,
                    }),
                  ],
                }),
              ],
            },
          }),
        ]),
        count: vi.fn().mockResolvedValue(1),
      },
    });

    const result = await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: {},
    });

    const prs = result.items[0]?.prs ?? [];
    expect(prs).toHaveLength(2);
    const byNum = new Map(prs.map((pr) => [pr.num, pr]));
    expect(byNum.get(1)?.status).toBe(SessionPrLifecycleStatus.Merged);
    expect(byNum.get(2)?.status).toBe(SessionPrLifecycleStatus.Open);
    expect(result.items[0]?.prsMerged).toBe(1);
  });

  // The fallback stays honest: a historical PR whose only detail is UNVERIFIED
  // (`lastVerifiedAt: null`) is genuinely unresolvable and keeps its "unknown"
  // placeholder — the historical set never launders an unverified merge.
  it("keeps a historical PR unknown when its detail is unverified", async () => {
    installDb({
      sessionDetail: {
        findMany: vi.fn().mockResolvedValue([
          buildSessionListRecord({
            branch: "reused-branch/head-ref",
            pullRequests: [
              {
                num: 1,
                title: "PR #1",
                status: SessionPrLifecycleStatus.Unknown,
              },
            ],
            artifact: {
              name: "Unverified-history session",
              status: "completed",
              slug: "SES-UNVERIFIED-HIST",
              project: null,
              sourceLinks: [
                reusedBranchSourceLink({
                  prNumber: 1,
                  current: currentPrDetail({
                    number: 2,
                    title: "Newer open PR",
                    prState: PullRequestState.Open,
                  }),
                  historical: [
                    historicalPrDetail({
                      number: 1,
                      title: "Unverified merged claim",
                      prState: PullRequestState.Merged,
                      mergedAt: MERGED_AT,
                      // Not freshness-verified → must not resolve state.
                      lastVerifiedAt: null,
                    }),
                  ],
                }),
              ],
            },
          }),
        ]),
        count: vi.fn().mockResolvedValue(1),
      },
    });

    const result = await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: {},
    });

    expect(result.items[0]?.prs).toEqual([
      {
        num: 1,
        title: "PR #1",
        status: SessionPrLifecycleStatus.Unknown,
      },
    ]);
    expect(result.items[0]?.prsMerged).toBe(0);
  });

  // wongk review: `lastVerifiedAt` alone is NOT a lifecycle observation. A desktop
  // bare-ref (`git_push`/`gh_pr_create` with no `gh pr view`) is inserted with the
  // Prisma `prState @default(OPEN)` and no lifecycle timestamps, yet still gets a
  // `lastVerifiedAt` stamp. This partial-ref shape must NOT turn an Unknown session
  // PR into a fabricated Open the producer never observed — the PR stays Unknown.
  it("keeps a partial-ref default-OPEN detail unknown when its lifecycle was never observed", async () => {
    installDb({
      sessionDetail: {
        findMany: vi.fn().mockResolvedValue([
          buildSessionListRecord({
            branch: "reused-branch/head-ref",
            pullRequests: [
              {
                num: 1,
                title: "PR #1",
                status: SessionPrLifecycleStatus.Unknown,
              },
            ],
            artifact: {
              name: "Partial-ref session",
              status: "completed",
              slug: "SES-PARTIAL-REF",
              project: null,
              sourceLinks: [
                reusedBranchSourceLink({
                  prNumber: 1,
                  // The branch's current pointer is a genuinely-observed newer PR.
                  current: currentPrDetail({
                    number: 2,
                    title: "Newer open PR",
                    prState: PullRequestState.Open,
                  }),
                  // #1 is a desktop bare-ref: verified-stamped, default OPEN, but
                  // NO lifecycle signal (no mergedAt/closedAt, no githubCreatedAt).
                  historical: [
                    historicalPrDetail({
                      number: 1,
                      title: "Unobserved default-open ref",
                      prState: PullRequestState.Open,
                      githubCreatedAt: null,
                    }),
                  ],
                }),
              ],
            },
          }),
        ]),
        count: vi.fn().mockResolvedValue(1),
      },
    });

    const result = await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: {},
    });

    expect(result.items[0]?.prs).toEqual([
      {
        num: 1,
        title: "PR #1",
        status: SessionPrLifecycleStatus.Unknown,
      },
    ]);
    expect(result.items[0]?.prsMerged).toBe(0);
  });

  // codex P2: a repo-unknown session (record.repositoryFullName null) stores its
  // legacy PRs under the shared `legacy#<n>` key. A same-number historical sibling
  // from a DIFFERENT repo's branch must NOT consume (and delete) the `legacy#<n>`
  // that belongs to the link's own declared repo. The link declares repo-A #17;
  // the branch history also holds an incidental repo-B #17 — repo-B's merged state
  // must not overwrite the legacy entry, which belongs to repo-A #17.
  it("does not let a same-number sibling from another repo claim the legacy entry", async () => {
    const OTHER_REPO = "closedloop-ai/other-repo";
    installDb({
      sessionDetail: {
        findMany: vi.fn().mockResolvedValue([
          buildSessionListRecord({
            // Repo-unknown session: legacy PR #17 stored under `legacy#17`.
            repositoryFullName: null,
            branch: "reused-branch/head-ref",
            pullRequests: [
              {
                num: 17,
                title: "PR #17",
                status: SessionPrLifecycleStatus.Unknown,
              },
            ],
            artifact: {
              name: "Repo-unknown session",
              status: "completed",
              slug: "SES-LEGACY-COLLIDE",
              project: null,
              sourceLinks: [
                {
                  metadata: {
                    linkKind: SessionArtifactLinkKind.SessionPr,
                    relationTypes: [SessionPrRelationType.Created],
                    // The link is authoritatively about repo-A #17.
                    repositoryFullName: REPO,
                    prNumber: 17,
                    source: "DETERMINISTIC",
                    confidence: 1.0,
                    extractorVersion: 1,
                  },
                  target: {
                    name: "reused-branch/head-ref",
                    type: ArtifactType.Branch,
                    branch: {
                      repository: { fullName: REPO },
                      // Current pointer is repo-A's open #17 (the link's PR).
                      currentPullRequestDetail: currentPrDetail({
                        number: 17,
                        title: "Repo-A open #17",
                        prState: PullRequestState.Open,
                      }),
                    },
                    // Incidental repo-B #17 in history — merged, but NOT this
                    // link's declared PR (different repo). It must not claim
                    // `legacy#17`.
                    pullRequestDetails: [
                      {
                        number: 17,
                        title: "Repo-B merged #17",
                        prState: PullRequestState.Merged,
                        closedAt: null,
                        mergedAt: MERGED_AT,
                        lastVerifiedAt: VERIFIED_AT,
                        githubCreatedAt: OPENED_AT,
                        isCurrent: false,
                        additions: null,
                        deletions: null,
                        repositoryFullName: OTHER_REPO,
                        repository: { fullName: OTHER_REPO },
                      },
                    ],
                  },
                },
              ],
            },
          }),
        ]),
        count: vi.fn().mockResolvedValue(1),
      },
    });

    const result = await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: {},
    });

    // The legacy #17 resolves to repo-A's OPEN #17 (the link's declared PR), not
    // repo-B's merged #17. The merged count stays 0 — repo-B's sibling never
    // consumed the legacy entry.
    const prs = result.items[0]?.prs ?? [];
    const seventeen = prs.filter((pr) => pr.num === 17);
    expect(seventeen).toHaveLength(1);
    expect(seventeen[0]?.status).toBe(SessionPrLifecycleStatus.Open);
    expect(result.items[0]?.prsMerged).toBe(0);
  });
});
