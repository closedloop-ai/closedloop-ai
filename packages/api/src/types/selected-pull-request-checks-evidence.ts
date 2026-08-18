import type {
  SelectedPullRequestEvidenceAvailability,
  SelectedPullRequestEvidenceUnavailableReason,
  SelectedPullRequestIdentity,
  SelectedPullRequestRevision,
} from "./selected-pull-request-evidence.ts";

/** GitHub provider node kinds included in selected-PR checks evidence. */
export const SelectedPullRequestCheckSourceKind = {
  CheckRun: "check_run",
  StatusContext: "status_context",
} as const;
export type SelectedPullRequestCheckSourceKind =
  (typeof SelectedPullRequestCheckSourceKind)[keyof typeof SelectedPullRequestCheckSourceKind];

/** Mutually exclusive summary bucket for one emitted check row. */
export const SelectedPullRequestCheckCategory = {
  Failing: "failing",
  Neutral: "neutral",
  Pending: "pending",
  Successful: "successful",
} as const;
export type SelectedPullRequestCheckCategory =
  (typeof SelectedPullRequestCheckCategory)[keyof typeof SelectedPullRequestCheckCategory];

/** Truthfulness state for the provider-visible selected-head check set. */
export const SelectedPullRequestChecksCompleteness = {
  Complete: "complete",
  Partial: "partial",
} as const;
export type SelectedPullRequestChecksCompleteness =
  (typeof SelectedPullRequestChecksCompleteness)[keyof typeof SelectedPullRequestChecksCompleteness];

/** Reasons why returned selected-head checks cannot claim complete coverage. */
export const SelectedPullRequestChecksPartialReason = {
  AcquisitionCapped: "acquisition_capped",
  AmbiguousSource: "ambiguous_source",
  CountMismatch: "count_mismatch",
  DuplicateProviderId: "duplicate_provider_id",
  MalformedContext: "malformed_context",
  PaginationStalled: "pagination_stalled",
  ProviderPageFailure: "provider_page_failure",
  UnknownOutcome: "unknown_outcome",
} as const;
export type SelectedPullRequestChecksPartialReason =
  (typeof SelectedPullRequestChecksPartialReason)[keyof typeof SelectedPullRequestChecksPartialReason];

/** Explicit attempt-selection semantics for emitted selected-head check rows. */
export const SelectedPullRequestChecksHistoryMode = {
  LatestPerSourceFromProviderRollup: "latest_per_source_from_provider_rollup",
} as const;
export type SelectedPullRequestChecksHistoryMode =
  (typeof SelectedPullRequestChecksHistoryMode)[keyof typeof SelectedPullRequestChecksHistoryMode];

/** Stable GitHub App identity retained for a check run when GitHub supplies it. */
export type SelectedPullRequestCheckApp = {
  nodeId: string;
  databaseId: number | null;
  slug: string | null;
  name: string;
  url: string | null;
};

/** One normalized latest-per-source check row for the selected PR head. */
export type SelectedPullRequestCheck = {
  providerId: string;
  sourceIdentity: string;
  sourceKind: SelectedPullRequestCheckSourceKind;
  sourceApp: SelectedPullRequestCheckApp | null;
  name: string;
  providerStatus: string;
  providerConclusion: string | null;
  category: SelectedPullRequestCheckCategory;
  createdAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  targetUrl: string | null;
};

/** Provider, normalization, and emitted-row counts for reconciliation. */
export type SelectedPullRequestChecksCounts = {
  providerExpected: number;
  providerReturned: number;
  normalizedAttempts: number;
  emitted: number;
  total: number;
  successful: number;
  failing: number;
  pending: number;
  neutral: number;
};

/** Bounded GraphQL cursor-pagination evidence for the selected head. */
export type SelectedPullRequestChecksPagination = {
  pageSize: number;
  pagesFetched: number;
  acquisitionMaximum: number;
  reachedAcquisitionMaximum: boolean;
};

/** History provenance without claiming undocumented provider retention. */
export type SelectedPullRequestChecksHistory = {
  mode: SelectedPullRequestChecksHistoryMode;
  providerLimit: null;
  rawAttempts: number;
  emittedSources: number;
};

/** Typed interruption retained when valid earlier pages are returned partially. */
export type SelectedPullRequestChecksInterruption = {
  reason: SelectedPullRequestEvidenceUnavailableReason;
  retryAfterSeconds?: number | null;
};

/** Complete or explicitly partial selected-head check coverage. */
export type SelectedPullRequestChecksCoverage = {
  completeness: SelectedPullRequestChecksCompleteness;
  reasons: readonly SelectedPullRequestChecksPartialReason[];
  interruption?: SelectedPullRequestChecksInterruption;
};

/** Stable selected-PR revision and normalized latest-per-source checks. */
export type SelectedPullRequestChecksEvidence = {
  identity: SelectedPullRequestIdentity;
  revision: Pick<SelectedPullRequestRevision, "headSha">;
  checks: readonly SelectedPullRequestCheck[];
  counts: SelectedPullRequestChecksCounts;
  pagination: SelectedPullRequestChecksPagination;
  history: SelectedPullRequestChecksHistory;
  coverage: SelectedPullRequestChecksCoverage;
};

/** Provider result that distinguishes known-zero checks from unavailability. */
export type SelectedPullRequestChecksEvidenceResult =
  | {
      status: typeof SelectedPullRequestEvidenceAvailability.Available;
      value: SelectedPullRequestChecksEvidence;
    }
  | {
      status: typeof SelectedPullRequestEvidenceAvailability.Unavailable;
      reason: SelectedPullRequestEvidenceUnavailableReason;
      retryAfterSeconds?: number | null;
    };
