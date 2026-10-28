/**
 * ISS-10513 — branch coverage for `pull-request-details.ts` left uncovered by
 * `pull-request-detail-lane.test.ts` (the lane's main suite) and the
 * differently-scoped `pull-request-details.test.ts` sibling.
 *
 * Every case here targets one or more specific uncovered branch slots from the
 * ISS-10513 baseline coverage run rather than re-proving behavior the lane
 * suite already pins. Where the full sync harness cannot reach a slot (a
 * mid-write race, or an internal helper's own defensive guard), the case calls
 * the exported `persistSessionPullRequestDetails` / `resolveSessionPrDetailMap`
 * directly against a hand-built minimal `tx`, matching the pattern the lane
 * suite already uses for `resolveSessionPrDetailMap`.
 */

import { GitHubPRState } from "@repo/api/src/types/github";
import { GitHubFetchMechanism } from "@repo/api/src/types/github-read-model";
import { normalizePersistedRepositoryDefaultAuthority } from "@repo/api/src/types/repository-default-identity";
import {
  SessionPrRelationType,
  type SyncedSessionPrRef,
} from "@repo/api/src/types/session-artifact-link";
import { VcsProviderKind } from "@repo/api/src/types/vcs-provider-kind";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { repositoryWithAvailableDefault } from "@/__tests__/support/agent-sessions/branch-ingest.test-harness";
import {
  PR_DETAIL_BRANCH_ARTIFACT_ID as BRANCH_ARTIFACT_ID,
  installPrDetailIngestDb,
  prDetailRef as prRef,
  syncPrDetailRefs,
} from "@/__tests__/support/agent-sessions/service.test-harness-pr-detail";
import { RepositoryIdentitySource } from "./authority-source-queries";
import {
  persistSessionPullRequestDetails,
  resolveSessionPrDetailMap,
  sessionPullRequestDetailKey,
} from "./pull-request-details";
import { PullRequestLaneDeferral } from "./pull-request-lane-deferral";

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

describe("pull_request artifact-ref lane — extra branch coverage (ISS-10513)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("collapses two factless, branchless refs sharing an identity into a single unresolved entry", async () => {
    const m = installPrDetailIngestDb({});

    await syncPrDetailRefs([
      prRef({ observedAt: undefined, branchName: undefined }),
      prRef({
        observedAt: undefined,
        branchName: undefined,
        title: "Second",
      }),
    ]);

    // Aggregation collapsed the two refs to one identity before the per-ref
    // loop ran: a single unresolved entry, not two, and no row write for
    // either. Mutating the merge's dedup key would emit two entries here.
    expect(m.prCreateMany).not.toHaveBeenCalled();
    const persisted = m.sessionDetailUpdate.mock.calls
      .map((c) => c[0]?.data?.metadata?._unresolvedPrDetailRefs)
      .find((value): value is unknown[] => Array.isArray(value));
    expect(persisted).toEqual([
      { repositoryFullName: "acme/web", prNumber: 42 },
    ]);
  });

  it("keeps the earlier-seen ref's facts when a later-arriving ref reports an earlier observedAt", async () => {
    const m = installPrDetailIngestDb({});

    await syncPrDetailRefs([
      prRef({
        observedAt: "2026-05-20T20:00:00.000Z",
        title: "First",
      }),
      // Arrives second in the batch but claims an EARLIER observation than
      // the ref already stored under this identity — the aggregation must not
      // let it win.
      prRef({
        observedAt: "2026-05-20T10:00:00.000Z",
        title: "Second",
      }),
    ]);

    expect(m.prCreateMany).toHaveBeenCalledTimes(1);
    expect(m.prCreateMany.mock.calls[0][0].data[0]).toMatchObject({
      title: "First",
    });
  });

  it("lets a later-arriving ref win on an exact observedAt tie", async () => {
    const m = installPrDetailIngestDb({});
    const tiedObservedAt = "2026-05-20T15:00:00.000Z";

    await syncPrDetailRefs([
      prRef({ observedAt: tiedObservedAt, title: "First" }),
      // Same observedAt as the stored ref — `incomingAt >= existingAt` must
      // still resolve the tie in the incoming ref's favor (`>=`, not `>`).
      prRef({ observedAt: tiedObservedAt, title: "Second" }),
    ]);

    expect(m.prCreateMany).toHaveBeenCalledTimes(1);
    expect(m.prCreateMany.mock.calls[0][0].data[0]).toMatchObject({
      title: "Second",
    });
  });

  it("bumps branch activity from mergedAt, not the ref's own observedAt", async () => {
    const m = installPrDetailIngestDb({});

    // observedAt (from the default fixture) and mergedAt are deliberately
    // different values so the two can't be confused for one another: the
    // `??` chain must pick mergedAt first, never fall through to observedAt
    // or null while mergedAt is present.
    await syncPrDetailRefs([
      prRef({
        state: GitHubPRState.Merged,
        mergedAt: "2026-05-25T00:00:00.000Z",
      }),
    ]);

    const activityWrite = m.branchDetailUpdateMany.mock.calls.find(
      (call) => "lastActivityAt" in (call[0]?.data ?? {})
    );
    expect(activityWrite?.[0].data).toEqual({
      lastActivityAt: new Date("2026-05-25T00:00:00.000Z"),
    });
  });

  it("stamps freshness at receipt time and skips the activity bump when the ref carries no observedAt", async () => {
    const fixedNow = new Date("2026-06-01T00:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(fixedNow);

    const m = installPrDetailIngestDb({});
    await syncPrDetailRefs([
      prRef({ observedAt: undefined, title: "Add widget" }),
    ]);

    const created = m.prCreateMany.mock.calls[0][0].data[0];
    expect(created.lastVerifiedAt).toEqual(fixedNow);
    expect(created.fetchObservedAt).toEqual(fixedNow);
    // No mergedAt/closedAt/observedAt survives to feed the activity bump, so
    // it must no-op rather than write a fabricated timestamp.
    expect(
      m.branchDetailUpdateMany.mock.calls.every(
        (call) => !("lastActivityAt" in (call[0]?.data ?? {}))
      )
    ).toBe(true);
  });

  it("gap-fills deletions, changedFiles, and a missing repositoryFullName on an App-owned row", async () => {
    const m = installPrDetailIngestDb({
      pullRequestDetails: [
        {
          id: "pr-app-gaps",
          branchArtifactId: BRANCH_ARTIFACT_ID,
          repositoryId: "repo-1",
          repositoryFullName: null,
          number: 42,
          fetchMechanism: GitHubFetchMechanism.Webhook,
          title: "Authoritative title",
          htmlUrl: "https://github.com/acme/web/pull/42",
          additions: 5,
          deletions: null,
          changedFiles: null,
        },
      ],
    });

    await syncPrDetailRefs([prRef({ deletions: 4, changedFiles: 2 })]);

    expect(m.prUpdateMany).toHaveBeenCalledTimes(1);
    const call = m.prUpdateMany.mock.calls[0][0];
    // Scoped to exactly this row, org-scoped — an unscoped `where` would gap-fill
    // (or collide across) every other row instead of just this one.
    expect(call.where).toEqual({ id: "pr-app-gaps", organizationId: "org-1" });
    expect(call.data).toEqual({
      deletions: 4,
      changedFiles: 2,
      repositoryFullName: "acme/web",
    });
    expect(m.branchDetailUpdateMany).not.toHaveBeenCalled();
  });

  it("preserves every already-populated App-owned column against a conflicting desktop observation", async () => {
    const m = installPrDetailIngestDb({
      pullRequestDetails: [
        {
          id: "pr-app-full",
          branchArtifactId: BRANCH_ARTIFACT_ID,
          repositoryId: "repo-1",
          repositoryFullName: "acme/web",
          number: 42,
          fetchMechanism: GitHubFetchMechanism.Webhook,
          title: "Authoritative title",
          htmlUrl: "https://github.com/acme/web/pull/42",
          additions: 5,
          deletions: 1,
          changedFiles: 2,
          baseRefName: "main",
        },
      ],
    });

    // Every gap-fillable column already has a value AND the ref supplies a
    // conflicting one for each — the App-owned row must win on every single
    // one of them, so the gap is empty and no update is issued at all.
    await syncPrDetailRefs([
      prRef({
        title: "Desktop title",
        additions: 99,
        deletions: 99,
        changedFiles: 99,
        baseRef: "release/2026",
      }),
    ]);

    expect(m.prUpdateMany).not.toHaveBeenCalled();
  });

  it("dedupes a row moved to another branch before the provider lock was acquired", async () => {
    const m = installPrDetailIngestDb({
      pullRequestDetails: [
        {
          id: "pr-moved",
          number: 42,
          repositoryId: "repo-1",
          repositoryFullName: "acme/web",
          branchArtifactId: "branch-artifact-OTHER",
          fetchMechanism: GitHubFetchMechanism.DesktopSync,
        },
      ],
    });
    await syncPrDetailRefs([prRef()]);
    expect(m.prCreateMany).not.toHaveBeenCalled();
    expect(m.prUpdateMany).not.toHaveBeenCalled();
    expect(m.branchDetailUpdateMany).not.toHaveBeenCalled();
  });

  it("recovers a missing repositoryFullName when updating an existing desktop-owned row found by repositoryId", async () => {
    const m = installPrDetailIngestDb({
      pullRequestDetails: [
        {
          id: "pr-missing-fullname",
          branchArtifactId: BRANCH_ARTIFACT_ID,
          repositoryId: "repo-1",
          repositoryFullName: null,
          number: 42,
          fetchMechanism: GitHubFetchMechanism.DesktopSync,
          title: null,
        },
      ],
    });

    await syncPrDetailRefs([prRef({ title: "New title" })]);

    const factsUpdate = m.prUpdateMany.mock.calls.find(
      (c) => c[0]?.where?.id === "pr-missing-fullname" && "title" in c[0].data
    );
    expect(factsUpdate?.[0].data).toMatchObject({
      repositoryFullName: "acme/web",
      title: "New title",
      // A same-branch desktop-owned update always stamps this true, even on a
      // row that predates the column.
      desktopOriginated: true,
    });
    expect(factsUpdate?.[0].data).not.toHaveProperty("repositoryId");
  });

  it("backfills repositoryId onto an existing desktop-owned row resolved without one", async () => {
    const m = installPrDetailIngestDb({
      pullRequestDetails: [
        {
          id: "pr-missing-repoid",
          branchArtifactId: BRANCH_ARTIFACT_ID,
          repositoryId: null,
          repositoryFullName: "acme/web",
          number: 42,
          fetchMechanism: GitHubFetchMechanism.DesktopSync,
          title: null,
        },
      ],
    });

    await syncPrDetailRefs([prRef({ title: "New title" })]);

    const factsUpdate = m.prUpdateMany.mock.calls.find(
      (c) => c[0]?.where?.id === "pr-missing-repoid" && "title" in c[0].data
    );
    expect(factsUpdate?.[0].data).toMatchObject({
      repositoryId: "repo-1",
      title: "New title",
    });
  });

  it("throws when the facts-update race loses its target row", async () => {
    const m = installPrDetailIngestDb({
      pullRequestDetails: [
        {
          id: "pr-race-update",
          branchArtifactId: BRANCH_ARTIFACT_ID,
          repositoryId: "repo-1",
          repositoryFullName: "acme/web",
          number: 42,
          fetchMechanism: GitHubFetchMechanism.DesktopSync,
          title: "Old",
        },
      ],
    });
    m.prUpdateMany.mockImplementationOnce(() => Promise.resolve({ count: 0 }));

    await expect(syncPrDetailRefs([prRef({ title: "New" })])).rejects.toThrow(
      "desktop PR owner changed"
    );
  });

  it("throws when the webhook gap-fill race loses its target row", async () => {
    const m = installPrDetailIngestDb({
      pullRequestDetails: [
        {
          id: "pr-app-race",
          branchArtifactId: BRANCH_ARTIFACT_ID,
          repositoryId: "repo-1",
          repositoryFullName: "acme/web",
          number: 42,
          fetchMechanism: GitHubFetchMechanism.Webhook,
          title: "Authoritative title",
          additions: null,
        },
      ],
    });
    m.prUpdateMany.mockImplementationOnce(() => Promise.resolve({ count: 0 }));

    await expect(syncPrDetailRefs([prRef({ additions: 7 })])).rejects.toThrow(
      "desktop PR gap-fill owner changed"
    );
  });

  it("throws when a conflict-safe insert leaves no row to read back", async () => {
    const m = installPrDetailIngestDb({});
    m.prCreateMany.mockImplementationOnce(() => Promise.resolve([]));

    await expect(syncPrDetailRefs([prRef()])).rejects.toThrow(
      "pullRequestDetail insert vanished"
    );
  });

  it("returns the successful conflict-safe insert directly with a minimal select", async () => {
    const m = installPrDetailIngestDb({});

    await syncPrDetailRefs([prRef()]);

    expect(m.prFindFirst).not.toHaveBeenCalled();
    expect(m.prCreateMany.mock.calls[0][0].select).toEqual({
      id: true,
      branchArtifactId: true,
    });
  });

  it("filters malformed stored unresolved PR refs while keeping valid ones across a resync", async () => {
    const sessionDetailUpdate = vi.fn().mockResolvedValue({});
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      sessionDetail: {
        findUnique: vi.fn().mockResolvedValue({
          metadata: {
            _unresolvedPrDetailRefs: [
              // Valid, no cause — the OR's left arm short-circuits true.
              { repositoryFullName: "old/repo", prNumber: 1 },
              // Valid, string cause — forces evaluation of the OR's right arm.
              {
                repositoryFullName: "old/repo",
                prNumber: 2,
                cause: "default_branch",
              },
              // Invalid: missing prNumber.
              { repositoryFullName: "old/repo" },
              // Invalid: cause present but not a string.
              { repositoryFullName: "old/repo", prNumber: 4, cause: 7 },
              // Invalid: not an object at all. `typeof null === "object"`, so
              // this also proves the guard short-circuits on `!= null` before
              // ever reading a property off it (a forced-true mutant here
              // reads `.repositoryFullName` off `null` and throws).
              null,
              // Invalid: repositoryFullName present but not a string.
              { repositoryFullName: 123, prNumber: 6 },
            ],
          },
        }),
        update: sessionDetailUpdate,
      },
    };

    await persistSessionPullRequestDetails(
      tx as never,
      "org-1",
      null,
      "session-artifact-1",
      [prRef({ branchName: undefined, prNumber: 5 })],
      new Map(),
      { shouldUpdatePullRequestLinks: true }
    );

    expect(sessionDetailUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { artifactId: "session-artifact-1" },
        data: expect.objectContaining({
          metadata: expect.objectContaining({
            _unresolvedPrDetailRefs: [
              { repositoryFullName: "old/repo", prNumber: 1 },
              {
                repositoryFullName: "old/repo",
                prNumber: 2,
                cause: "default_branch",
              },
              { repositoryFullName: "acme/web", prNumber: 5 },
            ],
          }),
        }),
      })
    );
  });

  /**
   * The lane decides per AGGREGATED target, never per raw ref, and it is the
   * only thing that decides: `aggregatePullRequestArtifactRefs` collapses a
   * session's refs to one per `(repository, number)` and carries a head branch
   * name from any of them. A reader answering this per raw ref disagreed with
   * the lane on exactly this shape — the headless ref claimed a key the named
   * ref had already been denied (PR #7621 defect 2) — which is why the verdict
   * is reported rather than re-derived.
   *
   * Two targets whose refs DISAGREE, because one target cannot tell a
   * per-target verdict from a delivery-wide one: 42 arrives headless AND
   * named, 43 headless only, and they must come back as different deferrals.
   */
  it("reports one deferral per aggregated target when its refs disagree", async () => {
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      $queryRaw: vi.fn().mockResolvedValue([]),
      pullRequestDetail: { findMany: vi.fn().mockResolvedValue([]) },
      sessionDetail: {
        findUnique: vi.fn().mockResolvedValue({ metadata: {} }),
        update: vi.fn().mockResolvedValue({}),
      },
      branchMaterializationRetry: {
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
        findMany: vi.fn().mockResolvedValue([]),
      },
    };

    const resolved = await persistSessionPullRequestDetails(
      tx as never,
      "org-1",
      null,
      "session-artifact-1",
      [
        prRef({ prNumber: 42, branchName: undefined }),
        prRef({ prNumber: 42, branchName: "feat/head" }),
        prRef({ prNumber: 43, branchName: undefined }),
      ],
      // Empty, so materializing the head branch 42's aggregate carries comes
      // back `AuthorityUnavailable` — attempted and refused, which is
      // `AwaitingRepositoryRead`. 43 carries no name for the lane to attempt.
      new Map(),
      { shouldUpdatePullRequestLinks: true }
    );

    expect(resolved.details.size).toBe(0);
    expect([...resolved.deferrals]).toEqual([
      [
        sessionPullRequestDetailKey("acme/web", 42),
        PullRequestLaneDeferral.AwaitingRepositoryRead,
      ],
      [
        sessionPullRequestDetailKey("acme/web", 43),
        PullRequestLaneDeferral.AwaitingDesktopDelivery,
      ],
    ]);
  });

  /**
   * A headless ref has no identity to materialize, and on a replay the lane
   * records nothing for a later tick either, so `_unresolvedPrDetailRefs`
   * cannot report it. The deferral map is the only thing that does — and a lane
   * that reported nothing here would leave the target to the existence read,
   * which finds no row and acknowledges the Session on evidence the desktop
   * only re-sends while it is held.
   */
  it("resolves no row for a branchless ref on a replay, and reports the deferral", async () => {
    const tx = { $executeRaw: vi.fn().mockResolvedValue(1) };

    const resolved = await persistSessionPullRequestDetails(
      tx as never,
      "org-1",
      null,
      "session-artifact-1",
      [prRef({ branchName: undefined })],
      new Map(),
      { shouldUpdatePullRequestLinks: false }
    );

    expect(resolved.details.size).toBe(0);
    expect([...resolved.deferrals.values()]).toEqual([
      PullRequestLaneDeferral.AwaitingDesktopDelivery,
    ]);
  });

  /**
   * ISS-9182: the lane ATTEMPTS the head branch on this payload's own PR
   * evidence, so a shut link gate no longer decides whether it tries. The
   * observable is the create itself, and reaching it takes a resolved
   * repository authority — `ensureBranchArtifactRow` rejects on
   * `AuthorityUnavailable` BEFORE `createWhenAbsent` is consulted, so the
   * sibling case below can never prove the attempt and does not claim to.
   *
   * The gate is shut here, so re-deriving `createWhenAbsent` from
   * `shouldUpdatePullRequestLinks` — what the pre-fix lane did — reddens this
   * case instead of passing quietly.
   */
  it("attempts and creates the head branch under a shut link gate", async () => {
    const authority = normalizePersistedRepositoryDefaultAuthority(
      {
        provider: VcsProviderKind.GitHub,
        providerRepositoryId: "987",
        fullName: "acme/web",
      },
      repositoryWithAvailableDefault({
        id: "repo-1",
        githubRepoId: "987",
        fullName: "acme/web",
      })
    );
    if (!authority) {
      throw new Error("test authority did not normalize");
    }
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      branchDetail: {
        findFirst: vi.fn().mockResolvedValue(null),
        findMany: vi.fn().mockResolvedValue([]),
      },
      artifact: { create: vi.fn().mockResolvedValue({ id: "branch-created" }) },
      pullRequestDetail: {
        findMany: vi.fn().mockResolvedValue([]),
        createManyAndReturn: vi
          .fn()
          .mockResolvedValue([
            { id: "pr-created", branchArtifactId: "branch-created" },
          ]),
      },
    };

    const resolved = await persistSessionPullRequestDetails(
      tx as never,
      "org-1",
      null,
      "session-artifact-1",
      [prRef({ branchName: "feat/x" })],
      new Map([
        [
          "acme/web",
          {
            repositoryId: "repo-1",
            providerRepositoryId: "987",
            identitySources: new Set([RepositoryIdentitySource.Installation]),
            authorities: [authority],
          },
        ],
      ]),
      { shouldUpdatePullRequestLinks: false }
    );

    // The D2 existence read ran and came back empty, and the lane created the
    // head Branch anyway — the attempt, not a decline.
    expect(tx.branchDetail.findFirst).toHaveBeenCalledTimes(1);
    expect(tx.artifact.create).toHaveBeenCalledTimes(1);
    expect([...resolved.deferrals.values()]).toEqual([]);
    expect([...resolved.details.values()]).toEqual([
      { prDetailId: "pr-created", branchArtifactId: "branch-created" },
    ]);
  });

  /**
   * The other half of ISS-9182: once the lane has attempted, the deferral
   * reports the REPOSITORY read rather than the gate. This case used to assert
   * `AwaitingDesktopDelivery` and argue that a shut gate meant the delivery had
   * declined to write rather than reaching a verdict. That reasoning is what
   * held an ENDED session's targets forever: the gate ties on every replay of a
   * frozen `updatedAt`, so the "later delivery that did try" never arrives.
   *
   * No repository authority resolves here, so the rejection is
   * `AuthorityUnavailable` and the deferral value is the whole contract this
   * case pins; the attempt itself is pinned above.
   */
  it("reports the repository-read verdict when no repository authority resolves", async () => {
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      pullRequestDetail: { findMany: vi.fn().mockResolvedValue([]) },
    };

    const resolved = await persistSessionPullRequestDetails(
      tx as never,
      "org-1",
      null,
      "session-artifact-1",
      [prRef({ branchName: "feat/x" })],
      new Map(),
      { shouldUpdatePullRequestLinks: false }
    );

    expect(resolved.details.size).toBe(0);
    expect([...resolved.deferrals.values()]).toEqual([
      PullRequestLaneDeferral.AwaitingRepositoryRead,
    ]);
  });

  it("skips a resolved detail row missing a repositoryId and one whose repositoryId has no matching name", async () => {
    const pullRequestDetailFindMany = vi.fn().mockResolvedValue([
      {
        id: "pr-no-repo-id",
        repositoryId: null,
        number: 1,
        branchArtifactId: "branch-a",
      },
      {
        id: "pr-unmapped-repo",
        repositoryId: "repo-unmapped",
        number: 2,
        branchArtifactId: "branch-b",
      },
      {
        id: "pr-valid",
        repositoryId: "repo-1",
        number: 42,
        branchArtifactId: BRANCH_ARTIFACT_ID,
      },
    ]);
    const tx = {
      gitHubInstallationRepository: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ id: "repo-1", fullName: "acme/web" }]),
      },
      pullRequestDetail: { findMany: pullRequestDetailFindMany },
    };

    const resolved = await resolveSessionPrDetailMap(
      tx as never,
      "org-1",
      [sessionPrRef(1), sessionPrRef(2), sessionPrRef(42)],
      new Map()
    );

    expect(resolved.size).toBe(1);
    expect(resolved.get(sessionPullRequestDetailKey("acme/web", 42))).toEqual({
      prDetailId: "pr-valid",
      branchArtifactId: BRANCH_ARTIFACT_ID,
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
