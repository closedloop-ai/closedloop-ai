import { describe, expect, it } from "vitest";
import {
  ArtifactRefMethod,
  commandDerivedSessionPrRefsFromMetadata,
  isProseDerivedSessionPrLink,
  isProseDerivedSessionPrRef,
  SessionArtifactLinkKind,
  SessionPrRelationType,
} from "../session-artifact-link";

/**
 * ISS-5823 (review cid 3839614162) — the per-ref prose discriminators, which
 * every metric- and cost-bearing reader and the GitHub-write authorization probe
 * now gate on, and which had no unit test of their own.
 *
 * The invariant most worth pinning is the one that is easiest to "clean up"
 * later and hardest to notice breaking: an ABSENT `method` is command-derived,
 * not unknown. Every row written before this ticket omits the field, so reading
 * absence as weak would retroactively evict the entire historical corpus from
 * the populations these functions gate — a silent, total regression that no
 * fixture carrying an explicit method would catch.
 *
 * Assertions are on the discriminators directly rather than through a reader,
 * because a reader can agree with a broken discriminator by accident (its own
 * link-level predicate already excluded the row) and the case would never fail.
 */

const REPO = "closedloop-ai/closedloop-ai";

function ref(prNumber: number, method?: string) {
  return {
    repositoryFullName: REPO,
    prNumber,
    relationTypes: [SessionPrRelationType.Referenced],
    ...(method === undefined ? {} : { method }),
  };
}

function canonicalMetadata(refs: ReturnType<typeof ref>[]) {
  return {
    linkKind: SessionArtifactLinkKind.SessionPr,
    linkKinds: [SessionArtifactLinkKind.SessionPr],
    relationTypes: [SessionPrRelationType.Referenced],
    prRefs: refs,
  };
}

describe("isProseDerivedSessionPrRef", () => {
  it.each([
    ArtifactRefMethod.PrMentionInProse,
    ArtifactRefMethod.BranchMentionInProse,
  ])("treats %s as prose-derived", (method) => {
    expect(isProseDerivedSessionPrRef({ method })).toBe(true);
  });

  it("treats an ABSENT method as command-derived, not unknown", () => {
    // The backward-compatibility invariant. Every pre-ISS-5823 row omits
    // `method` and came from the command-derived carrier, so absence is a
    // positive statement, not missing information. Flipping this to "absent means
    // weak" evicts the whole historical corpus from every metric this gates.
    expect(isProseDerivedSessionPrRef({})).toBe(false);
    expect(isProseDerivedSessionPrRef({ method: undefined })).toBe(false);
  });

  it("treats an unrecognized method as command-derived", () => {
    // A method this build does not know is NOT prose. Only the two enumerated
    // prose methods are weak; defaulting an unknown string to weak would let a
    // newer producer's method silently drop PRs out of the metrics.
    expect(isProseDerivedSessionPrRef({ method: "git_log" })).toBe(false);
    expect(isProseDerivedSessionPrRef({ method: "some_future_method" })).toBe(
      false
    );
  });
});

describe("commandDerivedSessionPrRefsFromMetadata", () => {
  it("keeps only the command-derived refs on a MIXED link", () => {
    // The case the link-level predicate provably cannot decide: a link carrying
    // one prose ref and one command-derived ref keeps the strong `linkKind`, so
    // the per-ref discriminator is the only thing that separates them.
    const metadata = canonicalMetadata([
      ref(10, ArtifactRefMethod.PrMentionInProse),
      ref(11),
    ]);

    expect(commandDerivedSessionPrRefsFromMetadata(metadata)).toEqual([
      expect.objectContaining({ prNumber: 11 }),
    ]);
  });

  it("returns nothing for a prose-only link", () => {
    const metadata = canonicalMetadata([
      ref(10, ArtifactRefMethod.PrMentionInProse),
    ]);

    expect(commandDerivedSessionPrRefsFromMetadata(metadata)).toEqual([]);
  });

  it("returns every ref when none carries a method", () => {
    // Anti-vacuity for the two cases above: a filter that returned nothing
    // unconditionally would pass both. This is also the legacy corpus shape.
    expect(
      commandDerivedSessionPrRefsFromMetadata(
        canonicalMetadata([ref(10), ref(11)])
      )
    ).toHaveLength(2);
  });
});

describe("isProseDerivedSessionPrLink", () => {
  it("is true only when EVERY declared identity is prose-derived", () => {
    expect(
      isProseDerivedSessionPrLink(
        canonicalMetadata([
          ref(10, ArtifactRefMethod.PrMentionInProse),
          ref(11, ArtifactRefMethod.BranchMentionInProse),
        ])
      )
    ).toBe(true);
  });

  it("is false for a mixed link, so one prose ref cannot demote a real one", () => {
    // The mirror of the mixed case above. Demoting the whole link would suppress
    // a command-derived PR that genuinely earned its place, which is the same
    // class of error as promoting prose — just in the other direction.
    expect(
      isProseDerivedSessionPrLink(
        canonicalMetadata([
          ref(10, ArtifactRefMethod.PrMentionInProse),
          ref(11),
        ])
      )
    ).toBe(false);
  });

  it("is false for a link declaring no identity at all", () => {
    // The legacy unique-branch shape. "No refs" is not "all refs are prose" —
    // `[].every(...)` is vacuously true, so this is exactly the case a naive
    // implementation gets wrong, and it would mark the entire pre-`prRefs`
    // corpus as prose-derived.
    expect(isProseDerivedSessionPrLink({ prRefs: [] })).toBe(false);
  });
});
