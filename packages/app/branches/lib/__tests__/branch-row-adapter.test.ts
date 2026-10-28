import {
  BranchDataState,
  BranchParticipationKind,
  BranchStatus,
  BranchTagAvailability,
  type BranchRow as WireBranchRow,
} from "@repo/api/src/types/branch";
import {
  PROVENANCE_RELATIONSHIP_KIND_LABELS,
  ProvenanceRelationshipKind,
} from "@repo/api/src/types/provenance-relationship";
import {
  DISPLAYED_SESSION_STATUS,
  type DisplayedSessionStatus,
  SESSION_STATUS,
} from "@repo/api/src/types/session-status";
import { describe, expect, it } from "vitest";
import {
  BRANCH_OWNER_AVATAR_URL,
  canonicalBranchProjectionFixture,
} from "../../test-fixtures/canonical-branch-projection";
import { BranchRowStatus, RENDER_MISSING } from "../branch-row";
import { adaptBranchRow, adaptBranchRows } from "../branch-row-adapter";

const NOW = Date.parse("2026-06-17T12:00:00.000Z");
const CONTRIBUTED_LABEL =
  PROVENANCE_RELATIONSHIP_KIND_LABELS[ProvenanceRelationshipKind.Contribution];

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

/**
 * ISS-10350 — the request-side continuation clock is retired, but the producer
 * still stamps its evaluation instant on the RESPONSE and the render must judge
 * rows against THAT. `validTimestamp` drops anything past `now`, so falling back
 * to the viewer's clock turns a genuinely recent branch on a browser that trails
 * the API into an em-dash and drops it out of the last-active facets — a
 * measurement nobody made, replacing one that was there.
 */
describe("adaptBranchRows against the producer clock", () => {
  const producerNow = Date.parse("2026-06-17T12:00:00.000Z");
  // Recent on the producer's clock; still in the future on the viewer's.
  const viewerNow = producerNow - 30_000;
  const recent = "2026-06-17T11:59:50.000Z";

  it("keeps a row the producer clock says is recent", () => {
    const [row] = adaptBranchRows([wireRow({ lastActivityAt: recent })], {
      now: producerNow,
    });

    expect(row?.lastActivityAt).toBe(recent);
    expect(row?.lastActivityLabel).not.toBe(RENDER_MISSING);
  });

  it("drops that same row when only the trailing viewer clock is available", () => {
    const [row] = adaptBranchRows([wireRow({ lastActivityAt: recent })], {
      now: viewerNow,
    });

    expect(row?.lastActivityAt).toBeUndefined();
    expect(row?.lastActivityLabel).toBe(RENDER_MISSING);
  });
});

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
      rawStatus: BranchStatus.Open,
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

  it("forwards the canonical Owner photo without changing the Collaborator source", () => {
    const adapted = adaptBranchRow(
      wireRow({ canonicalProjection: canonicalBranchProjectionFixture }),
      { now: NOW }
    );

    expect(adapted.ownerAvatarUrl).toBe(BRANCH_OWNER_AVATAR_URL);
    expect(adapted.ownerKey).toBe("closedloop:user-1");
    expect(adapted.collaborators).toEqual([
      { key: "closedloop:user-2", name: "Reviewer" },
    ]);
  });

  it("uses the legacy Owner identity only when no canonical projection exists", () => {
    const ownerIdentity = canonicalBranchProjectionFixture.common.people.owner;
    if (!ownerIdentity) {
      throw new Error("Canonical Branch fixture has no Owner identity");
    }
    const legacy = adaptBranchRow(wireRow({ ownerIdentity }), { now: NOW });
    expect(legacy.ownerAvatarUrl).toBe(BRANCH_OWNER_AVATAR_URL);

    const canonical = adaptBranchRow(
      wireRow({
        canonicalProjection: canonicalBranchProjectionFixture,
        ownerIdentity: {
          ...ownerIdentity,
          person: ownerIdentity.person
            ? {
                ...ownerIdentity.person,
                avatarUrl: "https://img.clerk.com/stale-photo.png",
              }
            : null,
        },
      }),
      { now: NOW }
    );
    expect(canonical.ownerAvatarUrl).toBe(BRANCH_OWNER_AVATAR_URL);
    expect(adaptBranchRow(wireRow(), { now: NOW })).not.toHaveProperty(
      "ownerAvatarUrl"
    );
  });

  // ISS-8155: the cloud PR projection reports an unmeasured base ref as `""` and
  // the Desktop overlay forwards it onto this row, so the placeholder has to
  // catch the empty string as well as null. Rendering `""` is the hidden absence
  // — a blank cell reads as "this branch has no base", which is a claim.
  it.each([
    ["null", null],
    ["an empty string", ""],
  ])(
    "names a base branch the producer did not measure (%s)",
    (_label, base) => {
      const adapted = adaptBranchRow(wireRow({ baseBranch: base }), {
        now: NOW,
      });

      expect(adapted.baseBranch).toBe(RENDER_MISSING);
    }
  );

  it("keeps a measured base branch verbatim", () => {
    const adapted = adaptBranchRow(wireRow({ baseBranch: "release/24" }), {
      now: NOW,
    });

    expect(adapted.baseBranch).toBe("release/24");
    expect(adapted.baseBranch).not.toBe(RENDER_MISSING);
  });

  it("ISS-12663: carries custom-field values, and keeps an omitted projection omitted", () => {
    const loaded = adaptBranchRow(wireRow({ customFields: [] }), { now: NOW });
    const omitted = adaptBranchRow(wireRow(), { now: NOW });

    expect(loaded.customFields).toEqual([]);
    expect(omitted).not.toHaveProperty("customFields");
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

  it("carries explicit Wrote identities and uses the canonical qualifying count", () => {
    const canonicalProjection = {
      ...canonicalBranchProjectionFixture,
      common: {
        ...canonicalBranchProjectionFixture.common,
        membership: {
          qualifyingSessionCount: 2,
          sessionIds: ["session-1", "session-legacy"],
          sessions: [
            {
              artifactId: "session-1",
              displayedStatus: DISPLAYED_SESSION_STATUS.ACTIVE,
              lastInteractionAt: "2026-06-17T09:00:00.000Z",
              name: "Canonical session",
              navigableRef: "SES-1",
              ownerName: "Avery Example",
              participation: BranchParticipationKind.Wrote,
              rawStatus: SESSION_STATUS.ACTIVE,
              slug: "SES-1",
            },
            {
              artifactId: "session-reviewed",
              displayedStatus: DISPLAYED_SESSION_STATUS.INACTIVE,
              lastInteractionAt: "2026-06-17T08:00:00.000Z",
              name: "Reviewed-only session",
              navigableRef: "SES-REVIEWED",
              ownerName: "Riley Reviewer",
              participation: BranchParticipationKind.Reviewed,
              rawStatus: SESSION_STATUS.INACTIVE,
              slug: "SES-REVIEWED",
            },
            {
              artifactId: "session-legacy",
              displayedStatus: DISPLAYED_SESSION_STATUS.INACTIVE,
              lastInteractionAt: "2026-06-17T07:00:00.000Z",
              name: "Legacy session",
              navigableRef: "SES-LEGACY",
              ownerName: null,
              rawStatus: SESSION_STATUS.INACTIVE,
              slug: "SES-LEGACY",
            },
          ],
        },
      },
    };
    const adapted = adaptBranchRow(
      wireRow({
        canonicalProjection,
        sessionIds: ["compatibility-only-session"],
      }),
      { now: NOW }
    );

    expect(adapted.sessions).toEqual([
      {
        id: "session-1",
        navigableRef: "SES-1",
        occurredAt: "2026-06-17T09:00:00.000Z",
        ownerName: "Avery Example",
        rawStatus: SESSION_STATUS.ACTIVE,
        relationshipLabel: CONTRIBUTED_LABEL,
        slug: "SES-1",
        status: DISPLAYED_SESSION_STATUS.ACTIVE,
      },
    ]);
    expect(adapted.sessionCount).toBe(2);
  });

  // ISS-10364 (operator ruling, 2026-09-23/24): the display-only `Unknown` fold
  // this test pinned is retired. An unrecognized wire value now fails open to
  // ACTIVE, like every other fold in the vocabulary.
  it("degrades a future displayed status to Active at the wire boundary", () => {
    const canonicalProjection = {
      ...canonicalBranchProjectionFixture,
      common: {
        ...canonicalBranchProjectionFixture.common,
        membership: {
          qualifyingSessionCount: 1,
          sessionIds: ["session-future"],
          sessions: [
            {
              artifactId: "session-future",
              displayedStatus:
                "future-display-status" as DisplayedSessionStatus,
              lastInteractionAt: "2026-06-17T09:00:00.000Z",
              name: "Future session",
              navigableRef: "SES-FUTURE",
              ownerName: "Avery Example",
              participation: BranchParticipationKind.Wrote,
              rawStatus: "future-display-status",
              slug: "SES-FUTURE",
            },
          ],
        },
      },
    };

    const adapted = adaptBranchRow(wireRow({ canonicalProjection }), {
      now: NOW,
    });

    expect(adapted.sessions?.[0]?.status).toBe(SESSION_STATUS.ACTIVE);
  });

  it("sanitizes malformed membership summaries and an invalid canonical count", () => {
    const validSession = {
      artifactId: "session-valid",
      displayedStatus: DISPLAYED_SESSION_STATUS.ACTIVE,
      lastInteractionAt: "2026-06-17T09:00:00.000Z",
      name: "Fallback session name",
      navigableRef: "",
      ownerName: "private-owner@example.com",
      participation: BranchParticipationKind.Wrote,
      rawStatus: SESSION_STATUS.ACTIVE,
      slug: "",
    };
    const canonicalProjection = {
      ...canonicalBranchProjectionFixture,
      common: {
        ...canonicalBranchProjectionFixture.common,
        membership: {
          qualifyingSessionCount: 0,
          sessionIds: ["session-valid", "session-invalid-date"],
          sessions: [
            validSession,
            {
              ...validSession,
              artifactId: "session-invalid-date",
              lastInteractionAt: "not-a-date",
            },
            { ...validSession, artifactId: "" },
          ],
        },
      },
    };

    const adapted = adaptBranchRow(
      wireRow({
        canonicalProjection,
        sessionIds: ["compat-1", "compat-2"],
      }),
      { now: NOW }
    );

    expect(adapted.sessionCount).toBe(2);
    expect(adapted.sessions).toEqual([
      expect.objectContaining({
        id: "session-valid",
        navigableRef: "session-valid",
        ownerName: null,
        ownerUnavailable: true,
        slug: "Fallback session name",
      }),
    ]);
    expect(JSON.stringify(adapted.sessions)).not.toContain(
      "private-owner@example.com"
    );
  });

  // ISS-8422: the badge tells an unobserved PR from no PR by `prNumber` beside a
  // NULL `prState`. The adapter is where that pair could be flattened — a `?? 0`
  // on the number or a fabricated OPEN here erases the distinction before any
  // component sees it, and the row would render as a plain Open PR again.
  it("preserves the unobserved-PR discriminator (number present, state NULL)", () => {
    const adapted = adaptBranchRow(
      wireRow({ prNumber: 42, prState: null, prTitle: null }),
      { now: NOW }
    );

    expect(adapted.prNumber).toBe(42);
    expect(adapted.prState).toBeNull();
    expect(adapted.hasPullRequest).toBe(true);
    expect(adapted.prRepo).toBe("owner/repo");
  });

  it("retains raw status evidence when the legacy render fold falls back", () => {
    const adapted = adaptBranchRow(
      wireRow({ status: "AWAITING_ROBOT_REVIEW" as BranchStatus }),
      { now: NOW }
    );

    expect(adapted.status).toBe(BranchRowStatus.Draft);
    expect(adapted.rawStatus).toBe("AWAITING_ROBOT_REVIEW");
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
