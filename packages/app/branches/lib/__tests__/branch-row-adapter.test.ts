import {
  BranchDataState,
  BranchStatus,
  BranchTagAvailability,
  type BranchRow as WireBranchRow,
} from "@repo/api/src/types/branch";
import { describe, expect, it } from "vitest";
import { canonicalBranchProjectionFixture } from "../../test-fixtures/canonical-branch-projection";
import { BranchRowStatus } from "../branch-row";
import { adaptBranchRow, adaptBranchRows } from "../branch-row-adapter";

const NOW = Date.parse("2026-06-17T12:00:00.000Z");

function wireRow(overrides: Partial<WireBranchRow> = {}): WireBranchRow {
  return {
    id: "repo%2Fowner::main",
    branchName: "main",
    baseBranch: "develop",
    repoFullName: "owner/repo",
    owner: "alice",
    status: BranchStatus.Open,
    prNumber: 1270,
    prTitle: "A PR",
    prState: null,
    prUrl: null,
    multiPrWarning: false,
    checksStatus: null,
    checksPassed: 9,
    checksTotal: 11,
    reviewDecision: null,
    ahead: 4,
    behind: 2,
    additions: 100,
    deletions: 20,
    filesChanged: null,
    estimatedCostUsd: null,
    lastActivityAt: "2026-06-17T09:00:00.000Z", // 3h before NOW
    sessionIds: [],
    ...overrides,
  };
}

describe("adaptBranchRow", () => {
  it("maps a fully-populated wire row to the render shape", () => {
    expect(adaptBranchRow(wireRow(), { now: NOW })).toEqual({
      id: "repo%2Fowner::main",
      branchName: "main",
      baseBranch: "develop",
      repo: "owner/repo",
      owner: "alice",
      ownerKey: "alice",
      collaborators: [],
      tags: [],
      tagAvailability: BranchTagAvailability.Unavailable,
      tagPermissions: undefined,
      artifactId: undefined,
      status: BranchRowStatus.Open,
      prNumber: 1270,
      prTitle: "A PR",
      prUrl: null,
      hasPullRequest: true,
      prRepo: "owner/repo",
      prState: null,
      checksPassed: 9,
      checksTotal: 11,
      checksStatus: null,
      behind: 2,
      ahead: 4,
      additions: 100,
      deletions: 20,
      sessionCount: 0,
      commentCount: null,
      provenance: "human",
      lastActivityLabel: "3 hours ago",
      lastActivityAt: "2026-06-17T09:00:00.000Z",
      canonicalIdentity: "repo%2Fowner::main",
    });
  });

  it("carries the B4 render fields through from the wire row", () => {
    const adapted = adaptBranchRow(
      wireRow({
        prState: "MERGED",
        checksStatus: "PASSING",
        sessionIds: ["s1", "s2", "s3"],
      }),
      { now: NOW }
    );
    expect(adapted.prState).toBe("MERGED");
    expect(adapted.checksStatus).toBe("PASSING");
    expect(adapted.sessionCount).toBe(3);
    // comment count has no wire producer in v1 (soft Epic F3 consumer).
    expect(adapted.commentCount).toBeNull();
  });

  it("prefers canonical list dataState over the compatibility field", () => {
    const canonicalProjection = {
      ...canonicalBranchProjectionFixture,
      list: {
        ...canonicalBranchProjectionFixture.list,
        dataState: BranchDataState.AwaitingSync,
      },
    };

    const adapted = adaptBranchRow(
      wireRow({
        canonicalProjection,
        dataState: BranchDataState.Ready,
      })
    );

    expect(adapted.dataState).toBe(BranchDataState.AwaitingSync);
  });

  it("falls back to top-level dataState and preserves absent-field omission", () => {
    expect(
      adaptBranchRow(wireRow({ dataState: BranchDataState.NotPresent }))
        .dataState
    ).toBe(BranchDataState.NotPresent);

    expect(adaptBranchRow(wireRow())).not.toHaveProperty("dataState");
  });

  it("falls back when a version-skewed canonical projection omits list", () => {
    const malformedProjectionRow = wireRow({
      dataState: BranchDataState.NotPresent,
    });
    Object.defineProperty(malformedProjectionRow, "canonicalProjection", {
      value: {
        common: canonicalBranchProjectionFixture.common,
        detail: canonicalBranchProjectionFixture.detail,
        version: canonicalBranchProjectionFixture.version,
      },
    });

    expect(adaptBranchRow(malformedProjectionRow).dataState).toBe(
      BranchDataState.NotPresent
    );
  });

  it("carries an unknown newer dataState without crashing older renderers", () => {
    const adapted = adaptBranchRow(
      wireRow({ dataState: "future_state" as WireBranchRow["dataState"] })
    );

    expect(adapted.dataState).toBe("future_state");
  });

  it("FEA-3285: derives provenance from the branch name", () => {
    expect(adaptBranchRow(wireRow({ branchName: "main" })).provenance).toBe(
      "human"
    );
    expect(
      adaptBranchRow(wireRow({ branchName: "worktree-agent-abc" })).provenance
    ).toBe("agent");
    expect(
      adaptBranchRow(wireRow({ branchName: "dependabot/npm/vite" })).provenance
    ).toBe("bot");
  });

  it("degrades NULL enrichment to render placeholders (not fabricated values)", () => {
    const adapted = adaptBranchRow(
      wireRow({
        baseBranch: null,
        repoFullName: null,
        owner: null,
        prNumber: null,
        prTitle: null,
        additions: null,
        deletions: null,
        ahead: null,
        behind: null,
      }),
      { now: NOW }
    );
    expect(adapted.baseBranch).toBe("—");
    expect(adapted.repo).toBe("—");
    expect(adapted.owner).toBe("unattributed");
    expect(adapted.prNumber).toBeNull();
    // Numeric enrichment stays NULL (never fabricated 0) so the table renders the
    // empty-value affordance for genuinely-unavailable data.
    expect(adapted.additions).toBeNull();
    expect(adapted.deletions).toBeNull();
    expect(adapted.ahead).toBeNull();
    expect(adapted.behind).toBeNull();
  });

  it("maps every wire status, including the approved closed status", () => {
    expect(
      adaptBranchRow(wireRow({ status: BranchStatus.Review })).status
    ).toBe(BranchRowStatus.Review);
    expect(
      adaptBranchRow(wireRow({ status: BranchStatus.Merged })).status
    ).toBe(BranchRowStatus.Merged);
    expect(
      adaptBranchRow(wireRow({ status: BranchStatus.Blocked })).status
    ).toBe(BranchRowStatus.Blocked);
    expect(
      adaptBranchRow(wireRow({ status: BranchStatus.Closed })).status
    ).toBe(BranchRowStatus.Closed);
  });

  it("degrades an unrecognized wire status to draft instead of undefined", () => {
    // A newer producer could emit a status this renderer predates; the lookup
    // must not return undefined (which would crash the status cell).
    const adapted = adaptBranchRow(
      wireRow({ status: "experimental" as BranchStatus })
    );
    expect(adapted.status).toBe(BranchRowStatus.Draft);
  });

  it("does not consume an unsupported canonical projection generation", () => {
    const futureRow = wireRow({ dataState: BranchDataState.NotPresent });
    Object.defineProperty(futureRow, "canonicalProjection", {
      value: {
        version: "v2",
        common: {
          identity: { repositoryFullName: "future/repo" },
        },
        list: { dataState: BranchDataState.AwaitingSync },
      },
    });

    const adapted = adaptBranchRow(futureRow, { now: NOW });
    expect(adapted.repo).toBe("owner/repo");
    expect(adapted.dataState).toBe(BranchDataState.NotPresent);
  });

  it("preserves explicit canonical Last-active unavailability", () => {
    const adapted = adaptBranchRow(
      wireRow({
        canonicalLastActiveAt: { state: "unavailable", value: null },
        lastActivityAt: "2026-06-17T09:00:00.000Z",
      }),
      { now: NOW, preferCanonicalLastActive: true }
    );

    expect(adapted.lastActivityAt).toBeUndefined();
    expect(adapted.lastActivityLabel).toBe("—");
  });

  it("preserves the legacy Last-active value while the approved List is off", () => {
    const adapted = adaptBranchRow(
      wireRow({
        canonicalLastActiveAt: { state: "unavailable", value: null },
        lastActivityAt: "2026-06-17T09:00:00.000Z",
      }),
      { now: NOW }
    );

    expect(adapted.lastActivityAt).toBe("2026-06-17T09:00:00.000Z");
    expect(adapted.lastActivityLabel).toBe("3 hours ago");
  });

  it("preserves associated PR presence when selection is ambiguous", () => {
    const canonicalProjection = {
      ...canonicalBranchProjectionFixture,
      common: {
        ...canonicalBranchProjectionFixture.common,
        pullRequests: {
          ...canonicalBranchProjectionFixture.common.pullRequests,
          associatedCount: 2,
          selected: null,
        },
      },
    };
    const adapted = adaptBranchRow(
      wireRow({ canonicalProjection, prNumber: null })
    );

    expect(adapted.hasPullRequest).toBe(true);
    expect(adapted.prNumber).toBeNull();
  });

  it("formats the updated label relative to now and degrades an unparseable date", () => {
    expect(
      adaptBranchRow(wireRow({ lastActivityAt: "2026-06-10T12:00:00.000Z" }), {
        now: NOW,
      }).lastActivityLabel
    ).toBe("Jun 10, 2026");
    expect(
      adaptBranchRow(wireRow({ lastActivityAt: "not-a-date" }), { now: NOW })
        .lastActivityLabel
    ).toBe("—");
    expect(
      adaptBranchRow(wireRow({ lastActivityAt: "2026-06-17T11:59:30.000Z" }), {
        now: NOW,
      }).lastActivityLabel
    ).toBe("Just now");
    const future = adaptBranchRow(
      wireRow({ lastActivityAt: "2026-06-17T12:00:00.001Z" }),
      { now: NOW }
    );
    expect(future.lastActivityAt).toBeUndefined();
    expect(future.lastActivityLabel).toBe("—");
  });

  it("maps a list of rows", () => {
    expect(
      adaptBranchRows([wireRow({ id: "a" }), wireRow({ id: "b" })], {
        now: NOW,
      }).map((row) => row.id)
    ).toEqual(["a", "b"]);
  });
});
