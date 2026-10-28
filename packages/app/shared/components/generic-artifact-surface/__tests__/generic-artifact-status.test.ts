import { DocumentStatus, IssueStatus } from "@closedloop-ai/loops-api/document";
import {
  ARTIFACT_STATUS_DETAIL,
  ARTIFACT_STATUS_ROOT,
  DISPLAYED_ARTIFACT_STATUS,
  UNKNOWN_ARTIFACT_STATUS,
} from "@repo/api/src/types/artifact-status";
import {
  ArtifactStatusReadOnlyReason,
  ArtifactStatusVocabulary,
} from "@repo/api/src/types/artifact-status-contract";
import { ARTIFACT_STATUS_DISPLAY_LABELS } from "@repo/api/src/types/artifact-status-display";
import { statusDisplayRank } from "@repo/api/src/types/artifact-status-display-order";
import { BranchStatus } from "@repo/api/src/types/branch";
import { branchStatusRank } from "@repo/api/src/types/branch-status-order";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { sessionStatusRank } from "@repo/api/src/types/session-status-rank";
import { describe, expect, it } from "vitest";
import {
  GenericArtifactKind,
  GenericArtifactStatus,
  genericArtifactCompatibleStatusOptions,
  genericArtifactFacetForKey,
  genericArtifactFilterKeys,
  genericArtifactRootFacet,
  genericArtifactRootFacets,
  genericArtifactStatusCapability,
  genericArtifactStatusDefaultForRoot,
  genericArtifactStatusFacet,
  genericArtifactStatusForRoot,
  genericArtifactStatusForSelection,
  genericArtifactStatusFromRaw,
  genericArtifactStatusKey,
  genericArtifactStatusKeyLabel,
  genericArtifactStatusLabel,
  genericArtifactStatusMatchesKey,
  genericArtifactStatusOptions,
  genericArtifactStatusRawRank,
  genericArtifactStatusRouteKey,
  isGenericArtifactStatusKey,
} from "../generic-artifact-status";

describe("genericArtifactStatusFacet", () => {
  it.each([
    [
      GenericArtifactKind.Document,
      GenericArtifactStatus.Approved,
      ARTIFACT_STATUS_ROOT.Done,
      ARTIFACT_STATUS_DETAIL.DocumentApproved,
    ],
    [
      GenericArtifactKind.Issue,
      GenericArtifactStatus.InReview,
      ARTIFACT_STATUS_ROOT.InReview,
      undefined,
    ],
    [
      GenericArtifactKind.Session,
      GenericArtifactStatus.Active,
      ARTIFACT_STATUS_ROOT.InProgress,
      ARTIFACT_STATUS_DETAIL.SessionRunning,
    ],
    [
      GenericArtifactKind.Document,
      GenericArtifactStatus.Completed,
      ARTIFACT_STATUS_ROOT.Done,
      ARTIFACT_STATUS_DETAIL.DocumentExecuted,
    ],
  ])("folds %s %s through the shipped table", (kind, status, root, detail) => {
    expect(genericArtifactStatusFacet({ kind, status }).normalized).toEqual({
      root,
      ...(detail ? { detail } : {}),
    });
  });

  it("preserves the branch provider detail instead of a local Blocked root", () => {
    expect(
      genericArtifactStatusFacet({
        kind: GenericArtifactKind.Branch,
        status: GenericArtifactStatus.Blocked,
        statusRaw: BranchStatus.Blocked,
      }).normalized
    ).toEqual({
      root: ARTIFACT_STATUS_ROOT.InReview,
      detail: ARTIFACT_STATUS_DETAIL.BranchChangesRequested,
    });
  });

  it("recognizes Failed only for Session rows", () => {
    expect(
      genericArtifactStatusFacet({
        kind: GenericArtifactKind.Session,
        status: GenericArtifactStatus.Failed,
      }).normalized
    ).toEqual({
      root: ARTIFACT_STATUS_ROOT.Canceled,
      detail: ARTIFACT_STATUS_DETAIL.SessionFailed,
    });
    expect(
      genericArtifactStatusFacet({
        kind: GenericArtifactKind.Issue,
        status: GenericArtifactStatus.Failed,
      }).normalized
    ).toBe(UNKNOWN_ARTIFACT_STATUS);
  });

  it("refuses an unrecognized editable row instead of widening authority", () => {
    expect(
      genericArtifactStatusCapability({
        kind: GenericArtifactKind.Document,
        status: GenericArtifactStatus.Draft,
        statusRaw: "FUTURE_DOCUMENT_STATUS",
      })
    ).toEqual({
      editable: false,
      reason: ArtifactStatusReadOnlyReason.UnrecognizedStatus,
    });
  });

  it("exposes the complete raw vocabulary for editable profiles", () => {
    const document = genericArtifactStatusCapability({
      kind: GenericArtifactKind.Document,
      status: GenericArtifactStatus.Draft,
    });
    const issue = genericArtifactStatusCapability({
      kind: GenericArtifactKind.Issue,
      status: GenericArtifactStatus.Todo,
    });

    expect(document.editable && new Set(document.allowedTargets)).toEqual(
      new Set(Object.values(DocumentStatus))
    );
    expect(issue.editable && new Set(issue.allowedTargets)).toEqual(
      new Set(Object.values(IssueStatus))
    );
  });

  it("offers exactly the supported options for every represented kind", () => {
    expect(
      Object.fromEntries(
        Object.values(GenericArtifactKind).map((kind) => [
          kind,
          genericArtifactStatusOptions(kind),
        ])
      )
    ).toEqual({
      [GenericArtifactKind.Agent]: [
        GenericArtifactStatus.Triage,
        GenericArtifactStatus.Backlog,
        GenericArtifactStatus.Todo,
        GenericArtifactStatus.InProgress,
        GenericArtifactStatus.InReview,
        GenericArtifactStatus.Blocked,
        GenericArtifactStatus.Done,
        GenericArtifactStatus.Canceled,
      ],
      [GenericArtifactKind.Branch]: [
        GenericArtifactStatus.Active,
        GenericArtifactStatus.Draft,
        GenericArtifactStatus.InReview,
        GenericArtifactStatus.Blocked,
        GenericArtifactStatus.Done,
        GenericArtifactStatus.Canceled,
      ],
      [GenericArtifactKind.Deployment]: [],
      [GenericArtifactKind.Document]: [
        GenericArtifactStatus.Draft,
        GenericArtifactStatus.InReview,
        GenericArtifactStatus.Blocked,
        GenericArtifactStatus.Approved,
        GenericArtifactStatus.Completed,
        GenericArtifactStatus.Canceled,
      ],
      [GenericArtifactKind.Issue]: [
        GenericArtifactStatus.Triage,
        GenericArtifactStatus.Backlog,
        GenericArtifactStatus.Todo,
        GenericArtifactStatus.InProgress,
        GenericArtifactStatus.InReview,
        GenericArtifactStatus.Blocked,
        GenericArtifactStatus.Done,
        GenericArtifactStatus.Canceled,
      ],
      [GenericArtifactKind.Prototype]: [
        GenericArtifactStatus.Triage,
        GenericArtifactStatus.Backlog,
        GenericArtifactStatus.Todo,
        GenericArtifactStatus.InProgress,
        GenericArtifactStatus.InReview,
        GenericArtifactStatus.Blocked,
        GenericArtifactStatus.Done,
        GenericArtifactStatus.Canceled,
      ],
      [GenericArtifactKind.Session]: [
        GenericArtifactStatus.Active,
        GenericArtifactStatus.Completed,
        GenericArtifactStatus.Failed,
      ],
    });
  });

  it("derives canonical labels instead of exposing fixture aliases", () => {
    expect(
      genericArtifactStatusLabel({
        kind: GenericArtifactKind.Document,
        status: GenericArtifactStatus.Blocked,
      })
    ).toBe("Changes requested");
    expect(
      genericArtifactStatusLabel({
        kind: GenericArtifactKind.Document,
        status: GenericArtifactStatus.Completed,
      })
    ).toBe("Executed");
  });
});

describe("generic artifact filter and lane identities", () => {
  it("uses exact namespaced detail keys and rejects retired URL values", () => {
    expect(
      genericArtifactStatusKey({
        kind: GenericArtifactKind.Document,
        status: GenericArtifactStatus.Approved,
      })
    ).toBe(ARTIFACT_STATUS_DETAIL.DocumentApproved);
    expect(isGenericArtifactStatusKey("Ready for review")).toBe(false);
    expect(isGenericArtifactStatusKey(ARTIFACT_STATUS_ROOT.InReview)).toBe(
      true
    );
  });

  it("includes every represented provider detail in filter options", () => {
    expect(genericArtifactFilterKeys([GenericArtifactKind.Branch])).toContain(
      ARTIFACT_STATUS_DETAIL.BranchPrOpen
    );
  });

  it("keeps root-only and detail filters exact", () => {
    const branch = {
      kind: GenericArtifactKind.Branch,
      status: GenericArtifactStatus.Active,
    };
    const rootOnlyIssue = {
      kind: GenericArtifactKind.Issue,
      status: GenericArtifactStatus.InReview,
    };

    expect(
      genericArtifactStatusMatchesKey(branch, ARTIFACT_STATUS_ROOT.InReview)
    ).toBe(false);
    expect(
      genericArtifactStatusMatchesKey(
        branch,
        ARTIFACT_STATUS_DETAIL.BranchPrOpen
      )
    ).toBe(true);
    expect(
      genericArtifactStatusMatchesKey(
        branch,
        ARTIFACT_STATUS_DETAIL.BranchReview
      )
    ).toBe(false);
    expect(
      genericArtifactStatusMatchesKey(
        rootOnlyIssue,
        ARTIFACT_STATUS_ROOT.InReview
      )
    ).toBe(true);
  });

  it("preserves old fixture-word filters without widening their match", () => {
    const legacyActive = genericArtifactStatusRouteKey(
      GenericArtifactStatus.Active
    )!;

    expect(genericArtifactStatusKeyLabel(legacyActive)).toBe(
      GenericArtifactStatus.Active
    );

    expect(
      genericArtifactStatusMatchesKey(
        {
          kind: GenericArtifactKind.Branch,
          status: GenericArtifactStatus.Active,
        },
        legacyActive
      )
    ).toBe(true);
    expect(
      genericArtifactStatusMatchesKey(
        {
          kind: GenericArtifactKind.Issue,
          status: GenericArtifactStatus.InProgress,
        },
        legacyActive
      )
    ).toBe(false);
  });

  it("preserves same-root detail and refuses unsupported cross-root moves", () => {
    expect(
      genericArtifactStatusForRoot(
        {
          kind: GenericArtifactKind.Document,
          status: GenericArtifactStatus.Completed,
        },
        ARTIFACT_STATUS_ROOT.Done
      )
    ).toBe(GenericArtifactStatus.Completed);
    expect(
      genericArtifactStatusForRoot(
        {
          kind: GenericArtifactKind.Document,
          status: GenericArtifactStatus.Completed,
        },
        ARTIFACT_STATUS_ROOT.InReview
      )
    ).toBe(GenericArtifactStatus.InReview);
    expect(
      genericArtifactStatusForRoot(
        {
          kind: GenericArtifactKind.Document,
          status: GenericArtifactStatus.Draft,
        },
        ARTIFACT_STATUS_ROOT.Done
      )
    ).toBeNull();
    expect(
      genericArtifactStatusForRoot(
        {
          kind: GenericArtifactKind.Branch,
          status: GenericArtifactStatus.Active,
        },
        ARTIFACT_STATUS_ROOT.Done
      )
    ).toBeNull();
  });

  it("requires an exact raw Document target for a status selection", () => {
    const document = {
      kind: GenericArtifactKind.Document,
      status: GenericArtifactStatus.Approved,
    };
    expect(
      genericArtifactStatusForSelection(document, ARTIFACT_STATUS_ROOT.Done)
    ).toBeNull();
    expect(
      genericArtifactStatusForSelection(
        document,
        ARTIFACT_STATUS_DETAIL.DocumentExecuted
      )
    ).toBe(GenericArtifactStatus.Completed);
    expect(
      genericArtifactStatusForSelection(document, ARTIFACT_STATUS_ROOT.InReview)
    ).toBe(GenericArtifactStatus.InReview);
    expect(
      genericArtifactStatusForSelection(
        { kind: GenericArtifactKind.Issue, status: GenericArtifactStatus.Todo },
        ARTIFACT_STATUS_ROOT.Done
      )
    ).toBe(GenericArtifactStatus.Done);
  });

  it("deduplicates mixed board lanes to the five ordered roots", () => {
    expect(
      genericArtifactRootFacets(Object.values(GenericArtifactKind)).map(
        (facet) => facet.normalized.root
      )
    ).toEqual([
      ARTIFACT_STATUS_ROOT.Todo,
      ARTIFACT_STATUS_ROOT.InProgress,
      ARTIFACT_STATUS_ROOT.InReview,
      ARTIFACT_STATUS_ROOT.Done,
      ARTIFACT_STATUS_ROOT.Canceled,
    ]);
  });

  it("derives specialized lanes only from the represented profile", () => {
    expect(
      genericArtifactRootFacets([GenericArtifactKind.Document]).map(
        (facet) => facet.normalized.root
      )
    ).toEqual([
      ARTIFACT_STATUS_ROOT.InProgress,
      ARTIFACT_STATUS_ROOT.InReview,
      ARTIFACT_STATUS_ROOT.Done,
      ARTIFACT_STATUS_ROOT.Canceled,
    ]);
  });

  it("intersects bulk options and refuses mixed source-managed selections", () => {
    const editable = genericArtifactCompatibleStatusOptions([
      {
        kind: GenericArtifactKind.Document,
        status: GenericArtifactStatus.Draft,
      },
      {
        kind: GenericArtifactKind.Issue,
        status: GenericArtifactStatus.Todo,
      },
    ]).map((option) => option.key);
    expect(editable).toEqual([ARTIFACT_STATUS_ROOT.InReview]);
    expect(
      genericArtifactCompatibleStatusOptions([
        {
          kind: GenericArtifactKind.Issue,
          status: GenericArtifactStatus.Todo,
        },
        {
          kind: GenericArtifactKind.Branch,
          status: GenericArtifactStatus.Active,
        },
      ])
    ).toEqual([]);
  });

  it("offers a creation root default only when that kind has a root-only raw value", () => {
    for (const kind of Object.values(GenericArtifactKind)) {
      const options = genericArtifactStatusOptions(kind);
      const source = { kind, status: options[0]! };
      const capability = genericArtifactStatusCapability(source);
      for (const facet of genericArtifactRootFacets([kind])) {
        const status = genericArtifactStatusDefaultForRoot(
          kind,
          facet.normalized.root
        );
        const hasRootOnlyRawValue =
          capability.editable &&
          options.some((option) => {
            const normalized = genericArtifactStatusFacet({
              kind,
              status: option,
            }).normalized;
            return (
              normalized.root === facet.normalized.root &&
              normalized.detail === undefined
            );
          });
        expect(status !== null).toBe(hasRootOnlyRawValue);
        if (status !== null) {
          expect(
            genericArtifactStatusFacet({ kind, status }).normalized
          ).toEqual({ root: facet.normalized.root });
        }
      }
    }
  });
});

describe("generic artifact status edge resolution", () => {
  it("resolves an unknown root facet from the first represented kind or Issue", () => {
    expect(
      genericArtifactRootFacet(DISPLAYED_ARTIFACT_STATUS.Unknown, [
        GenericArtifactKind.Branch,
      ])
    ).toEqual({
      normalized: UNKNOWN_ARTIFACT_STATUS,
      raw: null,
      vocabulary: ArtifactStatusVocabulary.Branch,
    });
    expect(
      genericArtifactRootFacet(DISPLAYED_ARTIFACT_STATUS.Unknown, [])
    ).toEqual({
      normalized: UNKNOWN_ARTIFACT_STATUS,
      raw: null,
      vocabulary: ArtifactStatusVocabulary.Issue,
    });
    expect(
      genericArtifactRootFacet(ARTIFACT_STATUS_ROOT.Todo, [
        GenericArtifactKind.Session,
      ])
    ).toBeNull();
  });

  it("resolves stored filter keys to root, detail, or nothing", () => {
    expect(
      genericArtifactFacetForKey(
        [GenericArtifactKind.Document],
        ARTIFACT_STATUS_DETAIL.DocumentExecuted
      )?.normalized
    ).toEqual({
      root: ARTIFACT_STATUS_ROOT.Done,
      detail: ARTIFACT_STATUS_DETAIL.DocumentExecuted,
    });
    expect(
      genericArtifactFacetForKey([GenericArtifactKind.Issue], "no-such-key")
    ).toBeNull();
  });

  it("appends the unknown filter key only when requested", () => {
    const keys = genericArtifactFilterKeys([GenericArtifactKind.Session], true);
    expect(keys.at(-1)).toBe(DISPLAYED_ARTIFACT_STATUS.Unknown);
    expect(
      genericArtifactFilterKeys([GenericArtifactKind.Session], false)
    ).toEqual(keys.slice(0, -1));
  });

  it("maps a raw editor target back to the first matching fixture alias", () => {
    expect(
      genericArtifactStatusFromRaw(
        GenericArtifactKind.Document,
        DocumentStatus.Approved
      )
    ).toBe(GenericArtifactStatus.Approved);
    expect(
      genericArtifactStatusFromRaw(GenericArtifactKind.Issue, "NOT_A_STATUS")
    ).toBeNull();
  });

  it("refuses a root move or creation default for a non-root key", () => {
    const issue = {
      kind: GenericArtifactKind.Issue,
      status: GenericArtifactStatus.Todo,
    };
    expect(genericArtifactStatusForRoot(issue, "not-a-root")).toBeNull();
    expect(genericArtifactStatusForRoot(issue, ARTIFACT_STATUS_ROOT.Done)).toBe(
      GenericArtifactStatus.Done
    );
    expect(
      genericArtifactStatusDefaultForRoot(
        GenericArtifactKind.Issue,
        "not-a-root"
      )
    ).toBeNull();
    expect(
      genericArtifactStatusDefaultForRoot(
        GenericArtifactKind.Issue,
        ARTIFACT_STATUS_ROOT.InProgress
      )
    ).toBe(GenericArtifactStatus.InProgress);
  });

  it("refuses a selection on a read-only vocabulary", () => {
    const branch = {
      kind: GenericArtifactKind.Branch,
      status: GenericArtifactStatus.Active,
    };
    expect(genericArtifactStatusCapability(branch).editable).toBe(false);
    expect(
      genericArtifactStatusForSelection(
        branch,
        ARTIFACT_STATUS_DETAIL.BranchPrOpen
      )
    ).toBeNull();
    expect(genericArtifactCompatibleStatusOptions([])).toEqual([]);
  });

  it("rejects a legacy key whose fixture word is not a status", () => {
    const key = "legacy-preview:Nonsense";
    expect(isGenericArtifactStatusKey(key)).toBe(false);
    expect(genericArtifactStatusRouteKey("Nonsense")).toBeNull();
    expect(genericArtifactStatusKeyLabel(key)).toBe(
      ARTIFACT_STATUS_DISPLAY_LABELS.unknown
    );
    expect(
      genericArtifactStatusMatchesKey(
        { kind: GenericArtifactKind.Issue, status: GenericArtifactStatus.Todo },
        key
      )
    ).toBe(false);
  });

  it("ranks raw values by the vocabulary's own order", () => {
    expect(
      genericArtifactStatusRawRank({
        kind: GenericArtifactKind.Branch,
        status: GenericArtifactStatus.InReview,
      })
    ).toBe(branchStatusRank(BranchStatus.Review));
    expect(
      genericArtifactStatusRawRank({
        kind: GenericArtifactKind.Document,
        status: GenericArtifactStatus.Completed,
      })
    ).toBe(statusDisplayRank(DocumentStatus.Executed));
    expect(
      genericArtifactStatusRawRank({
        kind: GenericArtifactKind.Issue,
        status: GenericArtifactStatus.Blocked,
      })
    ).toBe(statusDisplayRank(IssueStatus.Blocked));
    expect(
      genericArtifactStatusRawRank({
        kind: GenericArtifactKind.Session,
        status: GenericArtifactStatus.Failed,
      })
    ).toBe(sessionStatusRank(SESSION_STATUS.ERROR));
    expect(
      genericArtifactStatusRawRank({
        kind: GenericArtifactKind.Issue,
        status: GenericArtifactStatus.Failed,
      })
    ).toBeNull();
  });
});
