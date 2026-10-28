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

import { LinkType } from "@repo/api/src/types/artifact";
import { BranchParticipationKind } from "@repo/api/src/types/branch";
import { GitHubPRState } from "@repo/api/src/types/github";
import { GitHubFetchMechanism } from "@repo/api/src/types/github-read-model";
import {
  ArtifactRefMethod,
  ArtifactRefRelation,
  PR_INT_MAX,
  SessionArtifactLinkKind,
  SessionPrRelationType,
  type SyncedSessionPrRef,
} from "@repo/api/src/types/session-artifact-link";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { repositoryWithAvailableDefault } from "@/__tests__/support/agent-sessions/branch-ingest.test-harness";
import { buildSyncedSession } from "@/__tests__/support/agent-sessions/service.test-harness";
import {
  PR_DETAIL_BRANCH_ARTIFACT_ID as BRANCH_ARTIFACT_ID,
  installPrDetailIngestDb,
  PR_DETAIL_OBSERVED_AT as OBSERVED_AT,
  prDetailRef as prRef,
  syncPrDetailRefs,
} from "@/__tests__/support/agent-sessions/service.test-harness-pr-detail";
import { CloudBranchNonMaterializationKind } from "@/app/branches/branch-write-eligibility";
import {
  persistSessionPullRequestDetails,
  resolveSessionPrDetailMap,
  sessionPullRequestDetailKey,
} from "./pull-request-details";
import { SESSION_PR_LINK_SOURCE } from "./session-pr-link-source";
import { resolveSessionRepositoryIdentity } from "./shared";

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

const MERGED_AT = "2026-05-20T19:00:00.000Z";

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

  it("writes an exact identity-bearing Branch association for a fresh PR head ref", async () => {
    const m = installPrDetailIngestDb({});

    await syncPrDetailRefs([prRef()], undefined, {
      prRefs: [
        {
          repositoryFullName: "acme/web",
          prNumber: 42,
          relationType: SessionPrRelationType.Created,
        },
      ],
    });

    expect(m.prCreateMany).toHaveBeenCalledTimes(1);
    expect(m.artifactLinkUpsert).toHaveBeenCalledTimes(1);
    const upsert = m.artifactLinkUpsert.mock.calls[0]?.[0];
    expect(upsert.create).toMatchObject({
      organizationId: "org-1",
      sourceId: "persisted-session-1",
      targetId: BRANCH_ARTIFACT_ID,
      linkType: LinkType.RelatesTo,
      branchParticipation: BranchParticipationKind.Wrote,
      branchParticipationMethod: ArtifactRefMethod.PrCreateOutput,
      branchParticipationObservedAt: new Date(OBSERVED_AT),
      metadata: {
        linkKind: SessionArtifactLinkKind.SessionPr,
        linkKinds: [
          SessionArtifactLinkKind.SessionBranch,
          SessionArtifactLinkKind.SessionPr,
        ],
        relationTypes: [SessionPrRelationType.Created],
        repositoryFullName: "acme/web",
        prNumber: 42,
        prRefs: [
          {
            repositoryFullName: "acme/web",
            prNumber: 42,
            relationTypes: [SessionPrRelationType.Created],
          },
        ],
        source: SESSION_PR_LINK_SOURCE,
        confidence: 1,
        extractorVersion: 1,
        method: ArtifactRefMethod.PrCreateOutput,
        relation: ArtifactRefRelation.Created,
        observedAt: OBSERVED_AT,
        branchName: "feat/x",
        branchRepositoryFullName: "acme/web",
        branchParticipation: BranchParticipationKind.Wrote,
      },
    });
    expect(upsert.create.metadata).not.toHaveProperty("branchLinked");
  });

  it("does not materialize a spoofed incoming head for an existing exact PR row", async () => {
    const m = installPrDetailIngestDb({
      branches: [
        {
          artifactId: BRANCH_ARTIFACT_ID,
          branchName: "feat/original",
          repositoryFullName: "acme/web",
        },
      ],
      pullRequestDetails: [
        {
          id: "pr-existing-42",
          branchArtifactId: BRANCH_ARTIFACT_ID,
          repositoryId: "repo-1",
          repositoryFullName: "acme/web",
          number: 42,
        },
      ],
    });

    await syncPrDetailRefs([prRef({ branchName: "feat/spoofed" })], undefined, {
      prRefs: [
        {
          repositoryFullName: "acme/web",
          prNumber: 42,
          relationType: SessionPrRelationType.Created,
        },
      ],
    });

    expect(m.artifactCreate).not.toHaveBeenCalled();
    expect(m.prCreateMany).not.toHaveBeenCalled();
    expect(m.prUpdateMany).not.toHaveBeenCalled();
    expect(retryAggregateFromQueryRawCalls(m.queryRaw)).toBeUndefined();
    expect(m.artifactLinkUpsert).toHaveBeenCalledTimes(1);
    const upsert = m.artifactLinkUpsert.mock.calls[0]?.[0];
    expect(upsert.create).toMatchObject({
      targetId: BRANCH_ARTIFACT_ID,
      metadata: {
        linkKind: SessionArtifactLinkKind.SessionPr,
        linkKinds: [SessionArtifactLinkKind.SessionPr],
        repositoryFullName: "acme/web",
        prNumber: 42,
      },
    });
    expect(upsert.create.metadata).not.toHaveProperty("branchName");
    expect(upsert.create.metadata).not.toHaveProperty("branchLinked");
  });

  it("keeps PR detail writes independent of the PR-link freshness gate", async () => {
    const m = installPrDetailIngestDb({});

    await syncPrDetailRefs([prRef({ title: "Late PR facts" })], undefined, {
      prRefs: [
        {
          repositoryFullName: "acme/web",
          prNumber: 42,
          relationType: SessionPrRelationType.Created,
        },
      ],
      updatedAt: "2026-05-20T16:59:00.000Z",
    });

    expect(m.artifactCreate).not.toHaveBeenCalled();
    expect(m.prCreateMany).toHaveBeenCalledTimes(1);
    expect(m.prCreateMany.mock.calls[0][0].data[0]).toMatchObject({
      title: "Late PR facts",
      lastVerifiedAt: new Date(OBSERVED_AT),
    });
    expect(retryAggregateFromQueryRawCalls(m.queryRaw)).toBeUndefined();
    expect(m.artifactLinkUpsert).not.toHaveBeenCalled();
    expect(m.branchDetailUpdateMany).not.toHaveBeenCalled();
  });

  it("keeps every same-branch PR identity in the retry aggregate", async () => {
    const m = installPrDetailIngestDb({ repos: [], publicRepositories: [] });

    await syncPrDetailRefs([
      prRef(),
      prRef({
        prNumber: 43,
        title: "Second PR",
      }),
    ]);

    expect(m.prCreateMany).not.toHaveBeenCalled();
    expect(m.artifactLinkUpsert).not.toHaveBeenCalled();
    expect(retryAggregateFromQueryRawCalls(m.queryRaw)).toMatchObject({
      repositoryFullName: "acme/web",
      branchName: "feat/x",
      pullRequestObserved: true,
      branchRefObserved: false,
      prRefs: [
        {
          repositoryFullName: "acme/web",
          prNumber: 42,
          relationTypes: [SessionPrRelationType.Created],
        },
        {
          repositoryFullName: "acme/web",
          prNumber: 43,
          relationTypes: [SessionPrRelationType.Created],
        },
      ],
    });
    expect(m.sessionDetailUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          metadata: expect.objectContaining({
            _unresolvedPrDetailRefs: [
              {
                repositoryFullName: "acme/web",
                prNumber: 42,
                cause: CloudBranchNonMaterializationKind.AuthorityUnavailable,
              },
              {
                repositoryFullName: "acme/web",
                prNumber: 43,
                cause: CloudBranchNonMaterializationKind.AuthorityUnavailable,
              },
            ],
          }),
        }),
      })
    );
  });

  it("creates a factless ref's row without advancing either freshness clock", async () => {
    const m = installPrDetailIngestDb({});

    // Every optional fact absent — the shape a `gh_pr_create` parse leaves when
    // it recovered only the repo and number (ISS-8423).
    await syncPrDetailRefs([prRef()]);

    expect(m.prCreateMany).toHaveBeenCalledTimes(1);
    const created = m.prCreateMany.mock.calls[0][0].data[0];
    // The row IS written — the assertion below is about the stamp, not about a
    // write that never happened.
    expect(created.htmlUrl).toBe("https://github.com/acme/web/pull/42");
    expect(created).not.toHaveProperty("lastVerifiedAt");
    // Nor the reconciler's retry clock: an ingest that learned nothing must not
    // push the row out of the reconciler's window.
    expect(created).not.toHaveProperty("lastRefreshAttemptAt");
  });

  // ISS-8423 (whitlockk review): `state` and `isDraft` ARE observations, so they
  // still earn the verification stamp — but their columns are NOT NULL with
  // defaults, so the reconciler's stub arm cannot see that they were observed
  // and keeps selecting the row. A producer that moved that arm's clock would
  // therefore push the row out of the retry window on every sync and it would
  // never drain. Both shapes share the factless row's retry-clock treatment.
  it("stamps verification but not the retry clock for a state-only ref", async () => {
    const m = installPrDetailIngestDb({});

    await syncPrDetailRefs([prRef({ state: GitHubPRState.Open })]);

    const created = m.prCreateMany.mock.calls[0][0].data[0];
    expect(created.lastVerifiedAt).toEqual(new Date(OBSERVED_AT));
    expect(created).not.toHaveProperty("lastRefreshAttemptAt");
  });

  it("stamps verification but not the retry clock for an isDraft-only ref", async () => {
    const m = installPrDetailIngestDb({});

    await syncPrDetailRefs([prRef({ isDraft: true })]);

    const created = m.prCreateMany.mock.calls[0][0].data[0];
    expect(created.lastVerifiedAt).toEqual(new Date(OBSERVED_AT));
    expect(created).not.toHaveProperty("lastRefreshAttemptAt");
  });

  // ISS-8175 joining the same gate. A base ref read out of gh's create output IS
  // an observation, so it earns verification — but it is classified NOT fetchable
  // (`desktop-pull-request-facts.ts`) even though `base_ref_name` is nullable and
  // a provider fetch does fill it, because a row holding only a base still has no
  // title, no LOC and none of the `head_repository_default_branch_*` columns
  // cloud branch eligibility needs. It is as much a stub as the two above, so the
  // reconciler must keep selecting it and this lane must not move its clock.
  // Mapping `baseRefName` to its column instead reverses BOTH assertions here.
  it("stamps verification but not the retry clock for a baseRef-only ref", async () => {
    const m = installPrDetailIngestDb({});

    await syncPrDetailRefs([prRef({ baseRef: "release/2026-08" })]);

    const created = m.prCreateMany.mock.calls[0][0].data[0];
    expect(created.baseRefName).toBe("release/2026-08");
    expect(created.lastVerifiedAt).toEqual(new Date(OBSERVED_AT));
    expect(created).not.toHaveProperty("lastRefreshAttemptAt");
  });

  // The other side of the same gate: a fact a fetch could have filled leaves
  // nothing for the reconciler to do, so it DOES own the retry clock. Rules out
  // a fix that simply stops stamping.
  it("stamps both clocks when the ref carried a fetchable fact", async () => {
    const m = installPrDetailIngestDb({});

    await syncPrDetailRefs([prRef({ title: "Add widget" })]);

    const created = m.prCreateMany.mock.calls[0][0].data[0];
    expect(created.lastVerifiedAt).toEqual(new Date(OBSERVED_AT));
    expect(created.lastRefreshAttemptAt).toEqual(new Date(OBSERVED_AT));
  });

  it("updates a desktop-owned row from a factless ref without claiming verification", async () => {
    const m = installPrDetailIngestDb({
      pullRequestDetails: [
        {
          id: "pr-desktop-1",
          branchArtifactId: BRANCH_ARTIFACT_ID,
          repositoryId: "repo-1",
          repositoryFullName: "acme/web",
          number: 42,
          fetchMechanism: GitHubFetchMechanism.DesktopSync,
          title: null,
        },
      ],
    });

    await syncPrDetailRefs([prRef()]);

    // The facts update, not the isCurrent demote (whose `where` is keyed on
    // branchArtifactId + isCurrent).
    const factsUpdate = m.prUpdateMany.mock.calls
      .map((call) => call[0])
      .find((args) => args.where?.id === "pr-desktop-1");
    expect(factsUpdate).toBeDefined();
    expect(factsUpdate.data).not.toHaveProperty("lastVerifiedAt");
    expect(factsUpdate.data).not.toHaveProperty("lastRefreshAttemptAt");
    // The write still lands — the omissions above are about the two clocks, not
    // about a write that never happened.
    expect(factsUpdate.data.htmlUrl).toBe(
      "https://github.com/acme/web/pull/42"
    );
  });

  it("points the branch at a newly created desktop PR and advances its lifecycle", async () => {
    const m = installPrDetailIngestDb({});

    await syncPrDetailRefs([prRef({ state: GitHubPRState.Merged })]);

    expect(m.branchDetailUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          artifactId: BRANCH_ARTIFACT_ID,
          organizationId: "org-1",
          currentPullRequestDetailId: null,
        },
        data: {
          currentPullRequestDetailId: expect.any(String),
        },
      })
    );
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
    expect(m.prUpdateMany).toHaveBeenCalledTimes(1);
    const gap = m.prUpdateMany.mock.calls[0][0].data;
    // Only the NULL columns are filled; the App-owned title is untouched.
    expect(gap).not.toHaveProperty("title");
    expect(gap).toMatchObject({ additions: 7 });
    expect(gap.htmlUrl).toBe("https://github.com/acme/web/pull/42");
    // Never lifecycle: an App-owned row means the desktop does not own the row.
    expect(m.branchDetailUpdateMany).not.toHaveBeenCalled();
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
    expect(m.branchDetailUpdateMany).not.toHaveBeenCalled();
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
    expect(m.prUpdateMany).not.toHaveBeenCalled();
    expect(m.branchDetailUpdateMany).not.toHaveBeenCalled();
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

    expect(m.prUpdateMany).not.toHaveBeenCalled();
    expect(m.branchDetailUpdateMany).not.toHaveBeenCalled();
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
    const factsWrite = m.prUpdateMany.mock.calls.find(
      (c) => c[0]?.where?.id === "pr-own" && "title" in (c[0]?.data ?? {})
    );
    expect(factsWrite?.[0].data).toMatchObject({ title: "New" });
    const currentWrite = m.prUpdateMany.mock.calls.find(
      (c) => c[0]?.data?.isCurrent === true
    );
    expect(currentWrite).toBeDefined();
    expect(m.branchDetailUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          artifactId: BRANCH_ARTIFACT_ID,
          organizationId: "org-1",
          currentPullRequestDetailId: null,
        },
        data: { currentPullRequestDetailId: "pr-own" },
      })
    );
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
    expect(m.branchDetailUpdateMany).not.toHaveBeenCalled();
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
    expect(m.prUpdateMany).not.toHaveBeenCalled();
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
    expect(m.prFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: first?.id, organizationId: "org-1" },
      })
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

    expect(m.prUpdateMany).toHaveBeenCalledTimes(1);
    const gap = m.prUpdateMany.mock.calls[0][0].data;
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
    expect(m.branchDetailUpdateMany).not.toHaveBeenCalled();
    expect(m.artifactUpdateMany).not.toHaveBeenCalled();
  });
});

describe("resolved PullRequestDetail map (ISS-6450)", () => {
  it("drops out-of-range legacy prRefs before PullRequestDetail lookup", async () => {
    const pullRequestDetailFindMany = vi.fn().mockResolvedValue([
      {
        id: "pr-valid",
        repositoryId: "repo-1",
        number: 42,
        branchArtifactId: BRANCH_ARTIFACT_ID,
      },
    ]);
    const tx = {
      gitHubInstallationRepository: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "repo-1",
            fullName: "acme/web",
          },
        ]),
      },
      pullRequestDetail: {
        findMany: pullRequestDetailFindMany,
      },
    };

    const resolved = await resolveSessionPrDetailMap(
      tx as never,
      "org-1",
      [sessionPrRef(PR_INT_MAX + 1), sessionPrRef(42)],
      new Map()
    );

    expect(pullRequestDetailFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [{ repositoryId: "repo-1", number: 42 }],
        }),
      })
    );
    expect(resolved.get(sessionPullRequestDetailKey("acme/web", 42))).toEqual({
      prDetailId: "pr-valid",
      branchArtifactId: BRANCH_ARTIFACT_ID,
    });
  });

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
    const { authorities: repositoryAuthority } =
      await resolveSessionRepositoryIdentity(
        { $queryRaw: authorityQueryRaw } as never,
        "org-1",
        [buildSyncedSession({ artifactRefs: [prRef()] })]
      );
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      branchDetail: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      pullRequestDetail: {
        findMany: vi.fn().mockResolvedValue([
          {
            number: 42,
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
          },
        ]),
      },
    };

    const resolved = await persistSessionPullRequestDetails(
      tx as never,
      "org-1",
      null,
      "session-artifact-1",
      [prRef()],
      repositoryAuthority,
      { shouldUpdatePullRequestLinks: true }
    );

    // Leave-attached (FEA-3917 OQ1): the row keeps its own branch. Handing the
    // monitored-activity lane `BRANCH_ARTIFACT_ID` here would attribute the atom
    // to a branch that does not own the PR, which `validateOwnership` rejects —
    // rolling back every retry of the session.
    expect(
      resolved.details.get(sessionPullRequestDetailKey("acme/web", 42))
    ).toStrictEqual({
      prDetailId: "pr-other-branch",
      branchArtifactId: "branch-artifact-OTHER",
    });
  });
});

function sessionPrRef(prNumber: number): SyncedSessionPrRef {
  return {
    repositoryFullName: "acme/web",
    prNumber,
    relationType: SessionPrRelationType.Referenced,
  };
}

function retryAggregateFromQueryRawCalls(queryRaw: ReturnType<typeof vi.fn>) {
  return queryRaw.mock.calls
    .flatMap((call) => {
      const query = call[0] as
        | { sql?: string; values?: readonly unknown[] }
        | undefined;
      return query?.sql?.includes("branch_materialization_retries")
        ? (query.values ?? [])
        : [];
    })
    .filter((value): value is string => typeof value === "string")
    .map((value) => parseJsonObject(value))
    .find(
      (value): value is Record<string, unknown> =>
        value !== null &&
        typeof value === "object" &&
        Array.isArray(value.prRefs)
    );
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
