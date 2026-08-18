import {
  BranchActivityAtomVersion,
  BranchActivityAttributionKind,
  BranchActivityEvidenceCompleteness,
  BranchActivitySource,
} from "@repo/api/src/types/branch-activity";
import { describe, expect, it } from "vitest";
import {
  type CanonicalCloudBranchActivityAtom,
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
