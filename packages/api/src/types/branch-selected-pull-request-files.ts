import { z } from "zod";
import { normalizeRepoFullName } from "./branch-repository.ts";
import type { BranchViewFileDiff } from "./branch-view.ts";
import type { GitHubAccessDenialReason } from "./github.ts";
import {
  SelectedPullRequestContentAvailability,
  SelectedPullRequestContentClassification,
  SelectedPullRequestContentNotApplicableReason,
  type SelectedPullRequestContentResult,
  SelectedPullRequestContentUnavailableReason,
  type SelectedPullRequestEvidence,
  type SelectedPullRequestEvidenceAvailability,
  type SelectedPullRequestEvidenceResult,
  type SelectedPullRequestEvidenceUnavailableReason,
  type SelectedPullRequestFile,
  SelectedPullRequestFileCompleteness,
  type SelectedPullRequestFileContentEvidence,
  SelectedPullRequestFileContentEvidenceAvailability,
  type SelectedPullRequestFileContentEvidenceResult,
  type SelectedPullRequestFilePartialReason,
  type SelectedPullRequestIdentity,
  type SelectedPullRequestOrdinaryContentUnavailableReason,
  type SelectedPullRequestRevision,
} from "./selected-pull-request-evidence.ts";

const REPOSITORY_FULL_NAME_PATTERN = /^[^/\s]+\/[^/\s]+$/;
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/i;

/** Maximum decoded text bytes read for each side of an inline selected-PR diff. */
export const BRANCH_SELECTED_PULL_REQUEST_FILE_CONTENT_MAX_BYTES = 1024 * 1024;

/** Availability of a Branch selected-PR files or diff read. */
export const BranchSelectedPullRequestReadAvailability = {
  Available: "available",
  Unavailable: "unavailable",
} as const;
export type BranchSelectedPullRequestReadAvailability =
  (typeof BranchSelectedPullRequestReadAvailability)[keyof typeof BranchSelectedPullRequestReadAvailability];

/** Truthfulness state for persisted expected rows versus loaded provider rows. */
export const BranchSelectedPullRequestFileCompleteness = {
  Complete: "complete",
  Incomplete: "incomplete",
  Unavailable: "unavailable",
} as const;
export type BranchSelectedPullRequestFileCompleteness =
  (typeof BranchSelectedPullRequestFileCompleteness)[keyof typeof BranchSelectedPullRequestFileCompleteness];

/** Application reconciliation reasons that are not provider evidence reasons. */
export const BranchSelectedPullRequestFilePartialReason = {
  PersistedExpectedCountMismatch: "persisted_expected_count_mismatch",
} as const;
export type BranchSelectedPullRequestFilePartialReason =
  | SelectedPullRequestFilePartialReason
  | (typeof BranchSelectedPullRequestFilePartialReason)[keyof typeof BranchSelectedPullRequestFilePartialReason];

/** Why application-level file completeness cannot be determined. */
export const BranchSelectedPullRequestCompletenessUnavailableReason = {
  InvalidExpectedCount: "invalid_expected_count",
  LoadedExceedsExpected: "loaded_exceeds_expected",
  MissingExpectedCount: "missing_expected_count",
} as const;
export type BranchSelectedPullRequestCompletenessUnavailableReason =
  (typeof BranchSelectedPullRequestCompletenessUnavailableReason)[keyof typeof BranchSelectedPullRequestCompletenessUnavailableReason];

/** Availability of a gross additions/deletions value derived from known rows. */
export const BranchSelectedPullRequestGrossTotalAvailability = {
  Available: "available",
  Unavailable: "unavailable",
} as const;
export type BranchSelectedPullRequestGrossTotalAvailability =
  (typeof BranchSelectedPullRequestGrossTotalAvailability)[keyof typeof BranchSelectedPullRequestGrossTotalAvailability];

/** Which boundary supplied a typed selected-PR read failure. */
export const BranchSelectedPullRequestUnavailableSource = {
  Acquisition: "acquisition",
  Access: "access",
  Content: "content",
  ContentSides: "content_sides",
  Evidence: "evidence",
} as const;
export type BranchSelectedPullRequestUnavailableSource =
  (typeof BranchSelectedPullRequestUnavailableSource)[keyof typeof BranchSelectedPullRequestUnavailableSource];

/** Why a bounded application acquisition was not admitted. */
export const BranchSelectedPullRequestAcquisitionUnavailableReason = {
  BudgetExhausted: "acquisition_budget_exhausted",
} as const;
export type BranchSelectedPullRequestAcquisitionUnavailableReason =
  (typeof BranchSelectedPullRequestAcquisitionUnavailableReason)[keyof typeof BranchSelectedPullRequestAcquisitionUnavailableReason];

const repositoryFullNameSchema = z
  .string()
  .transform(normalizeRepoFullName)
  .pipe(z.string().regex(REPOSITORY_FULL_NAME_PATTERN));
const pullRequestNumberSchema = z.coerce.number().int().positive();
const gitShaSchema = z
  .string()
  .trim()
  .regex(GIT_SHA_PATTERN)
  .transform((value) => value.toLowerCase());

/** Query accepted by the Branch selected-PR files route. */
export const branchSelectedPullRequestFilesQuerySchema = z
  .object({
    repositoryFullName: repositoryFullNameSchema,
    pullRequestNumber: pullRequestNumberSchema,
  })
  .strict();
export type BranchSelectedPullRequestFilesQuery = z.infer<
  typeof branchSelectedPullRequestFilesQuerySchema
>;

/** Query accepted by the revision-pinned Branch selected-PR diff route. */
export const branchSelectedPullRequestDiffQuerySchema =
  branchSelectedPullRequestFilesQuerySchema
    .extend({
      path: z.string().min(1).max(4096),
      baseSha: gitShaSchema,
      headSha: gitShaSchema,
    })
    .strict();
export type BranchSelectedPullRequestDiffQuery = z.infer<
  typeof branchSelectedPullRequestDiffQuerySchema
>;

export type BranchSelectedPullRequestFileCoverage =
  | {
      completeness: typeof BranchSelectedPullRequestFileCompleteness.Complete;
      reasons: readonly [];
    }
  | {
      completeness: typeof BranchSelectedPullRequestFileCompleteness.Incomplete;
      reasons: readonly BranchSelectedPullRequestFilePartialReason[];
    }
  | {
      completeness: typeof BranchSelectedPullRequestFileCompleteness.Unavailable;
      reason: BranchSelectedPullRequestCompletenessUnavailableReason;
    };

export type BranchSelectedPullRequestGrossTotal =
  | {
      availability: typeof BranchSelectedPullRequestGrossTotalAvailability.Available;
      value: number;
      completeness:
        | typeof BranchSelectedPullRequestFileCompleteness.Complete
        | typeof BranchSelectedPullRequestFileCompleteness.Incomplete;
    }
  | {
      availability: typeof BranchSelectedPullRequestGrossTotalAvailability.Unavailable;
    };

/** Slim file-list row that excludes provider patches and content references. */
export type BranchSelectedPullRequestFile = Pick<
  SelectedPullRequestFile,
  | "path"
  | "previousPath"
  | "providerStatus"
  | "status"
  | "additions"
  | "deletions"
  | "changes"
>;

export type BranchSelectedPullRequestFiles = {
  identity: SelectedPullRequestIdentity;
  revision: SelectedPullRequestRevision;
  files: readonly BranchSelectedPullRequestFile[];
  counts: {
    expected: number | null;
    loaded: number;
    providerExpected: number | null;
    providerReturned: number;
  };
  coverage: BranchSelectedPullRequestFileCoverage;
  grossTotals: {
    additions: BranchSelectedPullRequestGrossTotal;
    deletions: BranchSelectedPullRequestGrossTotal;
  };
  pagination: SelectedPullRequestEvidence["pagination"];
};

type AccessUnavailable = {
  status: typeof BranchSelectedPullRequestReadAvailability.Unavailable;
  source: typeof BranchSelectedPullRequestUnavailableSource.Access;
  reason: GitHubAccessDenialReason;
  retryAfterSeconds?: number | null;
};

type AcquisitionUnavailable = {
  status: typeof BranchSelectedPullRequestReadAvailability.Unavailable;
  source: typeof BranchSelectedPullRequestUnavailableSource.Acquisition;
  reason: BranchSelectedPullRequestAcquisitionUnavailableReason;
  retryAfterSeconds: number;
};

type EvidenceUnavailable = {
  status: typeof BranchSelectedPullRequestReadAvailability.Unavailable;
  source: typeof BranchSelectedPullRequestUnavailableSource.Evidence;
  reason: SelectedPullRequestEvidenceUnavailableReason;
  retryAfterSeconds?: number | null;
};

type ContentUnavailable = {
  status: typeof BranchSelectedPullRequestReadAvailability.Unavailable;
  source: typeof BranchSelectedPullRequestUnavailableSource.Content;
  reason: SelectedPullRequestOrdinaryContentUnavailableReason;
};

type ContentSidesUnavailable = {
  status: typeof BranchSelectedPullRequestReadAvailability.Unavailable;
  source: typeof BranchSelectedPullRequestUnavailableSource.ContentSides;
  identity: SelectedPullRequestIdentity;
  revision: SelectedPullRequestRevision;
  content: SelectedPullRequestFileContentEvidence;
};

export type BranchSelectedPullRequestFilesResponse =
  | {
      status: typeof BranchSelectedPullRequestReadAvailability.Available;
      value: BranchSelectedPullRequestFiles;
    }
  | AccessUnavailable
  | AcquisitionUnavailable
  | EvidenceUnavailable;

export type BranchSelectedPullRequestDiffResponse =
  | {
      status: typeof BranchSelectedPullRequestReadAvailability.Available;
      value: {
        identity: SelectedPullRequestIdentity;
        revision: SelectedPullRequestRevision;
        diff: BranchViewFileDiff;
      };
    }
  | AccessUnavailable
  | AcquisitionUnavailable
  | EvidenceUnavailable
  | ContentUnavailable
  | ContentSidesUnavailable;

/** Project landed evidence through the persisted Branch expected-count contract. */
export function projectBranchSelectedPullRequestFiles(
  evidence: SelectedPullRequestEvidence,
  persistedExpected: number | null
): BranchSelectedPullRequestFilesResponse {
  const coverage = projectCoverage(evidence, persistedExpected);
  return {
    status: BranchSelectedPullRequestReadAvailability.Available,
    value: {
      identity: evidence.identity,
      revision: evidence.revision,
      files: evidence.files.map(projectBranchSelectedPullRequestFile),
      counts: {
        expected: validExpectedCount(persistedExpected)
          ? persistedExpected
          : null,
        loaded: evidence.counts.normalizedReturned,
        providerExpected: evidence.counts.expected,
        providerReturned: evidence.counts.providerReturned,
      },
      coverage,
      grossTotals: {
        additions: projectGrossTotal(evidence, coverage, "additions"),
        deletions: projectGrossTotal(evidence, coverage, "deletions"),
      },
      pagination: evidence.pagination,
    },
  };
}

/** Project landed immutable content evidence into the existing text-diff shape. */
export function projectBranchSelectedPullRequestDiff(
  evidence: SelectedPullRequestEvidence,
  contentResult: SelectedPullRequestFileContentEvidenceResult
): BranchSelectedPullRequestDiffResponse {
  if (
    contentResult.status ===
    SelectedPullRequestFileContentEvidenceAvailability.Unavailable
  ) {
    return {
      status: BranchSelectedPullRequestReadAvailability.Unavailable,
      source: BranchSelectedPullRequestUnavailableSource.Content,
      reason: contentResult.reason,
    };
  }

  const projected = projectContentDiff(contentResult.value);
  if (!projected) {
    return {
      status: BranchSelectedPullRequestReadAvailability.Unavailable,
      source: BranchSelectedPullRequestUnavailableSource.ContentSides,
      identity: evidence.identity,
      revision: evidence.revision,
      content: contentResult.value,
    };
  }
  return {
    status: BranchSelectedPullRequestReadAvailability.Available,
    value: {
      identity: evidence.identity,
      revision: evidence.revision,
      diff: projected,
    },
  };
}

function projectCoverage(
  evidence: SelectedPullRequestEvidence,
  persistedExpected: number | null
): BranchSelectedPullRequestFileCoverage {
  if (persistedExpected === null) {
    return unavailableCoverage(
      BranchSelectedPullRequestCompletenessUnavailableReason.MissingExpectedCount
    );
  }
  if (!validExpectedCount(persistedExpected)) {
    return unavailableCoverage(
      BranchSelectedPullRequestCompletenessUnavailableReason.InvalidExpectedCount
    );
  }
  const loaded = evidence.counts.normalizedReturned;
  if (loaded > persistedExpected) {
    return unavailableCoverage(
      BranchSelectedPullRequestCompletenessUnavailableReason.LoadedExceedsExpected
    );
  }
  if (
    loaded === persistedExpected &&
    evidence.coverage.completeness ===
      SelectedPullRequestFileCompleteness.Complete
  ) {
    return {
      completeness: BranchSelectedPullRequestFileCompleteness.Complete,
      reasons: [],
    };
  }
  const reasons = new Set<BranchSelectedPullRequestFilePartialReason>(
    evidence.coverage.reasons
  );
  if (loaded < persistedExpected) {
    reasons.add(
      BranchSelectedPullRequestFilePartialReason.PersistedExpectedCountMismatch
    );
  }
  return {
    completeness: BranchSelectedPullRequestFileCompleteness.Incomplete,
    reasons: [...reasons],
  };
}

function unavailableCoverage(
  reason: BranchSelectedPullRequestCompletenessUnavailableReason
): BranchSelectedPullRequestFileCoverage {
  return {
    completeness: BranchSelectedPullRequestFileCompleteness.Unavailable,
    reason,
  };
}

function projectGrossTotal(
  evidence: SelectedPullRequestEvidence,
  coverage: BranchSelectedPullRequestFileCoverage,
  field: "additions" | "deletions"
): BranchSelectedPullRequestGrossTotal {
  if (
    evidence.files.length === 0 &&
    coverage.completeness === BranchSelectedPullRequestFileCompleteness.Complete
  ) {
    return availableGrossTotal(
      0,
      BranchSelectedPullRequestFileCompleteness.Complete
    );
  }
  const known = evidence.files.flatMap((file) =>
    file[field] === null ? [] : [file[field]]
  );
  if (known.length === 0) {
    return {
      availability: BranchSelectedPullRequestGrossTotalAvailability.Unavailable,
    };
  }
  const completeness =
    known.length === evidence.files.length &&
    coverage.completeness === BranchSelectedPullRequestFileCompleteness.Complete
      ? BranchSelectedPullRequestFileCompleteness.Complete
      : BranchSelectedPullRequestFileCompleteness.Incomplete;
  return availableGrossTotal(
    known.reduce((sum, value) => sum + value, 0),
    completeness
  );
}

function availableGrossTotal(
  value: number,
  completeness:
    | typeof BranchSelectedPullRequestFileCompleteness.Complete
    | typeof BranchSelectedPullRequestFileCompleteness.Incomplete
): BranchSelectedPullRequestGrossTotal {
  return {
    availability: BranchSelectedPullRequestGrossTotalAvailability.Available,
    value,
    completeness,
  };
}

function projectContentDiff(
  content: SelectedPullRequestFileContentEvidence
): BranchViewFileDiff | null {
  const base = projectContentSide(
    content.base,
    SelectedPullRequestContentNotApplicableReason.AddedFile
  );
  const head = projectContentSide(
    content.head,
    SelectedPullRequestContentNotApplicableReason.RemovedFile
  );
  if (base.kind === "unavailable" || head.kind === "unavailable") {
    return null;
  }
  const isNew = base.kind === "not_applicable";
  const isDeleted = head.kind === "not_applicable";
  if (isNew && isDeleted) {
    return null;
  }
  const isBinary = base.kind === "binary" || head.kind === "binary";
  return {
    path: content.file.path,
    oldContent: isBinary || base.kind !== "text" ? "" : base.content,
    newContent: isBinary || head.kind !== "text" ? "" : head.content,
    isNew,
    isDeleted,
    isBinary,
  };
}

type ProjectedContentSide =
  | { kind: "binary" }
  | { kind: "not_applicable" }
  | { kind: "text"; content: string }
  | { kind: "unavailable" };

function projectContentSide(
  result: SelectedPullRequestContentResult,
  expectedNotApplicableReason: SelectedPullRequestContentNotApplicableReason
): ProjectedContentSide {
  if (
    result.availability ===
      SelectedPullRequestContentAvailability.NotApplicable &&
    result.reason === expectedNotApplicableReason
  ) {
    return { kind: "not_applicable" };
  }
  if (
    result.availability === SelectedPullRequestContentAvailability.Available
  ) {
    // Reflective reads keep version-skewed classifications outside this TypeScript union reachable so they fail closed below.
    const classification = Reflect.get(result, "classification");
    if (
      classification === undefined ||
      classification === SelectedPullRequestContentClassification.Text
    ) {
      return { kind: "text", content: result.content };
    }
    return { kind: "unavailable" };
  }
  if (
    result.availability ===
      SelectedPullRequestContentAvailability.Unavailable &&
    result.reason ===
      SelectedPullRequestContentUnavailableReason.BinaryContent &&
    Reflect.get(result, "classification") ===
      SelectedPullRequestContentClassification.Binary
  ) {
    return { kind: "binary" };
  }
  return { kind: "unavailable" };
}

function validExpectedCount(value: number | null): value is number {
  return Number.isInteger(value) && (value ?? -1) >= 0;
}

/** Convert an existing user-access denial to the files/diff response vocabulary. */
export function branchSelectedPullRequestAccessUnavailable(
  reason: GitHubAccessDenialReason,
  retryAfterSeconds?: number | null
): AccessUnavailable {
  return {
    status: BranchSelectedPullRequestReadAvailability.Unavailable,
    source: BranchSelectedPullRequestUnavailableSource.Access,
    reason,
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
  };
}

/** Report an application acquisition denial without disguising it as provider failure. */
export function branchSelectedPullRequestAcquisitionUnavailable(
  reason: BranchSelectedPullRequestAcquisitionUnavailableReason,
  retryAfterSeconds: number
): AcquisitionUnavailable {
  if (!(Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0)) {
    throw new RangeError("retryAfterSeconds must be a positive finite number");
  }
  return {
    status: BranchSelectedPullRequestReadAvailability.Unavailable,
    source: BranchSelectedPullRequestUnavailableSource.Acquisition,
    reason,
    retryAfterSeconds,
  };
}

/** Convert landed evidence unavailability without changing its precision. */
export function branchSelectedPullRequestEvidenceUnavailable(
  result: Exclude<
    SelectedPullRequestEvidenceResult,
    { status: typeof SelectedPullRequestEvidenceAvailability.Available }
  >
): EvidenceUnavailable {
  return {
    status: BranchSelectedPullRequestReadAvailability.Unavailable,
    source: BranchSelectedPullRequestUnavailableSource.Evidence,
    reason: result.reason,
    ...(result.retryAfterSeconds === undefined
      ? {}
      : { retryAfterSeconds: result.retryAfterSeconds }),
  };
}

function projectBranchSelectedPullRequestFile(
  file: SelectedPullRequestFile
): BranchSelectedPullRequestFile {
  return {
    path: file.path,
    ...(file.previousPath === undefined
      ? {}
      : { previousPath: file.previousPath }),
    providerStatus: file.providerStatus,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    changes: file.changes,
  };
}
