import { describe, expect, it } from "vitest";
import {
  BranchLifecycleBoundaryKind,
  BranchParticipationKind,
} from "./branch.js";
import {
  ArtifactRefConfidence,
  ArtifactRefMethod,
  ArtifactRefRelation,
  ArtifactRefTargetKind,
  allowsUniqueBranchPrFallback,
  classifySessionPrMetadata,
  deriveBranchParticipationFromEvidence,
  deriveBranchParticipationFromMetadata,
  deriveSessionPrPurposeFromMetadata,
  deriveSessionPrPurposeFromRelationTypes,
  hasSessionPrLinkKind,
  isKnownArtifactRefKind,
  isLifecycleBranchReadOnlyRelation,
  isLifecycleBranchWriteRelation,
  KNOWN_ARTIFACT_REF_KINDS,
  parseSessionPrLinkMetadata,
  SessionArtifactLinkKind,
  SessionPrMetadataClassificationKind,
  SessionPrPurpose,
  SessionPrRelationType,
  sessionPrRefsFromMetadata,
  syncedBranchLifecycleEventSchema,
} from "./session-artifact-link.js";

describe("isKnownArtifactRefKind / KNOWN_ARTIFACT_REF_KINDS (FEA-2729)", () => {
  it("recognizes the persistable/forwardable kinds (incl. commit — FEA-2731)", () => {
    expect(
      isKnownArtifactRefKind(ArtifactRefTargetKind.ClosedloopArtifact)
    ).toBe(true);
    expect(isKnownArtifactRefKind(ArtifactRefTargetKind.Branch)).toBe(true);
    expect(isKnownArtifactRefKind(ArtifactRefTargetKind.PullRequest)).toBe(
      true
    );
    expect(isKnownArtifactRefKind(ArtifactRefTargetKind.Commit)).toBe(true);
  });

  it("does not recognize arbitrary/unknown kinds", () => {
    expect(isKnownArtifactRefKind("something_new")).toBe(false);
    expect(isKnownArtifactRefKind(undefined)).toBe(false);
    expect(isKnownArtifactRefKind(42)).toBe(false);
  });

  it("KNOWN_ARTIFACT_REF_KINDS holds exactly the four persistable/forwardable kinds", () => {
    expect(KNOWN_ARTIFACT_REF_KINDS.size).toBe(4);
    expect(KNOWN_ARTIFACT_REF_KINDS.has(ArtifactRefTargetKind.Branch)).toBe(
      true
    );
    expect(KNOWN_ARTIFACT_REF_KINDS.has(ArtifactRefTargetKind.Commit)).toBe(
      true
    );
  });
});

describe("SessionArtifactLinkKind (FEA-2729)", () => {
  it("adds the session_branch link kind", () => {
    expect(SessionArtifactLinkKind.SessionBranch).toBe("session_branch");
    expect(SessionArtifactLinkKind.SessionPr).toBe("session_pr");
  });
});

describe("session PR purpose metadata", () => {
  it("keeps canonical empty and invalid shapes out of legacy fallback", () => {
    const legacy = { linkKind: SessionArtifactLinkKind.SessionPr };
    const canonicalEmpty = {
      ...legacy,
      repositoryFullName: "stale/repo",
      prNumber: 99,
      prRefs: [],
    };
    // ISS-8051 retired a third shape here: an over-500 `prRefs` array, which
    // this case asserted was `Invalid`. That classification was the defect —
    // it discarded the whole stored PR set of a link the cloud had already
    // accepted — so the expectation itself changed rather than being weakened.
    // Its replacement is the readback coverage in
    // `session-pr-link-metadata.test.ts`, which asserts all 501 survive.
    const invalidShapes = [
      { ...legacy, prRefs: "invalid" },
      {
        linkKind: SessionArtifactLinkKind.SessionBranch,
        linkKinds: [SessionArtifactLinkKind.SessionPrSet],
      },
    ];

    expect(allowsUniqueBranchPrFallback(legacy)).toBe(true);
    expect(classifySessionPrMetadata(canonicalEmpty)).toMatchObject({
      kind: SessionPrMetadataClassificationKind.Canonical,
      refs: [],
    });
    expect(allowsUniqueBranchPrFallback(canonicalEmpty)).toBe(false);
    for (const metadata of invalidShapes) {
      expect(classifySessionPrMetadata(metadata).kind).toBe(
        SessionPrMetadataClassificationKind.Invalid
      );
      expect(sessionPrRefsFromMetadata(metadata)).toEqual([]);
      expect(allowsUniqueBranchPrFallback(metadata)).toBe(false);
    }
  });

  it("classifies a large persisted prRefs array as canonical, not invalid (ISS-8064)", () => {
    // This shape used to sit in `invalidShapes` above, because the persisted
    // read schema carried `.max(500)`. That was the defect, not the contract:
    // a stored link past the bound read back as Invalid with zero refs, so its
    // PRs vanished with no error and no log. Count and identity, not silence.
    const prRefs = Array.from({ length: 501 }, (_, index) => ({
      repositoryFullName: "acme/web",
      prNumber: index + 1,
      relationTypes: [],
    }));
    const metadata = { linkKind: SessionArtifactLinkKind.SessionPr, prRefs };

    expect(classifySessionPrMetadata(metadata).kind).toBe(
      SessionPrMetadataClassificationKind.Canonical
    );
    expect(sessionPrRefsFromMetadata(metadata)).toHaveLength(501);
    expect(sessionPrRefsFromMetadata(metadata)).toEqual(prRefs);
    expect(allowsUniqueBranchPrFallback(metadata)).toBe(false);
  });

  it("rejects scalar session_pr_set while accepting the set marker in linkKinds", () => {
    expect(
      parseSessionPrLinkMetadata({
        linkKind: SessionArtifactLinkKind.SessionPrSet,
      })
    ).toBeNull();
    expect(
      hasSessionPrLinkKind({
        linkKind: SessionArtifactLinkKind.SessionPrSet,
      })
    ).toBe(false);
    expect(
      hasSessionPrLinkKind({
        linkKind: SessionArtifactLinkKind.SessionBranch,
        linkKinds: [SessionArtifactLinkKind.SessionPrSet],
        prRefs: [],
      })
    ).toBe(true);
  });

  it("prefers the canonical PR set over stale scalar identity", () => {
    const metadata = parseSessionPrLinkMetadata({
      linkKind: SessionArtifactLinkKind.SessionBranch,
      linkKinds: [SessionArtifactLinkKind.SessionPrSet],
      repositoryFullName: "stale/repo",
      prNumber: 99,
      relationTypes: [SessionPrRelationType.Created],
      prRefs: [
        {
          repositoryFullName: "acme/web",
          prNumber: 1,
          relationTypes: [SessionPrRelationType.Referenced],
        },
        {
          repositoryFullName: "acme/web",
          prNumber: 2,
          relationTypes: [SessionPrRelationType.Created],
        },
      ],
    });

    expect(hasSessionPrLinkKind(metadata)).toBe(true);
    expect(sessionPrRefsFromMetadata(metadata)).toEqual([
      {
        repositoryFullName: "acme/web",
        prNumber: 1,
        relationTypes: [SessionPrRelationType.Referenced],
      },
      {
        repositoryFullName: "acme/web",
        prNumber: 2,
        relationTypes: [SessionPrRelationType.Created],
      },
    ]);
    expect(
      deriveSessionPrPurposeFromRelationTypes(
        sessionPrRefsFromMetadata(metadata)[0]?.relationTypes ?? []
      )
    ).toBe(SessionPrPurpose.Referenced);
    expect(
      deriveSessionPrPurposeFromRelationTypes(
        sessionPrRefsFromMetadata(metadata)[1]?.relationTypes ?? []
      )
    ).toBe(SessionPrPurpose.Authored);
  });

  it("projects legacy scalar identity only when the canonical set is absent", () => {
    const metadata = parseSessionPrLinkMetadata({
      linkKind: SessionArtifactLinkKind.SessionPr,
      repositoryFullName: "acme/web",
      prNumber: 7,
      relationTypes: [SessionPrRelationType.Reviewed],
    });

    expect(sessionPrRefsFromMetadata(metadata)).toEqual([
      {
        repositoryFullName: "acme/web",
        prNumber: 7,
        relationTypes: [SessionPrRelationType.Reviewed],
      },
    ]);
    expect(
      sessionPrRefsFromMetadata(
        parseSessionPrLinkMetadata({
          repositoryFullName: "stale/repo",
          prNumber: 8,
          prRefs: [],
        })
      )
    ).toEqual([]);
  });

  it("parses branch lifecycle events from metadata and maps future kinds to unknown", () => {
    const event = syncedBranchLifecycleEventSchema.parse({
      kind: "future_boundary",
      evidenceId: "provider:future",
    });
    expect(event.kind).toBe(BranchLifecycleBoundaryKind.UnknownEvidence);

    const metadata = parseSessionPrLinkMetadata({
      linkKind: SessionArtifactLinkKind.SessionPr,
      confidence: 1,
      branchLifecycleEvents: [
        {
          kind: BranchLifecycleBoundaryKind.PrRaised,
          observedAt: "2026-07-08T12:00:00.000Z",
          evidenceId: "desktop-artifact-link:link-1",
        },
      ],
    });
    expect(metadata?.branchLifecycleEvents?.[0]?.kind).toBe(
      BranchLifecycleBoundaryKind.PrRaised
    );
  });

  it("derives authored purpose from CREATED metadata", () => {
    const metadata = parseSessionPrLinkMetadata({
      linkKind: SessionArtifactLinkKind.SessionPr,
      relationTypes: [SessionPrRelationType.Created],
      confidence: 1,
    });

    expect(deriveSessionPrPurposeFromMetadata(metadata)).toBe(
      SessionPrPurpose.Authored
    );
  });

  it("derives referenced purpose from REFERENCED metadata", () => {
    const metadata = parseSessionPrLinkMetadata({
      linkKind: SessionArtifactLinkKind.SessionPr,
      relationTypes: [SessionPrRelationType.Referenced],
      confidence: 1,
    });

    expect(deriveSessionPrPurposeFromMetadata(metadata)).toBe(
      SessionPrPurpose.Referenced
    );
  });

  it("derives reviewed purpose from REVIEWED metadata (FEA-3585)", () => {
    const metadata = parseSessionPrLinkMetadata({
      linkKind: SessionArtifactLinkKind.SessionPr,
      relationTypes: [SessionPrRelationType.Reviewed],
      confidence: 1,
    });

    expect(deriveSessionPrPurposeFromMetadata(metadata)).toBe(
      SessionPrPurpose.Reviewed
    );
  });

  it("REVIEWED outranks REFERENCED but not CREATED (FEA-3585)", () => {
    const reviewedAndReferenced = parseSessionPrLinkMetadata({
      linkKind: SessionArtifactLinkKind.SessionPr,
      relationTypes: [
        SessionPrRelationType.Referenced,
        SessionPrRelationType.Reviewed,
      ],
      confidence: 1,
    });
    // A PR both reviewed and mentioned surfaces as Reviewed, not Referenced.
    expect(deriveSessionPrPurposeFromMetadata(reviewedAndReferenced)).toBe(
      SessionPrPurpose.Reviewed
    );

    const authoredAndReviewed = parseSessionPrLinkMetadata({
      linkKind: SessionArtifactLinkKind.SessionPr,
      relationTypes: [
        SessionPrRelationType.Reviewed,
        SessionPrRelationType.Created,
      ],
      confidence: 1,
    });
    // Authoring still wins — a review must never mask authored output (FEA-3584).
    expect(deriveSessionPrPurposeFromMetadata(authoredAndReviewed)).toBe(
      SessionPrPurpose.Authored
    );
  });

  it("falls back for unknown or low-confidence metadata", () => {
    const lowConfidence = parseSessionPrLinkMetadata({
      linkKind: SessionArtifactLinkKind.SessionPr,
      relationTypes: [SessionPrRelationType.Created],
      confidence: 0.25,
    });

    expect(deriveSessionPrPurposeFromMetadata(null)).toBe(
      SessionPrPurpose.Unknown
    );
    expect(deriveSessionPrPurposeFromMetadata(lowConfidence)).toBe(
      SessionPrPurpose.Unknown
    );
    expect(
      parseSessionPrLinkMetadata({ relationTypes: ["UNKNOWN"] })?.relationTypes
    ).toEqual([]);
  });
});

describe("const-object enum values", () => {
  it("SessionPrRelationType has correct values", () => {
    expect(SessionPrRelationType.Created).toBe("CREATED");
    expect(SessionPrRelationType.Referenced).toBe("REFERENCED");
    expect(SessionPrRelationType.Reviewed).toBe("REVIEWED");
  });

  it("ArtifactRefMethod has correct values", () => {
    expect(ArtifactRefMethod.McpToolCall).toBe("mcp_tool_call");
    expect(ArtifactRefMethod.UrlInMessage).toBe("url_in_message");
    expect(ArtifactRefMethod.SlugInMessage).toBe("slug_in_message");
    expect(ArtifactRefMethod.SlugInBranch).toBe("slug_in_branch");
    expect(ArtifactRefMethod.SlugInCwd).toBe("slug_in_cwd");
    expect(ArtifactRefMethod.SlugInSessionSlug).toBe("slug_in_session_slug");
    expect(ArtifactRefMethod.PrCreateOutput).toBe("pr_create_output");
    expect(ArtifactRefMethod.PrUrlInToolUse).toBe("pr_url_in_tool_use");
    expect(ArtifactRefMethod.PrReviewCommand).toBe("pr_review_command");
    expect(ArtifactRefMethod.PrReviewFeedbackCommand).toBe(
      "pr_review_feedback_command"
    );
    expect(ArtifactRefMethod.HarnessPrLink).toBe("harness_pr_link");
    expect(ArtifactRefMethod.LaunchMetadata).toBe("launch_metadata");
    expect(ArtifactRefMethod.GitCommand).toBe("git_command");
  });

  it("ArtifactRefTargetKind has correct values", () => {
    expect(ArtifactRefTargetKind.ClosedloopArtifact).toBe(
      "closedloop_artifact"
    );
    expect(ArtifactRefTargetKind.PullRequest).toBe("pull_request");
    expect(ArtifactRefTargetKind.Branch).toBe("branch");
    expect(ArtifactRefTargetKind.Commit).toBe("commit");
  });

  it("ArtifactRefRelation has correct values", () => {
    expect(ArtifactRefRelation.Input).toBe("input");
    expect(ArtifactRefRelation.Output).toBe("output");
    expect(ArtifactRefRelation.Referenced).toBe("referenced");
    expect(ArtifactRefRelation.Created).toBe("created");
    expect(ArtifactRefRelation.Reviewed).toBe("reviewed");
    expect(ArtifactRefRelation.Workspace).toBe("workspace");
  });

  it("classifies branch lifecycle write relations separately from read-only context", () => {
    expect(isLifecycleBranchWriteRelation(ArtifactRefRelation.Created)).toBe(
      true
    );
    expect(isLifecycleBranchWriteRelation(ArtifactRefRelation.Output)).toBe(
      true
    );

    for (const relation of [
      ArtifactRefRelation.Input,
      ArtifactRefRelation.Referenced,
      ArtifactRefRelation.Reviewed,
      ArtifactRefRelation.Workspace,
    ]) {
      expect(isLifecycleBranchReadOnlyRelation(relation)).toBe(true);
      expect(isLifecycleBranchWriteRelation(relation)).toBe(false);
    }
  });

  it("derives branch participation from write and deliberate review evidence", () => {
    expect(
      deriveBranchParticipationFromEvidence({
        relation: ArtifactRefRelation.Created,
        method: ArtifactRefMethod.GitCommand,
      })
    ).toBe(BranchParticipationKind.Wrote);
    expect(
      deriveBranchParticipationFromEvidence({
        relation: ArtifactRefRelation.Workspace,
        method: ArtifactRefMethod.PrReviewFeedbackCommand,
      })
    ).toBe(BranchParticipationKind.Reviewed);
    expect(
      deriveBranchParticipationFromEvidence({
        relation: ArtifactRefRelation.Workspace,
        method: "git_checkout",
      })
    ).toBeUndefined();
  });

  it("derives branch participation from persisted link metadata with scalar precedence", () => {
    expect(
      deriveBranchParticipationFromMetadata(
        parseSessionPrLinkMetadata({
          branchParticipation: BranchParticipationKind.Reviewed,
          relation: ArtifactRefRelation.Created,
        })
      )
    ).toBe(BranchParticipationKind.Reviewed);
    expect(
      deriveBranchParticipationFromMetadata(
        parseSessionPrLinkMetadata({
          relation: ArtifactRefRelation.Output,
        })
      )
    ).toBe(BranchParticipationKind.Wrote);
    expect(
      deriveBranchParticipationFromMetadata(
        parseSessionPrLinkMetadata({
          branchLifecycleEvents: [
            { kind: BranchLifecycleBoundaryKind.ReviewFeedback },
          ],
        })
      )
    ).toBe(BranchParticipationKind.Reviewed);
    expect(
      deriveBranchParticipationFromMetadata(
        parseSessionPrLinkMetadata({
          relationTypes: [SessionPrRelationType.Created],
        })
      )
    ).toBe(BranchParticipationKind.Wrote);
    expect(
      deriveBranchParticipationFromMetadata(
        parseSessionPrLinkMetadata({
          relationTypes: [SessionPrRelationType.Reviewed],
        })
      )
    ).toBe(BranchParticipationKind.Reviewed);
  });

  it("ignores unknown promoted metadata fields without dropping valid fallback evidence", () => {
    expect(
      deriveBranchParticipationFromMetadata(
        parseSessionPrLinkMetadata({
          branchParticipation: "future-participation",
          relation: "future-relation",
          relationTypes: ["FUTURE", SessionPrRelationType.Reviewed],
          branchLifecycleEvents: [
            { kind: BranchLifecycleBoundaryKind.ReviewFeedback },
          ],
        })
      )
    ).toBe(BranchParticipationKind.Reviewed);
  });

  it("ArtifactRefConfidence has correct values", () => {
    expect(ArtifactRefConfidence.McpCall).toBe("mcp_call");
    expect(ArtifactRefConfidence.UrlMatch).toBe("url_match");
    expect(ArtifactRefConfidence.SlugMatchInProse).toBe("slug_match_in_prose");
    expect(ArtifactRefConfidence.SlugMatchInBranch).toBe(
      "slug_match_in_branch"
    );
    expect(ArtifactRefConfidence.HarnessRecord).toBe("harness_record");
  });
});

// ---------------------------------------------------------------------------
// ISS-8070. The branch writer stores the widened ref `method` verbatim into
// `artifact_links.metadata.method`, and `parseSessionPrLinkMetadata` is the
// READER for that stored JSON. A `.max()` there is not a wire guard — it
// rejects a value this repo already accepted and persisted. The parse is
// whole-object, so the failure returns `null` and takes every sibling field
// with it for all six consumers of the parser (attribution, session-pr-status,
// provenance-eligibility, session-usage-window, loc-branch-identity,
// branch-links).
// ---------------------------------------------------------------------------

/** Past the retired 200-char `method` bound, and not adjacent to it. */
const PERSISTED_METHOD_CHARS_PAST_RETIRED_BOUND = 512;

describe("parseSessionPrLinkMetadata reads back a widened persisted method (ISS-8070)", () => {
  it("keeps the fixture above the bound it is written to defeat", () => {
    expect(PERSISTED_METHOD_CHARS_PAST_RETIRED_BOUND).toBeGreaterThan(200);
  });

  it("returns the stored method and its sibling lifecycle event, not null", () => {
    const method = "m".repeat(PERSISTED_METHOD_CHARS_PAST_RETIRED_BOUND);

    const metadata = parseSessionPrLinkMetadata({
      method,
      relation: ArtifactRefRelation.Output,
      branchParticipation: BranchParticipationKind.Wrote,
      branchLifecycleEvents: [
        {
          kind: BranchLifecycleBoundaryKind.ReviewFeedback,
          evidenceId: "desktop-artifact-link:1",
        },
      ],
    });

    expect(metadata).not.toBeNull();
    expect(metadata?.method).toBe(method);
    expect(metadata?.branchLifecycleEvents).toEqual([
      {
        kind: BranchLifecycleBoundaryKind.ReviewFeedback,
        evidenceId: "desktop-artifact-link:1",
      },
    ]);
  });

  it("still derives participation from the sibling event a bound would have dropped", () => {
    expect(
      deriveBranchParticipationFromMetadata(
        parseSessionPrLinkMetadata({
          method: "m".repeat(PERSISTED_METHOD_CHARS_PAST_RETIRED_BOUND),
          branchLifecycleEvents: [
            { kind: BranchLifecycleBoundaryKind.ReviewFeedback },
          ],
        })
      )
    ).toBe(BranchParticipationKind.Reviewed);
  });

  it("still rejects an empty method (the min(1) bound is unchanged)", () => {
    expect(parseSessionPrLinkMetadata({ method: "" })).toBeNull();
  });
});
