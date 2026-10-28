import { describe, expect, it } from "vitest";
import {
  associatedPullRequestsWithholdDecisions,
  type BranchAssociatedPullRequest,
  type BranchAssociatedPullRequestCandidate,
  type BranchAssociatedPullRequestCollection,
  BranchAssociatedPullRequestCompletenessReason,
  BranchAssociatedPullRequestCompletenessState,
  BranchAssociatedPullRequestProvenance,
  BranchAssociatedPullRequestSelectionReason,
  branchSelectedPullRequestQuerySchema,
  isClosedUnmergedDraft,
  isUnobservedPullRequest,
  metricAssociatedPullRequestCollection,
  observedPullRequestState,
  selectBranchAssociatedPullRequests,
} from "../branch-associated-pull-request.js";
import { ReviewDecision } from "../branch-checks.js";
import { GitHubPRState } from "../github-status.js";

const PROVENANCE = BranchAssociatedPullRequestProvenance.PersistedDesktop;
const Reason = BranchAssociatedPullRequestCompletenessReason;
const State = BranchAssociatedPullRequestCompletenessState;

describe("observedPullRequestState (ISS-8422)", () => {
  it("returns null for a missing pull request", () => {
    expect(observedPullRequestState(null)).toBeNull();
  });

  it("returns null for an unobserved pull request instead of its default state", () => {
    expect(
      observedPullRequestState({
        state: GitHubPRState.Open,
        lifecycleObserved: false,
      })
    ).toBeNull();
  });

  it("returns the state when the observation flag is absent or true", () => {
    expect(observedPullRequestState({ state: GitHubPRState.Merged })).toBe(
      GitHubPRState.Merged
    );
    expect(
      observedPullRequestState({
        state: GitHubPRState.Closed,
        lifecycleObserved: true,
      })
    ).toBe(GitHubPRState.Closed);
  });

  it("returns null for an observed pull request whose state is null", () => {
    expect(observedPullRequestState({ state: null })).toBeNull();
  });
});

describe("isUnobservedPullRequest", () => {
  it.each([
    [null, false],
    [undefined, false],
    [{}, false],
    [{ lifecycleObserved: true }, false],
    [{ lifecycleObserved: false }, true],
  ])("reads %o as unobserved=%s", (input, expected) => {
    expect(isUnobservedPullRequest(input)).toBe(expected);
  });
});

describe("associatedPullRequestsWithholdDecisions (ISS-9959)", () => {
  it("withholds nothing for a Complete collection, even with an unobserved item", () => {
    expect(
      associatedPullRequestsWithholdDecisions(
        collection(State.Complete, [], [item({ lifecycleObserved: false })])
      )
    ).toBe(false);
  });

  it("withholds decisions for an Unavailable collection that states no reason", () => {
    expect(
      associatedPullRequestsWithholdDecisions(
        collection(State.Unavailable, [], [])
      )
    ).toBe(true);
  });

  it.each([
    [Reason.ConflictingDuplicate, true],
    [Reason.InvalidIdentity, true],
    [Reason.InvalidLifecycle, true],
    [Reason.InvalidTimestamp, true],
    [Reason.MissingTerminalTimestamp, true],
    [Reason.MultipleActive, false],
  ])(
    "maps reason %s over observed items to withholds=%s",
    (reason, expected) => {
      expect(
        associatedPullRequestsWithholdDecisions(
          collection(State.Incomplete, [reason], [item(), item({ number: 2 })])
        )
      ).toBe(expected);
    }
  );

  it("withholds when MultipleActive is paired with any withholding reason", () => {
    expect(
      associatedPullRequestsWithholdDecisions(
        collection(
          State.Incomplete,
          [Reason.MultipleActive, Reason.InvalidTimestamp],
          [item()]
        )
      )
    ).toBe(true);
  });

  it("withholds when MultipleActive covers an unobserved item", () => {
    expect(
      associatedPullRequestsWithholdDecisions(
        collection(
          State.Incomplete,
          [Reason.MultipleActive],
          [item(), item({ number: 2, lifecycleObserved: false })]
        )
      )
    ).toBe(true);
  });
});

describe("selectBranchAssociatedPullRequests identity and availability edges", () => {
  it("reports Unavailable and Ambiguous when every candidate is rejected", () => {
    const result = selectBranchAssociatedPullRequests(
      [
        candidate({ number: null }),
        candidate({ repositoryFullName: "no-slash" }),
        candidate({ number: 1.5 }),
      ],
      PROVENANCE
    );

    expect(result.selected).toBeNull();
    expect(result.collection).toEqual({
      items: [],
      selectedId: null,
      selectionReason: BranchAssociatedPullRequestSelectionReason.Ambiguous,
      completeness: {
        state: State.Unavailable,
        reasons: [Reason.InvalidIdentity],
        provenance: PROVENANCE,
      },
    });
  });

  it("stays Incomplete when some candidates survive a rejected sibling", () => {
    const result = selectBranchAssociatedPullRequests(
      [candidate({ number: 0 }), candidate({ number: 7 })],
      PROVENANCE
    );

    expect(result.collection.completeness.state).toBe(State.Incomplete);
    expect(result.collection.selectedId).toBeNull();
    expect(result.collection.selectionReason).toBe(
      BranchAssociatedPullRequestSelectionReason.Ambiguous
    );
    expect(result.collection.items.map(({ number }) => number)).toEqual([7]);
  });

  it("ranks a closed PR by closedAt against a merged PR's mergedAt", () => {
    const result = selectBranchAssociatedPullRequests(
      [
        candidate({
          number: 3,
          state: GitHubPRState.Closed,
          closedAt: "2026-08-05T00:00:00.000Z",
        }),
        candidate({
          number: 4,
          state: GitHubPRState.Closed,
          mergedAt: "2026-08-04T00:00:00.000Z",
        }),
      ],
      PROVENANCE
    );

    expect(result.collection.selectedId).toBe("closedloop-ai/symphony#3");
    expect(result.collection.items.map(({ state }) => state)).toEqual([
      GitHubPRState.Closed,
      GitHubPRState.Merged,
    ]);
    expect(result.collection.selectionReason).toBe(
      BranchAssociatedPullRequestSelectionReason.MostRecentTerminal
    );
  });
});

describe("compatible duplicate snapshots with no display metadata", () => {
  it("publishes null title, url, and review decision when no snapshot carries one", () => {
    const bare = {
      title: null,
      url: null,
      reviewDecision: null,
    } satisfies Partial<BranchAssociatedPullRequestCandidate>;
    const result = selectBranchAssociatedPullRequests(
      [
        candidate({ ...bare, observedAt: "2026-08-01T00:00:01.000Z" }),
        candidate({ ...bare, observedAt: "2026-08-01T00:00:02.000Z" }),
      ],
      PROVENANCE
    );

    expect(result.collection.items).toHaveLength(1);
    expect(result.collection.items[0]).toMatchObject(bare);
    expect(result.selected).toMatchObject({ ...bare, lifecycleObserved: true });
    expect(result.collection.completeness.state).toBe(State.Complete);
  });
});

const PAIR_MESSAGE =
  "repositoryFullName and pullRequestNumber must be provided together";
const TIED_OBSERVATION = "2026-08-01T00:00:01.000Z";

describe("branchSelectedPullRequestQuerySchema anchoring and issue shape", () => {
  it.each(["extra/closedloop-ai/symphony", "closedloop-ai/symphony/extra"])(
    "rejects a three-segment repository name %s",
    (repositoryFullName) => {
      expect(
        branchSelectedPullRequestQuerySchema.safeParse({
          repositoryFullName,
          pullRequestNumber: 1,
        }).success
      ).toBe(false);
    }
  );

  it("reports a half identity as one custom issue with the pairing message", () => {
    const result = branchSelectedPullRequestQuerySchema.safeParse({
      pullRequestNumber: 3,
    });
    expect(result.success).toBe(false);
    expect(
      result.error?.issues.map(({ code, message }) => ({ code, message }))
    ).toEqual([{ code: "custom", message: PAIR_MESSAGE }]);
  });
});

describe("selection-blocking reasons beside a sole active PR", () => {
  it("does not select the active PR when a sibling has an invalid lifecycle", () => {
    const result = selectBranchAssociatedPullRequests(
      [
        candidate({ number: 1 }),
        candidate({ number: 2, state: "BOGUS" as GitHubPRState }),
      ],
      PROVENANCE
    );
    expect(result.collection.selectedId).toBeNull();
    expect(result.collection.completeness.reasons).toEqual([
      Reason.InvalidLifecycle,
    ]);
    expect(result.collection.selectionReason).toBe(
      BranchAssociatedPullRequestSelectionReason.Ambiguous
    );
  });

  it("does not select the active PR when a sibling PR has conflicting duplicates", () => {
    const result = selectBranchAssociatedPullRequests(
      [
        candidate({ number: 1 }),
        candidate({
          number: 2,
          state: GitHubPRState.Closed,
          closedAt: "2026-08-02T00:00:00.000Z",
        }),
        candidate({
          number: 2,
          state: GitHubPRState.Closed,
          closedAt: "2026-08-03T00:00:00.000Z",
        }),
      ],
      PROVENANCE
    );
    expect(result.collection.selectedId).toBeNull();
    expect(result.collection.completeness.reasons).toEqual([
      Reason.ConflictingDuplicate,
    ]);
    expect(result.collection.items.map(({ number }) => number)).toEqual([1]);
  });

  it("still selects the active PR beside a non-blocking invalid timestamp", () => {
    const result = selectBranchAssociatedPullRequests(
      [candidate({ number: 1, openedAt: "not-a-date" })],
      PROVENANCE
    );
    expect(result.collection.selectedId).toBe("closedloop-ai/symphony#1");
    expect(result.collection.items[0]?.openedAt).toBeNull();
    expect(result.collection.completeness.reasons).toEqual([
      Reason.InvalidTimestamp,
    ]);
  });
});

describe("tied duplicate snapshots compare every lifecycle field", () => {
  it.each<[string, Partial<BranchAssociatedPullRequestCandidate>]>([
    ["isDraft", { isDraft: null }],
    ["openedAt", { openedAt: "2026-07-31T00:00:00.000Z" }],
    [
      "closedAt",
      {
        state: GitHubPRState.Closed,
        closedAt: "2026-08-09T00:00:00.000Z",
      },
    ],
    ["mergedAt", { mergedAt: "2026-08-09T00:00:00.000Z" }],
  ])("reports a conflict when only %s differs", (_field, difference) => {
    const base = {
      state: GitHubPRState.Closed,
      closedAt: "2026-08-02T00:00:00.000Z",
      observedAt: TIED_OBSERVATION,
    } satisfies Partial<BranchAssociatedPullRequestCandidate>;
    const result = selectBranchAssociatedPullRequests(
      [candidate(base), candidate({ ...base, ...difference })],
      PROVENANCE
    );
    expect(result.collection.items).toEqual([]);
    expect(result.collection.completeness.reasons).toContain(
      Reason.ConflictingDuplicate
    );
  });

  it("reports a conflict when the older snapshot has no observation time", () => {
    const result = selectBranchAssociatedPullRequests(
      [
        candidate({ observedAt: "2026-08-05T00:00:00.000Z" }),
        candidate({
          observedAt: null,
          state: GitHubPRState.Closed,
          closedAt: "2026-08-02T00:00:00.000Z",
        }),
      ],
      PROVENANCE
    );
    expect(result.collection.items).toEqual([]);
    expect(result.collection.completeness.reasons).toEqual([
      Reason.ConflictingDuplicate,
    ]);
  });

  it("lets the newer observation win when both snapshots are timestamped", () => {
    const result = selectBranchAssociatedPullRequests(
      [
        candidate({ observedAt: "2026-08-05T00:00:00.000Z" }),
        candidate({
          observedAt: "2026-08-04T00:00:00.000Z",
          state: GitHubPRState.Closed,
          closedAt: "2026-08-02T00:00:00.000Z",
        }),
      ],
      PROVENANCE
    );
    expect(result.collection.completeness.reasons).toEqual([]);
    expect(result.collection.items.map(({ state }) => state)).toEqual([
      GitHubPRState.Open,
    ]);
  });
});

describe("unobserved folding and reason ordering", () => {
  it("keeps an item unobserved when every duplicate snapshot is unobserved", () => {
    const result = selectBranchAssociatedPullRequests(
      [
        candidate({ lifecycleObserved: false, observedAt: TIED_OBSERVATION }),
        candidate({
          lifecycleObserved: false,
          observedAt: "2026-08-01T00:00:02.000Z",
        }),
      ],
      PROVENANCE
    );
    expect(result.collection.items[0]?.lifecycleObserved).toBe(false);
    expect(result.selected?.lifecycleObserved).toBe(false);
    expect(result.collection.selectionReason).toBe(
      BranchAssociatedPullRequestSelectionReason.Unobserved
    );
  });

  it("does not count a terminal sibling toward multiple unobserved open PRs", () => {
    const result = selectBranchAssociatedPullRequests(
      [
        candidate({ number: 1, lifecycleObserved: false }),
        candidate({
          number: 2,
          state: GitHubPRState.Closed,
          closedAt: "2026-08-02T00:00:00.000Z",
        }),
      ],
      PROVENANCE
    );
    expect(result.collection.completeness.reasons).toEqual([]);
    expect(result.collection.selectedId).toBe("closedloop-ai/symphony#2");
  });

  it("publishes reasons sorted, not in discovery order", () => {
    const result = selectBranchAssociatedPullRequests(
      [
        candidate({ number: 1, openedAt: "not-a-date" }),
        candidate({ number: null }),
      ],
      PROVENANCE
    );
    expect(result.collection.completeness.reasons).toEqual([
      Reason.InvalidIdentity,
      Reason.InvalidTimestamp,
    ]);
  });
});

describe("closed drafts and PR metrics (operator ruling 2026-10-14)", () => {
  const closedDraft = {
    state: GitHubPRState.Closed,
    isDraft: true,
    closedAt: "2026-08-02T00:00:00.000Z",
  };

  it.each([
    [closedDraft, true],
    [{ ...closedDraft, isDraft: false }, false],
    [{ ...closedDraft, state: GitHubPRState.Open, closedAt: null }, false],
    [
      {
        ...closedDraft,
        state: GitHubPRState.Merged,
        mergedAt: "2026-08-02T00:00:00.000Z",
      },
      false,
    ],
  ])("isClosedUnmergedDraft(%o) is %s", (overrides, expected) => {
    expect(isClosedUnmergedDraft(candidate(overrides))).toBe(expected);
  });

  it("leaves the selector reading a closed draft as an invalid lifecycle", () => {
    const result = selectBranchAssociatedPullRequests(
      [candidate(closedDraft)],
      PROVENANCE
    );
    expect(result.collection.completeness.reasons).toEqual([
      Reason.InvalidLifecycle,
    ]);
  });

  it("drops a closed draft from the metric collection, so it withholds no decision", () => {
    const metric = metricAssociatedPullRequestCollection(
      [
        candidate(closedDraft),
        candidate({
          number: 2,
          state: GitHubPRState.Merged,
          closedAt: "2026-08-03T00:00:00.000Z",
          mergedAt: "2026-08-03T00:00:00.000Z",
        }),
      ],
      PROVENANCE
    );
    expect(metric.completeness.state).toBe(State.Complete);
    expect(metric.items.map((pullRequest) => pullRequest.number)).toEqual([2]);
    expect(associatedPullRequestsWithholdDecisions(metric)).toBe(false);
  });

  it("still withholds decisions for a merged draft", () => {
    const metric = metricAssociatedPullRequestCollection(
      [
        candidate({
          isDraft: true,
          state: GitHubPRState.Merged,
          closedAt: "2026-08-03T00:00:00.000Z",
          mergedAt: "2026-08-03T00:00:00.000Z",
        }),
      ],
      PROVENANCE
    );
    expect(associatedPullRequestsWithholdDecisions(metric)).toBe(true);
  });
});

function collection(
  state: BranchAssociatedPullRequestCompletenessState,
  reasons: BranchAssociatedPullRequestCompletenessReason[],
  items: BranchAssociatedPullRequest[]
): BranchAssociatedPullRequestCollection {
  return {
    items,
    selectedId: null,
    selectionReason: BranchAssociatedPullRequestSelectionReason.None,
    completeness: { state, reasons, provenance: PROVENANCE },
  };
}

function item(
  overrides: Partial<BranchAssociatedPullRequest> = {}
): BranchAssociatedPullRequest {
  const number = overrides.number ?? 1;
  return {
    id: `closedloop-ai/symphony#${number}`,
    repositoryFullName: "closedloop-ai/symphony",
    number,
    title: "Pull request",
    url: null,
    state: GitHubPRState.Open,
    isDraft: false,
    reviewDecision: null,
    openedAt: "2026-08-01T00:00:00.000Z",
    closedAt: null,
    mergedAt: null,
    ...overrides,
  };
}

function candidate(
  overrides: Partial<BranchAssociatedPullRequestCandidate> = {}
): BranchAssociatedPullRequestCandidate {
  return {
    repositoryFullName: "ClosedLoop-AI/Symphony",
    number: 1,
    title: "Pull request",
    url: "https://github.com/closedloop-ai/symphony/pull/1",
    state: GitHubPRState.Open,
    isDraft: false,
    reviewDecision: ReviewDecision.Approved,
    openedAt: "2026-08-01T00:00:00.000Z",
    closedAt: null,
    mergedAt: null,
    observedAt: "2026-08-01T00:00:01.000Z",
    ...overrides,
  };
}
