/** Availability of one selected-pull-request provider read. */
export const SelectedPullRequestEvidenceAvailability = {
  Available: "available",
  Unavailable: "unavailable",
} as const;
export type SelectedPullRequestEvidenceAvailability =
  (typeof SelectedPullRequestEvidenceAvailability)[keyof typeof SelectedPullRequestEvidenceAvailability];

/** Closed reasons why selected-pull-request evidence could not be returned. */
export const SelectedPullRequestEvidenceUnavailableReason = {
  CredentialInsufficientScope: "credential_insufficient_scope",
  CredentialUnauthorized: "credential_unauthorized",
  MalformedRequest: "malformed_request",
  MalformedResponse: "malformed_response",
  MissingImmutableRevision: "missing_immutable_revision",
  ProviderFailure: "provider_failure",
  ProviderRateLimited: "provider_rate_limited",
  ProviderTimedOut: "provider_timed_out",
  ProviderUnavailable: "provider_unavailable",
  PullRequestMissingOrInaccessible: "pull_request_missing_or_inaccessible",
  SelectedRevisionMissingOrInaccessible:
    "selected_revision_missing_or_inaccessible",
  StaleRevision: "stale_revision",
} as const;
export type SelectedPullRequestEvidenceUnavailableReason =
  (typeof SelectedPullRequestEvidenceUnavailableReason)[keyof typeof SelectedPullRequestEvidenceUnavailableReason];

/** Truthfulness state for PR-scoped file membership. */
export const SelectedPullRequestFileCompleteness = {
  Complete: "complete",
  Partial: "partial",
} as const;
export type SelectedPullRequestFileCompleteness =
  (typeof SelectedPullRequestFileCompleteness)[keyof typeof SelectedPullRequestFileCompleteness];

/** Reasons why returned PR-file membership is not complete. */
export const SelectedPullRequestFilePartialReason = {
  CountMismatch: "count_mismatch",
  MalformedFile: "malformed_file",
  ProviderCapped: "provider_capped",
} as const;
export type SelectedPullRequestFilePartialReason =
  (typeof SelectedPullRequestFilePartialReason)[keyof typeof SelectedPullRequestFilePartialReason];

/** Normalized GitHub pull-request file status, including a safe future fallback. */
export const SelectedPullRequestFileStatus = {
  Added: "added",
  Changed: "changed",
  Copied: "copied",
  Modified: "modified",
  Removed: "removed",
  Renamed: "renamed",
  Unchanged: "unchanged",
  Unknown: "unknown",
} as const;
export type SelectedPullRequestFileStatus =
  (typeof SelectedPullRequestFileStatus)[keyof typeof SelectedPullRequestFileStatus];

/** Whether GitHub included a textual patch for a changed file. */
export const SelectedPullRequestPatchAvailability = {
  Available: "patch_available",
  Omitted: "patch_omitted",
} as const;
export type SelectedPullRequestPatchAvailability =
  (typeof SelectedPullRequestPatchAvailability)[keyof typeof SelectedPullRequestPatchAvailability];

/** Why a textual patch is absent without claiming the file is binary. */
export const SelectedPullRequestPatchOmissionReason = {
  ProviderOmitted: "provider_omitted",
} as const;
export type SelectedPullRequestPatchOmissionReason =
  (typeof SelectedPullRequestPatchOmissionReason)[keyof typeof SelectedPullRequestPatchOmissionReason];

/** Availability of one immutable content reference for a selected file. */
export const SelectedPullRequestContentReferenceAvailability = {
  Available: "reference_available",
  NotApplicable: "not_applicable",
} as const;
export type SelectedPullRequestContentReferenceAvailability =
  (typeof SelectedPullRequestContentReferenceAvailability)[keyof typeof SelectedPullRequestContentReferenceAvailability];

/** Why one side of a selected-file comparison has no content reference. */
export const SelectedPullRequestContentNotApplicableReason = {
  AddedFile: "added_file",
  RemovedFile: "removed_file",
} as const;
export type SelectedPullRequestContentNotApplicableReason =
  (typeof SelectedPullRequestContentNotApplicableReason)[keyof typeof SelectedPullRequestContentNotApplicableReason];

/** Result state for an attempted immutable content read. */
export const SelectedPullRequestContentAvailability = {
  Available: "content_available",
  NotApplicable: "not_applicable",
  Unavailable: "content_unavailable",
} as const;
export type SelectedPullRequestContentAvailability =
  (typeof SelectedPullRequestContentAvailability)[keyof typeof SelectedPullRequestContentAvailability];

/** Conservative semantic classification for bounded selected-PR file bytes. */
export const SelectedPullRequestContentClassification = {
  Binary: "binary",
  Text: "text",
  Unknown: "unknown",
} as const;
export type SelectedPullRequestContentClassification =
  (typeof SelectedPullRequestContentClassification)[keyof typeof SelectedPullRequestContentClassification];

/** Closed reasons why an expected selected-file content read is unavailable. */
export const SelectedPullRequestContentUnavailableReason = {
  BinaryContent: "binary_content",
  ContentClassificationUnknown: "content_classification_unknown",
  ContentTooLarge: "content_too_large",
  CredentialInsufficientScope: "credential_insufficient_scope",
  CredentialUnauthorized: "credential_unauthorized",
  FileNotInPullRequest: "file_not_in_pull_request",
  FileMembershipIncomplete: "file_membership_incomplete",
  MalformedRequest: "malformed_request",
  MissingContent: "missing_content",
  NotAFile: "not_a_file",
  ProviderFailure: "provider_failure",
  ProviderRateLimited: "provider_rate_limited",
  ProviderUnavailable: "provider_unavailable",
  UnsupportedEncoding: "unsupported_encoding",
} as const;
export type SelectedPullRequestContentUnavailableReason =
  (typeof SelectedPullRequestContentUnavailableReason)[keyof typeof SelectedPullRequestContentUnavailableReason];

/** Unavailable reasons that do not require a matching content classification. */
export type SelectedPullRequestOrdinaryContentUnavailableReason = Exclude<
  SelectedPullRequestContentUnavailableReason,
  | typeof SelectedPullRequestContentUnavailableReason.BinaryContent
  | typeof SelectedPullRequestContentUnavailableReason.ContentClassificationUnknown
>;

/** Availability of the selected-file content operation itself. */
export const SelectedPullRequestFileContentEvidenceAvailability = {
  Available: "available",
  Unavailable: "unavailable",
} as const;
export type SelectedPullRequestFileContentEvidenceAvailability =
  (typeof SelectedPullRequestFileContentEvidenceAvailability)[keyof typeof SelectedPullRequestFileContentEvidenceAvailability];

/** Canonical repository-qualified identity reusable by selected-PR evidence lanes. */
export type SelectedPullRequestIdentity = {
  githubId: string;
  repositoryFullName: string;
  number: number;
  url: string;
};

/** Immutable comparison revisions for one stable selected-PR observation. */
export type SelectedPullRequestRevision = {
  baseSha: string;
  headSha: string;
};

/** Reference to content at one immutable selected-PR comparison side. */
export type SelectedPullRequestContentReference =
  | {
      availability: typeof SelectedPullRequestContentReferenceAvailability.Available;
      path: string;
      ref: string;
    }
  | {
      availability: typeof SelectedPullRequestContentReferenceAvailability.NotApplicable;
      reason: SelectedPullRequestContentNotApplicableReason;
    };

/** Provider patch evidence for one normalized PR file. */
export type SelectedPullRequestPatchEvidence =
  | {
      availability: typeof SelectedPullRequestPatchAvailability.Available;
      patch: string;
    }
  | {
      availability: typeof SelectedPullRequestPatchAvailability.Omitted;
      reason: SelectedPullRequestPatchOmissionReason;
    };

/** One valid normalized file belonging to the selected pull request. */
export type SelectedPullRequestFile = {
  path: string;
  previousPath?: string;
  providerStatus: string;
  status: SelectedPullRequestFileStatus;
  additions: number | null;
  deletions: number | null;
  changes: number | null;
  patch: SelectedPullRequestPatchEvidence;
  baseContent: SelectedPullRequestContentReference;
  headContent: SelectedPullRequestContentReference;
};

/** Explicit provider pagination evidence for a PR-file collection. */
export type SelectedPullRequestFilePagination = {
  pageSize: number;
  pagesFetched: number;
  providerMaximum: number;
  reachedProviderMaximum: boolean;
};

/** Count reconciliation between PR metadata, provider rows, and valid output rows. */
export type SelectedPullRequestFileCounts = {
  expected: number | null;
  providerReturned: number;
  normalizedReturned: number;
};

/** Complete or explicitly partial file-membership evidence. */
export type SelectedPullRequestFileCoverage = {
  completeness: SelectedPullRequestFileCompleteness;
  reasons: readonly SelectedPullRequestFilePartialReason[];
};

/** Stable selected-PR revision and PR-scoped file evidence. */
export type SelectedPullRequestEvidence = {
  identity: SelectedPullRequestIdentity;
  revision: SelectedPullRequestRevision;
  files: readonly SelectedPullRequestFile[];
  counts: SelectedPullRequestFileCounts;
  pagination: SelectedPullRequestFilePagination;
  coverage: SelectedPullRequestFileCoverage;
};

/** Provider result that never fabricates selected-PR evidence on failure. */
export type SelectedPullRequestEvidenceResult =
  | {
      status: typeof SelectedPullRequestEvidenceAvailability.Available;
      value: SelectedPullRequestEvidence;
    }
  | {
      status: typeof SelectedPullRequestEvidenceAvailability.Unavailable;
      reason: SelectedPullRequestEvidenceUnavailableReason;
      retryAfterSeconds?: number | null;
    };

/** One side of an immutable selected-file content result. */
export type SelectedPullRequestContentResult =
  | {
      availability: typeof SelectedPullRequestContentAvailability.Available;
      content: string;
      classification?: typeof SelectedPullRequestContentClassification.Text;
    }
  | {
      availability: typeof SelectedPullRequestContentAvailability.NotApplicable;
      reason: SelectedPullRequestContentNotApplicableReason;
    }
  | {
      availability: typeof SelectedPullRequestContentAvailability.Unavailable;
      classification: typeof SelectedPullRequestContentClassification.Binary;
      reason: typeof SelectedPullRequestContentUnavailableReason.BinaryContent;
    }
  | {
      availability: typeof SelectedPullRequestContentAvailability.Unavailable;
      classification: typeof SelectedPullRequestContentClassification.Unknown;
      reason: typeof SelectedPullRequestContentUnavailableReason.ContentClassificationUnknown;
    }
  | {
      availability: typeof SelectedPullRequestContentAvailability.Unavailable;
      reason: SelectedPullRequestOrdinaryContentUnavailableReason;
      retryAfterSeconds?: number | null;
    };

/** Immutable base/head content evidence for one selected PR file. */
export type SelectedPullRequestFileContentEvidence = {
  file: SelectedPullRequestFile;
  base: SelectedPullRequestContentResult;
  head: SelectedPullRequestContentResult;
};

/** Operation result that keeps one-side content states under base and head. */
export type SelectedPullRequestFileContentEvidenceResult =
  | {
      status: typeof SelectedPullRequestFileContentEvidenceAvailability.Available;
      value: SelectedPullRequestFileContentEvidence;
    }
  | {
      status: typeof SelectedPullRequestFileContentEvidenceAvailability.Unavailable;
      reason: SelectedPullRequestOrdinaryContentUnavailableReason;
    };
