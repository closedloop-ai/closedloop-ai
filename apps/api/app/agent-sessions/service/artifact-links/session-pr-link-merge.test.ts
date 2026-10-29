/**
 * ISS-9859: the evidence-tier table for the cross-page PR-identity fold.
 *
 * `mergePersistedSessionPrRefs` has no dedicated suite of its own, so this file
 * pins the whole table rather than only the arm ISS-9859 adds — the `method`
 * precedence it already gets right is as load-bearing as the `relationTypes`
 * rule layered on top, and a regression in either is silent.
 *
 * Both arrival orders are asserted for every mixed-tier case. The rule is stated
 * per-identity precisely so it cannot depend on which part landed first, and an
 * implementation that special-cased one direction would pass half of these.
 */
import { MAX_SESSION_SYNC_CHUNKS } from "@repo/api/src/types/agent-session";
import {
  ArtifactRefMethod,
  ArtifactRefRelation,
  ArtifactRefTargetKind,
  type PersistedSessionPrRef,
  SessionPrRelationType,
  sessionPrIdentityKey,
} from "@repo/api/src/types/session-artifact-link";
import { describe, expect, it } from "vitest";
import type { BranchRefAggregate } from "./branch-ref-aggregate";
import { branchAggregateFromPrRef } from "./pull-request-branch-association";
import {
  foldBranchAssociationIntoBranchRef,
  isPaginatedPrListPageZero,
  isPrRefContinuationPart,
  mergeSessionPrRefsAcrossPages,
  type PrRefByBranch,
  persistedPrRefs,
  relationTypesFromPrRefs,
} from "./session-pr-link-merge";

const REPO = "acme/web";

function strongRef(
  prNumber: number,
  relationTypes: PersistedSessionPrRef["relationTypes"]
): PersistedSessionPrRef {
  return { repositoryFullName: REPO, prNumber, relationTypes };
}

function proseRef(
  prNumber: number,
  relationTypes: PersistedSessionPrRef["relationTypes"] = [
    SessionPrRelationType.Referenced,
  ]
): PersistedSessionPrRef {
  return {
    repositoryFullName: REPO,
    prNumber,
    relationTypes,
    method: ArtifactRefMethod.PrMentionInProse,
  };
}

describe("mergeSessionPrRefsAcrossPages evidence tiers", () => {
  it("unions relationTypes when both contributors are command-derived", () => {
    const merged = mergeSessionPrRefsAcrossPages(
      [strongRef(42, [SessionPrRelationType.Created])],
      [strongRef(42, [SessionPrRelationType.Reviewed])]
    );

    expect(merged).toEqual([
      strongRef(42, [
        SessionPrRelationType.Created,
        SessionPrRelationType.Reviewed,
      ]),
    ]);
  });

  it("drops a prose contribution when a strong ref claims the identity, stored-prose-first", () => {
    // Page 0 minted the prose twin because the command-derived ref shipped on a
    // later part. Whole delivery never emits that `REFERENCED`, so neither may
    // the paginated one.
    const merged = mergeSessionPrRefsAcrossPages(
      [proseRef(42)],
      [strongRef(42, [SessionPrRelationType.Created])]
    );

    expect(merged).toEqual([strongRef(42, [SessionPrRelationType.Created])]);
    expect(merged[0]).not.toHaveProperty("method");
  });

  it("drops a prose contribution when a strong ref claims the identity, stored-strong-first", () => {
    // The dominant direction: `artifactRefs` ride every part whole, so the LATER
    // part carries the prose twin for a PR the earlier part already claimed.
    const merged = mergeSessionPrRefsAcrossPages(
      [strongRef(42, [SessionPrRelationType.Created])],
      [proseRef(42)]
    );

    expect(merged).toEqual([strongRef(42, [SessionPrRelationType.Created])]);
    expect(merged[0]).not.toHaveProperty("method");
  });

  it("keeps prose evidence when NO strong ref claims the identity", () => {
    const merged = mergeSessionPrRefsAcrossPages(
      [proseRef(7)],
      [proseRef(7, [SessionPrRelationType.Referenced])]
    );

    expect(merged).toEqual([proseRef(7)]);
  });

  it("resolves each identity independently within one fold", () => {
    const merged = mergeSessionPrRefsAcrossPages(
      [strongRef(1, [SessionPrRelationType.Created]), proseRef(2)],
      [proseRef(1), strongRef(3, [SessionPrRelationType.Reviewed])]
    );

    expect(merged).toEqual([
      strongRef(1, [SessionPrRelationType.Created]),
      proseRef(2),
      strongRef(3, [SessionPrRelationType.Reviewed]),
    ]);
  });

  it("keys identities canonically, so repository spelling does not split one PR", () => {
    const merged = mergeSessionPrRefsAcrossPages(
      [
        {
          repositoryFullName: "Acme/Web",
          prNumber: 42,
          relationTypes: [SessionPrRelationType.Created],
        },
      ],
      [strongRef(42, [SessionPrRelationType.Reviewed])]
    );

    expect(merged).toHaveLength(1);
    expect(merged[0]?.relationTypes).toEqual([
      SessionPrRelationType.Created,
      SessionPrRelationType.Reviewed,
    ]);
  });

  it("tolerates absent groups", () => {
    expect(
      mergeSessionPrRefsAcrossPages(undefined, [
        strongRef(5, [SessionPrRelationType.Created]),
      ])
    ).toEqual([strongRef(5, [SessionPrRelationType.Created])]);
    expect(mergeSessionPrRefsAcrossPages(undefined, undefined)).toEqual([]);
  });
});

describe("relationTypesFromPrRefs", () => {
  it("derives the link-level set from the folded refs, sorted and deduped", () => {
    expect(
      relationTypesFromPrRefs([
        strongRef(1, [
          SessionPrRelationType.Reviewed,
          SessionPrRelationType.Created,
        ]),
        strongRef(2, [SessionPrRelationType.Created]),
      ])
    ).toEqual([SessionPrRelationType.Created, SessionPrRelationType.Reviewed]);
  });

  it("withholds a relation that only a dropped prose twin carried", () => {
    // The end-to-end point of the fold: deriving the link-level field from the
    // FOLDED refs is what keeps the prose `REFERENCED` off the link. Deriving it
    // from the stored column instead would re-import exactly this.
    const folded = mergeSessionPrRefsAcrossPages(
      [proseRef(42)],
      [strongRef(42, [SessionPrRelationType.Created])]
    );

    expect(relationTypesFromPrRefs(folded)).toEqual([
      SessionPrRelationType.Created,
    ]);
  });
});

describe("isPrRefContinuationPart", () => {
  it.each([
    { label: "a marked non-first part", chunk: { index: 1, total: 3 } },
    {
      label: "the last part of a longest-allowed sequence",
      chunk: {
        index: MAX_SESSION_SYNC_CHUNKS - 1,
        total: MAX_SESSION_SYNC_CHUNKS,
      },
    },
  ])("is true for $label", ({ chunk }) => {
    expect(isPrRefContinuationPart({ prRefsPaginated: true, chunk })).toBe(
      true
    );
  });

  // Each of these is a marked part whose chunk position no real sequence has.
  // All fall back to Replace, which retracts, so none can accumulate links.
  it.each([
    { label: "chunk 0", chunk: { index: 0, total: 3 } },
    {
      label: "a total past the chunk ceiling",
      chunk: { index: 1, total: MAX_SESSION_SYNC_CHUNKS + 1 },
    },
    { label: "an index equal to its total", chunk: { index: 3, total: 3 } },
    { label: "an index past its total", chunk: { index: 4, total: 3 } },
    { label: "a fractional index", chunk: { index: 1.5, total: 3 } },
    { label: "a fractional total", chunk: { index: 1, total: 2.5 } },
  ])("is false for a marked part with $label", ({ chunk }) => {
    expect(isPrRefContinuationPart({ prRefsPaginated: true, chunk })).toBe(
      false
    );
  });

  it("is false for any part not marked true, page 0 included", () => {
    const chunk = { index: 1, total: 3 };
    expect(isPrRefContinuationPart({ chunk })).toBe(false);
    expect(isPrRefContinuationPart({ prRefsPaginated: false, chunk })).toBe(
      false
    );
    expect(isPrRefContinuationPart({ prRefsPaginated: null, chunk })).toBe(
      false
    );
  });

  it("is false for a marked payload with no chunk", () => {
    expect(isPrRefContinuationPart({ prRefsPaginated: true })).toBe(false);
    expect(
      isPrRefContinuationPart({ prRefsPaginated: true, chunk: null })
    ).toBe(false);
  });
});

describe("isPaginatedPrListPageZero", () => {
  it.each([
    { label: "chunk 0, which page 0 may be", chunk: { index: 0, total: 3 } },
    { label: "a later chunk", chunk: { index: 2, total: 3 } },
    {
      label: "the last part of a longest-allowed sequence",
      chunk: {
        index: MAX_SESSION_SYNC_CHUNKS - 1,
        total: MAX_SESSION_SYNC_CHUNKS,
      },
    },
  ])("is true for an explicit false marker on $label", ({ chunk }) => {
    expect(isPaginatedPrListPageZero({ prRefsPaginated: false, chunk })).toBe(
      true
    );
  });

  // A page-0 marker on a position no real sequence has is handled as a plain
  // whole-set payload, so the ISS-4946 tie rule decides it.
  it.each([
    {
      label: "a total past the chunk ceiling",
      chunk: { index: 1, total: MAX_SESSION_SYNC_CHUNKS + 1 },
    },
    { label: "an index equal to its total", chunk: { index: 3, total: 3 } },
    { label: "a fractional index", chunk: { index: 0.5, total: 3 } },
    { label: "a fractional total", chunk: { index: 0, total: 2.5 } },
    { label: "a negative index", chunk: { index: -1, total: 3 } },
  ])("is false for an explicit false marker on $label", ({ chunk }) => {
    expect(isPaginatedPrListPageZero({ prRefsPaginated: false, chunk })).toBe(
      false
    );
  });

  it("is false without the explicit false marker", () => {
    const chunk = { index: 1, total: 3 };
    expect(isPaginatedPrListPageZero({ chunk })).toBe(false);
    expect(isPaginatedPrListPageZero({ prRefsPaginated: null, chunk })).toBe(
      false
    );
    expect(isPaginatedPrListPageZero({ prRefsPaginated: true, chunk })).toBe(
      false
    );
  });

  it("is false for an unchunked payload carrying the marker", () => {
    expect(isPaginatedPrListPageZero({ prRefsPaginated: false })).toBe(false);
    expect(
      isPaginatedPrListPageZero({ prRefsPaginated: false, chunk: null })
    ).toBe(false);
  });
});

describe("foldBranchAssociationIntoBranchRef", () => {
  it("lets the association's strong ref drop a prose twin's REFERENCED", () => {
    // Page 0 of a sequence whose strong ref for PR 42 rides a later page: this
    // part holds only the prose twin, and the PR-head association claims 42.
    const ref = branchRefWith(
      [proseRef(42)],
      pullRequestHeadAssociation(42, ArtifactRefRelation.Created)
    );

    foldBranchAssociationIntoBranchRef(ref);

    expect(persistedPrRefs(ref)).toEqual([
      strongRef(42, [SessionPrRelationType.Created]),
    ]);
    expect([...ref.relationTypes]).toEqual([SessionPrRelationType.Created]);
  });

  it("unions the association with a strong ref for the same identity", () => {
    const ref = branchRefWith(
      [strongRef(42, [SessionPrRelationType.Created])],
      pullRequestHeadAssociation(42, ArtifactRefRelation.Reviewed)
    );

    foldBranchAssociationIntoBranchRef(ref);

    expect(persistedPrRefs(ref)).toEqual([
      strongRef(42, [
        SessionPrRelationType.Created,
        SessionPrRelationType.Reviewed,
      ]),
    ]);
  });

  it("leaves the refs alone for an association the branch-link writer ignores", () => {
    // `hasPullRequestHeadPrIdentity` is false without an observed PR, and the
    // writer then merges none of the association's refs, so neither may this.
    const ref = branchRefWith([proseRef(42)], {
      ...pullRequestHeadAssociation(42, ArtifactRefRelation.Created),
      pullRequestObserved: false,
    });

    foldBranchAssociationIntoBranchRef(ref);

    expect(persistedPrRefs(ref)).toEqual([proseRef(42)]);
  });

  it("is a no-op when the branch has no association", () => {
    const ref = branchRefWith([proseRef(42)]);

    foldBranchAssociationIntoBranchRef(ref);

    expect(persistedPrRefs(ref)).toEqual([proseRef(42)]);
  });
});

function branchRefWith(
  refs: PersistedSessionPrRef[],
  branchAssociation?: BranchRefAggregate
): PrRefByBranch {
  return {
    relationTypes: new Set(refs.flatMap((ref) => ref.relationTypes)),
    refs: new Map(
      refs.map((ref) => [
        sessionPrIdentityKey(ref.repositoryFullName, ref.prNumber),
        {
          relationTypes: new Set(ref.relationTypes),
          repositoryFullName: ref.repositoryFullName,
          prNumber: ref.prNumber,
          ...(ref.method ? { method: ref.method } : {}),
        },
      ])
    ),
    branchLifecycleEvents: [],
    ...(branchAssociation ? { branchAssociation } : {}),
  };
}

/** Built by the production builder, so its refs have the shape the writer sees. */
function pullRequestHeadAssociation(
  prNumber: number,
  relation: ArtifactRefRelation
): BranchRefAggregate {
  return branchAggregateFromPrRef(
    {
      kind: ArtifactRefTargetKind.PullRequest,
      repositoryFullName: REPO,
      prNumber,
      branchName: "feat/x",
      method: ArtifactRefMethod.PrCreateOutput,
      relation,
      observedAt: "2026-05-20T17:01:00.000Z",
    },
    REPO
  );
}
