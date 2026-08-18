/**
 * FEA-2732 / FEA-3917 — the `pull_request` artifact-ref lane
 * (`pull-request-details.ts`).
 *
 * NOTE ON THE SIBLING FILE: `pull-request-details.test.ts` sits next to the
 * module but never sends a `pull_request` ref — it exercises
 * `agentSessionsService` sync-conflict projection. That naming is why the module
 * measured 6% branch coverage despite appearing to have a co-located suite. This
 * file is the lane's actual coverage.
 *
 * Every case below asserts the OBSERVABLE write (which delegate was called, with
 * what data) rather than that the sync merely ran — the PRD-618 no-coverage-
 * farming rule.
 */

import { GitHubPRState } from "@repo/api/src/types/github";
import { GitHubFetchMechanism } from "@repo/api/src/types/github-read-model";
import {
  ArtifactRefRelation,
  ArtifactRefTargetKind,
  type SyncedArtifactRef,
} from "@repo/api/src/types/session-artifact-link";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildSyncedSession,
  repositoryWithAvailableDefault,
} from "@/__tests__/support/agent-sessions/service.test-harness";
import {
  installPrDetailIngestDb,
  syncPrDetailRefs,
} from "@/__tests__/support/agent-sessions/service.test-harness-pr-detail";
import {
  persistSessionPullRequestDetails,
  sessionPullRequestDetailKey,
} from "./pull-request-details";
import { resolveBranchRepoMap } from "./shared";

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

const OBSERVED_AT = "2026-05-20T18:00:00.000Z";
const MERGED_AT = "2026-05-20T19:00:00.000Z";
const BRANCH_ARTIFACT_ID = "branch-artifact-1";

function prRef(overrides: Record<string, unknown> = {}): SyncedArtifactRef {
  return {
    kind: ArtifactRefTargetKind.PullRequest,
    repositoryFullName: "acme/web",
    prNumber: 42,
    method: "gh_pr_create",
    relation: ArtifactRefRelation.Created,
    observedAt: OBSERVED_AT,
    branchName: "feat/x",
    ...overrides,
  } as SyncedArtifactRef;
}

describe("pull_request artifact-ref lane", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates the PR row conflict-safe and derives htmlUrl server-side", async () => {
    const m = installPrDetailIngestDb({});

    await syncPrDetailRefs([prRef({ title: "Add widget", additions: 10 })]);

    expect(m.prCreateMany).toHaveBeenCalledTimes(1);
    const created = m.prCreateMany.mock.calls[0][0];
    expect(created.skipDuplicates).toBe(true);
    expect(created.data[0]).toMatchObject({
      number: 42,
      repositoryFullName: "acme/web",
      branchArtifactId: BRANCH_ARTIFACT_ID,
      title: "Add widget",
      additions: 10,
      githubId: null,
    });
    // Anti-forgery: the URL is built from the trusted repo + number, never
    // accepted from the producer.
    expect(created.data[0].htmlUrl).toBe("https://github.com/acme/web/pull/42");
  });

  it("points the branch at a newly created desktop PR and advances its lifecycle", async () => {
    const m = installPrDetailIngestDb({});

    await syncPrDetailRefs([prRef({ state: GitHubPRState.Merged })]);

    expect(m.branchDetailUpdate).toHaveBeenCalledTimes(1);
    expect(m.branchDetailUpdate.mock.calls[0][0]).toMatchObject({
      where: { artifactId: BRANCH_ARTIFACT_ID },
    });
    // The lifecycle advance must never downgrade a MERGED branch.
    expect(m.artifactUpdateMany).toHaveBeenCalled();
    const advance = m.artifactUpdateMany.mock.calls.at(-1)?.[0];
    expect(advance.where).toMatchObject({
      id: BRANCH_ARTIFACT_ID,
      status: { not: GitHubPRState.Merged },
    });
    expect(advance.data).toMatchObject({ status: GitHubPRState.Merged });
  });

  it("gap-fills but never overwrites a GitHub-App-owned row (webhook-wins)", async () => {
    const m = installPrDetailIngestDb({
      pullRequestDetails: [
        {
          id: "pr-app-1",
          branchArtifactId: BRANCH_ARTIFACT_ID,
          repositoryId: "repo-1",
          repositoryFullName: "acme/web",
          number: 42,
          fetchMechanism: GitHubFetchMechanism.Webhook,
          title: "Authoritative title",
          htmlUrl: null,
          additions: null,
        },
      ],
    });

    await syncPrDetailRefs([
      prRef({
        title: "Desktop title",
        additions: 7,
        state: GitHubPRState.Open,
      }),
    ]);

    expect(m.prCreateMany).not.toHaveBeenCalled();
    // Exactly one write — the gap-fill. No `isCurrent` write, because an
    // App-owned row means the desktop never takes the pointer.
    expect(m.prUpdate).toHaveBeenCalledTimes(1);
    const gap = m.prUpdate.mock.calls[0][0].data;
    // Only the NULL columns are filled; the App-owned title is untouched.
    expect(gap).not.toHaveProperty("title");
    expect(gap).toMatchObject({ additions: 7 });
    expect(gap.htmlUrl).toBe("https://github.com/acme/web/pull/42");
    // Never lifecycle: an App-owned row means the desktop does not own the row.
    expect(m.branchDetailUpdate).not.toHaveBeenCalled();
  });

  it("treats a legacy row carrying githubId as App-owned even with null provenance", async () => {
    const m = installPrDetailIngestDb({
      pullRequestDetails: [
        {
          id: "pr-legacy-1",
          branchArtifactId: BRANCH_ARTIFACT_ID,
          repositoryId: "repo-1",
          repositoryFullName: "acme/web",
          number: 42,
          fetchMechanism: null,
          githubId: "gh-999",
          title: "From the App",
        },
      ],
    });

    await syncPrDetailRefs([
      prRef({ title: "Desktop title", state: GitHubPRState.Open }),
    ]);

    expect(m.prCreateMany).not.toHaveBeenCalled();
    expect(m.branchDetailUpdate).not.toHaveBeenCalled();
    const updated = m.rows.find((r) => r.id === "pr-legacy-1");
    expect(updated?.title).toBe("From the App");
  });

  it("dedupes a row owned by a DIFFERENT branch without mutating it (FEA-3917 OQ1)", async () => {
    const m = installPrDetailIngestDb({
      pullRequestDetails: [
        {
          id: "pr-other-branch",
          branchArtifactId: "branch-artifact-OTHER",
          repositoryId: "repo-1",
          repositoryFullName: "acme/web",
          number: 42,
          fetchMechanism: GitHubFetchMechanism.DesktopSync,
          title: null,
        },
      ],
    });

    await syncPrDetailRefs([
      prRef({ title: "Desktop title", state: GitHubPRState.Open }),
    ]);

    // Found, so no colliding create — and not mutated, despite title being a
    // fillable gap on a non-App row.
    expect(m.prCreateMany).not.toHaveBeenCalled();
    expect(m.prUpdate).not.toHaveBeenCalled();
    expect(m.branchDetailUpdate).not.toHaveBeenCalled();
    expect(m.rows.find((r) => r.id === "pr-other-branch")?.title).toBeNull();
  });

  it("skips an out-of-order desktop observation older than the stored one", async () => {
    const m = installPrDetailIngestDb({
      pullRequestDetails: [
        {
          id: "pr-fresh",
          branchArtifactId: BRANCH_ARTIFACT_ID,
          repositoryId: "repo-1",
          repositoryFullName: "acme/web",
          number: 42,
          fetchMechanism: GitHubFetchMechanism.DesktopSync,
          fetchObservedAt: new Date("2026-05-21T00:00:00.000Z"),
          title: "Newer title",
        },
      ],
    });

    await syncPrDetailRefs([
      prRef({
        observedAt: "2026-05-20T00:00:00.000Z",
        title: "Stale",
        state: GitHubPRState.Closed,
      }),
    ]);

    expect(m.prUpdate).not.toHaveBeenCalled();
    expect(m.branchDetailUpdate).not.toHaveBeenCalled();
    expect(m.rows.find((r) => r.id === "pr-fresh")?.title).toBe("Newer title");
  });

  it("applies desktop facts to a same-branch desktop-owned row and takes ownership", async () => {
    const m = installPrDetailIngestDb({
      pullRequestDetails: [
        {
          id: "pr-own",
          branchArtifactId: BRANCH_ARTIFACT_ID,
          repositoryId: "repo-1",
          repositoryFullName: "acme/web",
          number: 42,
          fetchMechanism: GitHubFetchMechanism.DesktopSync,
          fetchObservedAt: new Date("2026-05-19T00:00:00.000Z"),
          title: "Old",
        },
      ],
    });

    await syncPrDetailRefs([
      prRef({ title: "New", state: GitHubPRState.Open }),
    ]);

    // Two distinct writes: the facts apply, then `isCurrent` when the branch
    // pointer moves to this row. Assert the facts write specifically rather
    // than a call count that would pass if either write disappeared.
    const factsWrite = m.prUpdate.mock.calls.find(
      (c) => c[0]?.where?.id === "pr-own" && "title" in (c[0]?.data ?? {})
    );
    expect(factsWrite?.[0].data).toMatchObject({ title: "New" });
    const currentWrite = m.prUpdate.mock.calls.find(
      (c) => c[0]?.data?.isCurrent === true
    );
    expect(currentWrite).toBeDefined();
    expect(m.branchDetailUpdate).toHaveBeenCalledTimes(1);
  });

  it("refuses to displace an App-owned CURRENT pointer on the branch", async () => {
    const m = installPrDetailIngestDb({
      branchCurrentPrId: "pr-app-current",
      pullRequestDetails: [
        {
          id: "pr-app-current",
          branchArtifactId: BRANCH_ARTIFACT_ID,
          repositoryId: "repo-1",
          repositoryFullName: "acme/web",
          number: 7,
          fetchMechanism: GitHubFetchMechanism.Webhook,
        },
      ],
    });

    await syncPrDetailRefs([
      prRef({ prNumber: 42, state: GitHubPRState.Open }),
    ]);

    // The new PR row is created, but the branch pointer stays with the App PR
    // and no lifecycle advance happens.
    expect(m.prCreateMany).toHaveBeenCalledTimes(1);
    expect(m.branchDetailUpdate).not.toHaveBeenCalled();
    expect(m.artifactUpdateMany).not.toHaveBeenCalled();
  });

  it("collapses refs for one PR, keeping the latest facts and carrying branchName", async () => {
    const m = installPrDetailIngestDb({});

    await syncPrDetailRefs([
      prRef({
        observedAt: "2026-05-20T10:00:00.000Z",
        branchName: "feat/x",
        title: "First",
      }),
      // Later observation, but it lost the branch name — identity is stable, so
      // the winner's facts must be kept AND the branch name carried across.
      prRef({
        observedAt: "2026-05-20T20:00:00.000Z",
        branchName: undefined,
        title: "Latest",
      }),
    ]);

    expect(m.prCreateMany).toHaveBeenCalledTimes(1);
    expect(m.prCreateMany.mock.calls[0][0].data[0]).toMatchObject({
      number: 42,
      title: "Latest",
      branchArtifactId: BRANCH_ARTIFACT_ID,
    });
  });

  it("defers a PR with no head branch instead of writing a row", async () => {
    const m = installPrDetailIngestDb({});

    await syncPrDetailRefs([prRef({ branchName: undefined })]);

    expect(m.prCreateMany).not.toHaveBeenCalled();
    expect(m.prUpdate).not.toHaveBeenCalled();
    // The deferral is recorded on the session detail for a later sync.
    const persisted = m.sessionDetailUpdate.mock.calls
      .map((c) => c[0]?.data?.metadata)
      .filter(Boolean);
    expect(JSON.stringify(persisted)).toContain("_unresolvedPrDetailRefs");
  });

  it("writes nothing when the session carries no pull_request refs", async () => {
    const m = installPrDetailIngestDb({});

    await syncPrDetailRefs([]);

    expect(m.prFindFirst).not.toHaveBeenCalled();
    expect(m.prCreateMany).not.toHaveBeenCalled();
  });

  it("tolerates a default-branch PR ref while materializing an eligible feature PR in the same transaction", async () => {
    const m = installPrDetailIngestDb({
      branches: [
        { artifactId: BRANCH_ARTIFACT_ID, branchName: "feat/x" },
        { artifactId: "branch-main", branchName: "main" },
      ],
    });

    await syncPrDetailRefs([
      prRef(),
      prRef({ branchName: "main", prNumber: 43 }),
    ]);

    expect(m.prCreateMany).toHaveBeenCalledTimes(1);
    expect(m.prCreateMany.mock.calls[0][0].data[0].number).toBe(42);
    expect(m.rows.some((row) => row.number === 43)).toBe(false);
    expect(m.branchPointers.get("branch-main")).toBeNull();
    expect(
      m.branchDetailUpdateMany.mock.calls.some(
        (call) => call[0].where.artifactId === "branch-main"
      )
    ).toBe(false);
    expect(
      m.artifactUpdateMany.mock.calls.some(
        (call) => call[0].where.id === "branch-main"
      )
    ).toBe(false);
    expect(m.sessionDetailUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          metadata: expect.objectContaining({
            _unresolvedPrDetailRefs: [
              {
                repositoryFullName: "acme/web",
                prNumber: 43,
                cause: "default_branch",
              },
            ],
          }),
        }),
      })
    );
  });

  it("uses an eligible public fork head without substituting the installed base repository", async () => {
    const m = installPrDetailIngestDb({
      repos: [{ id: "base-repo", fullName: "acme/web" }],
      publicRepositories: [
        {
          id: "fork-public-repo",
          githubRepoId: "fork-provider-id",
          fullName: "contributor/web",
        },
      ],
    });

    await syncPrDetailRefs([prRef({ repositoryFullName: "contributor/web" })]);

    expect(m.prCreateMany).toHaveBeenCalledTimes(1);
    expect(m.prCreateMany.mock.calls[0][0].data[0]).toMatchObject({
      repositoryId: null,
      repositoryFullName: "contributor/web",
      branchArtifactId: BRANCH_ARTIFACT_ID,
    });
  });

  it("demotes the branch's prior current PR, branch-scoped, so exactly one stays current", async () => {
    const m = installPrDetailIngestDb({
      branchCurrentPrId: "pr-prior-current",
      pullRequestDetails: [
        {
          id: "pr-prior-current",
          branchArtifactId: BRANCH_ARTIFACT_ID,
          repositoryId: "repo-1",
          repositoryFullName: "acme/web",
          number: 7,
          fetchMechanism: GitHubFetchMechanism.DesktopSync,
          isCurrent: true,
        },
        // A current row on ANOTHER branch: the demote is branch-scoped, so
        // dropping `branchArtifactId` from its `where` must fail here.
        {
          id: "pr-other-branch-current",
          branchArtifactId: "branch-artifact-OTHER",
          repositoryId: "repo-1",
          repositoryFullName: "acme/web",
          number: 99,
          fetchMechanism: GitHubFetchMechanism.DesktopSync,
          isCurrent: true,
        },
      ],
    });

    await syncPrDetailRefs([prRef({ state: GitHubPRState.Open })]);

    // isCurrent is mutually exclusive per branch artifact: the incoming PR is
    // current and the superseded one is not. Deleting the demote leaves two.
    const currentOnBranch = m.rows.filter(
      (r) => r.branchArtifactId === BRANCH_ARTIFACT_ID && r.isCurrent === true
    );
    expect(currentOnBranch.map((r) => r.number)).toEqual([42]);
    expect(m.rows.find((r) => r.id === "pr-prior-current")?.isCurrent).toBe(
      false
    );
    expect(
      m.rows.find((r) => r.id === "pr-other-branch-current")?.isCurrent
    ).toBe(true);
  });

  it("hands the branch pointer from the first PR to the second within one sync", async () => {
    const m = installPrDetailIngestDb({});

    await syncPrDetailRefs([
      prRef({ prNumber: 1, state: GitHubPRState.Open }),
      prRef({ prNumber: 2, state: GitHubPRState.Open }),
    ]);

    const first = m.rows.find((r) => r.number === 1);
    const second = m.rows.find((r) => r.number === 2);
    expect(first?.id).toBeDefined();
    expect(second?.id).toBeDefined();
    // The second PR's pointer read saw the FIRST PR — the desktop-owned-handover
    // branch, reachable only because the pointer written moments earlier in this
    // same sync is visible to the re-read.
    expect(m.prFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: first?.id } })
    );
    // Handover: the desktop-owned current PR is demoted and the pointer moves.
    expect(first?.isCurrent).toBe(false);
    expect(second?.isCurrent).toBe(true);
    expect(m.branchPointers.get(BRANCH_ARTIFACT_ID)).toBe(second?.id);
  });

  it("never gap-fills mergedAt/closedAt onto an App-owned row", async () => {
    const m = installPrDetailIngestDb({
      pullRequestDetails: [
        {
          id: "pr-app-lifecycle",
          branchArtifactId: BRANCH_ARTIFACT_ID,
          repositoryId: "repo-1",
          repositoryFullName: "acme/web",
          number: 42,
          fetchMechanism: GitHubFetchMechanism.Webhook,
          title: null,
          htmlUrl: null,
          additions: null,
        },
      ],
    });

    await syncPrDetailRefs([
      prRef({
        state: GitHubPRState.Merged,
        mergedAt: MERGED_AT,
        closedAt: MERGED_AT,
        title: "Desktop title",
        additions: 7,
      }),
    ]);

    expect(m.prUpdate).toHaveBeenCalledTimes(1);
    const gap = m.prUpdate.mock.calls[0][0].data;
    // On an App-owned row a NULL lifecycle timestamp is the authoritative
    // "not merged, not closed" answer. Adding these two to the gap-fill list
    // would mark the PR merged at a time GitHub never confirmed — the rail
    // would show a merged dot while the badge still read Open.
    expect(gap).not.toHaveProperty("mergedAt");
    expect(gap).not.toHaveProperty("closedAt");
    expect(m.rows.find((r) => r.id === "pr-app-lifecycle")).not.toHaveProperty(
      "mergedAt"
    );
    expect(m.rows.find((r) => r.id === "pr-app-lifecycle")).not.toHaveProperty(
      "closedAt"
    );
    // The columns that ARE gap-fillable still fill — this is an omission of two
    // specific fields, not a refusal to gap-fill a lifecycle-carrying ref.
    expect(gap).toMatchObject({ title: "Desktop title", additions: 7 });
    expect(gap.htmlUrl).toBe("https://github.com/acme/web/pull/42");
    // Webhook-wins throughout: no pointer move, no branch lifecycle advance.
    expect(m.branchDetailUpdate).not.toHaveBeenCalled();
    expect(m.artifactUpdateMany).not.toHaveBeenCalled();
  });
});

describe("resolved PullRequestDetail map (ISS-6450)", () => {
  it("reports the ROW's branch artifact, not the ref's, for a cross-branch row", async () => {
    const authorityQueryRaw = vi
      .fn()
      .mockImplementation((query: { sql?: string }) =>
        Promise.resolve(
          query.sql?.includes("github_installation_repositories")
            ? [
                repositoryWithAvailableDefault({
                  id: "repo-1",
                  fullName: "acme/web",
                }),
              ]
            : []
        )
      );
    const repositoryAuthority = await resolveBranchRepoMap(
      { $queryRaw: authorityQueryRaw } as never,
      "org-1",
      [buildSyncedSession({ artifactRefs: [prRef()] })]
    );
    const tx = {
      branchDetail: {
        findFirst: vi
          .fn()
          .mockResolvedValue({ artifactId: BRANCH_ARTIFACT_ID }),
      },
      pullRequestDetail: {
        findFirst: vi.fn().mockResolvedValue({
          id: "pr-other-branch",
          branchArtifactId: "branch-artifact-OTHER",
          fetchMechanism: GitHubFetchMechanism.DesktopSync,
          fetchObservedAt: null,
          githubId: null,
          repositoryId: "repo-1",
          repositoryFullName: "acme/web",
          title: null,
          htmlUrl: null,
          additions: null,
          deletions: null,
          changedFiles: null,
        }),
      },
    };

    const resolved = await persistSessionPullRequestDetails(
      tx as never,
      "org-1",
      null,
      "session-artifact-1",
      [prRef()],
      repositoryAuthority
    );

    // Leave-attached (FEA-3917 OQ1): the row keeps its own branch. Handing the
    // monitored-activity lane `BRANCH_ARTIFACT_ID` here would attribute the atom
    // to a branch that does not own the PR, which `validateOwnership` rejects —
    // rolling back every retry of the session.
    expect(
      resolved.get(sessionPullRequestDetailKey("acme/web", 42))
    ).toStrictEqual({
      prDetailId: "pr-other-branch",
      branchArtifactId: "branch-artifact-OTHER",
    });
  });
});
