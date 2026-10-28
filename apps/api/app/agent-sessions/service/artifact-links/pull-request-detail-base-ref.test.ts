/**
 * ISS-8175 — the BASE-REF half of the `pull_request` artifact-ref lane
 * (`pull-request-details.ts`): which base a desktop-created PR ref may assert,
 * and when that base reaches the PR row and the owning branch.
 *
 * Split out of `pull-request-detail-lane.test.ts`, which owns the identity /
 * ownership / lifecycle half. Both drive the same harness; only the concern
 * under test differs.
 *
 * Every case below asserts the OBSERVABLE write (which delegate was called, with
 * what data) rather than that the sync merely ran — the PRD-618 no-coverage-
 * farming rule.
 */

import { BranchBaseBranchSource } from "@repo/api/src/types/artifact";
import { GitHubPRState } from "@repo/api/src/types/github";
import { GitHubFetchMechanism } from "@repo/api/src/types/github-read-model";
import {
  ArtifactRefMethod,
  ArtifactRefRelation,
} from "@repo/api/src/types/session-artifact-link";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  PR_DETAIL_BRANCH_ARTIFACT_ID as BRANCH_ARTIFACT_ID,
  installPrDetailIngestDb,
  prDetailRef as prRef,
  syncPrDetailRefs,
} from "@/__tests__/support/agent-sessions/service.test-harness-pr-detail";

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

describe("pull_request base-ref lane (ISS-8175)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ISS-8175 AC-1: a base the desktop read when it OPENED the PR reaches both
  // the PR's own column and, through the shared precedence decider, the branch.
  it("writes a desktop-supplied base ref to the PR row and the branch", async () => {
    const m = installPrDetailIngestDb({});

    await syncPrDetailRefs([prRef({ baseRef: "release/2026-08" })]);

    expect(m.prCreateMany.mock.calls[0][0].data[0]).toMatchObject({
      baseRefName: "release/2026-08",
    });
    expect(m.branchBases.get(BRANCH_ARTIFACT_ID)).toEqual({
      baseBranch: "release/2026-08",
      baseBranchSource: BranchBaseBranchSource.DesktopPullRequestBase,
    });
  });

  // ISS-8175 AC-3, the version-skew case: an installed desktop that predates the
  // field sends every other PR fact and no base. The write must carry NO
  // `baseRefName` key — a `null` would be a measured "no base", and the branch's
  // own base must not be touched at all.
  it("omits baseRefName entirely for a ref that carries no base", async () => {
    const m = installPrDetailIngestDb({});

    await syncPrDetailRefs([
      prRef({
        title: "Add widget",
        state: GitHubPRState.Open,
        isDraft: false,
        additions: 10,
        deletions: 2,
        changedFiles: 1,
      }),
    ]);

    const created = m.prCreateMany.mock.calls[0][0].data[0];
    expect(created).toMatchObject({ title: "Add widget", additions: 10 });
    expect(Object.hasOwn(created, "baseRefName")).toBe(false);
    expect(m.branchBases.get(BRANCH_ARTIFACT_ID)).toEqual({
      baseBranch: null,
      baseBranchSource: null,
    });
  });

  // ISS-8175 AC-2: the lane routes the base through `resolveBaseProvenance`
  // rather than blind-writing it, so a stored HarnessInput base (rank 40) beats
  // the desktop's 35 and survives. The PR's OWN column still takes the value —
  // it is that PR's base regardless of what the branch's stronger source says.
  it("never lowers a stored harness base to a desktop-read one", async () => {
    const m = installPrDetailIngestDb({
      branchBase: {
        baseBranch: "main",
        baseBranchSource: BranchBaseBranchSource.HarnessInput,
      },
    });

    await syncPrDetailRefs([prRef({ baseRef: "release/2026-08" })]);

    expect(m.branchBases.get(BRANCH_ARTIFACT_ID)).toEqual({
      baseBranch: "main",
      baseBranchSource: BranchBaseBranchSource.HarnessInput,
    });
    expect(m.prCreateMany.mock.calls[0][0].data[0]).toMatchObject({
      baseRefName: "release/2026-08",
    });
  });

  // ISS-8175 webhook-wins: an App-owned row with no base yet takes the desktop's
  // as a gap-fill, and one that already has a base keeps GitHub's. Both halves
  // in one case because the second is what makes the first safe.
  it("gap-fills a null base on an App-owned row but never replaces one", async () => {
    const withNullBase = installPrDetailIngestDb({
      pullRequestDetails: [
        {
          id: "pr-app-1",
          branchArtifactId: BRANCH_ARTIFACT_ID,
          repositoryId: "repo-1",
          repositoryFullName: "acme/web",
          number: 42,
          fetchMechanism: GitHubFetchMechanism.Webhook,
          baseRefName: null,
        },
      ],
    });
    await syncPrDetailRefs([prRef({ baseRef: "release/2026-08" })]);
    expect(withNullBase.prUpdateMany.mock.calls[0][0].data).toMatchObject({
      baseRefName: "release/2026-08",
    });

    vi.clearAllMocks();
    const withGitHubBase = installPrDetailIngestDb({
      pullRequestDetails: [
        {
          id: "pr-app-2",
          branchArtifactId: BRANCH_ARTIFACT_ID,
          repositoryId: "repo-1",
          repositoryFullName: "acme/web",
          number: 42,
          fetchMechanism: GitHubFetchMechanism.Webhook,
          baseRefName: "main",
          htmlUrl: "https://github.com/acme/web/pull/42",
        },
      ],
    });
    await syncPrDetailRefs([prRef({ baseRef: "release/2026-08" })]);
    for (const call of withGitHubBase.prUpdateMany.mock.calls) {
      expect(call[0].data).not.toHaveProperty("baseRefName");
    }
  });

  // ISS-8175 review (whitlockk): the sync payload is client-supplied, so `relation`
  // and `method` are the only thing separating created-PR evidence from a PR the
  // session merely mentioned. Without the gate a `referenced` ref could carry a
  // baseRef and buy `DesktopPullRequestBase` — rank 35, deliberately withheld
  // from clients by `isClientAssertableBaseBranchSource`. Neither the PR's own
  // column nor the branch's base may take it.
  it.each([
    [
      "a referenced relation",
      {
        relation: ArtifactRefRelation.Referenced,
        method: ArtifactRefMethod.PrCreateOutput,
      },
    ],
    [
      "a non-create method",
      {
        relation: ArtifactRefRelation.Created,
        method: ArtifactRefMethod.PrUrlInToolUse,
      },
    ],
  ])("ignores a baseRef asserted by %s", async (_name, shape) => {
    const m = installPrDetailIngestDb({});

    await syncPrDetailRefs([prRef({ ...shape, baseRef: "attacker/main" })]);

    const created = m.prCreateMany.mock.calls[0][0].data[0];
    expect(Object.hasOwn(created, "baseRefName")).toBe(false);
    expect(m.branchBases.get(BRANCH_ARTIFACT_ID)).toEqual({
      baseBranch: null,
      baseBranchSource: null,
    });
  });

  // ISS-8175 review (davetho): the webhook keeps lifecycle ownership, so the
  // desktop's advance never runs for an App-owned row — but a base it just
  // gap-filled from NOTHING is a new fact, and without this the value lands on
  // the PR row while the branch keeps a weaker/absent base forever.
  it("runs the base decider after gap-filling an App-owned row's null base", async () => {
    const m = installPrDetailIngestDb({
      branchCurrentPrId: "pr-app-1",
      branchBase: {
        baseBranch: "main",
        baseBranchSource: BranchBaseBranchSource.McpInput,
      },
      pullRequestDetails: [
        {
          id: "pr-app-1",
          branchArtifactId: BRANCH_ARTIFACT_ID,
          repositoryId: "repo-1",
          repositoryFullName: "acme/web",
          number: 42,
          fetchMechanism: GitHubFetchMechanism.Webhook,
          baseRefName: null,
        },
      ],
    });

    await syncPrDetailRefs([prRef({ baseRef: "release/2026-08" })]);

    expect(m.branchBases.get(BRANCH_ARTIFACT_ID)).toEqual({
      baseBranch: "release/2026-08",
      baseBranchSource: BranchBaseBranchSource.DesktopPullRequestBase,
    });
    // Lifecycle ownership is untouched: the base is the ONLY branch write, and
    // the current-PR pointer the webhook owns is not re-taken.
    expect(m.branchDetailUpdateMany).toHaveBeenCalledTimes(1);
    expect(m.branchDetailUpdateMany.mock.calls[0][0].data).not.toHaveProperty(
      "currentPullRequestDetailId"
    );
  });

  // ...but only for the branch's CURRENT PR. A superseded PR's base must never
  // re-point the branch, and the not-owned path has no `becameCurrent` result to
  // lean on, so the gate is read alongside the stored provenance.
  it("does not re-point a branch from a superseded PR's gap-filled base", async () => {
    const m = installPrDetailIngestDb({
      branchCurrentPrId: "pr-newer",
      pullRequestDetails: [
        {
          id: "pr-app-1",
          branchArtifactId: BRANCH_ARTIFACT_ID,
          repositoryId: "repo-1",
          repositoryFullName: "acme/web",
          number: 42,
          fetchMechanism: GitHubFetchMechanism.Webhook,
          baseRefName: null,
        },
      ],
    });

    await syncPrDetailRefs([prRef({ baseRef: "release/2026-08" })]);

    // The PR's own column still learns its base — that is this PR's fact.
    expect(m.rows.find((r) => r.id === "pr-app-1")?.baseRefName).toBe(
      "release/2026-08"
    );
    // The branch does not, because this is not the branch's current PR.
    expect(m.branchBases.get(BRANCH_ARTIFACT_ID)).toEqual({
      baseBranch: null,
      baseBranchSource: null,
    });
  });

  // ISS-8175 review (davetho): the current-PR gate is a read-then-write, and
  // this sync runs at READ COMMITTED. A producer promoting a NEWER PR between
  // the read and the write would otherwise get the superseded PR's base stamped
  // onto its branch. The update is a compare-and-swap on the three values the
  // decision was read from, so the interleaved write makes it match nothing.
  it("drops the base write when a newer PR is promoted mid-decision", async () => {
    let promoted = false;
    const m = installPrDetailIngestDb({
      branchCurrentPrId: "pr-app-1",
      pullRequestDetails: [
        {
          id: "pr-app-1",
          branchArtifactId: BRANCH_ARTIFACT_ID,
          repositoryId: "repo-1",
          repositoryFullName: "acme/web",
          number: 42,
          fetchMechanism: GitHubFetchMechanism.Webhook,
          baseRefName: null,
        },
      ],
      onBranchBaseRead: () => {
        // One interleaving only: the concurrent promotion lands once, after this
        // decision has already read the pointer it is about to act on.
        if (promoted) {
          return;
        }
        promoted = true;
        m.branchPointers.set(BRANCH_ARTIFACT_ID, "pr-newer");
      },
    });

    await syncPrDetailRefs([prRef({ baseRef: "release/2026-08" })]);

    expect(promoted).toBe(true);
    // The write was attempted against the row it decided on, and matched nothing.
    const baseWrite = m.branchDetailUpdateMany.mock.calls.find((call) =>
      Object.hasOwn(call[0].data, "baseBranch")
    );
    expect(baseWrite?.[0].where).toMatchObject({
      currentPullRequestDetailId: "pr-app-1",
    });
    // The newer PR's branch keeps its own base — no stamp from the superseded PR.
    expect(m.branchBases.get(BRANCH_ARTIFACT_ID)).toEqual({
      baseBranch: null,
      baseBranchSource: null,
    });
  });

  // The other half of the same CAS: a stronger base landing between the read and
  // the write must survive, rather than being downgraded by a decision made
  // against the value it replaced.
  it("drops the base write when a stronger base lands mid-decision", async () => {
    let raced = false;
    const m = installPrDetailIngestDb({
      branchCurrentPrId: "pr-app-1",
      pullRequestDetails: [
        {
          id: "pr-app-1",
          branchArtifactId: BRANCH_ARTIFACT_ID,
          repositoryId: "repo-1",
          repositoryFullName: "acme/web",
          number: 42,
          fetchMechanism: GitHubFetchMechanism.Webhook,
          baseRefName: null,
        },
      ],
      onBranchBaseRead: () => {
        if (raced) {
          return;
        }
        raced = true;
        m.branchBases.set(BRANCH_ARTIFACT_ID, {
          baseBranch: "main",
          baseBranchSource: BranchBaseBranchSource.PullRequestBase,
        });
      },
    });

    await syncPrDetailRefs([prRef({ baseRef: "release/2026-08" })]);

    expect(raced).toBe(true);
    expect(m.branchBases.get(BRANCH_ARTIFACT_ID)).toEqual({
      baseBranch: "main",
      baseBranchSource: BranchBaseBranchSource.PullRequestBase,
    });
  });

  // ISS-8175 review (davetho), the out-of-order / mixed-device case: the base
  // recovery keeps the PR's ORIGINAL create timestamp, so a PR another device
  // already synced later hits the monotonic guard. The stale
  // ref may still fill a base column that is null — and only that column.
  it("gap-fills an absent base from an out-of-order desktop ref", async () => {
    const m = installPrDetailIngestDb({
      branchCurrentPrId: "pr-desktop-1",
      pullRequestDetails: [
        {
          id: "pr-desktop-1",
          branchArtifactId: BRANCH_ARTIFACT_ID,
          repositoryId: "repo-1",
          repositoryFullName: "acme/web",
          number: 42,
          fetchMechanism: GitHubFetchMechanism.DesktopSync,
          // A LATER observation from a second machine already landed.
          fetchObservedAt: new Date("2026-05-20T20:00:00.000Z"),
          title: "Synced by the other device",
          baseRefName: null,
        },
      ],
    });

    // The fixture's observedAt (18:00) predates the stored 20:00 — the stale path.
    await syncPrDetailRefs([
      prRef({ baseRef: "release/2026-08", title: "Stale title" }),
    ]);

    const baseFill = m.prUpdateMany.mock.calls.find((call) =>
      Object.hasOwn(call[0].data, "baseRefName")
    );
    expect(baseFill?.[0]).toMatchObject({
      where: { id: "pr-desktop-1", baseRefName: null },
      data: { baseRefName: "release/2026-08" },
    });
    // Fill-only: no stale fact and no freshness stamp rides along.
    expect(Object.keys(baseFill?.[0].data ?? {})).toEqual(["baseRefName"]);
    expect(m.rows.find((r) => r.id === "pr-desktop-1")?.title).toBe(
      "Synced by the other device"
    );
    expect(m.branchBases.get(BRANCH_ARTIFACT_ID)).toEqual({
      baseBranch: "release/2026-08",
      baseBranchSource: BranchBaseBranchSource.DesktopPullRequestBase,
    });
  });

  // The same stale path must NOT fill a base that is already there — that would
  // be the regression the monotonic guard exists to prevent, wearing a hat.
  it("leaves a stored base alone on the out-of-order path", async () => {
    const m = installPrDetailIngestDb({
      branchCurrentPrId: "pr-desktop-1",
      pullRequestDetails: [
        {
          id: "pr-desktop-1",
          branchArtifactId: BRANCH_ARTIFACT_ID,
          repositoryId: "repo-1",
          repositoryFullName: "acme/web",
          number: 42,
          fetchMechanism: GitHubFetchMechanism.DesktopSync,
          fetchObservedAt: new Date("2026-05-20T20:00:00.000Z"),
          baseRefName: "main",
        },
      ],
    });

    await syncPrDetailRefs([prRef({ baseRef: "release/2026-08" })]);

    expect(m.rows.find((r) => r.id === "pr-desktop-1")?.baseRefName).toBe(
      "main"
    );
    expect(m.branchBases.get(BRANCH_ARTIFACT_ID)).toEqual({
      baseBranch: null,
      baseBranchSource: null,
    });
  });
});
