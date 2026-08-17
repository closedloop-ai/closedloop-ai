// FEA-4378: the authored-PR LOC roll-up feeding the per-session KLOC numerator.
// A multi-PR session whose LOCAL working-tree diff is a tiny residual (branches
// merged/reset) must still read its real delivered code: the KLOC numerator is
// `max(localWorkingTreeDiff, sum(additions + deletions) over AUTHORED PRs)`, and
// the summed authored-PR LOC is exposed on the read contract as
// `authoredPrLinesChanged`. Kept in its own sibling (projections.test.ts is
// grandfathered over the 1000-line ceiling); asserts the projected values, not
// source text.

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
function authoredPrLocSourceLink({
  headRef,
  prNumber,
  additions,
  deletions,
}: {
  headRef: string;
  prNumber: number;
  additions: number;
  deletions: number;
}) {
  return {
    metadata: {
      linkKind: SessionArtifactLinkKind.SessionPr,
      relationTypes: [SessionPrRelationType.Created],
      repositoryFullName: "closedloop-ai/symphony-alpha",
      prNumber,
      source: "DETERMINISTIC",
      confidence: 1.0,
      extractorVersion: 1,
    },
    target: {
      name: headRef,
      type: "BRANCH",
      branch: {
        repository: { fullName: "closedloop-ai/symphony-alpha" },
        currentPullRequestDetail: {
          number: prNumber,
          title: `PR ${prNumber}`,
          prState: PullRequestState.Merged,
          closedAt: null,
          mergedAt: new Date("2026-07-20T02:10:11.000Z"),
          lastVerifiedAt: new Date("2026-07-20T02:09:00.000Z"),
          isCurrent: true,
          repository: { fullName: "closedloop-ai/symphony-alpha" },
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
          headRef: "mikeangstadt/pr-a",
          prNumber: 1001,
          additions: 4000,
          deletions: 1000,
        }),
        authoredPrLocSourceLink({
          headRef: "mikeangstadt/pr-b",
          prNumber: 1002,
          additions: 2500,
          deletions: 500,
        }),
      ],
    });

    // Summed authored-PR LOC = (4000+1000) + (2500+500) = 8000, which dwarfs the
    // 136-line local diff and is the numerator the projection must prefer.
    expect(item?.authoredPrLinesChanged).toBe(8000);
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
  it("keeps the local working-tree diff when it exceeds the authored-PR LOC", async () => {
    const item = await projectMultiPrSession({
      linesAdded: 9000,
      linesRemoved: 1000,
      estimatedCost: 100,
      sourceLinks: [
        authoredPrLocSourceLink({
          headRef: "mikeangstadt/pr-a",
          prNumber: 2001,
          additions: 300,
          deletions: 100,
        }),
      ],
    });

    expect(item?.authoredPrLinesChanged).toBe(400);
    // max(10000 local, 400 authored-PR) = 10000 → KLOC 10.
    expect(item?.kloc).toBeCloseTo(10, 10);
    // ISS-4667: raw LINES / cost — 10 KLOC is 10,000 lines.
    expect(item?.locPerDollar).toBeCloseTo(10_000 / 100, 12);
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
            headRef: "mikeangstadt/pr-ref",
            prNumber: 3001,
            additions: 9999,
            deletions: 9999,
          }),
          metadata: {
            linkKind: SessionArtifactLinkKind.SessionPr,
            relationTypes: [SessionPrRelationType.Referenced],
            repositoryFullName: "closedloop-ai/symphony-alpha",
            prNumber: 3001,
            source: "DETERMINISTIC",
            confidence: 1.0,
            extractorVersion: 1,
          },
        },
      ],
    });

    // The referenced PR's 19,998 lines are excluded; only the 50-line local diff
    // remains, so the roll-up contributes nothing.
    expect(item?.authoredPrLinesChanged).toBe(0);
    expect(item?.kloc).toBeCloseTo(0.05, 10);
  });

  // Parity with the PR⇒Branch invariant: when no head branch resolves (a BRANCH
  // target with a verified detail but no `name`), the PR projection SUPPRESSES
  // the PRs (renders "None"). The roll-up must be suppressed too, or KLOC and the
  // pills-row "N in PRs" figure would credit a PR the UI hides.
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
            repositoryFullName: "closedloop-ai/symphony-alpha",
            prNumber: 5001,
            source: "DETERMINISTIC",
            confidence: 1.0,
            extractorVersion: 1,
          },
          target: {
            // No `name` and not a resolvable BRANCH-link name → head branch is
            // null → enforcePrBranchInvariant empties the PRs.
            branch: {
              repository: { fullName: "closedloop-ai/symphony-alpha" },
              currentPullRequestDetail: {
                number: 5001,
                title: "PR 5001",
                prState: PullRequestState.Merged,
                closedAt: null,
                mergedAt: new Date("2026-07-20T02:10:11.000Z"),
                lastVerifiedAt: new Date("2026-07-20T02:09:00.000Z"),
                isCurrent: true,
                repository: { fullName: "closedloop-ai/symphony-alpha" },
                additions: 9000,
                deletions: 9000,
              },
            },
          },
        },
      ],
    });

    // PRs suppressed → roll-up suppressed → only the 60-line local diff drives KLOC.
    expect(item?.prs).toEqual([]);
    expect(item?.authoredPrLinesChanged).toBe(0);
    expect(item?.kloc).toBeCloseTo(0.06, 10);
  });

  // FEA-4378 (codex P2): a session that authored TWO PRs from the SAME reused
  // branch. The branch's `currentPullRequestDetail` pointer holds only the most
  // recent PR (#2); the earlier PR (#1) survives only as a non-current row in the
  // branch Artifact's historical `pullRequestDetails` set. Reading the current
  // pointer alone would drop #1's LOC; resolving each authored PR number against
  // the full current+historical set must recover it.
  it("rolls up a superseded PR's LOC from the branch historical set (reused branch)", async () => {
    const sharedHeadRef = "mikeangstadt/reused-branch";
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
            repositoryFullName: "closedloop-ai/symphony-alpha",
            prNumber: 6001,
            source: "DETERMINISTIC",
            confidence: 1.0,
            extractorVersion: 1,
          },
          target: {
            name: sharedHeadRef,
            type: "BRANCH",
            branch: {
              repository: { fullName: "closedloop-ai/symphony-alpha" },
              // Current pointer is PR #2, not #1.
              currentPullRequestDetail: {
                number: 6002,
                title: "PR 6002",
                prState: PullRequestState.Open,
                closedAt: null,
                mergedAt: null,
                lastVerifiedAt: new Date("2026-07-20T02:09:00.000Z"),
                isCurrent: true,
                repository: { fullName: "closedloop-ai/symphony-alpha" },
                additions: 1500,
                deletions: 500,
              },
            },
            // Branch Artifact's full PR history: #1 (superseded) + #2 (current).
            pullRequestDetails: [
              {
                number: 6001,
                lastVerifiedAt: new Date("2026-07-19T00:00:00.000Z"),
                additions: 3000,
                deletions: 1000,
                repositoryFullName: "closedloop-ai/symphony-alpha",
                repository: { fullName: "closedloop-ai/symphony-alpha" },
              },
              {
                number: 6002,
                lastVerifiedAt: new Date("2026-07-20T02:09:00.000Z"),
                additions: 1500,
                deletions: 500,
                repositoryFullName: "closedloop-ai/symphony-alpha",
                repository: { fullName: "closedloop-ai/symphony-alpha" },
              },
            ],
          },
        },
        // Authored link for PR #2 — same branch, resolves via the current pointer.
        {
          metadata: {
            linkKind: SessionArtifactLinkKind.SessionPr,
            relationTypes: [SessionPrRelationType.Created],
            repositoryFullName: "closedloop-ai/symphony-alpha",
            prNumber: 6002,
            source: "DETERMINISTIC",
            confidence: 1.0,
            extractorVersion: 1,
          },
          target: {
            name: sharedHeadRef,
            type: "BRANCH",
            branch: {
              repository: { fullName: "closedloop-ai/symphony-alpha" },
              currentPullRequestDetail: {
                number: 6002,
                title: "PR 6002",
                prState: PullRequestState.Open,
                closedAt: null,
                mergedAt: null,
                lastVerifiedAt: new Date("2026-07-20T02:09:00.000Z"),
                isCurrent: true,
                repository: { fullName: "closedloop-ai/symphony-alpha" },
                additions: 1500,
                deletions: 500,
              },
            },
            pullRequestDetails: [
              {
                number: 6001,
                lastVerifiedAt: new Date("2026-07-19T00:00:00.000Z"),
                additions: 3000,
                deletions: 1000,
                repositoryFullName: "closedloop-ai/symphony-alpha",
                repository: { fullName: "closedloop-ai/symphony-alpha" },
              },
              {
                number: 6002,
                lastVerifiedAt: new Date("2026-07-20T02:09:00.000Z"),
                additions: 1500,
                deletions: 500,
                repositoryFullName: "closedloop-ai/symphony-alpha",
                repository: { fullName: "closedloop-ai/symphony-alpha" },
              },
            ],
          },
        },
      ],
    });

    // #1 = 3000+1000 = 4000 (recovered from history), #2 = 1500+500 = 2000.
    // Deduped by identity: each PR counted exactly once = 6000, NOT double-counted
    // (both links carry #2 in their current pointer AND #1 in their history).
    expect(item?.authoredPrLinesChanged).toBe(6000);
    expect(item?.kloc).toBeCloseTo(6, 10);
  });

  // FEA-4378 (codex P2): a PR whose provider supplied only ONE LOC dimension
  // (`additions: 7, deletions: null` — a real persisted shape) is INCOMPLETE data,
  // not a verified 7-line total. Coercing the missing side to 0 would publish an
  // understated "N in PRs" and feed KLOC/$; the PR must contribute nothing and the
  // roll-up degrades to the local working-tree diff (unknown ≠ zero).
  it("rejects a partial-LOC PR (one dimension null) instead of understating the total", async () => {
    const item = await projectMultiPrSession({
      linesAdded: 120,
      linesRemoved: 30,
      estimatedCost: 10,
      sourceLinks: [
        {
          ...authoredPrLocSourceLink({
            headRef: "mikeangstadt/pr-partial",
            prNumber: 7001,
            additions: 0,
            deletions: 0,
          }),
          target: {
            name: "mikeangstadt/pr-partial",
            type: "BRANCH",
            branch: {
              repository: { fullName: "closedloop-ai/symphony-alpha" },
              currentPullRequestDetail: {
                number: 7001,
                title: "PR 7001",
                prState: PullRequestState.Open,
                closedAt: null,
                mergedAt: null,
                lastVerifiedAt: new Date("2026-07-20T02:09:00.000Z"),
                isCurrent: true,
                repository: { fullName: "closedloop-ai/symphony-alpha" },
                additions: 7,
                deletions: null,
              },
            },
          },
        },
      ],
    });

    // The partial PR contributes nothing (not 7); only the 150-line local diff
    // drives KLOC. Guards against publishing incomplete data as a verified total.
    expect(item?.authoredPrLinesChanged).toBe(0);
    expect(item?.kloc).toBeCloseTo(0.15, 10);
  });

  // A genuine no-op PR (both dimensions present and 0) is a TRUE zero, distinct
  // from the partial/unknown case above — it resolves and contributes 0 (not
  // rejected), so the local diff still drives the numerator without the PR being
  // mistaken for missing data.
  it("counts a true-zero PR (both dimensions 0) as an available 0", async () => {
    const item = await projectMultiPrSession({
      linesAdded: 80,
      linesRemoved: 0,
      estimatedCost: 8,
      sourceLinks: [
        authoredPrLocSourceLink({
          headRef: "mikeangstadt/pr-zero",
          prNumber: 7101,
          additions: 0,
          deletions: 0,
        }),
      ],
    });

    // Both 0 present → resolves to an available 0; max(80 local, 0) = 80.
    expect(item?.authoredPrLinesChanged).toBe(0);
    expect(item?.kloc).toBeCloseTo(0.08, 10);
  });

  // A session with authored PRs whose LOC columns were never fetched (BOTH
  // additions AND deletions null — the pre-enrichment shape) is unavailable, so it
  // contributes nothing and the roll-up falls back to the local diff — never NaN,
  // never a fabricated total.
  it("treats an unfetched per-PR LOC (both dimensions null) as unavailable and falls back to the local diff", async () => {
    const item = await projectMultiPrSession({
      linesAdded: 200,
      linesRemoved: 40,
      estimatedCost: 5,
      sourceLinks: [
        {
          ...authoredPrLocSourceLink({
            headRef: "mikeangstadt/pr-nulls",
            prNumber: 4001,
            additions: 0,
            deletions: 0,
          }),
          target: {
            name: "mikeangstadt/pr-nulls",
            type: "BRANCH",
            branch: {
              repository: { fullName: "closedloop-ai/symphony-alpha" },
              currentPullRequestDetail: {
                number: 4001,
                title: "PR 4001",
                prState: PullRequestState.Open,
                closedAt: null,
                mergedAt: null,
                lastVerifiedAt: new Date("2026-07-20T02:09:00.000Z"),
                isCurrent: true,
                repository: { fullName: "closedloop-ai/symphony-alpha" },
                additions: null,
                deletions: null,
              },
            },
          },
        },
      ],
    });

    expect(item?.authoredPrLinesChanged).toBe(0);
    expect(item?.kloc).toBeCloseTo(0.24, 10);
    // ISS-4667: raw LINES / cost — 0.24 KLOC is 240 lines.
    expect(item?.locPerDollar).toBeCloseTo(240 / 5, 12);
  });
});
