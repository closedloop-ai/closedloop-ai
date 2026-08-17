/**
 * @file agent-dashboard-trace-comment-sync.ts
 * @description ISS-4771: the trace-comment lane of the Agent Dashboard
 * design-system runtime — the local `store:traceComments.*` forwarders, the
 * cloud list/upload synchronizer (with its per-target coalescing, missing-parent
 * -session retry, and rate-limited error logging), and the renderer-payload
 * coercers the trace-comment IPC handlers validate with. Extracted whole out of
 * the shrink-only grandfathered `agent-dashboard-design-system-runtime.ts`; the
 * flow, ordering, and error handling are unchanged.
 */
import {
  branchTraceCommentCollectionQuerySchema,
  TRACE_COMMENT_ID_MAX_LENGTH,
  type TraceComment,
  type TraceCommentDeleteResult,
  type TraceCommentDraft,
  type TraceCommentReplyDraft,
  TraceCommentSurface,
  type TraceCommentTarget,
  TraceCommentTargetType,
  type TraceCommentUpdate,
  traceCommentDraftSchema,
  traceCommentPath,
  traceCommentRepliesPath,
  traceCommentReplyDraftSchema,
  traceCommentsPath,
  traceCommentTargetSchema,
  traceCommentUpdateSchema,
} from "@repo/api/src/types/comment";
import type { ApiResult } from "@repo/api/src/types/common";
import { z } from "zod";
import type { SharedTraceCommentStoreTarget } from "../../shared/shared-trace-comments-contract.js";
import type { AgentSessionSyncSource } from "../agent-sync/agent-session-sync-source.js";
import { resolveDesktopCloudCredential } from "../auth/desktop-cloud-credential.js";
import type {
  PendingTraceCommentSyncOperation,
  UserIdentity,
} from "../trace-comments/shared-trace-comments-store.js";
import { syncCloudSessionForTraceComments } from "../trace-comments/trace-comment-parent-session-recovery.js";
import type {
  AgentDashboardDesignSystemRuntimeOptions,
  InvokeStoreOp,
} from "./agent-dashboard-runtime-options.js";

const activeTraceCommentCloudSyncs = new Map<string, Promise<void>>();
const traceCommentCloudSyncErrorLogTimes = new Map<string, number>();
const TRACE_COMMENT_CLOUD_SYNC_ERROR_LOG_INTERVAL_MS = 30_000;
export const TRACE_COMMENT_BACKGROUND_SYNC_INTERVAL_MS = 10_000;
// Bound every cloud request so a hung dependency cannot stall the pending-comment
// sync retry loop indefinitely; matches the transcript-sync client convention.
const TRACE_COMMENT_CLOUD_REQUEST_TIMEOUT_MS = 30_000;
const cloudTraceCommentIdentitySchema = z.object({
  target: traceCommentTargetSchema,
  artifactId: z.string().min(1),
  surface: z.union([
    z.literal(TraceCommentSurface.SessionDetail),
    z.literal(TraceCommentSurface.BranchDetail),
    z.literal(TraceCommentSurface.BranchTimeline),
  ]),
});

export async function listLocalTraceComments(
  invokeStoreOp: InvokeStoreOp,
  target: TraceCommentTarget,
  identity: UserIdentity
): Promise<TraceComment[]> {
  return (await invokeStoreOp("traceComments.list", [
    target,
    identity,
  ])) as TraceComment[];
}

export async function createLocalTraceComment(
  invokeStoreOp: InvokeStoreOp,
  target: TraceCommentTarget,
  draft: TraceCommentDraft,
  identity: UserIdentity
): Promise<TraceComment> {
  return (await invokeStoreOp("traceComments.create", [
    target,
    draft,
    identity,
  ])) as TraceComment;
}

export async function createLocalTraceCommentReply(
  invokeStoreOp: InvokeStoreOp,
  target: TraceCommentTarget,
  commentId: string,
  draft: TraceCommentReplyDraft,
  identity: UserIdentity
): Promise<TraceComment> {
  return (await invokeStoreOp("traceComments.reply", [
    target,
    commentId,
    draft,
    identity,
  ])) as TraceComment;
}

export async function updateLocalTraceComment(
  invokeStoreOp: InvokeStoreOp,
  target: TraceCommentTarget,
  commentId: string,
  update: TraceCommentUpdate,
  identity: UserIdentity
): Promise<TraceComment> {
  return (await invokeStoreOp("traceComments.update", [
    target,
    commentId,
    update,
    identity,
  ])) as TraceComment;
}

export async function deleteLocalTraceComment(
  invokeStoreOp: InvokeStoreOp,
  target: TraceCommentTarget,
  commentId: string,
  identity: UserIdentity
): Promise<TraceCommentDeleteResult> {
  return (await invokeStoreOp("traceComments.delete", [
    target,
    commentId,
    identity,
  ])) as TraceCommentDeleteResult;
}

async function upsertCloudTraceComments(
  invokeStoreOp: InvokeStoreOp,
  target: TraceCommentTarget,
  comments: readonly TraceComment[],
  identity: UserIdentity
): Promise<void> {
  await invokeStoreOp("traceComments.upsertCloud", [
    target,
    comments,
    identity,
  ]);
}

async function listPendingLocalTraceCommentOperations(
  invokeStoreOp: InvokeStoreOp,
  target: TraceCommentTarget,
  identity: UserIdentity
): Promise<PendingTraceCommentSyncOperation[]> {
  return (await invokeStoreOp("traceComments.listPendingOperations", [
    target,
    identity,
  ])) as PendingTraceCommentSyncOperation[];
}

async function listPendingLocalTraceCommentTargets(
  invokeStoreOp: InvokeStoreOp,
  identity: UserIdentity
): Promise<TraceCommentTarget[]> {
  return (await invokeStoreOp("traceComments.listPendingTargets", [
    identity,
  ])) as TraceCommentTarget[];
}

async function markLocalTraceCommentUploaded(
  invokeStoreOp: InvokeStoreOp,
  localCommentId: string,
  cloudComment: TraceComment
): Promise<void> {
  await invokeStoreOp("traceComments.markUploaded", [
    localCommentId,
    cloudComment,
  ]);
}

async function markLocalTraceCommentSyncFailed(
  invokeStoreOp: InvokeStoreOp,
  localCommentId: string,
  error: unknown,
  operation: PendingTraceCommentSyncOperation["operation"]
): Promise<void> {
  await invokeStoreOp("traceComments.markSyncFailed", [
    localCommentId,
    syncErrorMessage(error),
    operation,
  ]);
}

async function markLocalTraceCommentReplyUploaded(
  invokeStoreOp: InvokeStoreOp,
  localCommentId: string,
  localReplyId: string,
  cloudComment: TraceComment
): Promise<void> {
  await invokeStoreOp("traceComments.markReplyUploaded", [
    localCommentId,
    localReplyId,
    cloudComment,
  ]);
}

async function markLocalTraceCommentReplySyncFailed(
  invokeStoreOp: InvokeStoreOp,
  localCommentId: string,
  localReplyId: string,
  error: unknown
): Promise<void> {
  await invokeStoreOp("traceComments.markReplySyncFailed", [
    localCommentId,
    localReplyId,
    syncErrorMessage(error),
  ]);
}

async function markLocalTraceCommentDeleted(
  invokeStoreOp: InvokeStoreOp,
  localCommentId: string
): Promise<void> {
  await invokeStoreOp("traceComments.markDeleted", [localCommentId]);
}

export function runTraceCommentCloudSync(
  invokeStoreOp: InvokeStoreOp,
  syncSource: AgentSessionSyncSource | null,
  target: TraceCommentTarget,
  options: AgentDashboardDesignSystemRuntimeOptions
): Promise<void> {
  if (!hasCloudTraceCommentsAuth(options)) {
    return Promise.resolve();
  }

  const key = traceCommentTargetKey(target);
  const active = activeTraceCommentCloudSyncs.get(key);
  if (active) {
    return active;
  }

  const sync = synchronizeTraceCommentTargetWithCloud(
    invokeStoreOp,
    syncSource,
    target,
    options
  ).finally(() => {
    activeTraceCommentCloudSyncs.delete(key);
  });
  activeTraceCommentCloudSyncs.set(key, sync);
  return sync;
}

export async function runPendingTraceCommentCloudSync(
  invokeStoreOp: InvokeStoreOp,
  syncSource: AgentSessionSyncSource | null,
  options: AgentDashboardDesignSystemRuntimeOptions
): Promise<void> {
  if (!hasCloudTraceCommentsAuth(options)) {
    return;
  }

  let targets: TraceCommentTarget[];
  const identity = getTraceCommentStoreScope(options);
  try {
    targets = await listPendingLocalTraceCommentTargets(
      invokeStoreOp,
      identity
    );
  } catch (error) {
    options.log?.(
      "trace-comments",
      `Pending sync discovery failed: ${syncErrorMessage(error)}`
    );
    return;
  }

  for (const target of targets) {
    await runTraceCommentCloudSync(invokeStoreOp, syncSource, target, options);
  }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: keeps the pending operation sync flow linear and auditable under the deadline.
async function synchronizeTraceCommentTargetWithCloud(
  invokeStoreOp: InvokeStoreOp,
  syncSource: AgentSessionSyncSource | null,
  target: TraceCommentTarget,
  options: AgentDashboardDesignSystemRuntimeOptions
): Promise<void> {
  try {
    const identity = getTraceCommentStoreScope(options);
    const cloudComments = await withTraceCommentSessionRetry(
      syncSource,
      target,
      options,
      () => fetchCloudTraceComments<TraceComment[]>(target, "GET", options)
    );
    await upsertCloudTraceComments(
      invokeStoreOp,
      target,
      cloudComments,
      identity
    );
  } catch (error) {
    logTraceCommentCloudSyncError(options, "list", target, error);
  }

  const pending = await listPendingLocalTraceCommentOperations(
    invokeStoreOp,
    target,
    getTraceCommentStoreScope(options)
  );
  for (const pendingOperation of pending) {
    try {
      if (pendingOperation.operation === "create") {
        const uploaded = await withTraceCommentSessionRetry(
          syncSource,
          target,
          options,
          () =>
            fetchCloudTraceComments<TraceComment>(target, "POST", options, {
              anchor: pendingOperation.comment.anchor,
              body: pendingOperation.comment.body,
              // Stable local row id as the idempotency key (FEA-3598): a create
              // re-POSTed after a lost response (timeout, or the app killed
              // before the row was marked uploaded) dedups server-side onto the
              // same thread instead of double-creating.
              clientId: pendingOperation.comment.id,
              // Forward the picked @-mentions so a mention added offline reaches
              // the cloud (FEA-3490); the API re-scopes them to the org.
              ...(pendingOperation.comment.mentions
                ? { mentions: pendingOperation.comment.mentions }
                : {}),
              // Forward the classification so a comment flagged as a parsing/data
              // bug offline reaches the cloud golden-candidate pipeline (FEA-4171).
              ...(pendingOperation.comment.kind
                ? { kind: pendingOperation.comment.kind }
                : {}),
            })
        );
        assertCloudTraceCommentMatchesTarget(target, uploaded);
        await markLocalTraceCommentUploaded(
          invokeStoreOp,
          pendingOperation.comment.id,
          uploaded
        );
        continue;
      }

      if (pendingOperation.operation === "update") {
        const cloudCommentId = pendingOperation.cloudCommentId;
        if (!cloudCommentId) {
          continue;
        }
        const updated = await withTraceCommentSessionRetry(
          syncSource,
          target,
          options,
          () =>
            fetchCloudTraceComments<TraceComment>(
              target,
              "PATCH",
              options,
              // Send the row's current mentions so a desktop-side edit keeps
              // them in sync with the cloud (FEA-3490); the API re-scopes them.
              {
                body: pendingOperation.comment.body,
                ...(pendingOperation.comment.mentions
                  ? { mentions: pendingOperation.comment.mentions }
                  : {}),
              },
              cloudCommentId
            )
        );
        assertCloudTraceCommentMatchesTarget(
          target,
          updated,
          pendingOperation.comment.artifactId
        );
        await markLocalTraceCommentUploaded(
          invokeStoreOp,
          pendingOperation.comment.id,
          updated
        );
        continue;
      }

      if (pendingOperation.operation === "reply") {
        const cloudCommentId = pendingOperation.cloudCommentId;
        const reply = pendingOperation.reply;
        const localReplyId = pendingOperation.localReplyId;
        if (!(cloudCommentId && reply && localReplyId)) {
          continue;
        }
        const updated = await withTraceCommentSessionRetry(
          syncSource,
          target,
          options,
          () =>
            fetchCloudTraceComments<TraceComment>(
              target,
              "POST",
              options,
              // Forward reply @-mentions to the cloud (FEA-3490); re-scoped by API.
              {
                body: reply.body,
                // Stable local reply id as the idempotency key (FEA-3598): a
                // reply re-POSTed after a lost response dedups server-side
                // instead of appending a duplicate reply.
                clientId: localReplyId,
                ...(reply.mentions ? { mentions: reply.mentions } : {}),
              },
              cloudCommentId,
              "replies"
            )
        );
        assertCloudTraceCommentMatchesTarget(
          target,
          updated,
          pendingOperation.comment.artifactId
        );
        await markLocalTraceCommentReplyUploaded(
          invokeStoreOp,
          pendingOperation.comment.id,
          localReplyId,
          updated
        );
        continue;
      }

      const cloudCommentId = pendingOperation.cloudCommentId;
      if (!cloudCommentId) {
        continue;
      }
      await withTraceCommentSessionRetry(syncSource, target, options, () =>
        fetchCloudTraceComments<TraceCommentDeleteResult>(
          target,
          "DELETE",
          options,
          undefined,
          cloudCommentId
        )
      );
      await markLocalTraceCommentDeleted(
        invokeStoreOp,
        pendingOperation.comment.id
      );
    } catch (error) {
      if (
        pendingOperation.operation === "reply" &&
        pendingOperation.localReplyId
      ) {
        await markLocalTraceCommentReplySyncFailed(
          invokeStoreOp,
          pendingOperation.comment.id,
          pendingOperation.localReplyId,
          error
        );
        logTraceCommentCloudSyncError(options, "upload", target, error);
        continue;
      }
      await markLocalTraceCommentSyncFailed(
        invokeStoreOp,
        pendingOperation.comment.id,
        error,
        pendingOperation.operation
      );
      logTraceCommentCloudSyncError(options, "upload", target, error);
    }
  }
}

function traceCommentTargetKey(target: TraceCommentTarget): string {
  return `${target.type}:${target.id}:${branchSurfaceForTarget(target) ?? ""}`;
}

function branchSurfaceForTarget(
  target: TraceCommentTarget
): TraceCommentSurface | undefined {
  if (target.type !== TraceCommentTargetType.Branch) {
    return undefined;
  }
  return (target as TraceCommentTarget & { surface?: TraceCommentSurface })
    .surface;
}

function assertCloudTraceCommentMatchesTarget(
  target: TraceCommentTarget,
  comment: unknown,
  expectedArtifactId?: string
): void {
  const expectedSurface =
    branchSurfaceForTarget(target) ?? TraceCommentSurface.SessionDetail;
  const parsed = cloudTraceCommentIdentitySchema.safeParse(comment);
  if (
    !parsed.success ||
    parsed.data.target.type !== target.type ||
    parsed.data.target.id !== target.id ||
    parsed.data.surface !== expectedSurface ||
    (expectedArtifactId !== undefined &&
      parsed.data.artifactId !== expectedArtifactId)
  ) {
    throw new Error("Cloud trace comment response did not match its target.");
  }
}

export function logTraceCommentCloudSyncError(
  options: AgentDashboardDesignSystemRuntimeOptions,
  phase: "list" | "sync" | "upload",
  target: TraceCommentTarget,
  error: unknown
): void {
  const message = error instanceof Error ? error.message : String(error);
  const key = `${phase}:${traceCommentTargetKey(target)}:${message}`;
  const now = Date.now();
  const lastLoggedAt = traceCommentCloudSyncErrorLogTimes.get(key) ?? 0;
  if (now - lastLoggedAt < TRACE_COMMENT_CLOUD_SYNC_ERROR_LOG_INTERVAL_MS) {
    return;
  }
  traceCommentCloudSyncErrorLogTimes.set(key, now);
  options.log?.(
    "trace-comments",
    `Cloud ${phase} failed for ${traceCommentTargetKey(target)}: ${message}`
  );
}

function syncErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 1000);
}

async function withTraceCommentSessionRetry<T>(
  syncSource: AgentSessionSyncSource | null,
  target: TraceCommentTarget,
  options: AgentDashboardDesignSystemRuntimeOptions,
  operation: () => Promise<T>
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (!isRetryableMissingSession(error, target)) {
      throw error;
    }
    await syncCloudSessionForTraceComments(syncSource, target, options);
    return await operation();
  }
}

function isRetryableMissingSession(
  error: unknown,
  target: TraceCommentTarget
): boolean {
  return (
    target.type === "session" &&
    error instanceof TraceCommentCloudRequestError &&
    error.status === 404
  );
}

function hasCloudTraceCommentsAuth(
  options: AgentDashboardDesignSystemRuntimeOptions
): boolean {
  // FEA-3425 (Phase 4a): cloud trace-comment auth is session-only. The static
  // `sk_live_*` fallback was removed once session coverage cleared the D7
  // no-strand gate; a live first-party session is now required.
  return Boolean(options.hasDesktopSessionAuth?.() && options.getApiOrigin?.());
}

export function getTraceCommentStoreScope(
  options: AgentDashboardDesignSystemRuntimeOptions
): UserIdentity {
  const identity = options.getUserIdentity?.() ?? null;
  return {
    profileId: options.getProfileId?.() ?? null,
    computeTargetId: options.getComputeTargetId?.() ?? null,
    userId: identity?.userId ?? null,
    organizationId: identity?.organizationId ?? null,
  };
}

async function fetchCloudTraceComments<T>(
  target: TraceCommentTarget,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  options: AgentDashboardDesignSystemRuntimeOptions,
  body?: TraceCommentDraft | TraceCommentReplyDraft | TraceCommentUpdate,
  commentId?: string,
  childPath?: "replies"
): Promise<T> {
  const apiOrigin = options.getApiOrigin?.();
  // FEA-3425 (Phase 4a): session-only. `hasCloudTraceCommentsAuth` gates every
  // caller on a live first-party session, so the shared resolver only ever
  // returns the session token here (the static-key fallback was removed).
  const credential = await resolveDesktopCloudCredential(options);
  if (!(credential && apiOrigin)) {
    throw new Error("Desktop cloud auth unavailable.");
  }

  const url = new URL(
    traceCommentCloudPath(target, commentId, childPath),
    apiOrigin
  );
  const computeTargetId = options.getComputeTargetId?.();
  if (target.type === "session" && computeTargetId) {
    url.searchParams.set("computeTargetId", computeTargetId);
  }
  const response = await fetch(url, {
    ...(body ? {} : { cache: "no-store" }),
    method,
    headers: {
      Authorization: `Bearer ${credential.token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(TRACE_COMMENT_CLOUD_REQUEST_TIMEOUT_MS),
  });
  const payload = (await response
    .json()
    .catch(() => null)) as ApiResult<T> | null;
  if (!(response.ok && payload?.success === true)) {
    throw new TraceCommentCloudRequestError(
      payload && "error" in payload
        ? payload.error
        : `Trace comments request failed with status ${response.status}.`,
      response.status
    );
  }
  return payload.data;
}

class TraceCommentCloudRequestError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "TraceCommentCloudRequestError";
    this.status = status;
  }
}

function traceCommentCloudPath(
  target: TraceCommentTarget,
  commentId?: string,
  childPath?: "replies"
): string {
  let path = traceCommentsPath(target);
  if (commentId) {
    path =
      childPath === "replies"
        ? traceCommentRepliesPath(target, commentId)
        : traceCommentPath(target, commentId);
  }
  const surface = branchSurfaceForTarget(target);
  return surface ? `${path}?surface=${encodeURIComponent(surface)}` : path;
}

export function coerceTraceCommentTarget(
  value: unknown
): TraceCommentTarget | null {
  const result = traceCommentTargetSchema.safeParse(value);
  return result.success ? result.data : null;
}

/** Coerce legacy target-only IPC and the additive Branch surface sidecar. */
export function coerceTraceCommentStoreTarget(
  value: unknown,
  queryValue: unknown
): SharedTraceCommentStoreTarget | null {
  const target = coerceTraceCommentTarget(value);
  if (!target) {
    return null;
  }
  if (target.type !== TraceCommentTargetType.Branch) {
    return target;
  }
  const query = branchTraceCommentCollectionQuerySchema
    .strip()
    .safeParse(queryValue ?? {});
  if (!query.success) {
    return null;
  }
  return {
    ...target,
    surface: query.data.surface ?? TraceCommentSurface.BranchDetail,
  };
}

export function coerceTraceCommentDraft(
  value: unknown
): TraceCommentDraft | null {
  const result = traceCommentDraftSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function coerceTraceCommentReplyDraft(
  value: unknown
): TraceCommentReplyDraft | null {
  const result = traceCommentReplyDraftSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function coerceTraceCommentUpdate(
  value: unknown
): TraceCommentUpdate | null {
  const result = traceCommentUpdateSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function coerceTraceCommentId(value: unknown): string | null {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= TRACE_COMMENT_ID_MAX_LENGTH
    ? value
    : null;
}

/**
 * Drop the rate-limiter's remembered "last logged at" stamps. Called when the
 * runtime closes so a disposed runtime leaves nothing behind in this
 * module-scoped map (the pre-extraction runtime cleared the same map inline).
 */
export function clearTraceCommentCloudSyncErrorLog(): void {
  traceCommentCloudSyncErrorLogTimes.clear();
}

/** The runtime seams the pending-sync driver needs, injected so it owns no globals. */
export type TraceCommentSyncDriverDeps = {
  invokeStoreOp: InvokeStoreOp;
  getSyncSource: () => AgentSessionSyncSource | null;
  options: AgentDashboardDesignSystemRuntimeOptions;
  /** True once the runtime is tearing down; every entry point becomes a no-op. */
  isClosed: () => boolean;
  /** Routes a tick through the runtime's serialized startup background queue. */
  enqueueBackgroundTask: (task: () => Promise<void>) => Promise<void>;
  log: (message: string) => void;
};

export type TraceCommentSyncDriver = {
  /** Run one pending-comment sync, coalescing with an already-running pass. */
  runPendingSync: () => Promise<void>;
  /** Start the periodic retry (idempotent; a no-op once closed or started). */
  startRetryInterval: () => void;
  /** Clear the retry interval. Safe to call when it was never started. */
  stopRetryInterval: () => void;
};

/**
 * ISS-5103 (extraction): the pending-trace-comment sync driver, lifted out of
 * `agent-dashboard-design-system-runtime.ts` so its two pieces of mutable state
 * — the in-flight coalescing promise and the retry-interval handle — live with
 * the sync logic that owns them instead of as runtime-scope variables.
 *
 * FEA-2261: every retry tick goes through the runtime's serialized startup queue
 * so a retry never overlaps still-draining startup work and always yields a
 * renderer background slot before touching the child loop.
 *
 * FEA-2931: callers start the interval behind the fast first-paint gate ONLY,
 * never the collector-import settle — gating the start behind the settle coupled
 * the failed-upload retry SLA (FEA-2242, ~10s) to first-launch maintenance, so a
 * transient 500 went unretried for up to 5 minutes whenever collectors were
 * idle, disabled, or stuck.
 */
export function createTraceCommentSyncDriver(
  deps: TraceCommentSyncDriverDeps
): TraceCommentSyncDriver {
  let activeSync: Promise<void> | null = null;
  let retryTimer: ReturnType<typeof setInterval> | null = null;

  const runPendingSync = async (): Promise<void> => {
    if (deps.isClosed()) {
      return;
    }
    if (activeSync) {
      await activeSync;
      return;
    }
    const sync = runPendingTraceCommentCloudSync(
      deps.invokeStoreOp,
      deps.getSyncSource(),
      deps.options
    ).finally(() => {
      if (activeSync === sync) {
        activeSync = null;
      }
    });
    activeSync = sync;
    await sync;
  };

  return {
    runPendingSync,
    startRetryInterval(): void {
      if (deps.isClosed() || retryTimer) {
        return;
      }
      retryTimer = setInterval(() => {
        deps
          .enqueueBackgroundTask(runPendingSync)
          .catch((error: unknown) =>
            deps.log(
              `Pending sync retry failed: ${error instanceof Error ? error.message : String(error)}`
            )
          );
      }, TRACE_COMMENT_BACKGROUND_SYNC_INTERVAL_MS);
    },
    stopRetryInterval(): void {
      if (retryTimer) {
        clearInterval(retryTimer);
        retryTimer = null;
      }
    },
  };
}
