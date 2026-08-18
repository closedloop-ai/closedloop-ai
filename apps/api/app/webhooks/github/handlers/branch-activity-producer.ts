import {
  type BranchActivityAtom,
  BranchActivityAtomVersion,
  BranchActivityAttributionKind,
  BranchActivityEvidenceCompleteness,
  BranchActivitySource,
} from "@repo/api/src/types/branch-activity";
import { z } from "zod";
import {
  BranchActivityPersistStatus,
  persistBranchActivityAtom,
} from "@/app/branches/branch-activity-evidence";
import { isRecord } from "@/lib/type-guards";

/** GitHub webhook event names considered by the Branch activity producer. */
export const GitHubBranchActivityEventName = {
  CheckRun: "check_run",
  DeploymentStatus: "deployment_status",
  IssueComment: "issue_comment",
  PullRequest: "pull_request",
  PullRequestReview: "pull_request_review",
  PullRequestReviewComment: "pull_request_review_comment",
  PullRequestReviewThread: "pull_request_review_thread",
  Push: "push",
} as const;
export type GitHubBranchActivityEventName =
  (typeof GitHubBranchActivityEventName)[keyof typeof GitHubBranchActivityEventName];

/** GitHub action literals used by the bounded producer decision table. */
export const GitHubBranchActivityAction = {
  Closed: "closed",
  Completed: "completed",
  Created: "created",
  Deleted: "deleted",
  Dismissed: "dismissed",
  Edited: "edited",
  Opened: "opened",
  Resolved: "resolved",
  Submitted: "submitted",
  Unresolved: "unresolved",
} as const;
export type GitHubBranchActivityAction =
  (typeof GitHubBranchActivityAction)[keyof typeof GitHubBranchActivityAction];

/** Discriminator returned by the pure webhook-to-atom mapping boundary. */
export const GitHubBranchActivityMappingStatus = {
  Mapped: "mapped",
  NoWrite: "no_write",
} as const;
export type GitHubBranchActivityMappingStatus =
  (typeof GitHubBranchActivityMappingStatus)[keyof typeof GitHubBranchActivityMappingStatus];

/** Terminal result discriminator returned by the persistence boundary. */
export const GitHubBranchActivityProductionStatus = {
  NoWrite: GitHubBranchActivityMappingStatus.NoWrite,
  Persisted: "persisted",
} as const;
export type GitHubBranchActivityProductionStatus =
  (typeof GitHubBranchActivityProductionStatus)[keyof typeof GitHubBranchActivityProductionStatus];

/** Exact reasons a GitHub delivery can terminate without an activity write. */
export const GitHubBranchActivityNoWriteReason = {
  InvalidAttribution: "invalid_attribution",
  InvalidAuthoritativeTimestamp: "invalid_authoritative_timestamp",
  InvalidDeliveryIdentity: "invalid_delivery_identity",
  MissingAttribution: "missing_attribution",
  MissingAuthoritativeTimestamp: "missing_authoritative_timestamp",
  MissingDeliveryIdentity: "missing_delivery_identity",
  PersistenceConflict: "persistence_conflict",
  PersistenceInvalid: "persistence_invalid",
  PersistenceInvalidAttribution: "persistence_invalid_attribution",
  PersistenceNotFound: "persistence_not_found",
  UnsupportedAction: "unsupported_action",
  UnsupportedEvent: "unsupported_event",
} as const;
export type GitHubBranchActivityNoWriteReason =
  (typeof GitHubBranchActivityNoWriteReason)[keyof typeof GitHubBranchActivityNoWriteReason];

/** Unknown-at-runtime inputs required to map one authenticated GitHub delivery. */
export type GitHubBranchActivityProducerInput = {
  eventName: unknown;
  deliveryId: unknown;
  payload: unknown;
  attribution: unknown;
};

/** Typed fail-closed outcome for an unmappable or rejected delivery. */
export type GitHubBranchActivityNoWrite = {
  status: typeof GitHubBranchActivityMappingStatus.NoWrite;
  reason: GitHubBranchActivityNoWriteReason;
};

/** Canonical atom plus its already-resolved organization and Branch scope. */
export type GitHubBranchActivityMapped = {
  status: typeof GitHubBranchActivityMappingStatus.Mapped;
  organizationId: string;
  branchArtifactId: string;
  atom: BranchActivityAtom;
};

/** Pure mapping result before any database access occurs. */
export type GitHubBranchActivityMappingResult =
  | GitHubBranchActivityMapped
  | GitHubBranchActivityNoWrite;

/** Terminal persistence result for one authenticated GitHub delivery. */
export type GitHubBranchActivityProductionResult =
  | GitHubBranchActivityNoWrite
  | {
      status: typeof GitHubBranchActivityProductionStatus.Persisted;
      persistenceStatus:
        | typeof BranchActivityPersistStatus.Inserted
        | typeof BranchActivityPersistStatus.Replayed;
    };

/**
 * Map one authenticated GitHub delivery to a canonical Branch activity atom.
 *
 * The mapper accepts runtime-unknown payloads deliberately and fails closed.
 * Only event/action-specific provider occurrence times are eligible; request
 * receipt time, generic resource update time, repository push time, and commit
 * time are never consulted.
 */
export function mapGitHubBranchActivity(
  input: GitHubBranchActivityProducerInput
): GitHubBranchActivityMappingResult {
  const delivery = parseDeliveryIdentity(input.deliveryId);
  if (!delivery.ok) {
    return noWrite(delivery.reason);
  }
  const eventName = parseEventName(input.eventName);
  if (!eventName) {
    return noWrite(GitHubBranchActivityNoWriteReason.UnsupportedEvent);
  }
  const selection = selectActivity(eventName, input.payload);
  if (selection.status === GitHubBranchActivityMappingStatus.NoWrite) {
    return selection;
  }
  const attribution = parseAttribution(
    input.attribution,
    selection.attributionKind
  );
  if (!attribution.ok) {
    return noWrite(attribution.reason);
  }
  const atomAttribution = buildAtomAttribution(
    selection.attributionKind,
    attribution.pullRequestDetailId
  );
  if (!atomAttribution) {
    return noWrite(GitHubBranchActivityNoWriteReason.MissingAttribution);
  }
  return {
    status: GitHubBranchActivityMappingStatus.Mapped,
    organizationId: attribution.organizationId,
    branchArtifactId: attribution.branchArtifactId,
    atom: {
      version: BranchActivityAtomVersion.V1,
      source: selection.source,
      sourceEventId: delivery.deliveryId,
      occurredAt: selection.occurredAt,
      attribution: atomAttribution,
      completeness: BranchActivityEvidenceCompleteness.Partial,
    },
  };
}

/**
 * Map and persist one delivery through the canonical Branch writer.
 *
 * The writer joins an ambient `withDb.tx` when the handler already owns one;
 * otherwise it opens the single Branch-owned transaction itself.
 */
export function persistGitHubBranchActivity(
  input: GitHubBranchActivityProducerInput
): Promise<GitHubBranchActivityProductionResult> {
  const mapped = mapGitHubBranchActivity(input);
  if (mapped.status === GitHubBranchActivityMappingStatus.NoWrite) {
    return Promise.resolve(mapped);
  }
  return persistMappedActivity(mapped);
}

async function persistMappedActivity(
  mapped: GitHubBranchActivityMapped
): Promise<GitHubBranchActivityProductionResult> {
  const result = await persistBranchActivityAtom({
    organizationId: mapped.organizationId,
    branchArtifactId: mapped.branchArtifactId,
    atom: mapped.atom,
  });
  if (
    result.status === BranchActivityPersistStatus.Inserted ||
    result.status === BranchActivityPersistStatus.Replayed
  ) {
    return {
      status: GitHubBranchActivityProductionStatus.Persisted,
      persistenceStatus: result.status,
    };
  }
  return noWrite(persistenceNoWriteReason(result.status));
}

function selectActivity(
  eventName: GitHubBranchActivityEventName,
  payload: unknown
): ActivitySelectionResult {
  const root = recordValue(payload);
  const action = stringValue(root?.action);
  switch (eventName) {
    case GitHubBranchActivityEventName.PullRequest:
      return selectPullRequestActivity(action, root);
    case GitHubBranchActivityEventName.PullRequestReview:
      return selectPullRequestReviewActivity(action, root);
    case GitHubBranchActivityEventName.PullRequestReviewComment:
      return selectCommentActivity(action, root, "comment");
    case GitHubBranchActivityEventName.IssueComment:
      return selectIssueCommentActivity(action, root);
    case GitHubBranchActivityEventName.CheckRun:
      return selectCheckRunActivity(action, root);
    case GitHubBranchActivityEventName.DeploymentStatus:
      return selectDeploymentStatusActivity(action, root);
    case GitHubBranchActivityEventName.PullRequestReviewThread:
      return selectReviewThreadActivity(action);
    case GitHubBranchActivityEventName.Push:
      return noWrite(
        GitHubBranchActivityNoWriteReason.MissingAuthoritativeTimestamp
      );
    default:
      return exhaustiveEvent(eventName);
  }
}

function selectPullRequestActivity(
  action: string | undefined,
  root: UnknownRecord | undefined
): ActivitySelectionResult {
  const pullRequest = recordValue(root?.pull_request);
  if (action === GitHubBranchActivityAction.Opened) {
    return activitySelection(
      BranchActivitySource.PullRequestLifecycle,
      BranchActivityAttributionKind.PullRequest,
      pullRequest?.created_at
    );
  }
  if (action === GitHubBranchActivityAction.Closed) {
    const merged = pullRequest?.merged;
    if (typeof merged !== "boolean") {
      return noWrite(
        GitHubBranchActivityNoWriteReason.MissingAuthoritativeTimestamp
      );
    }
    return activitySelection(
      BranchActivitySource.PullRequestLifecycle,
      BranchActivityAttributionKind.PullRequest,
      merged ? pullRequest?.merged_at : pullRequest?.closed_at
    );
  }
  return noWrite(GitHubBranchActivityNoWriteReason.UnsupportedAction);
}

function selectPullRequestReviewActivity(
  action: string | undefined,
  root: UnknownRecord | undefined
): ActivitySelectionResult {
  if (action !== GitHubBranchActivityAction.Submitted) {
    return noWrite(GitHubBranchActivityNoWriteReason.UnsupportedAction);
  }
  return activitySelection(
    BranchActivitySource.PullRequestReview,
    BranchActivityAttributionKind.PullRequest,
    recordValue(root?.review)?.submitted_at
  );
}

function selectCommentActivity(
  action: string | undefined,
  root: UnknownRecord | undefined,
  resourceKey: string
): ActivitySelectionResult {
  if (action === GitHubBranchActivityAction.Deleted) {
    return noWrite(
      GitHubBranchActivityNoWriteReason.MissingAuthoritativeTimestamp
    );
  }
  if (
    action !== GitHubBranchActivityAction.Created &&
    action !== GitHubBranchActivityAction.Edited
  ) {
    return noWrite(GitHubBranchActivityNoWriteReason.UnsupportedAction);
  }
  const resource = recordValue(root?.[resourceKey]);
  return activitySelection(
    BranchActivitySource.PullRequestReview,
    BranchActivityAttributionKind.PullRequest,
    action === GitHubBranchActivityAction.Created
      ? resource?.created_at
      : resource?.updated_at
  );
}

function selectIssueCommentActivity(
  action: string | undefined,
  root: UnknownRecord | undefined
): ActivitySelectionResult {
  if (!recordValue(recordValue(root?.issue)?.pull_request)) {
    return noWrite(GitHubBranchActivityNoWriteReason.MissingAttribution);
  }
  return selectCommentActivity(action, root, "comment");
}

function selectCheckRunActivity(
  action: string | undefined,
  root: UnknownRecord | undefined
): ActivitySelectionResult {
  if (action !== GitHubBranchActivityAction.Completed) {
    return noWrite(GitHubBranchActivityNoWriteReason.UnsupportedAction);
  }
  return activitySelection(
    BranchActivitySource.GitHubWebhook,
    BranchActivityAttributionKind.Branch,
    recordValue(root?.check_run)?.completed_at
  );
}

function selectDeploymentStatusActivity(
  action: string | undefined,
  root: UnknownRecord | undefined
): ActivitySelectionResult {
  if (action !== GitHubBranchActivityAction.Created) {
    return noWrite(GitHubBranchActivityNoWriteReason.UnsupportedAction);
  }
  return activitySelection(
    BranchActivitySource.GitHubWebhook,
    BranchActivityAttributionKind.Branch,
    recordValue(root?.deployment_status)?.created_at
  );
}

function selectReviewThreadActivity(
  action: string | undefined
): GitHubBranchActivityNoWrite {
  if (
    action === GitHubBranchActivityAction.Resolved ||
    action === GitHubBranchActivityAction.Unresolved
  ) {
    return noWrite(
      GitHubBranchActivityNoWriteReason.MissingAuthoritativeTimestamp
    );
  }
  return noWrite(GitHubBranchActivityNoWriteReason.UnsupportedAction);
}

function activitySelection(
  source: ActivitySource,
  attributionKind: BranchActivityAttributionKind,
  timestamp: unknown
): ActivitySelectionResult {
  const occurredAt = parseProviderTimestamp(timestamp);
  if (!occurredAt.ok) {
    return noWrite(occurredAt.reason);
  }
  return {
    status: GitHubBranchActivityMappingStatus.Mapped,
    source,
    attributionKind,
    occurredAt: occurredAt.value,
  };
}

function parseProviderTimestamp(timestamp: unknown): TimestampParseResult {
  if (timestamp === null || timestamp === undefined || timestamp === "") {
    return {
      ok: false,
      reason: GitHubBranchActivityNoWriteReason.MissingAuthoritativeTimestamp,
    };
  }
  const parsed = providerTimestampSchema.safeParse(timestamp);
  if (!parsed.success) {
    return {
      ok: false,
      reason: GitHubBranchActivityNoWriteReason.InvalidAuthoritativeTimestamp,
    };
  }
  return { ok: true, value: parsed.data };
}

function parseDeliveryIdentity(deliveryId: unknown): DeliveryParseResult {
  if (deliveryId === null || deliveryId === undefined || deliveryId === "") {
    return {
      ok: false,
      reason: GitHubBranchActivityNoWriteReason.MissingDeliveryIdentity,
    };
  }
  if (typeof deliveryId !== "string") {
    return {
      ok: false,
      reason: GitHubBranchActivityNoWriteReason.InvalidDeliveryIdentity,
    };
  }
  const normalized = deliveryId.trim();
  if (normalized.length === 0) {
    return {
      ok: false,
      reason: GitHubBranchActivityNoWriteReason.MissingDeliveryIdentity,
    };
  }
  if (normalized.length > 512) {
    return {
      ok: false,
      reason: GitHubBranchActivityNoWriteReason.InvalidDeliveryIdentity,
    };
  }
  return { ok: true, deliveryId: normalized };
}

function parseAttribution(
  value: unknown,
  expectedKind: BranchActivityAttributionKind
): AttributionParseResult {
  if (value === null || value === undefined) {
    return {
      ok: false,
      reason: GitHubBranchActivityNoWriteReason.MissingAttribution,
    };
  }
  const parsed = attributionSchema.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      reason: GitHubBranchActivityNoWriteReason.InvalidAttribution,
    };
  }
  const attribution = parsed.data;
  if (expectedKind === BranchActivityAttributionKind.PullRequest) {
    if (!attribution.pullRequestDetailId) {
      return {
        ok: false,
        reason: GitHubBranchActivityNoWriteReason.MissingAttribution,
      };
    }
    return {
      ok: true,
      organizationId: attribution.organizationId,
      branchArtifactId: attribution.branchArtifactId,
      pullRequestDetailId: attribution.pullRequestDetailId,
    };
  }
  if (attribution.pullRequestDetailId) {
    return {
      ok: false,
      reason: GitHubBranchActivityNoWriteReason.InvalidAttribution,
    };
  }
  return { ok: true, ...attribution, pullRequestDetailId: undefined };
}

function buildAtomAttribution(
  kind: BranchActivityAttributionKind,
  pullRequestDetailId: string | undefined
): BranchActivityAtom["attribution"] | null {
  if (kind === BranchActivityAttributionKind.Branch) {
    return { kind: BranchActivityAttributionKind.Branch };
  }
  return pullRequestDetailId
    ? {
        kind: BranchActivityAttributionKind.PullRequest,
        pullRequestId: pullRequestDetailId,
      }
    : null;
}

function parseEventName(value: unknown): GitHubBranchActivityEventName | null {
  if (typeof value !== "string") {
    return null;
  }
  return eventNames.has(value)
    ? (value as GitHubBranchActivityEventName)
    : null;
}

function persistenceNoWriteReason(
  status: Exclude<
    BranchActivityPersistStatus,
    | typeof BranchActivityPersistStatus.Inserted
    | typeof BranchActivityPersistStatus.Replayed
  >
): GitHubBranchActivityNoWriteReason {
  switch (status) {
    case BranchActivityPersistStatus.Conflict:
      return GitHubBranchActivityNoWriteReason.PersistenceConflict;
    case BranchActivityPersistStatus.Invalid:
      return GitHubBranchActivityNoWriteReason.PersistenceInvalid;
    case BranchActivityPersistStatus.NotFound:
      return GitHubBranchActivityNoWriteReason.PersistenceNotFound;
    case BranchActivityPersistStatus.InvalidAttribution:
      return GitHubBranchActivityNoWriteReason.PersistenceInvalidAttribution;
    default:
      return exhaustivePersistenceStatus(status);
  }
}

function noWrite(
  reason: GitHubBranchActivityNoWriteReason
): GitHubBranchActivityNoWrite {
  return { status: GitHubBranchActivityMappingStatus.NoWrite, reason };
}

function recordValue(value: unknown): UnknownRecord | undefined {
  return isRecord(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function exhaustiveEvent(value: never): never {
  throw new Error(`Unhandled GitHub Branch activity event: ${String(value)}`);
}

function exhaustivePersistenceStatus(value: never): never {
  throw new Error(`Unhandled Branch activity persistence status: ${value}`);
}

type UnknownRecord = Record<string, unknown>;

type ActivitySource =
  | typeof BranchActivitySource.PullRequestLifecycle
  | typeof BranchActivitySource.PullRequestReview
  | typeof BranchActivitySource.GitHubWebhook;

type ActivitySelection = {
  status: typeof GitHubBranchActivityMappingStatus.Mapped;
  source: ActivitySource;
  attributionKind: BranchActivityAttributionKind;
  occurredAt: string;
};

type ActivitySelectionResult = ActivitySelection | GitHubBranchActivityNoWrite;

type DeliveryParseResult =
  | { ok: true; deliveryId: string }
  | { ok: false; reason: GitHubBranchActivityNoWriteReason };

type TimestampParseResult =
  | { ok: true; value: string }
  | { ok: false; reason: GitHubBranchActivityNoWriteReason };

type AttributionParseResult =
  | {
      ok: true;
      organizationId: string;
      branchArtifactId: string;
      pullRequestDetailId: string | undefined;
    }
  | { ok: false; reason: GitHubBranchActivityNoWriteReason };

const providerTimestampSchema = z.iso.datetime();

const attributionSchema = z
  .object({
    organizationId: z.uuid(),
    branchArtifactId: z.uuid(),
    pullRequestDetailId: z.uuid().nullish(),
  })
  .strict();

const eventNames = new Set<string>(
  Object.values(GitHubBranchActivityEventName)
);
