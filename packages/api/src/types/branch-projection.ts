import type {
  BranchDataState,
  BranchLifecyclePhaseCostRollup,
  BranchParticipationKind,
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
import type { DisplayedSessionStatus } from "./session-status.ts";
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
    projectName: string | null;
    branchName: string;
    repositoryFullName: string | null;
  };
  membership: {
    sessionIds: readonly string[];
    qualifyingSessionCount: number;
    sessions?: readonly BranchMembershipSession[];
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

/**
 * ISS-8972 — one qualifying Session's membership entry, as a LIST row carries it.
 *
 * A superset of {@link BranchTraceSessionIdentity} rather than a second type: the
 * trace path already emits that identity into this same field, so widening the
 * element keeps every existing producer assignable and adds no second name for
 * the identity half.
 *
 * The added fields are what the Branches Linked Sessions column renders per chip
 * — the owner it belongs to, the status that tones it, why the Session is
 * related, and the interaction the date label states. All OPTIONAL, because the
 * two producers know different amounts: the cloud list read populates every one,
 * and the trace path (whose job is the merged timeline, not a chip) populates
 * none. ABSENCE is the only encoding of "this producer did not resolve it", so a
 * consumer must degrade rather than read a missing owner as an anonymous one.
 *
 * `displayedStatus` is a {@link DisplayedSessionStatus} and never a stored
 * lifecycle value: it is derived per read from the row's status plus its activity
 * recency, so `stale` and `waiting` can reach a render that a column never held.
 * Nothing writes this back.
 */
export type BranchMembershipSession = BranchTraceSessionIdentity & {
  /** Resolved display name of the Session's owner; null when unattributed. */
  ownerName?: string | null;
  /**
   * ISS-8972 — `true` when the Session HAS an owner whose identity this read
   * could not resolve (deleted, or outside the org), as opposed to a Session
   * with no owner at all.
   *
   * `apps/api/app/branches/AGENTS.md` requires the two be distinguished and the
   * distinction carried to the render: collapsing them makes a chip say
   * "Unattributed" — a confident claim that nobody owns this run — about a run
   * that has an owner nobody could look up. ABSENT means genuinely ownerless.
   */
  ownerUnavailable?: boolean;
  /** Owner's picture when the directory has one; initials are the fallback. */
  ownerAvatarUrl?: string;
  /** Presentation-only status fold — never a value headed for a column. */
  displayedStatus?: DisplayedSessionStatus;
  /** Producer-owned lifecycle evidence retained beside the display fold. */
  rawStatus?: string | null;
  /** Why this Session is related to the Branch (wrote to it vs reviewed it). */
  participation?: BranchParticipationKind;
  /** ISO-8601 genuine-activity instant the chip's date label states. */
  lastInteractionAt?: string;
};

/** A type guard that rejects unknown future generations instead of coercing them. */
export function isSupportedBranchProjectionVersion(
  value: { version?: string } | null | undefined
): value is { version: typeof BranchProjectionVersion.V1 } {
  return value?.version === BranchProjectionVersion.V1;
}
