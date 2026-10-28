// FEA-4378: the authored-PR LOC roll-up feeding the per-session numerator, as
// narrowed by ISS-9964 / ISS-9980 (RULED 2026-09-11).
//
// The numerator is now `sum(additions + deletions) over MERGED authored PRs` and
// nothing else — the `max(localWorkingTreeDiff, …)` rung is RETIRED, so a
// session's LOC/$ can no longer move because a branch was pushed or a working
// tree was dirty. It is exposed on the read contract as
// `mergedAuthoredPrLinesChanged`.
//
// Three outcomes are distinct here and the cases below pin each:
//   - a resolved sum (including a resolved ZERO, which divides into a real 0);
//   - `null` = NOT KNOWABLE — no head branch resolves, so the PRs are
//     suppressed, or a matching merged PR's LOC row is half-populated;
//   - `kloc`, which is a VOLUME and keeps its own FEA-4250 rule of `null` for
//     zero churn, so a measured-zero session reads `locPerDollar: 0` beside
//     `kloc: null`. That divergence is deliberate, not drift.
//
// Kept in its own sibling (projections.test.ts is grandfathered over the
// 1000-line ceiling); asserts the projected values, not source text.

import { PullRequestState } from "@repo/api/src/types/document";
import {
  SessionArtifactLinkKind,
  SessionPrRelationType,
} from "@repo/api/src/types/session-artifact-link";
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

/**
 * An AUTHORED (Created) session→PR sourceLink whose verified BRANCH target
 * carries per-PR LOC on its `currentPullRequestDetail`. Mirrors the fixture
 * shape in projections.pull-requests.test.ts (metadata identity + BRANCH target
 * name = head ref) so the head branch resolves and the PR⇒Branch invariant
 * passes, then adds `additions`/`deletions` — the columns the record select now
 * reads for the roll-up.
 */
/**
 * ISS-6114: the PR LIFECYCLE this fixture builds, defaulted to merged.
 *
 * Every case in this suite predates the merge gate and was written against a
 * hardcoded `prState: Merged`, which is precisely why the gap the ticket found
 * was invisible: no fixture could produce an unmerged authored PR, so no test
 * could tell "counts authored PRs" from "counts merged authored PRs". The
 * default keeps those cases byte-identical. `Open` is what the merge-gate cases
 * use, and `MergedWithoutTimestamp` is the ISS-6114-review shape where this
 * rung and the PR pills deliberately disagree.
 */
const PR_LIFECYCLE = {
  Merged: {
    prState: PullRequestState.Merged,
    closedAt: null,
    mergedAt: new Date("2026-07-20T02:10:11.000Z"),
  },
  Open: {
    prState: PullRequestState.Open,
    closedAt: null,
    mergedAt: null,
  },
  /**
   * ISS-6114 review: MERGED state with no merge TIMESTAMP. Writable in
   * production — `buildPullRequestDetailUpdate` writes `prState` unconditionally
   * but `mergedAt` only when the producer supplies one — and it is the one shape
   * where this rung and the PR pills disagree, because the pills classify Merged
   * with an OR and `isMergedPrDetail` is an AND.
   */
  MergedWithoutTimestamp: {
    prState: PullRequestState.Merged,
    closedAt: null,
    mergedAt: null,
  },
} as const;

function authoredPrLocSourceLink({
  headRef,
  prNumber,
  additions,
  deletions,
  lifecycle = PR_LIFECYCLE.Merged,
  verified = true,
}: {
  headRef: string;
  prNumber: number;
  additions: number;
  deletions: number;
  lifecycle?: (typeof PR_LIFECYCLE)[keyof typeof PR_LIFECYCLE];
  /**
   * ISS-6114 (code review): whether this cloud has ever verified the row
   * against GitHub. Defaults true because every other case is about the merge
   * gate, not freshness.
   */
  verified?: boolean;
}) {
  return {
    metadata: {
      linkKind: SessionArtifactLinkKind.SessionPr,
      relationTypes: [SessionPrRelationType.Created],
      repositoryFullName: "closedloop-ai/closedloop-ai",
      prNumber,
      source: "DETERMINISTIC",
      confidence: 1.0,
      extractorVersion: 1,
    },
    target: {
      name: headRef,
      type: "BRANCH",
      branch: {
        repository: { fullName: "closedloop-ai/closedloop-ai" },
        currentPullRequestDetail: {
          number: prNumber,
          title: `PR ${prNumber}`,
          ...lifecycle,
          // An UNVERIFIED row still carries real additions/deletions, so nothing
          // about its shape says it cannot be trusted — only this field does.
          lastVerifiedAt: verified
            ? new Date("2026-07-20T02:09:00.000Z")
            : null,
          isCurrent: true,
          repository: { fullName: "closedloop-ai/closedloop-ai" },
          additions,
          deletions,
        },
      },
    },
  };
}

async function projectMultiPrSession(overrides: {
  linesAdded: number;
  linesRemoved: number;
  estimatedCost: number;
  sourceLinks: unknown[];
}) {
  installDb({
    sessionDetail: {
      findMany: vi.fn().mockResolvedValue([
        buildSessionListRecord({
          linesAdded: overrides.linesAdded,
          linesRemoved: overrides.linesRemoved,
          estimatedCost: overrides.estimatedCost,
          pullRequests: [],
          artifact: {
            organizationId: "org-1",
            name: "Multi-PR session",
            status: "completed",
            slug: "SES-74343",
            project: null,
            sourceLinks: overrides.sourceLinks,
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
  return result.items[0];
}

describe("agentSessionsService authored-PR KLOC roll-up (FEA-4378)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // The reported case: a 13-PR session with a real cost but a tiny local diff
  // (+134 -2) reads KLOC ≈ 0 today. With the roll-up, the numerator is the summed
  // authored-PR LOC (far larger), so KLOC/$ becomes meaningful.
  it("uses the summed authored-PR LOC as the KLOC numerator when it exceeds the local diff", async () => {
    const item = await projectMultiPrSession({
      // Tiny local working-tree residual — the bug's symptom.
      linesAdded: 134,
      linesRemoved: 2,
      estimatedCost: 434.69,
      sourceLinks: [
        authoredPrLocSourceLink({
          headRef: "marisolashgrove/pr-a",
          prNumber: 1001,
          additions: 4000,
          deletions: 1000,
        }),
        authoredPrLocSourceLink({
          headRef: "marisolashgrove/pr-b",
          prNumber: 1002,
          additions: 2500,
          deletions: 500,
        }),
      ],
    });

    // Summed authored-PR LOC = (4000+1000) + (2500+500) = 8000, which dwarfs the
    // 136-line local diff and is the numerator the projection must prefer.
    expect(item?.mergedAuthoredPrLinesChanged).toBe(8000);
    expect(item?.kloc).toBeCloseTo(8, 10);
    // (8000 / 1000) / 434.69 — NOT the ~0.0003 the local diff would have yielded.
    // ISS-4667: raw LINES / cost — 8 KLOC is 8000 lines.
    expect(item?.locPerDollar).toBeCloseTo(8000 / 434.69, 12);
    // Guard against the pre-fix behavior: the local-diff numerator (136) would
    // have rounded KLOC/$ to ~0.
    expect(item?.locPerDollar ?? 0).toBeGreaterThan(0.01);
  });

  // When the local working-tree diff is the larger, genuine signal (a live /
  // unmerged session), the numerator keeps it — the roll-up is a floor-raiser,
  // never a downgrade.
  /**
   * ISS-6114 — THE DECISION, pinned. Cosimo ruled on 2026-09-01 that this rung
   * means MERGED LOC.
   *
   * Before the gate, this roll-up counted every authored PR with a
   * verified detail row regardless of lifecycle, so a session that opened two
   * large PRs and landed neither reported their combined size as delivered code
   * and divided it by cost to publish a LOC/$ for work that never shipped —
   * while contributing 0 to the Sessions-list "LOC / $" card, which has
   * always run the merge-gated `isMergedPrDetail`. One question, two surfaces,
   * two populations.
   *
   * The ticket named the missing coverage exactly: no test distinguished the two
   * cases, because the fixture could only build merged PRs. These two do.
   */
  it("counts the MERGED authored PR and excludes the open one on the same session", async () => {
    const session = await projectMultiPrSession({
      linesAdded: 10,
      linesRemoved: 2,
      estimatedCost: 4,
      sourceLinks: [
        authoredPrLocSourceLink({
          headRef: "feat/landed",
          prNumber: 101,
          additions: 300,
          deletions: 100,
          lifecycle: PR_LIFECYCLE.Merged,
        }),
        authoredPrLocSourceLink({
          headRef: "feat/still-open",
          prNumber: 102,
          additions: 900,
          deletions: 700,
          lifecycle: PR_LIFECYCLE.Open,
        }),
      ],
    });

    // 300 + 100 from the merged PR ONLY. The open PR's 1,600 lines are real code
    // that has not shipped, and counting them is what the ruling forbids.
    expect(session.mergedAuthoredPrLinesChanged).toBe(400);
    // …and the derived figures follow the same population, so the rung, KLOC and
    // LOC/$ cannot disagree about which PRs delivered.
    expect(session.kloc).toBeCloseTo(0.4, 10);
    expect(session.locPerDollar).toBeCloseTo(100, 10);
  });

  /**
   * ISS-6114 review: the DEDUP guard, actually pinned.
   *
   * The superseded-PR case further down carried a comment claiming it proves
   * "counted exactly once, not 8000". It does not: its two links declare
   * DIFFERENT `prNumber`s (6001, 6002), and `resolveAuthoredPrLinkIdentities`
   * returns only the identities a link's own metadata declares, so no identity
   * is ever seen twice there.
   *
   * WHAT DEDUPES THE SUM is the `byIdentity` MAP KEY. Verified by mutation:
   * keying the map per occurrence instead of per identity makes this case read
   * 800, and it is the only case in the suite that reds for it.
   *
   * The `byIdentity.has(...)` early-continue above it does a SECOND job, and
   * this case does not pin it (review of #6413): `resolveAuthoredPrLoc`
   * is called with a DIFFERENT `link` each iteration and reads that link's own
   * branch rows, so when two links resolve one identity to DIFFERENT counts the
   * guard makes it first-wins — remove it and the map silently becomes
   * last-wins. Both links here resolve 400, so `if (false)` changes nothing for
   * THIS fixture only. The sibling case below pins the divergent shape.
   *
   * Two authored links declaring the SAME PR is the shape that reaches it, and
   * it is reachable in production — a reused branch, a re-opened PR, or two
   * command-derived refs on one session all produce it.
   */
  it("counts a PR declared by TWO authored links exactly once", async () => {
    const session = await projectMultiPrSession({
      linesAdded: 10,
      linesRemoved: 2,
      estimatedCost: 4,
      sourceLinks: [
        authoredPrLocSourceLink({
          headRef: "feat/first-link",
          prNumber: 7100,
          additions: 300,
          deletions: 100,
          lifecycle: PR_LIFECYCLE.Merged,
        }),
        // The SAME repository + PR number, reached through a second link.
        authoredPrLocSourceLink({
          headRef: "feat/second-link",
          prNumber: 7100,
          additions: 300,
          deletions: 100,
          lifecycle: PR_LIFECYCLE.Merged,
        }),
      ],
    });

    // 400, not 800 — one identity, counted once however many links declare it.
    expect(session.mergedAuthoredPrLinesChanged).toBe(400);
    expect(session.kloc).toBeCloseTo(0.4, 10);
  });

  /**
   * ISS-6114 review: the intended divergence from the PR pills, pinned.
   *
   * A detail row with `prState = MERGED` and a null `mergedAt` is pill-Merged
   * (`derivePrLifecycleStatus` uses `mergedAt || prState === Merged`) but is NOT
   * admitted here (`isMergedPrDetail` is an AND requiring the timestamp). The
   * panel therefore renders a Merged pill above a rung that falls back to the
   * local diff.
   *
   * That is deliberate — a LOC figure must not count a merge it has no merge
   * timestamp for — and it degrades to an UNDERCOUNT rather than a false claim.
   * Asserting it so the next reader does not "fix" the asymmetry by loosening
   * the gate to match the pills, which would re-admit unverified merges.
   */
  it("excludes a MERGED PR carrying no merge timestamp", async () => {
    const session = await projectMultiPrSession({
      linesAdded: 10,
      linesRemoved: 2,
      estimatedCost: 4,
      sourceLinks: [
        authoredPrLocSourceLink({
          headRef: "feat/merged-no-timestamp",
          prNumber: 7200,
          additions: 300,
          deletions: 100,
          lifecycle: PR_LIFECYCLE.MergedWithoutTimestamp,
        }),
      ],
    });

    // Not 400: the gate refuses a merge it cannot date. The PR was reachable and
    // examined, so this is a MEASURED zero, not an unknowable one.
    expect(session.mergedAuthoredPrLinesChanged).toBe(0);
    // ISS-9964 retired the local-diff rung, so the 12-line working tree no longer
    // props the numerator up. `kloc` is `null` on its own FEA-4250 zero-churn
    // rule, while the ratio divides the measured zero (next assertion).
    expect(session.kloc).toBeNull();
    expect(session.locPerDollar).toBe(0);
  });

  /**
   * ISS-6114 review of #6413: the `byIdentity.has(...)` guard's second job.
   *
   * Two authored links declaring ONE identity but resolving DIFFERENT counts —
   * a reused branch where one artifact still holds a stale detail row and the
   * other a refreshed one. The guard makes the FIRST resolution win; deleting
   * it makes the map last-wins, which is a silent answer change rather than a
   * double count, so the sibling dedup case above cannot see it.
   */
  it("keeps the FIRST resolution when two links disagree on one PR's LOC", async () => {
    const session = await projectMultiPrSession({
      linesAdded: 10,
      linesRemoved: 2,
      estimatedCost: 4,
      sourceLinks: [
        authoredPrLocSourceLink({
          headRef: "feat/fresh-row",
          prNumber: 7300,
          additions: 300,
          deletions: 100,
          lifecycle: PR_LIFECYCLE.Merged,
        }),
        // Same PR, a stale row carrying a different count.
        authoredPrLocSourceLink({
          headRef: "feat/stale-row",
          prNumber: 7300,
          additions: 900,
          deletions: 99,
          lifecycle: PR_LIFECYCLE.Merged,
        }),
      ],
    });

    // 400 (first link), not 999 (second) and not 1399 (both).
    expect(session.mergedAuthoredPrLinesChanged).toBe(400);
  });

  /**
   * ISS-6114 (code review): freshness is NOT part of the merge gate.
   *
   * A row this cloud has never verified against GitHub is refused by an
   * unconditional guard that runs BEFORE `isMergedPrDetail`, so its LOC never
   * reaches the numerator or the deprecated alias installed Desktop builds read.
   * A draft of that branch folded the `lastVerifiedAt` check into
   * `isMergedPrDetail` itself, which let an unverified row through on the path
   * that skipped it.
   *
   * ISS-9964 deleted the `sessions-merged-loc-rung` flag, so there is no longer a
   * gate-closed path to hold this row against — the case now pins the guard on
   * the ONE population that exists. It still cannot pass by accident: the PR is
   * MERGED and dated, so `isMergedPrDetail` admits it, and only the freshness
   * guard keeps its 8,000 lines out.
   */
  it("refuses an UNVERIFIED authored PR", async () => {
    const session = await projectMultiPrSession({
      linesAdded: 10,
      linesRemoved: 2,
      estimatedCost: 4,
      sourceLinks: [
        authoredPrLocSourceLink({
          headRef: "feat/never-verified",
          prNumber: 103,
          additions: 5000,
          deletions: 3000,
          lifecycle: PR_LIFECYCLE.Merged,
          verified: false,
        }),
      ],
    });

    // Contributes nothing rather than publishing 8,000 lines it cannot stand
    // behind. The 12-line local diff no longer backfills it (ISS-9964).
    expect(session?.authoredPrLinesChanged).toBe(0);
    expect(session?.mergedAuthoredPrLinesChanged).toBe(0);
    expect(session?.kloc).toBeNull();
  });

  it("emits the deprecated alias carrying the identical value", async () => {
    // ISS-6114 renamed the field; the old spelling is still emitted because an
    // installed Desktop build reads the LOC rung by it, and a client that never
    // learns the new name would silently fall back to its local working-tree
    // diff — degraded rather than broken, and invisible.
    //
    // Pinned rather than left incidental: without this the alias is untested,
    // so it could drift from the canonical value or be dropped in an unrelated
    // cleanup with nothing going red. Removing it needs explicit approval.
    const session = await projectMultiPrSession({
      linesAdded: 10,
      linesRemoved: 2,
      estimatedCost: 4,
      sourceLinks: [
        authoredPrLocSourceLink({
          headRef: "feat/landed",
          prNumber: 104,
          additions: 300,
          deletions: 100,
          lifecycle: PR_LIFECYCLE.Merged,
        }),
      ],
    });

    expect(session.mergedAuthoredPrLinesChanged).toBe(400);
    expect(session.authoredPrLinesChanged).toBe(
      session.mergedAuthoredPrLinesChanged
    );
  });

  it("credits nothing when every authored PR is still open", async () => {
    // The accepted cost of the ruling, stated as a test rather than left to be
    // discovered: an in-flight session has delivered nothing, and since ISS-9964
    // there is no local-diff rung to soften that — it reads a measured 0.
    // Without this case the gate could be satisfied by a roll-up that merely
    // preferred merged PRs when both were present.
    const session = await projectMultiPrSession({
      linesAdded: 10,
      linesRemoved: 2,
      estimatedCost: 4,
      sourceLinks: [
        authoredPrLocSourceLink({
          headRef: "feat/still-open",
          prNumber: 103,
          additions: 900,
          deletions: 700,
          lifecycle: PR_LIFECYCLE.Open,
        }),
      ],
    });

    expect(session.mergedAuthoredPrLinesChanged).toBe(0);
    // A measured zero: `kloc` withholds on its zero-churn rule, the ratio divides.
    expect(session.kloc).toBeNull();
    expect(session.locPerDollar).toBe(0);
  });

  // ISS-9964: the case that most directly pins the retirement. A 10,000-line
  // working tree beside a 400-line merged PR used to read 10,000 — a LOC/$ of
  // 100 for a session that delivered 400 lines. The local diff is now ignored
  // outright, so the same fixture reads the 400 it actually landed.
  it("ignores a local working-tree diff far larger than the merged authored-PR LOC", async () => {
    const item = await projectMultiPrSession({
      linesAdded: 9000,
      linesRemoved: 1000,
      estimatedCost: 100,
      sourceLinks: [
        authoredPrLocSourceLink({
          headRef: "marisolashgrove/pr-a",
          prNumber: 2001,
          additions: 300,
          deletions: 100,
        }),
      ],
    });

    expect(item?.mergedAuthoredPrLinesChanged).toBe(400);
    // 400 merged lines → KLOC 0.4, NOT the 10 the 10,000-line local diff gave.
    expect(item?.kloc).toBeCloseTo(0.4, 10);
    // ISS-4667: raw LINES / cost — 400 / 100 = 4, NOT 100.
    expect(item?.locPerDollar).toBeCloseTo(400 / 100, 12);
  });

  // A referenced-only PR authored no code for this session, so its LOC must not
  // enter the roll-up (mirrors the PR-output attribution gate).
  it("excludes referenced-only PR LOC from the roll-up", async () => {
    const item = await projectMultiPrSession({
      linesAdded: 50,
      linesRemoved: 0,
      estimatedCost: 10,
      sourceLinks: [
        {
          ...authoredPrLocSourceLink({
            headRef: "marisolashgrove/pr-ref",
            prNumber: 3001,
            additions: 9999,
            deletions: 9999,
          }),
          metadata: {
            linkKind: SessionArtifactLinkKind.SessionPr,
            relationTypes: [SessionPrRelationType.Referenced],
            repositoryFullName: "closedloop-ai/closedloop-ai",
            prNumber: 3001,
            source: "DETERMINISTIC",
            confidence: 1.0,
            extractorVersion: 1,
          },
        },
      ],
    });

    // The referenced PR's 19,998 lines are excluded from the roll-up — that half
    // is unchanged. What ISS-9964 changed is what remains: the 50-line local diff
    // used to stand in for them and report a confident ratio.
    //
    // The answer is NOT KNOWABLE rather than a measured 0, and the assertion
    // below is here to say WHY rather than leave a bare null: a referenced-only
    // link resolves no head branch, so `enforcePrBranchInvariant` suppresses the
    // PR projection entirely. This is the same rule as the head-branch case
    // below — a population the projection refused to read cannot be reported as
    // zero — not a second, PR-relation-specific policy.
    expect(item?.prs).toEqual([]);
    expect(item?.mergedAuthoredPrLinesChanged).toBeNull();
    expect(item?.kloc).toBeNull();
    expect(item?.locPerDollar).toBeNull();
  });

  // Parity with the PR⇒Branch invariant: when no head branch resolves (a BRANCH
  // target with a verified detail but no `name`), the PR projection SUPPRESSES
  // the PRs (renders "None"). The roll-up must be suppressed too, or KLOC and the
  // pills-row "N in merged PRs" figure would credit a PR the UI hides.
  it("excludes authored-PR LOC when the PR is suppressed for an unresolved head branch", async () => {
    const item = await projectMultiPrSession({
      linesAdded: 60,
      linesRemoved: 0,
      estimatedCost: 10,
      sourceLinks: [
        {
          metadata: {
            linkKind: SessionArtifactLinkKind.SessionPr,
            relationTypes: [SessionPrRelationType.Created],
            repositoryFullName: "closedloop-ai/closedloop-ai",
            prNumber: 5001,
            source: "DETERMINISTIC",
            confidence: 1.0,
            extractorVersion: 1,
          },
          target: {
            // No `name` and not a resolvable BRANCH-link name → head branch is
            // null → enforcePrBranchInvariant empties the PRs.
            branch: {
              repository: { fullName: "closedloop-ai/closedloop-ai" },
              currentPullRequestDetail: {
                number: 5001,
                title: "PR 5001",
                prState: PullRequestState.Merged,
                closedAt: null,
                mergedAt: new Date("2026-07-20T02:10:11.000Z"),
                lastVerifiedAt: new Date("2026-07-20T02:09:00.000Z"),
                isCurrent: true,
                repository: { fullName: "closedloop-ai/closedloop-ai" },
                additions: 9000,
                deletions: 9000,
              },
            },
          },
        },
      ],
    });

    // PRs suppressed → the roll-up is suppressed too. ISS-9980 (RULED
    // 2026-09-11): this is NOT KNOWABLE, not a measured zero — nobody could look
    // at a population the projection refused to resolve, so `0` would report a
    // measurement no one took. The expectation changed from `0` because the
    // ruling drew that distinction, which the old two-state field could not
    // express.
    expect(item?.prs).toEqual([]);
    expect(item?.mergedAuthoredPrLinesChanged).toBeNull();
    expect(item?.kloc).toBeNull();
    expect(item?.locPerDollar).toBeNull();
  });

  // FEA-4378 (codex P2): a session that authored TWO PRs from the SAME reused
  // branch. The branch's `currentPullRequestDetail` pointer holds only the most
  // recent PR (#2); the earlier PR (#1) survives only as a non-current row in the
  // branch Artifact's historical `pullRequestDetails` set. Reading the current
  // pointer alone would drop #1's LOC; resolving each authored PR number against
  // the full current+historical set must recover it.
  it("rolls up a superseded PR's LOC from the branch historical set (reused branch)", async () => {
    const sharedHeadRef = "marisolashgrove/reused-branch";
    const item = await projectMultiPrSession({
      linesAdded: 10,
      linesRemoved: 2,
      estimatedCost: 50,
      sourceLinks: [
        // Authored link for PR #1 — superseded on the branch, so it resolves via
        // the historical set, NOT the current pointer (which now points at #2).
        {
          metadata: {
            linkKind: SessionArtifactLinkKind.SessionPr,
            relationTypes: [SessionPrRelationType.Created],
            repositoryFullName: "closedloop-ai/closedloop-ai",
            prNumber: 6001,
            source: "DETERMINISTIC",
            confidence: 1.0,
            extractorVersion: 1,
          },
          target: {
            name: sharedHeadRef,
            type: "BRANCH",
            branch: {
              repository: { fullName: "closedloop-ai/closedloop-ai" },
              // Current pointer is PR #2, not #1.
              currentPullRequestDetail: {
                number: 6002,
                title: "PR 6002",
                prState: PullRequestState.Open,
                closedAt: null,
                mergedAt: null,
                lastVerifiedAt: new Date("2026-07-20T02:09:00.000Z"),
                isCurrent: true,
                repository: { fullName: "closedloop-ai/closedloop-ai" },
                additions: 1500,
                deletions: 500,
              },
            },
            // Branch Artifact's full PR history: #1 (superseded) + #2 (current).
            pullRequestDetails: [
              {
                number: 6001,
                // ISS-6114: the superseded PR LANDED. These historical rows
                // carried no lifecycle at all before the merge gate, which made
                // them indistinguishable from an open PR the moment the gate
                // started reading one.
                ...PR_LIFECYCLE.Merged,
                lastVerifiedAt: new Date("2026-07-19T00:00:00.000Z"),
                additions: 3000,
                deletions: 1000,
                repositoryFullName: "closedloop-ai/closedloop-ai",
                repository: { fullName: "closedloop-ai/closedloop-ai" },
              },
              {
                number: 6002,
                // Still open, matching its current-pointer row.
                ...PR_LIFECYCLE.Open,
                lastVerifiedAt: new Date("2026-07-20T02:09:00.000Z"),
                additions: 1500,
                deletions: 500,
                repositoryFullName: "closedloop-ai/closedloop-ai",
                repository: { fullName: "closedloop-ai/closedloop-ai" },
              },
            ],
          },
        },
        // Authored link for PR #2 — same branch, resolves via the current pointer.
        {
          metadata: {
            linkKind: SessionArtifactLinkKind.SessionPr,
            relationTypes: [SessionPrRelationType.Created],
            repositoryFullName: "closedloop-ai/closedloop-ai",
            prNumber: 6002,
            source: "DETERMINISTIC",
            confidence: 1.0,
            extractorVersion: 1,
          },
          target: {
            name: sharedHeadRef,
            type: "BRANCH",
            branch: {
              repository: { fullName: "closedloop-ai/closedloop-ai" },
              currentPullRequestDetail: {
                number: 6002,
                title: "PR 6002",
                prState: PullRequestState.Open,
                closedAt: null,
                mergedAt: null,
                lastVerifiedAt: new Date("2026-07-20T02:09:00.000Z"),
                isCurrent: true,
                repository: { fullName: "closedloop-ai/closedloop-ai" },
                additions: 1500,
                deletions: 500,
              },
            },
            pullRequestDetails: [
              {
                number: 6001,
                // ISS-6114: the superseded PR LANDED. These historical rows
                // carried no lifecycle at all before the merge gate, which made
                // them indistinguishable from an open PR the moment the gate
                // started reading one.
                ...PR_LIFECYCLE.Merged,
                lastVerifiedAt: new Date("2026-07-19T00:00:00.000Z"),
                additions: 3000,
                deletions: 1000,
                repositoryFullName: "closedloop-ai/closedloop-ai",
                repository: { fullName: "closedloop-ai/closedloop-ai" },
              },
              {
                number: 6002,
                // Still open, matching its current-pointer row.
                ...PR_LIFECYCLE.Open,
                lastVerifiedAt: new Date("2026-07-20T02:09:00.000Z"),
                additions: 1500,
                deletions: 500,
                repositoryFullName: "closedloop-ai/closedloop-ai",
                repository: { fullName: "closedloop-ai/closedloop-ai" },
              },
            ],
          },
        },
      ],
    });

    // #1 = 3000+1000 = 4000, recovered from HISTORY and counted because it
    // MERGED. #2 is still open, so ISS-6114 excludes its 2,000 lines — which
    // makes this case sharper than the 6000 it asserted before the gate: it now
    // proves the historical lookup AND the merge gate at once, and a regression
    // in either shows up as a different number rather than the same total.
    //
    // This case does NOT pin dedup, despite both links reaching #1's history:
    // they declare different PR numbers, so only one identity is ever resolved
    // per link. The dedup invariant is pinned by "counts a PR declared by TWO
    // authored links exactly once" above.
    expect(item?.mergedAuthoredPrLinesChanged).toBe(4000);
    expect(item?.kloc).toBeCloseTo(4, 10);
  });

  // FEA-4378 (codex P2): a PR whose provider supplied only ONE LOC dimension
  // (`additions: 7, deletions: null` — a real persisted shape) is INCOMPLETE data,
  // not a verified 7-line total. Coercing the missing side to 0 would publish an
  // understated "N in merged PRs" and feed LOC/$; the PR must contribute nothing and the
  // roll-up degrades to the local working-tree diff (unknown ≠ zero).
  it("rejects a partial-LOC PR (one dimension null) instead of understating the total", async () => {
    const item = await projectMultiPrSession({
      linesAdded: 120,
      linesRemoved: 30,
      estimatedCost: 10,
      sourceLinks: [
        {
          ...authoredPrLocSourceLink({
            headRef: "marisolashgrove/pr-partial",
            prNumber: 7001,
            additions: 0,
            deletions: 0,
          }),
          target: {
            name: "marisolashgrove/pr-partial",
            type: "BRANCH",
            branch: {
              repository: { fullName: "closedloop-ai/closedloop-ai" },
              currentPullRequestDetail: {
                number: 7001,
                title: "PR 7001",
                ...PR_LIFECYCLE.Merged,
                lastVerifiedAt: new Date("2026-07-20T02:09:00.000Z"),
                isCurrent: true,
                repository: { fullName: "closedloop-ai/closedloop-ai" },
                additions: 7,
                deletions: null,
              },
            },
          },
        },
      ],
    });

    // The partial PR contributes nothing (not 7). ISS-9980: a matching merged PR
    // whose LOC row is half-populated makes the whole numerator NOT KNOWABLE —
    // the answer is unreachable, not zero — so this reads `null` rather than the
    // `0` it asserted when the 150-line local diff stood in for it.
    expect(item?.mergedAuthoredPrLinesChanged).toBeNull();
    expect(item?.kloc).toBeNull();
    expect(item?.locPerDollar).toBeNull();
  });

  // A genuine no-op PR (both dimensions present and 0) is a TRUE zero, distinct
  // from the partial/unknown case above — it RESOLVES and contributes 0 rather
  // than being rejected as missing data, so the numerator is a measured zero and
  // the ratio divides it.
  it("counts a true-zero PR (both dimensions 0) as an available 0", async () => {
    const item = await projectMultiPrSession({
      linesAdded: 80,
      linesRemoved: 0,
      estimatedCost: 8,
      sourceLinks: [
        authoredPrLocSourceLink({
          headRef: "marisolashgrove/pr-zero",
          prNumber: 7101,
          additions: 0,
          deletions: 0,
        }),
      ],
    });

    // Both 0 present → resolves to an AVAILABLE 0, which is the distinction the
    // partial-LOC case above turns on: this session's numerator was measured and
    // found to be zero, so the ratio divides it rather than withholding.
    expect(item?.mergedAuthoredPrLinesChanged).toBe(0);
    expect(item?.kloc).toBeNull();
    expect(item?.locPerDollar).toBe(0);
  });

  // A session with authored PRs whose LOC columns were never fetched (BOTH
  // additions AND deletions null — the pre-enrichment shape) is unavailable. This
  // is ISS-4448's session in miniature: 88 merged PRs whose per-PR LOC cannot be
  // resolved. ISS-9980 settled it BY PRINCIPLE — an unreachable numerator renders
  // NOT AVAILABLE, never `0`, and never a fabricated total from the local diff.
  it("treats an unfetched per-PR LOC (both dimensions null) as NOT KNOWABLE", async () => {
    const item = await projectMultiPrSession({
      linesAdded: 200,
      linesRemoved: 40,
      estimatedCost: 5,
      sourceLinks: [
        {
          ...authoredPrLocSourceLink({
            headRef: "marisolashgrove/pr-nulls",
            prNumber: 4001,
            additions: 0,
            deletions: 0,
          }),
          target: {
            name: "marisolashgrove/pr-nulls",
            type: "BRANCH",
            branch: {
              repository: { fullName: "closedloop-ai/closedloop-ai" },
              currentPullRequestDetail: {
                number: 4001,
                title: "PR 4001",
                ...PR_LIFECYCLE.Merged,
                lastVerifiedAt: new Date("2026-07-20T02:09:00.000Z"),
                isCurrent: true,
                repository: { fullName: "closedloop-ai/closedloop-ai" },
                additions: null,
                deletions: null,
              },
            },
          },
        },
      ],
    });

    expect(item?.mergedAuthoredPrLinesChanged).toBeNull();
    expect(item?.kloc).toBeNull();
    // The 240-line local diff used to supply this ratio (240 / 5 = 48). It was
    // never this session's delivered code, and publishing it as LOC/$ is the
    // exact dishonesty ISS-9964 removed: the honest answer is "we cannot say".
    expect(item?.locPerDollar).toBeNull();
  });

  /**
   * ONE identity reached by TWO links — a reused branch holding an unenriched
   * detail row alongside a fetched one — where the unenriched link is iterated
   * FIRST.
   *
   * The completeness verdict must not depend on `sourceLinks` order. It was
   * latched inside the loop, and the identity was recorded only on the counted
   * branch, so the first link marked the total incomplete and left no trace; the
   * second link then passed the dedup guard and summed its 400 lines. The sum
   * took the LAST resolution while the verdict took the FIRST, and the session
   * published `mergedAuthoredPrLinesChanged: null` while holding a fully
   * correct 400 — a NOT-AVAILABLE card for a session whose merged LOC was in
   * fact read. Reversing these two links flipped the answer with no other
   * change, which is what makes it a bug rather than a policy.
   *
   * A PR another link DID read is knowable. Only an identity nothing ever
   * counted makes the total NOT KNOWABLE.
   */
  it("counts a PR one link could not read when a SECOND link resolved it", async () => {
    const item = await projectMultiPrSession({
      linesAdded: 10,
      linesRemoved: 2,
      estimatedCost: 5,
      sourceLinks: [
        {
          ...authoredPrLocSourceLink({
            headRef: "marisolashgrove/pr-unenriched",
            prNumber: 4002,
            additions: 0,
            deletions: 0,
          }),
          target: {
            name: "marisolashgrove/pr-unenriched",
            type: "BRANCH",
            branch: {
              repository: { fullName: "closedloop-ai/closedloop-ai" },
              currentPullRequestDetail: {
                number: 4002,
                title: "PR 4002",
                ...PR_LIFECYCLE.Merged,
                lastVerifiedAt: new Date("2026-07-20T02:09:00.000Z"),
                isCurrent: true,
                repository: { fullName: "closedloop-ai/closedloop-ai" },
                additions: null,
                deletions: null,
              },
            },
          },
        },
        authoredPrLocSourceLink({
          headRef: "marisolashgrove/pr-enriched",
          prNumber: 4002,
          additions: 300,
          deletions: 100,
          lifecycle: PR_LIFECYCLE.Merged,
        }),
      ],
    });

    expect(item?.mergedAuthoredPrLinesChanged).toBe(400);
    expect(item?.locPerDollar).toBe(80);
  });

  /**
   * FEA-4250's DENOMINATOR rule, re-homed here from projections.kloc.test.ts
   * when ISS-9964 / ISS-9980 (RULED 2026-09-11) deleted that file. Its four
   * cases seeded the numerator from the local working-tree and branch diffs;
   * two of them pinned those retired rungs outright, and the other two could no
   * longer reach the behavior they named. This is the one rule that survived
   * them and had no other owner, so it moves to the suite that can still seed a
   * numerator — the contract followed the derivation rather than being deleted
   * with its old harness.
   *
   * The two nulls in this suite are NOT the same fact. Everywhere above, `null`
   * means the numerator is NOT KNOWABLE. Here it is arithmetic: the numerator is
   * a perfectly good 1,000, and there is simply no cost to divide it by. Both
   * render the same placeholder, and that is fine — neither is a number.
   */
  it("reports a null locPerDollar when the session has no cost to divide by", async () => {
    const item = await projectMultiPrSession({
      linesAdded: 0,
      linesRemoved: 0,
      estimatedCost: 0,
      sourceLinks: [
        authoredPrLocSourceLink({
          headRef: "marisolashgrove/pr-unpriced",
          prNumber: 9301,
          additions: 900,
          deletions: 100,
        }),
      ],
    });

    // The numerator RESOLVED — this is not the unknowable case above.
    expect(item?.mergedAuthoredPrLinesChanged).toBe(1000);
    expect(item?.kloc).toBeCloseTo(1, 10);
    // Division by zero, so an honest null rather than an Infinity rendered as a
    // spectacular efficiency.
    expect(item?.locPerDollar).toBeNull();
  });
});
