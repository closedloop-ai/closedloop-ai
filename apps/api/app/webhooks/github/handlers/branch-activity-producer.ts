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
  type BranchActivityPushEvidence,
  branchActivityPushEvidence,
  persistBranchActivityAtom,
} from "@/app/branches/branch-activity-evidence";
import {
  PullRequestLifecycleOccurrence,
  pullRequestLifecycleActivityAtom,
} from "@/app/branches/pull-request-lifecycle-activity";
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
  MissingPushRange: "missing_push_range",
  PersistenceConflict: "persistence_conflict",
  PersistenceInvalid: "persistence_invalid",
  PersistenceInvalidAttribution: "persistence_invalid_attribution",
  PersistenceNotFound: "persistence_not_found",
  PersistenceFutureTimestamp: "persistence_future_timestamp",
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
  /**
   * ISS-10009: the push's own line delta, resolved by the caller against the
   * provider compare. Absent or unparseable means UNKNOWN and is written as
   * null — this mapper never derives a count from the payload, because the push
   * payload carries none.
   */
  pushLineDelta?: unknown;
  /**
   * ISS-10009: the immutable base the delta above was measured against, when
   * the caller read one. It WINS over the payload's `before`, which names the
   * branch's previous tip rather than the compared range: on a branch create it
   * is the all-zero sha, and on a force-push it is a tip the diff never saw.
   * Absent means no compare was read, and the payload's `before` stands.
   */
  pushBaseSha?: unknown;
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
  /** Set only for push deliveries; written to the atom's additive columns. */
  pushEvidence?: BranchActivityPushEvidence;
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
  const selection = selectActivity(eventName, input.payload, {
    baseSha: input.pushBaseSha,
    lineDelta: input.pushLineDelta,
  });
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
  return {
    status: GitHubBranchActivityMappingStatus.Mapped,
    organizationId: attribution.organizationId,
    branchArtifactId: attribution.branchArtifactId,
    atom: mappedAtom(delivery.deliveryId, selection, attribution),
    ...(selection.pushEvidence ? { pushEvidence: selection.pushEvidence } : {}),
  };
}

/**
 * Build the atom for one mapped delivery.
 *
 * PR lifecycle deliveries are keyed by the occurrence they report rather than
 * by the delivery that carried it, so the same opened/merged/closed event
 * observed again — by a redelivery, or by the non-webhook backfill and
 * settlement writers — replays the one immutable row instead of adding a
 * second copy under a second identity space. Every other lane keeps the
 * delivery identity, which is the only occurrence key those events have.
 *
 * This lane deliberately does not run the batch writer's legacy `:closed`
 * reconciliation. That reconciliation exists for rows keyed without the close
 * time, a form that never reached `main` — the timestamped key and the
 * reconciliation landed in the same commit (ISS-6421) — and a close webhook
 * only ever reports a close happening now, so it cannot carry an occurrence
 * old enough to have one.
 */
function mappedAtom(
  deliveryId: string,
  selection: ActivitySelection,
  attribution: Extract<AttributionParseResult, { ok: true }>
): BranchActivityAtom {
  if (
    selection.occurrence &&
    attribution.atomAttribution.kind ===
      BranchActivityAttributionKind.PullRequest
  ) {
    return pullRequestLifecycleActivityAtom({
      pullRequestDetailId: attribution.atomAttribution.pullRequestId,
      occurrence: selection.occurrence,
      occurredAt: new Date(selection.occurredAt),
    });
  }
  return {
    version: BranchActivityAtomVersion.V1,
    source: selection.source,
    sourceEventId: deliveryId,
    occurredAt: selection.occurredAt,
    attribution: attribution.atomAttribution,
    completeness: BranchActivityEvidenceCompleteness.Partial,
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
    pushEvidence: mapped.pushEvidence,
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
  payload: unknown,
  pushCompare: RawPushCompare
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
      return selectPushActivity(root, pushCompare);
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
    return lifecycleSelection(
      PullRequestLifecycleOccurrence.Opened,
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
    return merged
      ? lifecycleSelection(
          PullRequestLifecycleOccurrence.Merged,
          pullRequest?.merged_at
        )
      : lifecycleSelection(
          PullRequestLifecycleOccurrence.Closed,
          pullRequest?.closed_at
        );
  }
  return noWrite(GitHubBranchActivityNoWriteReason.UnsupportedAction);
}

function lifecycleSelection(
  occurrence: PullRequestLifecycleOccurrence,
  timestamp: unknown
): ActivitySelectionResult {
  const selection = activitySelection(
    BranchActivitySource.PullRequestLifecycle,
    BranchActivityAttributionKind.PullRequest,
    timestamp
  );
  return selection.status === GitHubBranchActivityMappingStatus.Mapped
    ? { ...selection, occurrence }
    : selection;
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
      atomAttribution: {
        kind: BranchActivityAttributionKind.PullRequest,
        pullRequestId: attribution.pullRequestDetailId,
      },
    };
  }
  if (attribution.pullRequestDetailId) {
    return {
      ok: false,
      reason: GitHubBranchActivityNoWriteReason.InvalidAttribution,
    };
  }
  return {
    ok: true,
    organizationId: attribution.organizationId,
    branchArtifactId: attribution.branchArtifactId,
    atomAttribution: { kind: BranchActivityAttributionKind.Branch },
  };
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
    case BranchActivityPersistStatus.FutureTimestamp:
      return GitHubBranchActivityNoWriteReason.PersistenceFutureTimestamp;
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
  | typeof BranchActivitySource.GitHubWebhook
  | typeof BranchActivitySource.PushLoc;

type ActivitySelection = {
  status: typeof GitHubBranchActivityMappingStatus.Mapped;
  source: ActivitySource;
  attributionKind: BranchActivityAttributionKind;
  occurredAt: string;
  /** Set only for PR lifecycle events, which key by occurrence not delivery. */
  occurrence?: PullRequestLifecycleOccurrence;
  /** Set only for push deliveries (ISS-10009). */
  pushEvidence?: BranchActivityPushEvidence;
};

type ActivitySelectionResult = ActivitySelection | GitHubBranchActivityNoWrite;

/** The caller's push compare, still unknown-at-runtime (ISS-10009). */
type RawPushCompare = { baseSha: unknown; lineDelta: unknown };

type DeliveryParseResult =
  | { ok: true; deliveryId: string }
  | { ok: false; reason: GitHubBranchActivityNoWriteReason };

type TimestampParseResult =
  | { ok: true; value: string }
  | { ok: false; reason: GitHubBranchActivityNoWriteReason };

/**
 * The success arm carries the atom attribution already built, because this is
 * the only place `pullRequestDetailId` is narrowed to a string for the
 * PullRequest kind. Returning the raw id instead would hand the caller an
 * invariant the compiler could not check.
 */
type AttributionParseResult =
  | {
      ok: true;
      organizationId: string;
      branchArtifactId: string;
      atomAttribution: BranchActivityAtom["attribution"];
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

/**
 * Select the per-push atom (ISS-10009, operator ruling 1).
 *
 * `occurredAt` is the NEWEST `commits[].timestamp`, the only occurrence time a
 * push has. A ZERO-COMMIT push — a branch delete, or a force-push to an already
 * existing sha — carries none, so it writes no row rather than adopting receipt
 * time. That rule is enforced HERE and not left to the timestamp fold: the fold
 * also reads `head_commit`, which a zero-commit delivery still populates with
 * the branch's prior tip, so folding first would time a row by a commit this
 * push did not carry. The lane is `push_loc`, excluded from
 * `canonicalBranchActivitySources` so it cannot reach the Last-active aggregate
 * the Branches list sorts on.
 */
function selectPushActivity(
  root: UnknownRecord | undefined,
  pushCompare: RawPushCompare
): ActivitySelectionResult {
  const pushEvidence = branchActivityPushEvidence({
    beforeSha: stringValue(pushCompare.baseSha) ?? root?.before,
    afterSha: root?.after,
    lineDelta: pushCompare.lineDelta,
  });
  if (!pushEvidence) {
    return noWrite(GitHubBranchActivityNoWriteReason.MissingPushRange);
  }
  const commits = root?.commits;
  if (!(Array.isArray(commits) && commits.length > 0)) {
    return noWrite(
      GitHubBranchActivityNoWriteReason.MissingAuthoritativeTimestamp
    );
  }
  const occurredAt = newestCommitTimestamp(commits, root?.head_commit);
  if (!occurredAt.ok) {
    return noWrite(occurredAt.reason);
  }
  return {
    status: GitHubBranchActivityMappingStatus.Mapped,
    source: BranchActivitySource.PushLoc,
    attributionKind: BranchActivityAttributionKind.Branch,
    occurredAt: occurredAt.value,
    pushEvidence,
  };
}

/**
 * The newest parseable commit timestamp in the payload, normalized to UTC.
 *
 * Commits arrive in push order, which is NOT timestamp order — a rebase, a
 * cherry-pick, or a skewed client clock reorders them — so the newest is
 * computed, never taken positionally. `head_commit` is folded in beside the
 * array because `commits[]` is TRUNCATED: `webhook-body-caps.test.ts` records a
 * 400-commit push arriving with 20 entries plus a separate `head_commit`, so
 * reading the array alone would compute a confident time from a capped set.
 * A payload carrying no timestamp at all is a different failure from one whose
 * every timestamp is unparseable, and the two reasons are kept apart so the
 * second is visibly a provider defect.
 */
function newestCommitTimestamp(
  commits: readonly unknown[],
  headCommit: unknown
): TimestampParseResult {
  const present = [...commits, headCommit]
    .map((entry) => recordValue(entry)?.timestamp)
    .filter((raw) => raw !== null && raw !== undefined && raw !== "");
  if (present.length === 0) {
    return {
      ok: false,
      reason: GitHubBranchActivityNoWriteReason.MissingAuthoritativeTimestamp,
    };
  }
  const epochMs = present
    .flatMap((raw) => {
      const parsed = pushCommitTimestampSchema.safeParse(raw);
      return parsed.success ? [Date.parse(parsed.data)] : [];
    })
    .filter((ms) => Number.isFinite(ms));
  if (epochMs.length === 0) {
    return {
      ok: false,
      reason: GitHubBranchActivityNoWriteReason.InvalidAuthoritativeTimestamp,
    };
  }
  const newest = epochMs.reduce((left, right) => (right > left ? right : left));
  return { ok: true, value: new Date(newest).toISOString() };
}

/** Push commit times carry a local offset; every other lane's time is UTC. */
const pushCommitTimestampSchema = z.iso.datetime({ offset: true });
