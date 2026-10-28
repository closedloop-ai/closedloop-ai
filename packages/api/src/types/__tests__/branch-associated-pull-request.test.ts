import { describe, expect, it } from "vitest";
import {
  type BranchAssociatedPullRequestCandidate,
  BranchAssociatedPullRequestCompletenessReason,
  BranchAssociatedPullRequestCompletenessState,
  BranchAssociatedPullRequestProvenance,
  BranchAssociatedPullRequestSelectionReason,
  branchSelectedPullRequestQuerySchema,
  selectBranchAssociatedPullRequests,
} from "../branch-associated-pull-request.js";
import { ReviewDecision } from "../branch-checks.js";
import { GitHubPRState } from "../github-status.js";

const PROVENANCE = BranchAssociatedPullRequestProvenance.PersistedCloud;

describe("branchSelectedPullRequestQuerySchema", () => {
  it("preserves omission and canonicalizes a complete identity", () => {
    expect(branchSelectedPullRequestQuerySchema.parse({})).toEqual({});
    expect(
      branchSelectedPullRequestQuerySchema.parse({
        repositoryFullName: " /ClosedLoop-AI/Symphony.git/ ",
        pullRequestNumber: "42",
      })
    ).toEqual({
      repositoryFullName: "closedloop-ai/symphony",
      pullRequestNumber: 42,
    });
  });

  it.each([
    { repositoryFullName: "closedloop-ai/symphony" },
    { pullRequestNumber: 42 },
    { repositoryFullName: "closedloop-ai/symphony", pullRequestNumber: 0 },
    { repositoryFullName: "closedloop-ai", pullRequestNumber: 42 },
  ])("rejects malformed or half identities: %o", (query) => {
    expect(branchSelectedPullRequestQuerySchema.safeParse(query).success).toBe(
      false
    );
  });
});

describe("selectBranchAssociatedPullRequests", () => {
  it("distinguishes a trustworthy complete-empty population from unavailable evidence", () => {
    const result = selectBranchAssociatedPullRequests([], PROVENANCE);

    expect(result.collection).toEqual({
      items: [],
      selectedId: null,
      selectionReason: BranchAssociatedPullRequestSelectionReason.None,
      completeness: {
        state: BranchAssociatedPullRequestCompletenessState.Complete,
        reasons: [],
        provenance: PROVENANCE,
      },
    });
  });

  it("selects the sole active draft while retaining sorted history", () => {
    const result = selectBranchAssociatedPullRequests(
      [
        candidate({
          number: 12,
          state: GitHubPRState.Open,
          isDraft: true,
          observedAt: "2026-08-03T12:00:00.000Z",
        }),
        candidate({
          number: 10,
          state: GitHubPRState.Closed,
          closedAt: "2026-08-02T12:00:00.000Z",
        }),
      ],
      PROVENANCE
    );

    expect(result.collection.items.map(({ number }) => number)).toEqual([
      10, 12,
    ]);
    expect(result.collection.selectedId).toBe("closedloop-ai/symphony#12");
    expect(result.collection.selectionReason).toBe(
      BranchAssociatedPullRequestSelectionReason.Active
    );
    expect(result.selected?.isDraft).toBe(true);
  });

  it("selects the newest terminal timestamp and uses canonical identity to break ties", () => {
    const result = selectBranchAssociatedPullRequests(
      [
        candidate({
          repositoryFullName: "zeta/repo",
          number: 1,
          state: GitHubPRState.Merged,
          mergedAt: "2026-08-02T12:00:00.000Z",
        }),
        candidate({
          repositoryFullName: "alpha/repo",
          number: 99,
          state: GitHubPRState.Closed,
          closedAt: "2026-08-02T12:00:00.000Z",
        }),
        candidate({
          repositoryFullName: "alpha/repo",
          number: 2,
          state: GitHubPRState.Closed,
          closedAt: "2026-08-01T12:00:00.000Z",
        }),
      ],
      PROVENANCE
    );

    expect(result.collection.selectedId).toBe("alpha/repo#99");
    expect(result.collection.selectionReason).toBe(
      BranchAssociatedPullRequestSelectionReason.MostRecentTerminal
    );
  });

  it("does not invent a selector rule when more than one PR is active", () => {
    const result = selectBranchAssociatedPullRequests(
      [candidate({ number: 3 }), candidate({ number: 4, isDraft: true })],
      PROVENANCE
    );

    expect(result.collection.selectedId).toBeNull();
    expect(result.collection.selectionReason).toBe(
      BranchAssociatedPullRequestSelectionReason.Ambiguous
    );
    expect(result.collection.completeness).toMatchObject({
      state: BranchAssociatedPullRequestCompletenessState.Incomplete,
      reasons: [BranchAssociatedPullRequestCompletenessReason.MultipleActive],
    });
  });

  it("uses the latest trustworthy observation for a same-PR reopen cycle", () => {
    const result = selectBranchAssociatedPullRequests(
      [
        candidate({
          number: 7,
          state: GitHubPRState.Closed,
          closedAt: "2026-08-01T10:00:00.000Z",
          observedAt: "2026-08-01T10:01:00.000Z",
        }),
        candidate({
          number: 7,
          state: GitHubPRState.Open,
          closedAt: "2026-08-01T10:00:00.000Z",
          observedAt: "2026-08-02T10:00:00.000Z",
        }),
      ],
      PROVENANCE
    );

    expect(result.collection.items).toHaveLength(1);
    expect(result.collection.items[0]?.state).toBe(GitHubPRState.Open);
    expect(result.collection.selectionReason).toBe(
      BranchAssociatedPullRequestSelectionReason.Active
    );
  });

  it("marks equal-observation conflicting duplicate rows incomplete", () => {
    const observedAt = "2026-08-02T10:00:00.000Z";
    const result = selectBranchAssociatedPullRequests(
      [
        candidate({ number: 8, observedAt }),
        candidate({
          number: 8,
          state: GitHubPRState.Closed,
          closedAt: observedAt,
          observedAt,
        }),
      ],
      PROVENANCE
    );

    expect(result.collection.items).toEqual([]);
    expect(result.collection.completeness.state).toBe(
      BranchAssociatedPullRequestCompletenessState.Unavailable
    );
    expect(result.collection.completeness.reasons).toContain(
      BranchAssociatedPullRequestCompletenessReason.ConflictingDuplicate
    );
  });

  it("detects a conflicting third snapshot at the authoritative observation", () => {
    const observedAt = "2026-08-02T10:00:00.000Z";
    const open = candidate({ number: 8, observedAt });
    const result = selectBranchAssociatedPullRequests(
      [
        open,
        { ...open },
        candidate({
          number: 8,
          state: GitHubPRState.Closed,
          closedAt: observedAt,
          observedAt,
        }),
      ],
      PROVENANCE
    );

    expect(result.collection.items).toEqual([]);
    expect(result.collection.completeness.reasons).toContain(
      BranchAssociatedPullRequestCompletenessReason.ConflictingDuplicate
    );
  });

  it("coalesces complementary display metadata for compatible unranked snapshots", () => {
    const result = selectBranchAssociatedPullRequests(
      [
        candidate({
          number: 8,
          title: "Canonical title",
          url: null,
          observedAt: null,
        }),
        candidate({
          number: 8,
          title: null,
          url: "https://github.com/closedloop-ai/symphony/pull/8",
          reviewDecision: ReviewDecision.Approved,
          observedAt: null,
        }),
      ],
      PROVENANCE
    );

    expect(result.collection.items).toEqual([
      expect.objectContaining({
        title: "Canonical title",
        url: "https://github.com/closedloop-ai/symphony/pull/8",
        reviewDecision: ReviewDecision.Approved,
      }),
    ]);
    expect(result.selected).toMatchObject({
      title: "Canonical title",
      url: "https://github.com/closedloop-ai/symphony/pull/8",
      reviewDecision: ReviewDecision.Approved,
    });
    expect(result.collection.completeness.state).toBe(
      BranchAssociatedPullRequestCompletenessState.Complete
    );
  });

  it("keeps repository collisions distinct and normalizes canonical identity", () => {
    const result = selectBranchAssociatedPullRequests(
      [
        candidate({ repositoryFullName: "/Other/Repo.git/", number: 5 }),
        candidate({ repositoryFullName: "ClosedLoop-AI/Symphony", number: 5 }),
      ],
      PROVENANCE
    );

    expect(result.collection.items.map(({ id }) => id)).toEqual([
      "closedloop-ai/symphony#5",
      "other/repo#5",
    ]);
  });

  it("uses locale-independent code-unit ordering for canonical identities", () => {
    const result = selectBranchAssociatedPullRequests(
      [
        candidate({ repositoryFullName: "a_/repo", number: 5 }),
        candidate({ repositoryFullName: "a-/repo", number: 5 }),
      ],
      PROVENANCE
    );

    expect(result.collection.items.map(({ id }) => id)).toEqual([
      "a-/repo#5",
      "a_/repo#5",
    ]);
  });

  it("does not select historical evidence without its trustworthy terminal timestamp", () => {
    const result = selectBranchAssociatedPullRequests(
      [candidate({ state: GitHubPRState.Closed, closedAt: null })],
      PROVENANCE
    );

    expect(result.collection.selectedId).toBeNull();
    expect(result.collection.completeness).toMatchObject({
      state: BranchAssociatedPullRequestCompletenessState.Incomplete,
      reasons: [
        BranchAssociatedPullRequestCompletenessReason.MissingTerminalTimestamp,
      ],
    });
  });

  it("does not rank terminal history when any terminal timestamp is missing", () => {
    const result = selectBranchAssociatedPullRequests(
      [
        candidate({
          number: 1,
          state: GitHubPRState.Closed,
          closedAt: "2026-08-01T00:00:00.000Z",
        }),
        candidate({
          number: 2,
          state: GitHubPRState.Closed,
          closedAt: null,
        }),
      ],
      PROVENANCE
    );

    expect(result.collection.selectedId).toBeNull();
    expect(result.collection.selectionReason).toBe(
      BranchAssociatedPullRequestSelectionReason.Ambiguous
    );
  });

  it("keeps an active selection when only historical timestamp evidence is incomplete", () => {
    const result = selectBranchAssociatedPullRequests(
      [
        candidate({ number: 1 }),
        candidate({
          number: 2,
          state: GitHubPRState.Closed,
          closedAt: null,
        }),
      ],
      PROVENANCE
    );

    expect(result.collection.selectedId).toBe("closedloop-ai/symphony#1");
    expect(result.collection.completeness.state).toBe(
      BranchAssociatedPullRequestCompletenessState.Incomplete
    );
  });

  it("rejects parseable timestamps that are not canonical ISO instants", () => {
    for (const closedAt of ["0", "2026-02-30T00:00:00.000Z"]) {
      const result = selectBranchAssociatedPullRequests(
        [candidate({ state: GitHubPRState.Closed, closedAt })],
        PROVENANCE
      );

      expect(result.collection.selectedId).toBeNull();
      expect(result.collection.completeness.reasons).toEqual([
        BranchAssociatedPullRequestCompletenessReason.InvalidTimestamp,
        BranchAssociatedPullRequestCompletenessReason.MissingTerminalTimestamp,
      ]);
    }
  });

  it("fails closed for missing identity, unknown lifecycle, and draft terminal evidence", () => {
    const missingIdentity = selectBranchAssociatedPullRequests(
      [candidate({ repositoryFullName: null })],
      PROVENANCE
    );
    const unknownLifecycle = selectBranchAssociatedPullRequests(
      [candidate({ state: "UNKNOWN" as GitHubPRState })],
      PROVENANCE
    );
    const draftTerminal = selectBranchAssociatedPullRequests(
      [
        candidate({
          state: GitHubPRState.Closed,
          isDraft: true,
          closedAt: "2026-08-01T00:00:00.000Z",
        }),
      ],
      PROVENANCE
    );
    const draftWithMergeEvidence = selectBranchAssociatedPullRequests(
      [
        candidate({
          isDraft: true,
          mergedAt: "2026-08-01T00:00:00.000Z",
        }),
      ],
      PROVENANCE
    );

    expect(missingIdentity.collection.completeness.reasons).toContain(
      BranchAssociatedPullRequestCompletenessReason.InvalidIdentity
    );
    expect(unknownLifecycle.collection.completeness.reasons).toContain(
      BranchAssociatedPullRequestCompletenessReason.InvalidLifecycle
    );
    expect(draftTerminal.collection.completeness.reasons).toContain(
      BranchAssociatedPullRequestCompletenessReason.InvalidLifecycle
    );
    expect(draftWithMergeEvidence.collection.completeness.reasons).toContain(
      BranchAssociatedPullRequestCompletenessReason.InvalidLifecycle
    );
  });

  it("reports malformed persisted timestamps without dropping a valid active identity", () => {
    const result = selectBranchAssociatedPullRequests(
      [candidate({ openedAt: "not-a-timestamp" })],
      PROVENANCE
    );

    expect(result.collection.selectedId).toBe("closedloop-ai/symphony#1");
    expect(result.collection.completeness.reasons).toContain(
      BranchAssociatedPullRequestCompletenessReason.InvalidTimestamp
    );
  });
});

describe("unobserved pull requests (ISS-8422)", () => {
  it("never lets an unwitnessed PR outrank a merged sibling", () => {
    const result = selectBranchAssociatedPullRequests(
      [
        candidate({ number: 7, lifecycleObserved: false }),
        candidate({
          number: 4,
          state: GitHubPRState.Merged,
          mergedAt: "2026-08-02T00:00:00.000Z",
        }),
      ],
      PROVENANCE
    );

    expect(result.collection.selectedId).toBe("closedloop-ai/symphony#4");
    expect(result.collection.selectionReason).toBe(
      BranchAssociatedPullRequestSelectionReason.MostRecentTerminal
    );
  });

  it("still selects an unwitnessed PR when it is the only one, so the row keeps its link", () => {
    const result = selectBranchAssociatedPullRequests(
      [candidate({ number: 7, lifecycleObserved: false })],
      PROVENANCE
    );

    expect(result.collection.selectedId).toBe("closedloop-ai/symphony#7");
    expect(result.collection.selectionReason).toBe(
      BranchAssociatedPullRequestSelectionReason.Unobserved
    );
    // The point of selecting it: the row still has a PR number and a link to
    // open, rather than reading as a branch with no pull request at all.
    expect(result.selected?.number).toBe(7);
    expect(result.collection.items[0]?.url).not.toBeNull();
  });

  it("keeps an unwitnessed PR out of the completeness reasons, so downstream coverage stays Complete", () => {
    const result = selectBranchAssociatedPullRequests(
      [candidate({ number: 7, lifecycleObserved: false })],
      PROVENANCE
    );

    // An unwitnessed PR is a normal transient state, not degraded evidence.
    // Reporting it as Incomplete flips `pullRequestCoverageComplete` false for
    // a whole cohort and downgrades the org-wide merge rate; the selection
    // reason is where this is said instead.
    expect(result.collection.completeness).toEqual({
      state: BranchAssociatedPullRequestCompletenessState.Complete,
      reasons: [],
      provenance: PROVENANCE,
    });
  });

  it("flags two unwitnessed open PRs as ambiguous instead of picking one", () => {
    const result = selectBranchAssociatedPullRequests(
      [
        candidate({ number: 7, lifecycleObserved: false }),
        candidate({ number: 9, lifecycleObserved: false }),
      ],
      PROVENANCE
    );

    expect(result.collection.selectedId).toBeNull();
    expect(result.collection.completeness.reasons).toContain(
      BranchAssociatedPullRequestCompletenessReason.MultipleActive
    );
  });

  it("treats a candidate that never declares observation as observed", () => {
    const result = selectBranchAssociatedPullRequests(
      [
        candidate({ number: 7, openedAt: null }),
        candidate({
          number: 4,
          state: GitHubPRState.Merged,
          mergedAt: "2026-08-02T00:00:00.000Z",
        }),
      ],
      PROVENANCE
    );

    // Desktop builds its cloud-overlay candidate with `openedAt: null` and
    // passes PersistedCloud, so inferring non-observation from the shape (or
    // from the provenance token) mislabels a genuinely observed PR.
    expect(result.collection.selectedId).toBe("closedloop-ai/symphony#7");
    expect(result.collection.selectionReason).toBe(
      BranchAssociatedPullRequestSelectionReason.Active
    );
  });

  it("lets an unwitnessed PR through without blocking a second active selection", () => {
    const result = selectBranchAssociatedPullRequests(
      [
        candidate({ number: 7, lifecycleObserved: false }),
        candidate({ number: 4 }),
      ],
      PROVENANCE
    );

    // One OBSERVED active PR, so this is a clean selection and not MultipleActive.
    expect(result.collection.selectedId).toBe("closedloop-ai/symphony#4");
    expect(result.collection.completeness.reasons).not.toContain(
      BranchAssociatedPullRequestCompletenessReason.MultipleActive
    );
  });

  it("marks the unwitnessed ITEM on the wire and omits the field from the rest", () => {
    const result = selectBranchAssociatedPullRequests(
      [
        candidate({ number: 7, lifecycleObserved: false }),
        candidate({
          number: 4,
          state: GitHubPRState.Merged,
          mergedAt: "2026-08-02T00:00:00.000Z",
        }),
      ],
      PROVENANCE
    );

    const items = new Map(
      result.collection.items.map((item) => [item.number, item])
    );
    // #7 still reports `state: OPEN` — that column default is exactly what the
    // detail selector was believing — so the flag has to be what disowns it.
    expect(items.get(7)?.state).toBe(GitHubPRState.Open);
    expect(items.get(7)?.lifecycleObserved).toBe(false);
    // Omitted, not `true`: every payload written before this field existed is
    // unchanged, and an old client reading one sees no new key.
    expect(items.get(4)).not.toHaveProperty("lifecycleObserved");
  });

  it("publishes the RESOLVED observation on the item, not the newest snapshot's", () => {
    const result = selectBranchAssociatedPullRequests(
      [
        candidate({
          number: 7,
          title: "Observed once",
          observedAt: "2026-08-01T00:00:00.000Z",
        }),
        candidate({
          number: 7,
          title: null,
          lifecycleObserved: false,
          observedAt: "2026-08-03T00:00:00.000Z",
        }),
      ],
      PROVENANCE
    );

    // One PR, two snapshots, the newest of them factless. Publishing the newest
    // snapshot's answer would label a PR unconfirmed on the detail panel while
    // selection had already used the merged verdict and called it observed.
    expect(result.collection.items).toHaveLength(1);
    expect(result.collection.items[0]).not.toHaveProperty("lifecycleObserved");
  });
});

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
