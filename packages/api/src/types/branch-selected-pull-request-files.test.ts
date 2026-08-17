import { describe, expect, it } from "vitest";
import {
  BranchSelectedPullRequestAcquisitionUnavailableReason,
  BranchSelectedPullRequestCompletenessUnavailableReason,
  BranchSelectedPullRequestFileCompleteness,
  BranchSelectedPullRequestFilePartialReason,
  BranchSelectedPullRequestGrossTotalAvailability,
  BranchSelectedPullRequestReadAvailability,
  BranchSelectedPullRequestUnavailableSource,
  branchSelectedPullRequestAcquisitionUnavailable,
  branchSelectedPullRequestDiffQuerySchema,
  branchSelectedPullRequestFilesQuerySchema,
  projectBranchSelectedPullRequestDiff,
  projectBranchSelectedPullRequestFiles,
} from "./branch-selected-pull-request-files.ts";
import {
  SelectedPullRequestContentAvailability,
  SelectedPullRequestContentClassification,
  SelectedPullRequestContentNotApplicableReason,
  SelectedPullRequestContentReferenceAvailability,
  SelectedPullRequestContentUnavailableReason,
  type SelectedPullRequestEvidence,
  SelectedPullRequestFileCompleteness,
  SelectedPullRequestFileContentEvidenceAvailability,
  type SelectedPullRequestFileContentEvidenceResult,
  SelectedPullRequestFilePartialReason,
  SelectedPullRequestFileStatus,
  SelectedPullRequestPatchAvailability,
  SelectedPullRequestPatchOmissionReason,
} from "./selected-pull-request-evidence.ts";

const BASE_SHA = "a".repeat(40);
const HEAD_SHA = "b".repeat(40);

describe("Branch selected-PR query schemas", () => {
  it("canonicalizes repository and revision identity", () => {
    expect(
      branchSelectedPullRequestDiffQuerySchema.parse({
        repositoryFullName: " /ClosedLoop-AI/Symphony-Alpha.git/ ",
        pullRequestNumber: "4471",
        path: "apps/api/a file.ts",
        baseSha: BASE_SHA.toUpperCase(),
        headSha: HEAD_SHA.toUpperCase(),
      })
    ).toEqual({
      repositoryFullName: "closedloop-ai/symphony-alpha",
      pullRequestNumber: 4471,
      path: "apps/api/a file.ts",
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
    });
  });

  it("rejects malformed and unsupported query fields", () => {
    expect(
      branchSelectedPullRequestFilesQuerySchema.safeParse({
        repositoryFullName: "owner/repo/extra",
        pullRequestNumber: 1,
      }).success
    ).toBe(false);
    expect(
      branchSelectedPullRequestDiffQuerySchema.safeParse({
        repositoryFullName: "owner/repo",
        pullRequestNumber: 1,
        path: "file.ts",
        baseSha: "short",
        headSha: HEAD_SHA,
        unsupported: true,
      }).success
    ).toBe(false);
  });
});

describe("branchSelectedPullRequestAcquisitionUnavailable", () => {
  it("requires and preserves a positive retry interval", () => {
    expect(
      branchSelectedPullRequestAcquisitionUnavailable(
        BranchSelectedPullRequestAcquisitionUnavailableReason.BudgetExhausted,
        2
      )
    ).toEqual({
      status: BranchSelectedPullRequestReadAvailability.Unavailable,
      source: BranchSelectedPullRequestUnavailableSource.Acquisition,
      reason:
        BranchSelectedPullRequestAcquisitionUnavailableReason.BudgetExhausted,
      retryAfterSeconds: 2,
    });
    expect(() =>
      branchSelectedPullRequestAcquisitionUnavailable(
        BranchSelectedPullRequestAcquisitionUnavailableReason.BudgetExhausted,
        0
      )
    ).toThrow(RangeError);
  });
});

describe("projectBranchSelectedPullRequestFiles", () => {
  it("marks exact landed-complete evidence complete with complete gross totals", () => {
    const result = projectBranchSelectedPullRequestFiles(evidence(), 2);

    expect(result.status).toBe(
      BranchSelectedPullRequestReadAvailability.Available
    );
    if (result.status !== BranchSelectedPullRequestReadAvailability.Available) {
      throw new Error("Expected available files evidence");
    }
    expect(result.value.coverage).toEqual({
      completeness: BranchSelectedPullRequestFileCompleteness.Complete,
      reasons: [],
    });
    expect(result.value.counts).toEqual({
      expected: 2,
      loaded: 2,
      providerExpected: 2,
      providerReturned: 2,
    });
    expect(result.value.grossTotals).toEqual({
      additions: {
        availability: BranchSelectedPullRequestGrossTotalAvailability.Available,
        value: 4,
        completeness: BranchSelectedPullRequestFileCompleteness.Complete,
      },
      deletions: {
        availability: BranchSelectedPullRequestGrossTotalAvailability.Available,
        value: 6,
        completeness: BranchSelectedPullRequestFileCompleteness.Complete,
      },
    });
  });

  it("projects slim rows without provider patches or content references", () => {
    const value = availableValue(
      projectBranchSelectedPullRequestFiles(
        evidence({
          files: [file({ previousPath: "old-file.ts" })],
        }),
        1
      )
    );

    expect(value.files).toEqual([
      {
        path: "file.ts",
        previousPath: "old-file.ts",
        providerStatus: SelectedPullRequestFileStatus.Modified,
        status: SelectedPullRequestFileStatus.Modified,
        additions: 2,
        deletions: 3,
        changes: 5,
      },
    ]);
  });

  it("never upgrades equal-count landed-partial evidence", () => {
    const result = projectBranchSelectedPullRequestFiles(
      evidence({
        completeness: SelectedPullRequestFileCompleteness.Partial,
        reasons: [SelectedPullRequestFilePartialReason.MalformedFile],
      }),
      2
    );

    expect(availableValue(result).coverage).toEqual({
      completeness: BranchSelectedPullRequestFileCompleteness.Incomplete,
      reasons: [SelectedPullRequestFilePartialReason.MalformedFile],
    });
  });

  it("uses persisted expected count for the exact 300/450 case", () => {
    const selectedEvidence = evidence({
      expected: 300,
      normalizedReturned: 300,
      providerReturned: 300,
      files: [file({ additions: 7, deletions: 2 })],
    });
    const result = projectBranchSelectedPullRequestFiles(selectedEvidence, 450);
    const value = availableValue(result);

    expect(value.counts).toMatchObject({
      expected: 450,
      loaded: 300,
      providerExpected: 300,
    });
    expect(value.coverage).toEqual({
      completeness: BranchSelectedPullRequestFileCompleteness.Incomplete,
      reasons: [
        BranchSelectedPullRequestFilePartialReason.PersistedExpectedCountMismatch,
      ],
    });
    expect(value.grossTotals.additions).toEqual({
      availability: BranchSelectedPullRequestGrossTotalAvailability.Available,
      value: 7,
      completeness: BranchSelectedPullRequestFileCompleteness.Incomplete,
    });
  });

  it("keeps provider and persisted count mismatches distinguishable", () => {
    const result = projectBranchSelectedPullRequestFiles(
      evidence({
        completeness: SelectedPullRequestFileCompleteness.Partial,
        normalizedReturned: 1,
        reasons: [SelectedPullRequestFilePartialReason.CountMismatch],
      }),
      2
    );

    expect(availableValue(result).coverage).toEqual({
      completeness: BranchSelectedPullRequestFileCompleteness.Incomplete,
      reasons: [
        SelectedPullRequestFilePartialReason.CountMismatch,
        BranchSelectedPullRequestFilePartialReason.PersistedExpectedCountMismatch,
      ],
    });
  });

  it.each([
    {
      name: "missing expected",
      expected: null,
      loaded: 2,
      reason:
        BranchSelectedPullRequestCompletenessUnavailableReason.MissingExpectedCount,
    },
    {
      name: "invalid expected",
      expected: -1,
      loaded: 2,
      reason:
        BranchSelectedPullRequestCompletenessUnavailableReason.InvalidExpectedCount,
    },
    {
      name: "loaded exceeds expected",
      expected: 1,
      loaded: 2,
      reason:
        BranchSelectedPullRequestCompletenessUnavailableReason.LoadedExceedsExpected,
    },
  ])("keeps $name distinct from partial", ({ expected, loaded, reason }) => {
    const result = projectBranchSelectedPullRequestFiles(
      evidence({ normalizedReturned: loaded }),
      expected
    );

    expect(availableValue(result).coverage).toEqual({
      completeness: BranchSelectedPullRequestFileCompleteness.Unavailable,
      reason,
    });
  });

  it("keeps missing row contributions unavailable instead of zero", () => {
    const result = projectBranchSelectedPullRequestFiles(
      evidence({
        files: [
          file({ additions: 2, deletions: null }),
          file({ path: "second.ts", additions: null, deletions: null }),
        ],
      }),
      2
    );
    const totals = availableValue(result).grossTotals;

    expect(totals.additions).toEqual({
      availability: BranchSelectedPullRequestGrossTotalAvailability.Available,
      value: 2,
      completeness: BranchSelectedPullRequestFileCompleteness.Incomplete,
    });
    expect(totals.deletions).toEqual({
      availability: BranchSelectedPullRequestGrossTotalAvailability.Unavailable,
    });
  });

  it("treats complete zero-file evidence as known zero", () => {
    const result = projectBranchSelectedPullRequestFiles(
      evidence({
        expected: 0,
        normalizedReturned: 0,
        providerReturned: 0,
        files: [],
      }),
      0
    );

    expect(availableValue(result).grossTotals.additions).toEqual({
      availability: BranchSelectedPullRequestGrossTotalAvailability.Available,
      value: 0,
      completeness: BranchSelectedPullRequestFileCompleteness.Complete,
    });
  });
});

describe("projectBranchSelectedPullRequestDiff", () => {
  it("projects text and explicit added/removed sides without guessing binary", () => {
    const added = projectBranchSelectedPullRequestDiff(
      evidence(),
      contentEvidence({
        base: {
          availability: SelectedPullRequestContentAvailability.NotApplicable,
          reason: SelectedPullRequestContentNotApplicableReason.AddedFile,
        },
      })
    );
    expect(availableDiff(added).diff).toMatchObject({
      oldContent: "",
      newContent: "new content",
      isNew: true,
      isDeleted: false,
      isBinary: false,
    });

    const removed = projectBranchSelectedPullRequestDiff(
      evidence(),
      contentEvidence({
        head: {
          availability: SelectedPullRequestContentAvailability.NotApplicable,
          reason: SelectedPullRequestContentNotApplicableReason.RemovedFile,
        },
      })
    );
    expect(availableDiff(removed).diff).toMatchObject({
      oldContent: "old content",
      newContent: "",
      isNew: false,
      isDeleted: true,
    });
  });

  it("preserves applicable-side unavailability instead of coercing empty content", () => {
    const content = contentEvidence({
      head: {
        availability: SelectedPullRequestContentAvailability.Unavailable,
        reason: SelectedPullRequestContentUnavailableReason.ContentTooLarge,
      },
    });
    const result = projectBranchSelectedPullRequestDiff(evidence(), content);

    expect(result).toEqual({
      status: BranchSelectedPullRequestReadAvailability.Unavailable,
      source: BranchSelectedPullRequestUnavailableSource.ContentSides,
      identity: evidence().identity,
      revision: evidence().revision,
      content: content.value,
    });
  });

  it.each([
    {
      name: "modified",
      overrides: {
        base: binaryContent(),
        head: binaryContent(),
      },
      expected: { isNew: false, isDeleted: false },
    },
    {
      name: "added",
      overrides: {
        base: {
          availability: SelectedPullRequestContentAvailability.NotApplicable,
          reason: SelectedPullRequestContentNotApplicableReason.AddedFile,
        },
        head: binaryContent(),
      },
      expected: { isNew: true, isDeleted: false },
    },
    {
      name: "removed",
      overrides: {
        base: binaryContent(),
        head: {
          availability: SelectedPullRequestContentAvailability.NotApplicable,
          reason: SelectedPullRequestContentNotApplicableReason.RemovedFile,
        },
      },
      expected: { isNew: false, isDeleted: true },
    },
    {
      name: "text to binary",
      overrides: { head: binaryContent() },
      expected: { isNew: false, isDeleted: false },
    },
    {
      name: "binary to text",
      overrides: { base: binaryContent() },
      expected: { isNew: false, isDeleted: false },
    },
  ])("projects confirmed $name content as binary without source strings", ({
    overrides,
    expected,
  }) => {
    const result = projectBranchSelectedPullRequestDiff(
      evidence(),
      contentEvidence(overrides)
    );

    expect(availableDiff(result).diff).toMatchObject({
      oldContent: "",
      newContent: "",
      isBinary: true,
      ...expected,
    });
  });

  it.each([
    {
      name: "explicit unknown",
      side: unknownContent(),
    },
    {
      name: "ordinary unavailable beside binary",
      side: {
        availability: SelectedPullRequestContentAvailability.Unavailable,
        reason: SelectedPullRequestContentUnavailableReason.ContentTooLarge,
      },
      base: binaryContent(),
    },
    {
      name: "unknown beside binary",
      side: unknownContent(),
      base: binaryContent(),
    },
  ])("fails closed for $name", ({ side, base }) => {
    const content = contentEvidence({
      ...(base === undefined ? {} : { base }),
      head: side,
    });
    const result = projectBranchSelectedPullRequestDiff(evidence(), content);

    expect(result).toMatchObject({
      status: BranchSelectedPullRequestReadAvailability.Unavailable,
      source: BranchSelectedPullRequestUnavailableSource.ContentSides,
    });
  });

  it("fails closed for an unrecognized future classification", () => {
    const content = contentEvidence();
    Reflect.set(content.value.head, "classification", "future_classification");

    expect(
      projectBranchSelectedPullRequestDiff(evidence(), content)
    ).toMatchObject({
      status: BranchSelectedPullRequestReadAvailability.Unavailable,
      source: BranchSelectedPullRequestUnavailableSource.ContentSides,
    });
  });

  it("preserves omitted classification as the legacy text alias", () => {
    const result = projectBranchSelectedPullRequestDiff(
      evidence(),
      contentEvidence()
    );

    expect(availableDiff(result).diff).toMatchObject({
      oldContent: "old content",
      newContent: "new content",
      isBinary: false,
    });
  });

  it("projects the new producer's explicit text classification", () => {
    const result = projectBranchSelectedPullRequestDiff(
      evidence(),
      contentEvidence({
        base: {
          availability: SelectedPullRequestContentAvailability.Available,
          classification: SelectedPullRequestContentClassification.Text,
          content: "explicit old content",
        },
        head: {
          availability: SelectedPullRequestContentAvailability.Available,
          classification: SelectedPullRequestContentClassification.Text,
          content: "explicit new content",
        },
      })
    );

    expect(availableDiff(result).diff).toMatchObject({
      oldContent: "explicit old content",
      newContent: "explicit new content",
      isBinary: false,
    });
  });

  it("preserves file-membership operation unavailability", () => {
    const result = projectBranchSelectedPullRequestDiff(evidence(), {
      status: SelectedPullRequestFileContentEvidenceAvailability.Unavailable,
      reason:
        SelectedPullRequestContentUnavailableReason.FileMembershipIncomplete,
    });

    expect(result).toEqual({
      status: BranchSelectedPullRequestReadAvailability.Unavailable,
      source: BranchSelectedPullRequestUnavailableSource.Content,
      reason:
        SelectedPullRequestContentUnavailableReason.FileMembershipIncomplete,
    });
  });
});

function evidence(
  overrides: {
    expected?: number | null;
    providerReturned?: number;
    normalizedReturned?: number;
    completeness?: SelectedPullRequestFileCompleteness;
    reasons?: SelectedPullRequestFilePartialReason[];
    files?: SelectedPullRequestEvidence["files"];
  } = {}
): SelectedPullRequestEvidence {
  const files = overrides.files ?? [file(), file({ path: "second.ts" })];
  return {
    identity: {
      githubId: "123",
      repositoryFullName: "closedloop-ai/symphony-alpha",
      number: 4471,
      url: "https://github.com/closedloop-ai/symphony-alpha/pull/4471",
    },
    revision: { baseSha: BASE_SHA, headSha: HEAD_SHA },
    files,
    counts: {
      expected:
        overrides.expected === undefined ? files.length : overrides.expected,
      providerReturned: overrides.providerReturned ?? files.length,
      normalizedReturned: overrides.normalizedReturned ?? files.length,
    },
    pagination: {
      pageSize: 100,
      pagesFetched: 1,
      providerMaximum: 3000,
      reachedProviderMaximum: false,
    },
    coverage: {
      completeness:
        overrides.completeness ?? SelectedPullRequestFileCompleteness.Complete,
      reasons: overrides.reasons ?? [],
    },
  };
}

function file(
  overrides: Partial<SelectedPullRequestEvidence["files"][number]> = {}
): SelectedPullRequestEvidence["files"][number] {
  return {
    path: "file.ts",
    providerStatus: SelectedPullRequestFileStatus.Modified,
    status: SelectedPullRequestFileStatus.Modified,
    additions: 2,
    deletions: 3,
    changes: 5,
    patch: {
      availability: SelectedPullRequestPatchAvailability.Omitted,
      reason: SelectedPullRequestPatchOmissionReason.ProviderOmitted,
    },
    baseContent: {
      availability: SelectedPullRequestContentReferenceAvailability.Available,
      path: "file.ts",
      ref: BASE_SHA,
    },
    headContent: {
      availability: SelectedPullRequestContentReferenceAvailability.Available,
      path: "file.ts",
      ref: HEAD_SHA,
    },
    ...overrides,
  };
}

function contentEvidence(
  overrides: Partial<
    Extract<
      SelectedPullRequestFileContentEvidenceResult,
      {
        status: typeof SelectedPullRequestFileContentEvidenceAvailability.Available;
      }
    >["value"]
  > = {}
): Extract<
  SelectedPullRequestFileContentEvidenceResult,
  {
    status: typeof SelectedPullRequestFileContentEvidenceAvailability.Available;
  }
> {
  return {
    status: SelectedPullRequestFileContentEvidenceAvailability.Available,
    value: {
      file: file(),
      base: {
        availability: SelectedPullRequestContentAvailability.Available,
        content: "old content",
      },
      head: {
        availability: SelectedPullRequestContentAvailability.Available,
        content: "new content",
      },
      ...overrides,
    },
  };
}

function binaryContent() {
  return {
    availability: SelectedPullRequestContentAvailability.Unavailable,
    classification: SelectedPullRequestContentClassification.Binary,
    reason: SelectedPullRequestContentUnavailableReason.BinaryContent,
  } as const;
}

function unknownContent() {
  return {
    availability: SelectedPullRequestContentAvailability.Unavailable,
    classification: SelectedPullRequestContentClassification.Unknown,
    reason:
      SelectedPullRequestContentUnavailableReason.ContentClassificationUnknown,
  } as const;
}

function availableValue(
  result: ReturnType<typeof projectBranchSelectedPullRequestFiles>
) {
  if (result.status !== BranchSelectedPullRequestReadAvailability.Available) {
    throw new Error("Expected available files response");
  }
  return result.value;
}

function availableDiff(
  result: ReturnType<typeof projectBranchSelectedPullRequestDiff>
) {
  if (result.status !== BranchSelectedPullRequestReadAvailability.Available) {
    throw new Error("Expected available diff response");
  }
  return result.value;
}
