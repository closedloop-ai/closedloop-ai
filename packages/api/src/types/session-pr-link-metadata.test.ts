import { describe, expect, it } from "vitest";
import {
  allowsUniqueBranchPrFallback,
  classifySessionPrMetadata,
  declaresSessionBranchLinkKind,
  deriveSessionPrPurposeFromRelationTypes,
  hasSessionPrLinkKind,
  SessionArtifactLinkKind,
  SessionPrMetadataClassificationKind,
  SessionPrPurpose,
  SessionPrRelationType,
  sessionPrIdentityKey,
  sessionPrRefsFromMetadata,
} from "./session-pr-link-metadata.ts";

describe("classifySessionPrMetadata", () => {
  it("classifies a non-object metadata value as invalid", () => {
    expect(classifySessionPrMetadata(null)).toEqual({
      kind: SessionPrMetadataClassificationKind.Invalid,
      refs: [],
    });
    expect(classifySessionPrMetadata("not-an-object")).toEqual({
      kind: SessionPrMetadataClassificationKind.Invalid,
      refs: [],
    });
    expect(classifySessionPrMetadata([])).toEqual({
      kind: SessionPrMetadataClassificationKind.Invalid,
      refs: [],
    });
  });

  it("classifies a present prRefs array as canonical, keyed off key presence not value", () => {
    const refs = [
      { repositoryFullName: "org/repo", prNumber: 5, relationTypes: [] },
    ];

    expect(classifySessionPrMetadata({ prRefs: refs })).toEqual({
      kind: SessionPrMetadataClassificationKind.Canonical,
      refs,
    });
  });

  it("defaults refs to empty when prRefs key is present but explicitly undefined", () => {
    // pins current behavior; Object.hasOwn treats an explicit `undefined`
    // value as key-present, so this counts as canonical with no refs rather
    // than falling through to the linkKind-based classification below it.
    expect(classifySessionPrMetadata({ prRefs: undefined })).toEqual({
      kind: SessionPrMetadataClassificationKind.Canonical,
      refs: [],
    });
  });

  it("classifies a malformed prRefs entry as invalid rather than canonical", () => {
    expect(
      classifySessionPrMetadata({
        prRefs: [{ repositoryFullName: "", prNumber: 1, relationTypes: [] }],
      })
    ).toEqual({
      kind: SessionPrMetadataClassificationKind.Invalid,
      refs: [],
    });
  });

  it("classifies a linkKinds set including session_pr_set as invalid", () => {
    expect(
      classifySessionPrMetadata({
        linkKinds: [SessionArtifactLinkKind.SessionPrSet],
      })
    ).toEqual({
      kind: SessionPrMetadataClassificationKind.Invalid,
      refs: [],
    });
  });

  it("filters an unrecognized linkKinds entry instead of failing the whole array", () => {
    expect(
      classifySessionPrMetadata({
        linkKinds: [SessionArtifactLinkKind.SessionBranch, "future_kind"],
      })
    ).toEqual({
      kind: SessionPrMetadataClassificationKind.None,
      refs: [],
    });
  });

  it("classifies a non-session_pr linkKind as none", () => {
    expect(
      classifySessionPrMetadata({
        linkKind: SessionArtifactLinkKind.SessionBranch,
      })
    ).toEqual({
      kind: SessionPrMetadataClassificationKind.None,
      refs: [],
    });
  });

  it("classifies a missing linkKind as none", () => {
    expect(classifySessionPrMetadata({})).toEqual({
      kind: SessionPrMetadataClassificationKind.None,
      refs: [],
    });
  });

  it("classifies session_pr with only one of repositoryFullName/prNumber as invalid", () => {
    expect(
      classifySessionPrMetadata({
        linkKind: SessionArtifactLinkKind.SessionPr,
        repositoryFullName: "org/repo",
      })
    ).toEqual({
      kind: SessionPrMetadataClassificationKind.Invalid,
      refs: [],
    });
    expect(
      classifySessionPrMetadata({
        linkKind: SessionArtifactLinkKind.SessionPr,
        prNumber: 5,
      })
    ).toEqual({
      kind: SessionPrMetadataClassificationKind.Invalid,
      refs: [],
    });
  });

  it("classifies session_pr with neither repositoryFullName nor prNumber as legacy with no refs", () => {
    expect(
      classifySessionPrMetadata({ linkKind: SessionArtifactLinkKind.SessionPr })
    ).toEqual({
      kind: SessionPrMetadataClassificationKind.Legacy,
      refs: [],
    });
  });

  it("classifies a valid legacy session_pr row, defaulting absent relationTypes to empty", () => {
    expect(
      classifySessionPrMetadata({
        linkKind: SessionArtifactLinkKind.SessionPr,
        repositoryFullName: "org/repo",
        prNumber: 7,
      })
    ).toEqual({
      kind: SessionPrMetadataClassificationKind.Legacy,
      refs: [
        { repositoryFullName: "org/repo", prNumber: 7, relationTypes: [] },
      ],
    });
  });

  it("carries filtered relationTypes into the legacy ref when provided", () => {
    expect(
      classifySessionPrMetadata({
        linkKind: SessionArtifactLinkKind.SessionPr,
        repositoryFullName: "org/repo",
        prNumber: 7,
        relationTypes: [SessionPrRelationType.Created, "bogus"],
      })
    ).toEqual({
      kind: SessionPrMetadataClassificationKind.Legacy,
      refs: [
        {
          repositoryFullName: "org/repo",
          prNumber: 7,
          relationTypes: [SessionPrRelationType.Created],
        },
      ],
    });
  });
});

describe("sessionPrRefsFromMetadata", () => {
  it("returns the refs from the underlying classification", () => {
    expect(
      sessionPrRefsFromMetadata({
        linkKind: SessionArtifactLinkKind.SessionPr,
        repositoryFullName: "org/repo",
        prNumber: 1,
      })
    ).toEqual([
      { repositoryFullName: "org/repo", prNumber: 1, relationTypes: [] },
    ]);
  });

  it("returns an empty array for a non-PR classification", () => {
    expect(sessionPrRefsFromMetadata({})).toEqual([]);
  });
});

describe("allowsUniqueBranchPrFallback", () => {
  it("allows fallback for a legacy row with no declared refs", () => {
    expect(
      allowsUniqueBranchPrFallback({
        linkKind: SessionArtifactLinkKind.SessionPr,
      })
    ).toBe(true);
  });

  it("disallows fallback for a legacy row that already declares a ref", () => {
    expect(
      allowsUniqueBranchPrFallback({
        linkKind: SessionArtifactLinkKind.SessionPr,
        repositoryFullName: "org/repo",
        prNumber: 1,
      })
    ).toBe(false);
  });

  it("disallows fallback for a canonical row", () => {
    expect(allowsUniqueBranchPrFallback({ prRefs: [] })).toBe(false);
  });

  it("disallows fallback for a none or invalid row", () => {
    expect(allowsUniqueBranchPrFallback({})).toBe(false);
    expect(allowsUniqueBranchPrFallback(null)).toBe(false);
  });
});

describe("hasSessionPrLinkKind", () => {
  it("is true for legacy and canonical classifications", () => {
    expect(
      hasSessionPrLinkKind({ linkKind: SessionArtifactLinkKind.SessionPr })
    ).toBe(true);
    expect(hasSessionPrLinkKind({ prRefs: [] })).toBe(true);
  });

  it("is false for none and invalid classifications", () => {
    expect(hasSessionPrLinkKind({})).toBe(false);
    expect(hasSessionPrLinkKind(null)).toBe(false);
  });
});

describe("deriveSessionPrPurposeFromRelationTypes", () => {
  it("returns unknown when confidence is below the 0.5 threshold, overriding relation types", () => {
    expect(
      deriveSessionPrPurposeFromRelationTypes(
        [SessionPrRelationType.Created],
        0.4
      )
    ).toBe(SessionPrPurpose.Unknown);
  });

  it("does not override on a confidence of exactly 0.5", () => {
    expect(
      deriveSessionPrPurposeFromRelationTypes(
        [SessionPrRelationType.Created],
        0.5
      )
    ).toBe(SessionPrPurpose.Authored);
  });

  it("ignores confidence entirely when it is undefined", () => {
    expect(
      deriveSessionPrPurposeFromRelationTypes([SessionPrRelationType.Reviewed])
    ).toBe(SessionPrPurpose.Reviewed);
  });

  it("prioritizes Created over Reviewed and Referenced", () => {
    expect(
      deriveSessionPrPurposeFromRelationTypes([
        SessionPrRelationType.Referenced,
        SessionPrRelationType.Reviewed,
        SessionPrRelationType.Created,
      ])
    ).toBe(SessionPrPurpose.Authored);
  });

  it("prioritizes Reviewed over Referenced when Created is absent", () => {
    expect(
      deriveSessionPrPurposeFromRelationTypes([
        SessionPrRelationType.Referenced,
        SessionPrRelationType.Reviewed,
      ])
    ).toBe(SessionPrPurpose.Reviewed);
  });

  it("falls back to Referenced when only Referenced is present", () => {
    expect(
      deriveSessionPrPurposeFromRelationTypes([
        SessionPrRelationType.Referenced,
      ])
    ).toBe(SessionPrPurpose.Referenced);
  });

  it("falls back to Unknown when no relation types are present", () => {
    expect(deriveSessionPrPurposeFromRelationTypes([])).toBe(
      SessionPrPurpose.Unknown
    );
  });
});

describe("sessionPrIdentityKey", () => {
  it("builds a normalized repo-scoped key, trimming and lowercasing the repository", () => {
    expect(sessionPrIdentityKey("Org/Repo.git", 5)).toBe("org/repo#5");
  });

  it("builds a legacy key when repositoryFullName is null", () => {
    expect(sessionPrIdentityKey(null, 7)).toBe("legacy#7");
  });

  it("builds a legacy key when repositoryFullName is undefined", () => {
    expect(sessionPrIdentityKey(undefined, 3)).toBe("legacy#3");
  });

  it("builds a legacy key when repositoryFullName is whitespace-only", () => {
    expect(sessionPrIdentityKey("   ", 9)).toBe("legacy#9");
  });

  it("trims a string prNumber in both the canonical and legacy forms", () => {
    expect(sessionPrIdentityKey("org/repo", " 42 ")).toBe("org/repo#42");
    expect(sessionPrIdentityKey(null, " 42 ")).toBe("legacy#42");
  });
});

/**
 * One more identity than the retired 500-ref ceiling. Written out: ISS-9859
 * deleted the constant, and nothing enforces a count any more.
 */
const OVER_RETIRED_CAP_REF_COUNT = 501;

function buildPersistedPrRefs(count: number) {
  return Array.from({ length: count }, (_unused, index) => ({
    repositoryFullName: "org/repo",
    prNumber: index + 1,
    relationTypes: [],
  }));
}

describe("ISS-8051: persisted prRefs readback past the retired receive-side cap", () => {
  it("reads back every ref from metadata holding more than the retired cap", () => {
    const refs = buildPersistedPrRefs(OVER_RETIRED_CAP_REF_COUNT);

    // The regression this guards is TOTAL loss, not truncation: a `.max()` on
    // this read schema made `safeParse` fail, which `classifySessionPrMetadata`
    // maps to `invalid` -> `refs: []`. So the assertion that matters is the full
    // count surviving, and `Invalid` never being the classification of a row the
    // cloud already accepted and wrote.
    expect(sessionPrRefsFromMetadata({ prRefs: refs })).toHaveLength(
      OVER_RETIRED_CAP_REF_COUNT
    );
    expect(classifySessionPrMetadata({ prRefs: refs })).toEqual({
      kind: SessionPrMetadataClassificationKind.Canonical,
      refs,
    });
  });

  it("keeps an over-cap canonical row reporting a PR link kind", () => {
    const metadata = {
      linkKind: SessionArtifactLinkKind.SessionPr,
      prRefs: buildPersistedPrRefs(OVER_RETIRED_CAP_REF_COUNT),
    };

    // Downstream PR attribution gates on this predicate, so a re-added cap
    // would not merely empty the set — it would stop the link counting as a PR
    // link at all.
    expect(hasSessionPrLinkKind(metadata)).toBe(true);
  });
});

// ISS-8064 / ISS-8070: this module is the PERSISTED shape, parsed on the way
// OUT of `artifact_links.metadata`. A `.max()` here can never protect a write —
// the row is already stored — so it can only fail the read closed and take
// every ref with it: no thrown error a caller sees, no log, no truncation
// marker. The counts and lengths below are deliberate LITERALS, never derived
// from the retired constants, so restoring a bound cannot silently re-satisfy
// the assertion.

/** Past the retired 500-ref read bound, and not adjacent to it. */
const REFS_PAST_RETIRED_READ_BOUND = 640;
/** Past the retired 200-char read bound on repositoryFullName / method. */
const CHARS_PAST_RETIRED_STRING_BOUND = 512;

function buildPersistedRefs(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    repositoryFullName: `org/repo-${i}`,
    prNumber: i + 1,
    relationTypes: [SessionPrRelationType.Created],
  }));
}

describe("persisted read path returns every stored ref (ISS-8064)", () => {
  it("keeps the fixture above the retired bounds it is written to defeat", () => {
    // Assert the property the fixtures are assumed to have rather than trusting
    // it: a fixture that silently fell under the old bound would turn every
    // test below into a false green.
    expect(REFS_PAST_RETIRED_READ_BOUND).toBeGreaterThan(500);
    expect(buildPersistedRefs(REFS_PAST_RETIRED_READ_BOUND)).toHaveLength(
      REFS_PAST_RETIRED_READ_BOUND
    );
    expect("r".repeat(CHARS_PAST_RETIRED_STRING_BOUND).length).toBeGreaterThan(
      200
    );
  });

  it("returns a small persisted set unchanged (positive sibling)", () => {
    const refs = buildPersistedRefs(3);

    const classification = classifySessionPrMetadata({ prRefs: refs });

    expect(classification.kind).toBe(
      SessionPrMetadataClassificationKind.Canonical
    );
    expect(classification.refs).toHaveLength(3);
    expect(classification.refs).toEqual(refs);
  });

  it("returns the full COUNT and IDENTITY past the retired 500-ref bound", () => {
    const refs = buildPersistedRefs(REFS_PAST_RETIRED_READ_BOUND);

    const classification = classifySessionPrMetadata({ prRefs: refs });

    // Count: the defect dropped every ref, so the count is the primary claim.
    expect(classification.kind).toBe(
      SessionPrMetadataClassificationKind.Canonical
    );
    expect(classification.refs).toHaveLength(REFS_PAST_RETIRED_READ_BOUND);
    // Identity: a count alone would pass on a truncated-but-refilled array.
    expect(classification.refs.map((ref) => ref.prNumber)).toEqual(
      refs.map((ref) => ref.prNumber)
    );
    expect(classification.refs.at(-1)).toEqual(refs.at(-1));
    // Byte-identical round trip of the whole persisted array.
    expect(classification.refs).toEqual(refs);
  });

  it("exposes the same full set through sessionPrRefsFromMetadata", () => {
    const refs = buildPersistedRefs(REFS_PAST_RETIRED_READ_BOUND);

    expect(sessionPrRefsFromMetadata({ prRefs: refs })).toEqual(refs);
  });

  it("does not let ONE over-long repositoryFullName drop its sibling refs", () => {
    // The read schema validated each element, so a single over-long value
    // failed the whole object and every sibling ref vanished with it.
    const refs = buildPersistedRefs(3);
    const poisoned = [
      ...refs,
      {
        repositoryFullName: `org/${"r".repeat(CHARS_PAST_RETIRED_STRING_BOUND)}`,
        prNumber: 900,
        relationTypes: [SessionPrRelationType.Referenced],
      },
    ];

    const classification = classifySessionPrMetadata({ prRefs: poisoned });

    expect(classification.kind).toBe(
      SessionPrMetadataClassificationKind.Canonical
    );
    expect(classification.refs).toHaveLength(4);
    expect(classification.refs).toEqual(poisoned);
  });

  it("does not let an over-long ref method drop its sibling refs", () => {
    const refs = buildPersistedRefs(2);
    const poisoned = [
      ...refs,
      {
        repositoryFullName: "org/repo-long-method",
        prNumber: 901,
        relationTypes: [SessionPrRelationType.Reviewed],
        method: "m".repeat(CHARS_PAST_RETIRED_STRING_BOUND),
      },
    ];

    const classification = classifySessionPrMetadata({ prRefs: poisoned });

    expect(classification.kind).toBe(
      SessionPrMetadataClassificationKind.Canonical
    );
    expect(classification.refs).toEqual(poisoned);
  });

  it("reads a legacy row whose top-level repositoryFullName is over-long", () => {
    const repositoryFullName = `org/${"r".repeat(CHARS_PAST_RETIRED_STRING_BOUND)}`;

    const classification = classifySessionPrMetadata({
      linkKind: SessionArtifactLinkKind.SessionPr,
      repositoryFullName,
      prNumber: 12,
    });

    expect(classification.kind).toBe(
      SessionPrMetadataClassificationKind.Legacy
    );
    expect(classification.refs).toEqual([
      { repositoryFullName, prNumber: 12, relationTypes: [] },
    ]);
  });
});

describe("declaresSessionBranchLinkKind", () => {
  it("reports false for null metadata", () => {
    expect(declaresSessionBranchLinkKind(null)).toBe(false);
  });

  it("reports true when the scalar linkKind declares session_branch", () => {
    expect(
      declaresSessionBranchLinkKind({
        linkKind: SessionArtifactLinkKind.SessionBranch,
      })
    ).toBe(true);
  });

  it("reports true when only the plural linkKinds declares session_branch", () => {
    expect(
      declaresSessionBranchLinkKind({
        linkKind: SessionArtifactLinkKind.SessionPr,
        linkKinds: [
          SessionArtifactLinkKind.SessionPr,
          SessionArtifactLinkKind.SessionBranch,
        ],
      })
    ).toBe(true);
  });

  it("reports false when neither marker declares session_branch", () => {
    expect(
      declaresSessionBranchLinkKind({
        linkKind: SessionArtifactLinkKind.SessionPr,
        linkKinds: [SessionArtifactLinkKind.SessionPr],
      })
    ).toBe(false);
  });
});
