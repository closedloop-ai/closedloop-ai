import { BranchSyncStatus } from "@repo/api/src/types/artifact";
import {
  BranchDataState,
  BranchParticipationKind,
  type BranchSession,
  BranchStatus,
} from "@repo/api/src/types/branch";
import {
  BranchViewCheckKind,
  BranchViewChecksProviderState,
} from "@repo/api/src/types/branch-check-projection";
import { ChecksStatus } from "@repo/api/src/types/branch-checks";
import { BranchProjectionVersion } from "@repo/api/src/types/branch-projection";
import { GitHubPRState } from "@repo/api/src/types/github";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type BranchRowInput,
  branchRow,
  NOW,
  ORGANIZATION_ID,
  pullRequest,
} from "@/__tests__/support/branches/canonical-projection.test-fixtures";
import { membershipSessionRow } from "@/__tests__/support/branches/canonical-projection-membership.test-fixtures";
import { attachSessionEvenSplitCosts } from "../branch-cost-attribution";
import type { SelectedBranchPullRequestDetail } from "../branch-read-selects";
import { BRANCH_MEMBERSHIP_SESSION_LIMIT } from "./branch-membership-limit";
import {
  finalizeCanonicalCloudBranchDetail,
  projectCanonicalCloudBranchDetail,
  projectCanonicalCloudBranchRow,
  projectCloudBranchRefreshDetail,
} from "./canonical-projection";
import { emptyUsage, type SessionUsage } from "./session-usage-window";

/**
 * ISS-6660 — the four cloud branch projection entry points. They compose
 * (`row` ⊂ `detail`, `detail` → `finalize`), and the failures this repo keeps
 * shipping live in the seams between them, not inside any one function:
 *
 * - the LIST and DETAIL entry points run DIFFERENT associated-PR selectors, so
 *   they can pick different PRs and make one branch tell two stories;
 * - the REFRESH entry point must not claim canonical V1 enrichment it has not
 *   loaded;
 * - `finalize` rewrites membership and cost from the detail's own sessions
 *   AFTER projection, so a fixture literal fed into it cannot catch drift in
 *   the intermediate shape.
 *
 * Every `finalize` case below is therefore fed the real output of
 * `projectCanonicalCloudBranchDetail`, never a hand-built projection.
 */

type BranchDetailInput = Parameters<
  typeof projectCanonicalCloudBranchDetail
>[0];

describe("list and detail projections of the same branch", () => {
  it("select the same pull request, so status and PR identity cannot disagree between the two screens", () => {
    // A stale merged PR alongside the live one. List and detail both run
    // `projectCloudOwnedBranchAssociatedPullRequests`; if the two entry points
    // ever diverge the branch reads "merged" in the table and "open" on its own
    // page, with a different PR number on each.
    const row = branchRow({
      pullRequestDetails: [
        pullRequest({
          id: "stale",
          number: 41,
          prState: GitHubPRState.Merged,
          mergedAt: new Date("2026-08-01T00:00:00.000Z"),
          closedAt: new Date("2026-08-01T00:00:00.000Z"),
          lastVerifiedAt: new Date("2026-08-01T00:00:00.000Z"),
        }),
        pullRequest({ id: "live", number: 42, lastVerifiedAt: NOW }),
      ],
    });

    const listRow = projectCanonicalCloudBranchRow(row, ORGANIZATION_ID);
    const detail = projectCanonicalCloudBranchDetail(
      detailRow(row),
      ORGANIZATION_ID
    );

    expect(listRow.prNumber).toBe(42);
    expect(listRow.status).toBe(BranchStatus.Open);
    expect(listRow.multiPrWarning).toBe(true);
    expect(
      listRow.canonicalProjection?.common.pullRequests.associatedCount
    ).toBe(2);
    expect(detail.prNumber).toBe(listRow.prNumber);
    expect(detail.status).toBe(listRow.status);
    expect(detail.prUrl).toBe(listRow.prUrl);
    expect(detail.multiPrWarning).toBe(true);
    expect(detail.associatedPullRequests?.items).toHaveLength(2);
  });

  it("keeps the branch ref head separate from the selected PR's historical head", () => {
    // `headSha` is the selected PR's revision and is only known once the heavy
    // PR detail is loaded; `branchHeadSha` is the ref's own head. Collapsing
    // them makes the detail claim the branch sits at a PR revision it may have
    // moved past — with no PR detail loaded here, the PR head is unknown.
    const detail = projectCanonicalCloudBranchDetail(
      detailRow(branchRow({})),
      ORGANIZATION_ID
    );

    expect(detail.branchHeadSha).toBe("head-sha-current");
    expect(detail.headSha).toBeNull();
  });

  it("surfaces the branch's eligible activity atom as canonical Last-active", () => {
    // Also keeps the shared fixture honest: `latestEligibleCloudBranchActivityAtom`
    // silently drops an atom whose version, source, attribution kind or
    // completeness is off-vocabulary, and an ineligible fixture atom would leave
    // every case in this file projecting against no activity evidence at all
    // while reading as though it supplied some.
    const listRow = projectCanonicalCloudBranchRow(
      branchRow({}),
      ORGANIZATION_ID
    );

    expect(listRow.canonicalLastActiveAt?.value).toBe(NOW.toISOString());
    expect(listRow.lastActivityAt).toBe(NOW.toISOString());
  });

  it("falls back to the local artifact status and reports no PR when the branch has none linked", () => {
    // With no PR evidence the local artifact status is the only signal, and a
    // locally-closed branch must not read as Open just because no PR was found.
    const row = branchRow({
      status: GitHubPRState.Closed,
      pullRequestDetails: [],
    });

    const listRow = projectCanonicalCloudBranchRow(row, ORGANIZATION_ID);
    const detail = projectCanonicalCloudBranchDetail(
      detailRow(row),
      ORGANIZATION_ID
    );

    expect(listRow.status).toBe(BranchStatus.Closed);
    expect(listRow.prNumber).toBeNull();
    expect(listRow.prState).toBeNull();
    expect(listRow.multiPrWarning).toBe(false);
    expect(listRow.canonicalProjection?.list.selectedPullRequest.id).toBeNull();
    expect(detail.status).toBe(listRow.status);
    expect(detail.selectedPullRequest).toBeNull();
    expect(detail.multiPrWarning).toBe(false);
    expect(detail.linkedPrNumbers).toEqual([]);
  });
});

describe("the detail's selected-PR checks (ISS-8241 Half A)", () => {
  it("withholds the branch's rollup that the list is still right to report", () => {
    // The two surfaces answer DIFFERENT questions and this is where they stop
    // agreeing on purpose: one branch row's checks are the branch's, but the
    // detail names ONE pull request, and the fixture's rollup was never measured
    // at that pull request's head. Serving it here is the ISS-8241 defect.
    // The shared fixture already stores a Passing rollup over 3 checks, and
    // never says which head it measured — the pre-ISS-8241 state of every row.
    const row = branchRow({});

    const listRow = projectCanonicalCloudBranchRow(row, ORGANIZATION_ID);
    const detail = projectCanonicalCloudBranchDetail(
      detailRow(row),
      ORGANIZATION_ID,
      undefined,
      undefined,
      undefined,
      undefined,
      selectedPullRequestDetail({ headRefOid: SELECTED_PR_HEAD })
    );

    expect(listRow.checksStatus).toBe(ChecksStatus.Passing);
    expect(listRow.checksTotal).toBe(3);
    expect(detail.checksStatus).toBeNull();
    expect(detail.checksTotal).toBeNull();
    expect(detail.selectedPullRequestChecksProjection).toBeUndefined();
  });

  it("carries the same withheld answer into the canonical block, not just the compatibility copy", () => {
    // `canonicalProjection.list.selectedPullRequest` is the structure that names
    // the branch's rollup after the selected pull request. A consumer reading it
    // instead of the top-level scalars must not be told a different story.
    const detail = projectCanonicalCloudBranchDetail(
      detailRow(branchRow({})),
      ORGANIZATION_ID,
      undefined,
      undefined,
      undefined,
      undefined,
      selectedPullRequestDetail({ headRefOid: SELECTED_PR_HEAD })
    );

    expect(
      detail.canonicalProjection?.list.selectedPullRequest.checksStatus
    ).toBeNull();
    expect(
      detail.canonicalProjection?.list.selectedPullRequest.checksTotal
    ).toBeNull();
  });

  it("counts the rollup from the rows measured at that pull request's own head", () => {
    const detail = projectCanonicalCloudBranchDetail(
      detailRow(branchRow({}), {
        checksDetailHeadSha: SELECTED_PR_HEAD,
        checksDetailProviderState: BranchViewChecksProviderState.Available,
        checksDetailUpdatedAt: NOW,
        statusChecks: [0, 1, 2].map((position) =>
          measuredRow(position, "success")
        ),
      }),
      ORGANIZATION_ID,
      undefined,
      undefined,
      undefined,
      undefined,
      selectedPullRequestDetail({ headRefOid: SELECTED_PR_HEAD })
    );

    expect(detail.checksStatus).toBe(ChecksStatus.Passing);
    expect(detail.checksTotal).toBe(3);
    expect(
      detail.canonicalProjection?.list.selectedPullRequest.checksStatus
    ).toBe(ChecksStatus.Passing);
    expect(detail.selectedPullRequestChecksProjection?.items).toHaveLength(3);
  });

  it("will not call the population passing while rows it counted are missing", () => {
    // The compatibility scalar and the canonical block BOTH have to withhold it.
    // `checks_status` is not covered by the head-sha gate — a `synchronize`
    // redelivery and the backfill lane each move it at an unchanged head — so
    // neither field may be served from that column, and one passing row out of
    // three says nothing about the two nobody fetched.
    const detail = projectCanonicalCloudBranchDetail(
      detailRow(branchRow({}), {
        checksDetailHeadSha: SELECTED_PR_HEAD,
        checksDetailProviderState: BranchViewChecksProviderState.Available,
        checksDetailUpdatedAt: NOW,
        statusChecks: [measuredRow(0, "success")],
      }),
      ORGANIZATION_ID,
      undefined,
      undefined,
      undefined,
      undefined,
      selectedPullRequestDetail({ headRefOid: SELECTED_PR_HEAD })
    );

    expect(detail.checksStatus).toBe(ChecksStatus.Unknown);
    expect(
      detail.canonicalProjection?.list.selectedPullRequest.checksStatus
    ).toBe(ChecksStatus.Unknown);
    expect(detail.checksTotal).toBe(3);
    expect(detail.selectedPullRequestChecksProjection?.items).toHaveLength(1);
  });
});

function measuredRow(position: number, conclusion: string) {
  return {
    providerKey: `ci-${position}`,
    headSha: SELECTED_PR_HEAD,
    kind: BranchViewCheckKind.CheckRun,
    name: `ci-${position}`,
    status: "completed",
    conclusion,
    targetUrl: null,
    position,
  };
}

describe("a capped file cache on the canonical list projection", () => {
  // ISS-6127 (tamsinb review): the main list/detail LOC path is the one a user
  // actually reads, and it was summing a CAPPED cache into a confident, short
  // number. A provider that caps a compare below the 500-row heuristic passes
  // every count guard, so the flag is the only signal — this pins that the
  // projection reads it and takes the same unknown exit a stale cache takes.
  it("rejects a capped cache's short sum and falls back to the connected PR", () => {
    const row = branchRow({});
    row.branch.fileCacheCapped = true;

    const listRow = projectCanonicalCloudBranchRow(row, ORGANIZATION_ID);

    // The cache sums to 30/4; the PR reports 10/2. Reading the PR proves the
    // capped sum was rejected rather than trusted.
    expect(listRow.canonicalProjection?.list.changes).toEqual({
      additions: 10,
      deletions: 2,
      filesChanged: 1,
    });
    // The PR fallback is the DISPLAY answer. The analytics basis must stay
    // unknown — it is sourced from the file cache, not the PR, and a future
    // change sourcing it from `loc` would leak 10/2 in here with the suite
    // green.
    expect(listRow.analyticsAdditions).toBeNull();
    expect(listRow.analyticsDeletions).toBeNull();
  });

  it("still trusts an uncapped cache, so the guard cannot be vacuous", () => {
    const row = branchRow({});
    row.branch.fileCacheCapped = false;

    const listRow = projectCanonicalCloudBranchRow(row, ORGANIZATION_ID);

    expect(listRow.canonicalProjection?.list.changes).toEqual({
      additions: 30,
      deletions: 4,
      filesChanged: 1,
    });
    expect(listRow.analyticsAdditions).toBe(30);
    expect(listRow.analyticsDeletions).toBe(4);
  });
});

describe("cost on the canonical list projection", () => {
  it("omits the attributed field entirely rather than serialising a 0.00 a caller would render", () => {
    // Version-skewed consumers read `attributedCostUsd` when present. An
    // un-computed share must be ABSENT from the wire payload, not `0` (which
    // claims a priced zero) and not `null` unless the caller resolved one.
    const listRow = projectCanonicalCloudBranchRow(
      branchRow({}),
      ORGANIZATION_ID
    );

    expect(listRow.estimatedCostUsd).toBeNull();
    expect("attributedCostUsd" in listRow).toBe(false);
    expect(JSON.parse(JSON.stringify(listRow))).not.toHaveProperty(
      "attributedCostUsd"
    );
    expect(
      listRow.canonicalProjection?.list.cost.attributedUsd
    ).toBeUndefined();
  });

  it("carries a resolved attributed share through to the wire field", () => {
    const listRow = projectCanonicalCloudBranchRow(
      branchRow({}),
      ORGANIZATION_ID,
      undefined,
      usageOf([costedSession("s1", 12)], 12),
      undefined,
      4
    );

    expect(listRow.attributedCostUsd).toBe(4);
    expect(listRow.canonicalProjection?.list.cost.attributedUsd).toBe(4);
    // The replicated compatibility field keeps its own raw semantics.
    expect(listRow.estimatedCostUsd).toBe(12);
  });

  it("keeps a priced zero raw cost distinct from unavailable cost", () => {
    const listRow = projectCanonicalCloudBranchRow(
      branchRow({}),
      ORGANIZATION_ID,
      undefined,
      usageOf([costedSession("s1", 0)], 0)
    );

    expect(listRow.estimatedCostUsd).toBe(0);
    expect(listRow.canonicalProjection?.list.cost.replicatedUsd).toBe(0);
  });
});

describe("projectCloudBranchRefreshDetail", () => {
  it("does not claim canonical V1 enrichment it has not loaded", () => {
    const row = detailRow(branchRow({}));

    const refresh = projectCloudBranchRefreshDetail(row, ORGANIZATION_ID);
    const enriched = projectCanonicalCloudBranchDetail(row, ORGANIZATION_ID);

    expect(refresh.canonicalProjection).toBeUndefined();
    expect(enriched.canonicalProjection?.version).toBe(
      BranchProjectionVersion.V1
    );
    // The compatibility fields are still projected; only the canonical claim
    // is withheld.
    expect(refresh.status).toBe(enriched.status);
    expect(refresh.branchName).toBe(enriched.branchName);
  });

  it("is left untouched by finalize rather than having a projection synthesised onto it", () => {
    const refresh = projectCloudBranchRefreshDetail(
      detailRow(branchRow({})),
      ORGANIZATION_ID
    );

    finalizeCanonicalCloudBranchDetail(refresh);

    expect(refresh.canonicalProjection).toBeUndefined();
  });
});

describe("finalizeCanonicalCloudBranchDetail", () => {
  it("drops reviewed-only sessions from membership so the detail's session count matches the list corpus", () => {
    // A reviewer's session is linked to the branch but never wrote to it. It
    // must not inflate the branch's qualifying session count.
    const detail = detailWithSessions([
      costedSession("wrote-1", 12, BranchParticipationKind.Wrote),
      costedSession("reviewed-1", 90, BranchParticipationKind.Reviewed),
    ]);

    finalizeCanonicalCloudBranchDetail(detail);

    const membership = detail.canonicalProjection?.common.membership;
    expect(membership?.sessionIds).toEqual(["wrote-1"]);
    expect(membership?.qualifyingSessionCount).toBe(1);
    expect(membership?.sessions?.map((entry) => entry.artifactId)).toEqual([
      "wrote-1",
    ]);
  });

  it("excludes a reviewed session's spend from both canonical cost figures", () => {
    // The regression this guards: the reviewer's $90 leaking into the branch's
    // cost because membership was filtered but cost was not.
    const detail = detailWithSessions([
      costedSession("wrote-1", 12, BranchParticipationKind.Wrote),
      costedSession("reviewed-1", 90, BranchParticipationKind.Reviewed),
    ]);
    attachSessionEvenSplitCosts(
      detail,
      new Map([
        ["wrote-1", 3],
        ["reviewed-1", 1],
      ])
    );

    finalizeCanonicalCloudBranchDetail(detail);

    const cost = detail.canonicalProjection?.list.cost;
    // Hand-computed: replicated = 12 (the reviewer's 90 is not this branch's
    // spend); attributed = 12 / 3 = 4.
    expect(cost?.replicatedUsd).toBe(12);
    expect(cost?.attributedUsd).toBe(4);
  });

  it("reports unpriced sessions as null cost, never as a priced zero", () => {
    const detail = detailWithSessions([
      costedSession("wrote-1", null, BranchParticipationKind.Wrote),
    ]);
    attachSessionEvenSplitCosts(detail, new Map([["wrote-1", 2]]));

    finalizeCanonicalCloudBranchDetail(detail);

    const cost = detail.canonicalProjection?.list.cost;
    expect(cost?.replicatedUsd).toBeNull();
    expect(cost?.attributedUsd).toBeNull();
    expect(cost?.attributedUsd).not.toBe(0);
  });

  it("keeps a branch's attributed cost known when one session is free and another is unpriced", () => {
    // The adversarial mix for the priced-zero flag: a `||=` over the SHARE
    // rather than over `share != null` reads the free session's 0 as falsy and
    // reports the whole branch as cost-unavailable, even though $0 is known.
    const detail = detailWithSessions([
      costedSession("free", 0, BranchParticipationKind.Wrote),
      costedSession("unpriced", null, BranchParticipationKind.Wrote),
    ]);
    attachSessionEvenSplitCosts(
      detail,
      new Map([
        ["free", 1],
        ["unpriced", 1],
      ])
    );

    finalizeCanonicalCloudBranchDetail(detail);

    expect(detail.canonicalProjection?.list.cost.attributedUsd).toBe(0);
    expect(detail.canonicalProjection?.list.cost.attributedUsd).not.toBeNull();
  });

  it("keeps a genuinely free session's replicated and attributed cost at a priced zero", () => {
    // A session that ran and cost nothing is known-zero. Collapsing either
    // branch cost field to `null` would render "cost unavailable" for a branch
    // whose cost IS known.
    const detail = detailWithSessions([
      costedSession("wrote-1", 0, BranchParticipationKind.Wrote),
    ]);
    attachSessionEvenSplitCosts(detail, new Map([["wrote-1", 1]]));

    finalizeCanonicalCloudBranchDetail(detail);

    expect(detail.canonicalProjection?.list.cost.replicatedUsd).toBe(0);
    expect(detail.canonicalProjection?.list.cost.attributedUsd).toBe(0);
    expect(detail.estimatedCostUsd).toBe(0);
  });

  it("downgrades a branch whose only sessions are reviewed-only to NoSessions", () => {
    const detail = detailWithSessions([
      costedSession("reviewed-1", 5, BranchParticipationKind.Reviewed),
    ]);

    expect(detail.canonicalProjection?.list.dataState).toBe(
      BranchDataState.Ready
    );

    finalizeCanonicalCloudBranchDetail(detail);

    expect(detail.canonicalProjection?.list.dataState).toBe(
      BranchDataState.NoSessions
    );
  });

  it("does not overwrite AwaitingSync with NoSessions while the branch is still syncing", () => {
    // "Still loading" and "genuinely has nothing" are different answers. A
    // syncing branch with no sessions yet must not claim the latter.
    const syncing = branchRow({});
    syncing.branch.syncStatus = BranchSyncStatus.Syncing;
    syncing.branch.lastSyncCompletedAt = null;
    const detail = projectCanonicalCloudBranchDetail(
      detailRow(syncing),
      ORGANIZATION_ID,
      undefined,
      usageOf([])
    );

    expect(detail.canonicalProjection?.list.dataState).toBe(
      BranchDataState.AwaitingSync
    );

    finalizeCanonicalCloudBranchDetail(detail);

    expect(detail.canonicalProjection?.list.dataState).toBe(
      BranchDataState.AwaitingSync
    );
  });
});

describe("the selected PR's own base ref and author (ISS-8241)", () => {
  // The owning Branch's `baseBranch` is the branch's CURRENT target, which a
  // branch reused for a later PR has already moved. Reading it here would make
  // every earlier PR of that branch claim the newer target as a measured value —
  // the defect ISS-8155 removed from the projection read, arriving on this
  // surface instead. The fixture's branch base and the PR's base are deliberately
  // different so a fallback cannot pass.
  it("serves the pull request's own columns, not the branch's current base", () => {
    const detail = projectCanonicalCloudBranchDetail(
      detailRow(branchRow({})),
      ORGANIZATION_ID,
      undefined,
      undefined,
      undefined,
      undefined,
      selectedPullRequestDetail({
        baseRefName: "release/2026-08",
        authorLogin: "davetho",
      })
    );

    expect(detail.branchHeadSha).toBe("head-sha-current");
    expect(detail.selectedPullRequest?.baseRefName).toBe("release/2026-08");
    expect(detail.selectedPullRequest?.authorLogin).toBe("davetho");
  });

  it("keeps an unmeasured base ref and author null rather than filling them in", () => {
    const detail = projectCanonicalCloudBranchDetail(
      detailRow(branchRow({})),
      ORGANIZATION_ID,
      undefined,
      undefined,
      undefined,
      undefined,
      selectedPullRequestDetail({ baseRefName: null, authorLogin: null })
    );

    // `branchRow` bases the branch on `main`; null must survive as null.
    expect(detail.baseBranch).toBe("main");
    expect(detail.selectedPullRequest?.baseRefName).toBeNull();
    expect(detail.selectedPullRequest?.authorLogin).toBeNull();
  });
});

/** Build a detail through the real projection, then hand it to `finalize`. */
function detailWithSessions(sessions: BranchSession[]) {
  return projectCanonicalCloudBranchDetail(
    detailRow(branchRow({})),
    ORGANIZATION_ID,
    undefined,
    usageOf(
      sessions,
      sessions.reduce(
        (total, entry) => total + (entry.estimatedCostUsd ?? 0),
        0
      )
    )
  );
}

function usageOf(
  sessions: BranchSession[],
  estimatedCostUsd = 0
): SessionUsage {
  return {
    ...emptyUsage(),
    sessionIds: sessions.map((entry) => entry.sessionId),
    sessions,
    estimatedCostUsd,
    hasPricedCost: sessions.some((entry) => entry.estimatedCostUsd !== null),
  };
}

function costedSession(
  sessionId: string,
  estimatedCostUsd: number | null,
  participation?: BranchParticipationKind
): BranchSession {
  return {
    sessionId,
    slug: sessionId,
    name: sessionId,
    harness: "claude",
    startedAt: "2026-08-09T00:00:00.000Z",
    endedAt: null,
    isPrimary: false,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    estimatedCostUsd,
    ownerUserName: null,
    ...(participation ? { participation } : {}),
  };
}

function detailRow(
  row: BranchRowInput,
  checks: Partial<BranchDetailInput["branch"]> = {}
): BranchDetailInput {
  return {
    ...row,
    targetLinks: [],
    // ISS-12197: the Artifact row's Details-tab fields, unset by default.
    slug: null,
    updatedAt: NOW,
    dueDate: null,
    assignee: null,
    createdBy: null,
    project: null,
    branch: {
      ...row.branch,
      // ISS-8241 Half A: the rest of the stored checks projection, DETAIL-only.
      // Unwritten by default, which is what every branch that never had its
      // checks measured actually holds.
      checksDetailTruncated: false,
      checksDetailProviderState: null,
      checksDetailUnavailableReason: null,
      checksDetailUpdatedAt: null,
      statusChecks: [],
      ...checks,
    },
  };
}

const SELECTED_PR_HEAD = "c".repeat(40);

/** The heavy selected-PR row the detail projection enriches from. */
function selectedPullRequestDetail(
  overrides: Partial<SelectedBranchPullRequestDetail>
): SelectedBranchPullRequestDetail {
  return {
    ...pullRequest({ id: "live", number: 42 }),
    body: null,
    mergeCommitSha: null,
    baseRefName: null,
    authorLogin: null,
    reviews: [],
    ...overrides,
  };
}

function membershipUsage(
  entries: readonly {
    id: string;
    ownerId?: string | null;
    profile?: { name: string; avatarUrl?: string };
    participation?: BranchParticipationKind;
    status?: string;
    awaitingInputSince?: Date | null;
    sessionEndedAt?: Date | null;
  }[]
): SessionUsage {
  const usage = emptyUsage();
  for (const entry of entries) {
    usage.sessionIds.push(entry.id);
    usage.sessions.push({
      ...membershipSessionRow(entry.id),
      ...(entry.participation ? { participation: entry.participation } : {}),
    });
    usage.sessionDisplayInputsById.set(entry.id, {
      status: entry.status ?? SESSION_STATUS.ACTIVE,
      awaitingInputSince: entry.awaitingInputSince ?? null,
      sessionEndedAt: entry.sessionEndedAt ?? null,
      lastActivityAt: new Date("2026-08-09T23:30:00.000Z"),
      sessionStartedAt: new Date("2026-08-09T00:00:00.000Z"),
      endsWithError: null,
    });
    if (entry.ownerId !== undefined) {
      usage.sessionOwnerById.set(entry.id, entry.ownerId);
    }
    if (entry.profile) {
      usage.sessionOwnerProfileById.set(entry.id, entry.profile);
    }
  }
  return usage;
}

describe("linked-session membership on the list row (ISS-8972)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("derives ids, count, and entries from the same non-reviewed population", () => {
    const listRow = projectCanonicalCloudBranchRow(
      branchRow({}),
      ORGANIZATION_ID,
      undefined,
      membershipUsage([
        {
          id: "wrote-1",
          participation: BranchParticipationKind.Wrote,
        },
        {
          id: "reviewed-1",
          participation: BranchParticipationKind.Reviewed,
        },
      ])
    );
    const membership = listRow.canonicalProjection?.common.membership;

    expect(membership?.sessionIds).toEqual(["wrote-1"]);
    expect(membership?.qualifyingSessionCount).toBe(1);
    expect(membership?.sessions?.map((entry) => entry.artifactId)).toEqual([
      "wrote-1",
    ]);
    expect(listRow.sessionIds).toEqual(["wrote-1"]);
    expect(listRow.canonicalProjection?.list.dataState).toBe(
      BranchDataState.Ready
    );
  });

  it("ISS-10364: an awaiting-input session's chip now reads Active, not Waiting", () => {
    // COUNTERFACTUAL. A blocked run stores `active` and carries
    // `awaiting_input_since`, and the chip used to derive Waiting from it
    // (whitlockk review). The operator retired that word on 2026-09-23, so the
    // branch chip says Active. The `awaiting_input_since` COLUMN is untouched;
    // only the word is gone.
    //
    // This pins the CHIP alone (tamsinb review, #7820). The Sessions list and
    // the detail title chip derive separately — through
    // `resolveDisplayedSessionStatusWithWaiting` and
    // `resolveSessionDetailDisplayStatus` — and both still project Waiting for
    // this row, so the three surfaces do NOT agree on this head. That split
    // opens here and closes when the renderer projection is retired; do not
    // read this case as cross-surface agreement until it is.
    const listRow = projectCanonicalCloudBranchRow(
      branchRow({}),
      ORGANIZATION_ID,
      undefined,
      membershipUsage([
        {
          id: "session-waiting",
          awaitingInputSince: new Date("2026-08-09T12:00:00.000Z"),
        },
      ])
    );

    expect(
      listRow.canonicalProjection?.common.membership.sessions?.[0]
        ?.displayedStatus
    ).toBe(SESSION_STATUS.ACTIVE);
  });

  it("caps the described entries per branch while the count stays exact", () => {
    // davetho review: the page bound limits BRANCHES, not the Sessions on one
    // of them. The count must survive the cap — it is what the column falls back
    // to when it cannot describe every Session.
    const overLimit = BRANCH_MEMBERSHIP_SESSION_LIMIT + 7;
    const listRow = projectCanonicalCloudBranchRow(
      branchRow({}),
      ORGANIZATION_ID,
      undefined,
      membershipUsage(
        Array.from({ length: overLimit }, (_unused, index) => ({
          id: `session-${index}`,
        }))
      )
    );
    const membership = listRow.canonicalProjection?.common.membership;

    expect(membership?.sessions).toHaveLength(BRANCH_MEMBERSHIP_SESSION_LIMIT);
    expect(membership?.sessionIds).toHaveLength(overLimit);
    expect(membership?.qualifyingSessionCount).toBe(overLimit);
  });

  it("caps after reviewed sessions so final detail members keep their evidence", () => {
    const usage = membershipUsage([
      ...Array.from(
        { length: BRANCH_MEMBERSHIP_SESSION_LIMIT },
        (_unused, index) => ({
          id: `reviewed-${index}`,
          participation: BranchParticipationKind.Reviewed,
        })
      ),
      {
        id: "qualifying-session",
        ownerId: "user-1",
        participation: BranchParticipationKind.Wrote,
        profile: { name: "Avery Example" },
        status: SESSION_STATUS.ACTIVE,
      },
    ]);
    const detail = projectCanonicalCloudBranchDetail(
      detailRow(branchRow({})),
      ORGANIZATION_ID,
      undefined,
      usage
    );

    finalizeCanonicalCloudBranchDetail(detail);

    expect(detail.canonicalProjection?.common.membership.sessions).toEqual([
      expect.objectContaining({
        artifactId: "qualifying-session",
        displayedStatus: SESSION_STATUS.ACTIVE,
        lastInteractionAt: "2026-08-09T23:30:00.000Z",
        ownerName: "Avery Example",
        rawStatus: SESSION_STATUS.ACTIVE,
      }),
    ]);
  });

  it("keeps complete enriched detail membership when later enrichment reorders sessions", () => {
    const count = BRANCH_MEMBERSHIP_SESSION_LIMIT + 1;
    const expectedIds = Array.from(
      { length: count },
      (_unused, index) => `session-${index}`
    );
    const detail = projectCanonicalCloudBranchDetail(
      detailRow(branchRow({})),
      ORGANIZATION_ID,
      undefined,
      membershipUsage(expectedIds.map((id) => ({ id })))
    );

    expect(detail.canonicalProjection?.common.membership.sessions).toHaveLength(
      count
    );
    detail.sessions.reverse();
    finalizeCanonicalCloudBranchDetail(detail);

    const membership = detail.canonicalProjection?.common.membership;
    expect(membership?.sessionIds).toEqual(expectedIds);
    expect(membership?.qualifyingSessionCount).toBe(count);
    expect(membership?.sessions).toHaveLength(count);
    expect(
      membership?.sessions?.every(
        (entry) =>
          entry.displayedStatus === SESSION_STATUS.ACTIVE &&
          entry.rawStatus === SESSION_STATUS.ACTIVE
      )
    ).toBe(true);
  });

  it("keeps an unresolved owner distinct from a Session with no owner", () => {
    // `apps/api/app/branches/AGENTS.md`: collapsing these makes a chip claim
    // nobody owns a run that is owned by someone we could not look up.
    const listRow = projectCanonicalCloudBranchRow(
      branchRow({}),
      ORGANIZATION_ID,
      undefined,
      membershipUsage([
        { id: "session-unresolved", ownerId: "user-gone" },
        { id: "session-unowned", ownerId: null },
      ])
    );
    const [unresolved, unowned] =
      listRow.canonicalProjection?.common.membership.sessions ?? [];

    expect(unresolved?.ownerUnavailable).toBe(true);
    expect(unresolved?.ownerName).toBeUndefined();
    expect(unowned?.ownerUnavailable).toBeUndefined();
  });

  it("names the owner it did resolve", () => {
    const listRow = projectCanonicalCloudBranchRow(
      branchRow({}),
      ORGANIZATION_ID,
      undefined,
      membershipUsage([
        {
          id: "session-owned",
          ownerId: "user-1",
          profile: { name: "Avery Example", avatarUrl: "https://a.test/a.png" },
        },
      ])
    );
    const [owned] =
      listRow.canonicalProjection?.common.membership.sessions ?? [];

    expect(owned).toMatchObject({
      ownerName: "Avery Example",
      ownerAvatarUrl: "https://a.test/a.png",
    });
    expect(owned?.ownerUnavailable).toBeUndefined();
  });
});
