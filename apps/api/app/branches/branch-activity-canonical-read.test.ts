import {
  BranchActivityAtomVersion,
  BranchActivityAttributionKind,
  BranchActivityEvidenceCompleteness,
  BranchActivitySource,
} from "@repo/api/src/types/branch-activity";
import { describe, expect, it } from "vitest";
import {
  type CanonicalCloudBranchActivityAtom,
  canonicalBranchActivitySources,
  latestEligibleCloudBranchActivityAtom,
} from "./branch-activity-canonical-read";

describe("latestEligibleCloudBranchActivityAtom", () => {
  it("uses occurrence, source, and source-event identity as stable ordering", () => {
    const occurredAt = new Date("2026-08-01T00:00:00.000Z");
    const atoms = [
      atom({ sourceEventId: "z-event", occurredAt }),
      atom({
        source: BranchActivitySource.MonitoredSession,
        sourceEventId: "a-event",
        occurredAt,
      }),
      atom({ sourceEventId: "a-event", occurredAt }),
    ];

    expect(latestEligibleCloudBranchActivityAtom(row(atoms))).toMatchObject({
      source: BranchActivitySource.GitHead,
      sourceEventId: "a-event",
    });
  });

  it("rejects a foreign PR attribution without hiding older evidence", () => {
    const older = atom({
      sourceEventId: "older-head",
      occurredAt: new Date("2026-08-01T00:00:00.000Z"),
    });
    const foreign = atom({
      source: BranchActivitySource.PullRequestLifecycle,
      sourceEventId: "foreign-pr",
      occurredAt: new Date("2099-01-01T00:00:00.000Z"),
      attributionKind: BranchActivityAttributionKind.PullRequest,
      pullRequestDetailId: "pr-other",
    });

    expect(
      latestEligibleCloudBranchActivityAtom(row([foreign, older]))
    ).toEqual(older);
  });

  // ISS-10009 part 1's whole invariant: capturing pushes must move no published
  // number. Both halves of the canonical read — the in-memory eligibility here
  // and the SQL predicate the Last-active aggregate and the Branches list share
  // — key on this one list, so a `push_loc` row it excludes can reach neither
  // `last_activity_at` nor the list's default sort.
  it("excludes push_loc from canonical activity, however recent it is", () => {
    const older = atom({
      sourceEventId: "older-head",
      occurredAt: new Date("2026-08-01T00:00:00.000Z"),
    });
    const push = atom({
      source: BranchActivitySource.PushLoc,
      sourceEventId: "push-delivery-1",
      occurredAt: new Date("2099-01-01T00:00:00.000Z"),
    });

    expect(latestEligibleCloudBranchActivityAtom(row([push, older]))).toEqual(
      older
    );
    // Literals, not the const members, so a renamed or deleted member cannot
    // make the list agree with its own mistake.
    expect(canonicalBranchActivitySources).not.toContain("push_loc");
    // Sibling positive, so the absence above cannot pass against an empty list.
    expect(canonicalBranchActivitySources).toContain("git_head");
  });
});

function atom(
  overrides: Partial<CanonicalCloudBranchActivityAtom> = {}
): CanonicalCloudBranchActivityAtom {
  return {
    version: BranchActivityAtomVersion.V1,
    source: BranchActivitySource.GitHead,
    sourceEventId: "head-event",
    occurredAt: new Date("2026-08-01T00:00:00.000Z"),
    attributionKind: BranchActivityAttributionKind.Branch,
    pullRequestDetailId: null,
    completeness: BranchActivityEvidenceCompleteness.Complete,
    ...overrides,
  };
}

function row(activityAtoms: readonly CanonicalCloudBranchActivityAtom[]) {
  return {
    id: "branch-1",
    pullRequestDetails: [{ id: "pr-branch-1", branchArtifactId: "branch-1" }],
    branch: { activityAtoms },
  };
}
