// Linked-PR projection tests for the agent-session list/detail surfaces:
// `toSessionPullRequestProjection` (the `prs` output + verified-merged count)
// and `deriveLinkedPrHeadBranch` (the PR-head-ref branch back-fill). Split out
// of `projections.test.ts` (FEA-3297) to keep that file under the size ceiling;
// the sibling owns the session→PR link fixture shape.

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

// FEA-3562: shared factory for a session→PR sourceLink whose BRANCH target
// carries the PR head-ref `name` the branch back-fill reads. The three
// back-fill tests build their sourceLinks entry through this instead of
// repeating the ~30-line literal, so the fixture shape (metadata + BRANCH
// target + currentPullRequestDetail) lives in one place.
function prHeadRefSourceLink({
  headRef,
  prNumber,
  title = "Linked PR",
  prState = PullRequestState.Open,
  relationType = SessionPrRelationType.Created,
}: {
  headRef: string;
  prNumber: number;
  title?: string;
  prState?: PullRequestState;
  relationType?: SessionPrRelationType;
}) {
  return {
    metadata: {
      linkKind: SessionArtifactLinkKind.SessionPr,
      relationTypes: [relationType],
      repositoryFullName: "closedloop-ai/symphony-alpha",
      prNumber,
      source: "DETERMINISTIC",
      confidence: 1.0,
      extractorVersion: 1,
    },
    target: {
      // The BRANCH artifact's name is the PR's head branch.
      name: headRef,
      type: "BRANCH",
      branch: {
        repository: {
          fullName: "closedloop-ai/symphony-alpha",
        },
        currentPullRequestDetail: {
          number: prNumber,
          title,
          prState,
          closedAt: null,
          mergedAt: null,
          lastVerifiedAt: new Date("2026-07-20T02:09:00.000Z"),
          isCurrent: true,
          repository: {
            fullName: "closedloop-ai/symphony-alpha",
          },
        },
      },
    },
  };
}

describe("agentSessionsService pull request projection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  // FEA-3584: a session that merely REFERENCES a PR (e.g. a standup that names
  // PR numbers in prose to compose a message) must not be attributed as session
  // output. The link derives to the `Referenced` purpose, so it is excluded from
  // both the `prs` list and the merged count even when the PR itself is merged
  // and verified — otherwise a zero-churn standup inflates throughput.
  it("excludes a referenced-only PR link from session output", async () => {
    installDb({
      sessionDetail: {
        findMany: vi.fn().mockResolvedValue([
          buildSessionListRecord({
            pullRequests: [],
            artifact: {
              name: "Standup session",
              status: "completed",
              slug: "SES-STANDUP",
              project: null,
              sourceLinks: [
                {
                  metadata: {
                    linkKind: SessionArtifactLinkKind.SessionPr,
                    relationTypes: [SessionPrRelationType.Referenced],
                    repositoryFullName: "closedloop-ai/symphony-alpha",
                    prNumber: 2897,
                    source: "DETERMINISTIC",
                    confidence: 1.0,
                    extractorVersion: 1,
                  },
                  target: {
                    branch: {
                      repository: {
                        fullName: "closedloop-ai/symphony-alpha",
                      },
                      currentPullRequestDetail: {
                        number: 2897,
                        title: "Referenced PR",
                        prState: PullRequestState.Merged,
                        closedAt: null,
                        mergedAt: new Date("2026-07-20T02:10:11.000Z"),
                        lastVerifiedAt: new Date("2026-07-20T02:09:00.000Z"),
                        isCurrent: true,
                        repository: {
                          fullName: "closedloop-ai/symphony-alpha",
                        },
                      },
                    },
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

    expect(result.items[0]?.prs).toEqual([]);
    expect(result.items[0]?.prsMerged).toBe(0);
  });
  // FEA-3584: the same PR reached by BOTH a referenced link and an authored
  // link must be attributed exactly once (the authored evidence), never
  // double-counted across the two source streams.
  it("counts a PR authored by the session exactly once alongside a referenced link", async () => {
    installDb({
      sessionDetail: {
        findMany: vi.fn().mockResolvedValue([
          buildSessionListRecord({
            pullRequests: [],
            artifact: {
              name: "Authoring session",
              status: "completed",
              slug: "SES-AUTHOR",
              project: null,
              sourceLinks: [
                {
                  metadata: {
                    linkKind: SessionArtifactLinkKind.SessionPr,
                    relationTypes: [SessionPrRelationType.Referenced],
                    repositoryFullName: "closedloop-ai/symphony-alpha",
                    prNumber: 3200,
                    source: "DETERMINISTIC",
                    confidence: 1.0,
                    extractorVersion: 1,
                  },
                  target: {
                    branch: {
                      repository: {
                        fullName: "closedloop-ai/symphony-alpha",
                      },
                      currentPullRequestDetail: {
                        number: 3200,
                        title: "Authored PR",
                        prState: PullRequestState.Merged,
                        closedAt: null,
                        mergedAt: new Date("2026-07-20T02:10:11.000Z"),
                        lastVerifiedAt: new Date("2026-07-20T02:09:00.000Z"),
                        isCurrent: true,
                        repository: {
                          fullName: "closedloop-ai/symphony-alpha",
                        },
                      },
                    },
                  },
                },
                {
                  metadata: {
                    linkKind: SessionArtifactLinkKind.SessionPr,
                    relationTypes: [SessionPrRelationType.Created],
                    repositoryFullName: "closedloop-ai/symphony-alpha",
                    prNumber: 3200,
                    source: "DETERMINISTIC",
                    confidence: 1.0,
                    extractorVersion: 1,
                  },
                  target: {
                    // Authored (Created) PR link carries the head-ref `name` so
                    // the PR resolves a real head branch and is not orphaned by
                    // the PR⇒Branch invariant (FEA-4188).
                    name: "authoring-session/head-ref",
                    branch: {
                      repository: {
                        fullName: "closedloop-ai/symphony-alpha",
                      },
                      currentPullRequestDetail: {
                        number: 3200,
                        title: "Authored PR",
                        prState: PullRequestState.Merged,
                        closedAt: null,
                        mergedAt: new Date("2026-07-20T02:10:11.000Z"),
                        lastVerifiedAt: new Date("2026-07-20T02:09:00.000Z"),
                        isCurrent: true,
                        repository: {
                          fullName: "closedloop-ai/symphony-alpha",
                        },
                      },
                    },
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

    expect(result.items[0]?.prs).toEqual([
      {
        num: 3200,
        title: "Authored PR",
        status: SessionPrLifecycleStatus.Merged,
      },
    ]);
    expect(result.items[0]?.prsMerged).toBe(1);
  });
  // FEA-3562: a session with a linked (authored) PR but no synced local branch —
  // both `branch` and `baseBranch` null — must show the PR's HEAD branch rather
  // than "None". The head ref is the linked BRANCH artifact's `name`.
  it("back-fills the session branch from a linked PR's head ref when branch/baseBranch are null", async () => {
    installDb({
      sessionDetail: {
        findMany: vi.fn().mockResolvedValue([
          buildSessionListRecord({
            branch: null,
            baseBranch: null,
            pullRequests: [],
            artifact: {
              name: "Cloud session, unsynced branch",
              status: "completed",
              slug: "SES-2cacb886",
              project: null,
              sourceLinks: [
                prHeadRefSourceLink({
                  headRef: "mikeangstadt/fea-3562-head-ref",
                  prNumber: 3143,
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

    // The linked PR surfaces...
    expect(result.items[0]?.prs).toEqual([
      {
        num: 3143,
        title: "Linked PR",
        status: SessionPrLifecycleStatus.Open,
      },
    ]);
    // ...and so does its head branch — not "None".
    expect(result.items[0]?.branch).toBe("mikeangstadt/fea-3562-head-ref");
  });
  // FEA-3562: a REAL synced local branch always wins over the PR head-ref
  // fallback — the back-fill only fills the gap, it never overrides.
  it("prefers the synced local branch over the linked PR head ref", async () => {
    installDb({
      sessionDetail: {
        findMany: vi.fn().mockResolvedValue([
          buildSessionListRecord({
            branch: "feature/local-synced",
            baseBranch: null,
            pullRequests: [],
            artifact: {
              name: "Synced branch session",
              status: "completed",
              slug: "SES-SYNCED",
              project: null,
              sourceLinks: [
                prHeadRefSourceLink({
                  headRef: "mikeangstadt/pr-head-ref",
                  prNumber: 3144,
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

    expect(result.items[0]?.branch).toBe("feature/local-synced");
  });
  // FEA-3562: `baseBranch` is the base/target ref, not the head; when a session
  // has no synced local `branch` but does have a `baseBranch` AND an authored PR
  // link, the linked PR's HEAD ref wins over `baseBranch` so the chip shows the
  // branch the session worked on, not its base (e.g. `main`).
  it("prefers the linked PR head ref over baseBranch when the local branch is null", async () => {
    installDb({
      sessionDetail: {
        findMany: vi.fn().mockResolvedValue([
          buildSessionListRecord({
            branch: null,
            baseBranch: "main",
            pullRequests: [],
            artifact: {
              name: "Cloud session, base-only, authored PR",
              status: "completed",
              slug: "SES-BASEHEAD",
              project: null,
              sourceLinks: [
                prHeadRefSourceLink({
                  headRef: "mikeangstadt/fea-3562-over-base",
                  prNumber: 3146,
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

    expect(result.items[0]?.branch).toBe("mikeangstadt/fea-3562-over-base");
  });
  // FEA-3562: with no synced local branch and no authored PR head ref, the
  // display still degrades to `baseBranch` — the head-ref back-fill only fills
  // the gap, it never suppresses a real base branch.
  it("degrades to baseBranch when the local branch is null and no PR head ref resolves", async () => {
    installDb({
      sessionDetail: {
        findMany: vi.fn().mockResolvedValue([
          buildSessionListRecord({
            branch: null,
            baseBranch: "main",
            pullRequests: [],
            artifact: {
              name: "Cloud session, base-only, no authored PR",
              status: "completed",
              slug: "SES-BASEONLY",
              project: null,
              sourceLinks: [],
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

    expect(result.items[0]?.branch).toBe("main");
  });
  // FEA-3562: a session that only REFERENCED a PR authored no branch, so its
  // head ref must not be attributed — the session still shows "None" (null).
  it("does not back-fill the branch from a referenced-only PR link", async () => {
    installDb({
      sessionDetail: {
        findMany: vi.fn().mockResolvedValue([
          buildSessionListRecord({
            branch: null,
            baseBranch: null,
            pullRequests: [],
            artifact: {
              name: "Referenced-only session",
              status: "completed",
              slug: "SES-REFONLY",
              project: null,
              sourceLinks: [
                prHeadRefSourceLink({
                  headRef: "someone-else/head-ref",
                  prNumber: 3145,
                  title: "Referenced PR",
                  relationType: SessionPrRelationType.Referenced,
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

    expect(result.items[0]?.branch).toBeNull();
  });
  it("deduplicates legacy pull request JSON when a trusted session PR link exists", async () => {
    installDb({
      sessionDetail: {
        findMany: vi.fn().mockResolvedValue([
          buildSessionListRecord({
            // Synced local head branch → the PR resolves a branch and is not
            // orphaned by the PR⇒Branch invariant (FEA-4188).
            branch: "dedup-session/head",
            pullRequests: [
              {
                num: 17,
                title: "Legacy title",
                status: SessionPrLifecycleStatus.Merged,
              },
            ],
            artifact: {
              name: "Session One",
              status: "completed",
              slug: "SES-1",
              project: null,
              sourceLinks: [
                {
                  metadata: {
                    linkKind: SessionArtifactLinkKind.SessionPr,
                    relationTypes: [SessionPrRelationType.Created],
                    repositoryFullName: "closedloop-ai/symphony-alpha",
                    prNumber: 17,
                    source: "DETERMINISTIC",
                    confidence: 1.0,
                    extractorVersion: 1,
                  },
                  target: {
                    branch: {
                      repository: {
                        fullName: "closedloop-ai/symphony-alpha",
                      },
                      currentPullRequestDetail: {
                        number: 17,
                        title: "Trusted title",
                        prState: PullRequestState.Merged,
                        closedAt: null,
                        mergedAt: new Date("2026-05-20T17:10:00.000Z"),
                        lastVerifiedAt: new Date("2026-05-20T17:09:00.000Z"),
                        isCurrent: true,
                        repository: {
                          fullName: "closedloop-ai/symphony-alpha",
                        },
                      },
                    },
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

    expect(result.items[0]?.prs).toEqual([
      {
        num: 17,
        title: "Trusted title",
        status: SessionPrLifecycleStatus.Merged,
      },
    ]);
    expect(result.items[0]?.prsMerged).toBe(1);
  });
  it("downgrades legacy-only merged pull requests to unknown list state", async () => {
    installDb({
      sessionDetail: {
        findMany: vi.fn().mockResolvedValue([
          buildSessionListRecord({
            // Synced local head branch → the legacy PR is not orphaned by the
            // PR⇒Branch invariant (FEA-4188); this test exercises the legacy
            // merged→unknown downgrade, not the invariant.
            branch: "legacy-session/head",
            pullRequests: [
              {
                num: 17,
                title: "Legacy title",
                status: SessionPrLifecycleStatus.Merged,
              },
            ],
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
        num: 17,
        title: "Legacy title",
        status: SessionPrLifecycleStatus.Unknown,
      },
    ]);
    expect(result.items[0]?.prsMerged).toBe(0);
  });
  // FEA-4251 (moved by ISS-4768): the two cases proving a legacy-blob PR is
  // resolved (or honestly left unknown) by a REFERENCED link's verified GitHub
  // detail now live in `projections.pr-attribution-gate.test.ts`, alongside the
  // ISS-4768 Authored gate that decides whether the blob entry is admitted at
  // all — the two are one story, and this file was at the 1000-line ceiling.
  it("deduplicates repository-less legacy pull request JSON when a trusted session PR link exists", async () => {
    installDb({
      sessionDetail: {
        findMany: vi.fn().mockResolvedValue([
          buildSessionListRecord({
            // Synced local head branch → the PR is not orphaned (FEA-4188).
            branch: "repoless-trusted-session/head",
            repositoryFullName: null,
            pullRequests: [
              {
                num: 17,
                title: "Repository-less legacy title",
                status: SessionPrLifecycleStatus.Merged,
              },
            ],
            artifact: {
              name: "Session One",
              status: "completed",
              slug: "SES-1",
              project: null,
              sourceLinks: [
                {
                  metadata: {
                    linkKind: SessionArtifactLinkKind.SessionPr,
                    relationTypes: [SessionPrRelationType.Created],
                    repositoryFullName: "closedloop-ai/symphony-alpha",
                    prNumber: 17,
                    source: "DETERMINISTIC",
                    confidence: 1.0,
                    extractorVersion: 1,
                  },
                  target: {
                    branch: {
                      repository: {
                        fullName: "closedloop-ai/symphony-alpha",
                      },
                      currentPullRequestDetail: {
                        number: 17,
                        title: "Trusted title",
                        prState: PullRequestState.Merged,
                        closedAt: null,
                        mergedAt: new Date("2026-05-20T17:10:00.000Z"),
                        lastVerifiedAt: new Date("2026-05-20T17:09:00.000Z"),
                        isCurrent: true,
                        repository: {
                          fullName: "closedloop-ai/symphony-alpha",
                        },
                      },
                    },
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

    expect(result.items[0]?.prs).toEqual([
      {
        num: 17,
        title: "Trusted title",
        status: SessionPrLifecycleStatus.Merged,
      },
    ]);
    expect(result.items[0]?.prsMerged).toBe(1);
  });
  it("keeps current pull request details unknown until they have verification freshness", async () => {
    installDb({
      sessionDetail: {
        findMany: vi.fn().mockResolvedValue([
          buildSessionListRecord({
            artifact: {
              name: "Session One",
              status: "completed",
              slug: "SES-1",
              project: null,
              sourceLinks: [
                {
                  metadata: {
                    linkKind: SessionArtifactLinkKind.SessionPr,
                    relationTypes: [SessionPrRelationType.Created],
                    repositoryFullName: "closedloop-ai/symphony-alpha",
                    prNumber: 17,
                    source: "DETERMINISTIC",
                    confidence: 1.0,
                    extractorVersion: 1,
                  },
                  target: {
                    // Authored (Created) link carries the head-ref `name`, so
                    // the PR resolves a real head branch (FEA-4188 invariant).
                    name: "unverified-fresh-session/head-ref",
                    branch: {
                      repository: {
                        fullName: "closedloop-ai/symphony-alpha",
                      },
                      currentPullRequestDetail: {
                        number: 17,
                        title: "Unverified title",
                        prState: PullRequestState.Merged,
                        closedAt: null,
                        mergedAt: new Date("2026-05-20T17:10:00.000Z"),
                        lastVerifiedAt: null,
                        isCurrent: true,
                        repository: {
                          fullName: "closedloop-ai/symphony-alpha",
                        },
                      },
                    },
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

    expect(result.items[0]?.prs).toEqual([
      {
        num: 17,
        title: "PR #17",
        status: SessionPrLifecycleStatus.Unknown,
      },
    ]);
    expect(result.items[0]?.prsMerged).toBe(0);
  });
  it("downgrades legacy merged pull request status when linked details are unverified", async () => {
    installDb({
      sessionDetail: {
        findMany: vi.fn().mockResolvedValue([
          buildSessionListRecord({
            // Synced local head branch → the PR is not orphaned (FEA-4188).
            branch: "legacy-unverified-session/head",
            pullRequests: [
              {
                num: 17,
                title: "Legacy title",
                status: SessionPrLifecycleStatus.Merged,
              },
            ],
            artifact: {
              name: "Session One",
              status: "completed",
              slug: "SES-1",
              project: null,
              sourceLinks: [
                {
                  metadata: {
                    linkKind: SessionArtifactLinkKind.SessionPr,
                    relationTypes: [SessionPrRelationType.Created],
                    repositoryFullName: "closedloop-ai/symphony-alpha",
                    prNumber: 17,
                    source: "DETERMINISTIC",
                    confidence: 1.0,
                    extractorVersion: 1,
                  },
                  target: {
                    branch: {
                      repository: {
                        fullName: "closedloop-ai/symphony-alpha",
                      },
                      currentPullRequestDetail: {
                        number: 17,
                        title: "Unverified title",
                        prState: PullRequestState.Open,
                        closedAt: null,
                        mergedAt: null,
                        lastVerifiedAt: null,
                        isCurrent: true,
                        repository: {
                          fullName: "closedloop-ai/symphony-alpha",
                        },
                      },
                    },
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

    expect(result.items[0]?.prs).toEqual([
      {
        num: 17,
        title: "Legacy title",
        status: SessionPrLifecycleStatus.Unknown,
      },
    ]);
    expect(result.items[0]?.prsMerged).toBe(0);
  });
  // FEA-3297: the repo-less legacy seed and the unverified link are each covered
  // above, but only in isolation — a null `repositoryFullName` was always paired
  // with a TRUSTED detail, and an unverified detail always with a repo-qualified
  // session. Their intersection is the one case that keys the same PR twice
  // (`legacy#17` from the seed, `closedloop-ai/symphony-alpha#17` from the link),
  // so it is the case that regresses if the legacy delete is ever re-gated on
  // `trustedDetail`.
  it("deduplicates repository-less legacy pull request JSON when the linked session PR detail is unverified", async () => {
    installDb({
      sessionDetail: {
        findMany: vi.fn().mockResolvedValue([
          buildSessionListRecord({
            // Synced local head branch → the PR is not orphaned (FEA-4188).
            branch: "repoless-unverified-session/head",
            repositoryFullName: null,
            pullRequests: [
              {
                num: 17,
                title: "Repository-less legacy title",
                status: SessionPrLifecycleStatus.Merged,
              },
            ],
            artifact: {
              name: "Session One",
              status: "completed",
              slug: "SES-1",
              project: null,
              sourceLinks: [
                {
                  metadata: {
                    linkKind: SessionArtifactLinkKind.SessionPr,
                    relationTypes: [SessionPrRelationType.Created],
                    repositoryFullName: "closedloop-ai/symphony-alpha",
                    prNumber: 17,
                    source: "DETERMINISTIC",
                    confidence: 1.0,
                    extractorVersion: 1,
                  },
                  target: {
                    branch: {
                      repository: {
                        fullName: "closedloop-ai/symphony-alpha",
                      },
                      currentPullRequestDetail: {
                        number: 17,
                        title: "Unverified title",
                        prState: PullRequestState.Open,
                        closedAt: null,
                        mergedAt: null,
                        lastVerifiedAt: null,
                        isCurrent: true,
                        repository: {
                          fullName: "closedloop-ai/symphony-alpha",
                        },
                      },
                    },
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

    // One entry, not two: the repo-qualified link key supersedes the repo-unknown
    // legacy key even though the detail is unverified. The legacy title still
    // merges through (an unverified detail supplies no trusted title) and the
    // legacy `merged` claim stays downgraded, so collapsing the identity does not
    // smuggle in an unverified merge.
    expect(result.items[0]?.prs).toEqual([
      {
        num: 17,
        title: "Repository-less legacy title",
        status: SessionPrLifecycleStatus.Unknown,
      },
    ]);
    expect(result.items[0]?.prsMerged).toBe(0);
  });
});
