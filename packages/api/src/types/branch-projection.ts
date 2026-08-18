import type {
  BranchDataState,
  BranchLifecyclePhaseCostRollup,
  BranchPrCommentsResponse,
  BranchStatus,
  BranchTagAvailability,
  BranchTagPermissions,
} from "./branch.ts";
import type {
  BranchAssociatedPullRequest,
  BranchAssociatedPullRequestCollection,
} from "./branch-associated-pull-request.ts";
import type { ChecksStatus } from "./branch-checks.ts";
import type {
  BranchCollaborators,
  BranchOwnerIdentity,
} from "./branch-identity.ts";
import type {
  BranchDetailMetricBundle,
  BranchMetricResult,
} from "./branch-metrics.ts";
import type { BranchPhaseAttributionResult } from "./branch-phase-attribution.ts";
import type {
  BranchSelectedPullRequestFilesResponse,
  BranchSelectedPullRequestReadAvailability,
} from "./branch-selected-pull-request-files.ts";
import type {
  BranchTraceSessionIdentity,
  BranchTraceState,
} from "./branch-trace.ts";
import type { ReadSource } from "./read-source.ts";
import type { SelectedPullRequestChecksEvidenceResult } from "./selected-pull-request-checks-evidence.ts";
import type { SelectedPullRequestEvidenceAvailability } from "./selected-pull-request-evidence.ts";
import type { TagSummary } from "./tag.ts";

/** Supported generations of the additive canonical Branch projection. */
export const BranchProjectionVersion = {
  V1: "v1",
} as const;
export type BranchProjectionVersion =
  (typeof BranchProjectionVersion)[keyof typeof BranchProjectionVersion];

/** Evidence payloads remain behind their dedicated, bounded lazy reads. */
export const BranchProjectionEvidenceDelivery = {
  Lazy: "lazy",
} as const;
export type BranchProjectionEvidenceDelivery =
  (typeof BranchProjectionEvidenceDelivery)[keyof typeof BranchProjectionEvidenceDelivery];

/** Provider-file evidence without the potentially large file-row payload. */
export type BranchProjectionFilesSummary =
  BranchSelectedPullRequestFilesResponse extends infer Result
    ? Result extends {
        status: typeof BranchSelectedPullRequestReadAvailability.Available;
        value: infer Value;
      }
      ? Omit<Result, "value"> & { value: Omit<Value, "files"> }
      : Result
    : never;

/** Selected-head check evidence without the potentially large check-row payload. */
export type BranchProjectionChecksSummary =
  SelectedPullRequestChecksEvidenceResult extends infer Result
    ? Result extends {
        status: typeof SelectedPullRequestEvidenceAvailability.Available;
        value: infer Value;
      }
      ? Omit<Result, "value"> & { value: Omit<Value, "checks"> }
      : Result
    : never;

/** Comment evidence without comment bodies or rows. */
export type BranchProjectionCommentsSummary = Omit<
  BranchPrCommentsResponse,
  "comments"
>;

/** One lazy evidence channel with an owner-typed summary when already loaded. */
export type BranchProjectionEvidenceChannel<Summary> = {
  delivery: typeof BranchProjectionEvidenceDelivery.Lazy;
  summary?: Summary;
};

/** Lazy evidence channels that can be composed without changing acquisition. */
export type BranchProjectionEvidenceSummary = {
  comments: BranchProjectionEvidenceChannel<BranchProjectionCommentsSummary>;
  checks: BranchProjectionEvidenceChannel<BranchProjectionChecksSummary>;
  files: BranchProjectionEvidenceChannel<BranchProjectionFilesSummary>;
  trace: BranchProjectionEvidenceChannel<BranchTraceState>;
};

/** Bounded associated-PR summary suitable for every list row. */
export type BranchProjectionPullRequestsSummary = {
  associatedCount: number;
  selected: BranchAssociatedPullRequest | null;
  selectionReason: BranchAssociatedPullRequestCollection["selectionReason"];
  completeness: BranchAssociatedPullRequestCollection["completeness"];
};

/** Canonical identity, membership, and shared state for every Branch surface. */
export type CanonicalBranchProjectionCommonV1 = {
  identity: {
    artifactId: string;
    projectId: string | null;
    branchName: string;
    repositoryFullName: string | null;
  };
  membership: {
    sessionIds: readonly string[];
    qualifyingSessionCount: number;
    sessions?: readonly BranchTraceSessionIdentity[];
  };
  people: {
    owner?: BranchOwnerIdentity;
    collaborators?: BranchCollaborators;
  };
  tags: {
    items?: readonly TagSummary[];
    availability: BranchTagAvailability;
    permissions?: BranchTagPermissions;
  };
  pullRequests: BranchProjectionPullRequestsSummary;
  lastActiveAt: BranchMetricResult<string>;
  evidence: BranchProjectionEvidenceSummary;
  provenance: {
    source: typeof ReadSource.Cloud;
  };
};

/** List fields whose canonical values also back the compatibility row. */
export type CanonicalBranchProjectionListV1 = {
  status: BranchStatus;
  /** State of the qualifying write-participation population on every surface. */
  dataState: BranchDataState;
  selectedPullRequest: {
    id: string | null;
    checksStatus: ChecksStatus | null;
    checksPassed: number | null;
    checksTotal: number | null;
  };
  changes: {
    additions: number | null;
    deletions: number | null;
    filesChanged: number | null;
  };
  cost: {
    /** Whole captured cost of qualifying write sessions, counted once each. */
    replicatedUsd: number | null;
    /** Even-split cost of the same qualifying write-session population. */
    attributedUsd?: number | null;
  };
};

/** Detail-only delivery state composed after bounded enrichment completes. */
export type CanonicalBranchProjectionDetailV1 = {
  phaseAttribution?: BranchPhaseAttributionResult;
  metrics?: BranchDetailMetricBundle;
  lifecyclePhaseStacks?: readonly BranchLifecyclePhaseCostRollup[];
};

/** One additive canonical contract shared by cloud, Desktop, and clients. */
export type CanonicalBranchProjectionV1 = {
  version: typeof BranchProjectionVersion.V1;
  common: CanonicalBranchProjectionCommonV1;
  list: CanonicalBranchProjectionListV1;
  detail?: CanonicalBranchProjectionDetailV1;
};

/** A type guard that rejects unknown future generations instead of coercing them. */
export function isSupportedBranchProjectionVersion(
  value: { version?: string } | null | undefined
): value is { version: typeof BranchProjectionVersion.V1 } {
  return value?.version === BranchProjectionVersion.V1;
}
