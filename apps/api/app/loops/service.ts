import { createHash } from "node:crypto";
import { AdditionalRepoRefSchema } from "@closedloop-ai/loops-api/context-pack";
import type {
  HeartbeatResult,
  RunnerTokenIssue,
} from "@closedloop-ai/loops-api/token-refresh";
import { LinkType } from "@repo/api/src/types/artifact";
import type { JsonObject } from "@repo/api/src/types/common";
import { HarnessType } from "@repo/api/src/types/compute-target";
import type { BranchInfo, PullRequestInfo } from "@repo/api/src/types/document";
import {
  type AdditionalRepoRefWithPr,
  type ComputeTargetSummary,
  type CreateLoopRequest,
  type CreateLoopResponse,
  HeartbeatErrorCode,
  INHERITANCE_ANCESTOR_MAX_DEPTH,
  type InheritedAdditionalRepos,
  type Loop,
  LoopCommand,
  type LoopDetail,
  LoopErrorCode,
  type LoopEventsFilters,
  type LoopEventsPaginatedResponse,
  LoopEventType,
  type LoopListFilters,
  LoopStatus,
  type LoopSupportArtifact,
  type LoopUsageByCommand,
  type LoopUsageByUser,
  type LoopUsageSummary,
  type LoopWithUser,
  type RefreshError,
  type RefreshResult,
  RefreshTokenErrorCode,
  type ResumeLoopRequest,
  type StoredLoopEvent,
  type TokensByModel,
} from "@repo/api/src/types/loop";
import {
  issueLoopRunnerToken,
  type LoopRunnerTokenIssueResult,
} from "@repo/auth/loop-runner-jwt";
import {
  type GitHubInstallationRepository,
  GitHubInstallationStatus,
  Prisma,
  type Loop as PrismaLoop,
  withDb,
} from "@repo/database";
import { verifyInstallationBranchExists } from "@repo/github";
import { log } from "@repo/observability/log";
import { z } from "zod";
import { documentPullRequestService } from "@/app/documents/document-pull-request-service";
import type { LoopRuntimeState } from "@/app/loops/types";
import { mapTagRelations, TAG_RELATION_INCLUDE } from "@/app/tags/service";
import { basicUserSelect, getPrismaErrorCode } from "@/lib/db-utils";
import {
  findNonTerminalBlockers,
  type LoopBlocker,
} from "@/lib/loops/loop-blockers";
import {
  generateDownloadUrl,
  validateKeyBelongsToLoop,
} from "@/lib/loops/loop-state";
import { ACTIVE_LOOP_STATUSES } from "@/lib/loops/loop-statuses";
import { extractUploadedPlanRaw } from "@/lib/loops/uploaded-plan-artifacts";
import {
  emitHeartbeatAccepted,
  emitReapReversed,
  emitRefreshAttempt,
  emitRefreshFailure,
  mapRefreshErrorCodeToReason,
  ReapReason,
} from "@/lib/observability/loop-runner-metrics";
import {
  HEARTBEAT_RATE_LIMIT_WINDOW_MS,
  LOOP_ACTIVE_INDEX_NAME,
  LOOP_BLOCKED_INDEX_NAME,
  REVIVAL_GRACE_WINDOW_MS,
  REVIVAL_MAX_PER_LOOP,
} from "./loop-constants";
import {
  BranchNotFoundError,
  ConcurrentLoopLimitError,
  InvalidStatusTransitionError,
  LoopAlreadyActiveError,
  NestedManualLoopError,
  ReplayDetectedError,
  RepoNotInProjectPoolError,
  UnauthorizedRepoError,
} from "./loop-errors";
import {
  IngestRunnerEventErrorCode,
  type IngestRunnerEventResult,
} from "./loop-ingest-types";
import { clearLoopTokens } from "./loop-token-cleanup";
import { shouldIgnoreEventForTerminalLoop } from "./validators";

/**
 * Fetch the effective concurrent loop limit for an organization from the DB.
 * Reads Organization.settings.maxConcurrentLoops and falls back to
 * DEFAULT_MAX_CONCURRENT_LOOPS for missing or invalid values.
 */
export async function fetchOrgLoopLimit(
  organizationId: string
): Promise<number> {
  const org = await withDb((db) =>
    db.organization.findUnique({
      where: { id: organizationId },
      select: { settings: true },
    })
  );
  return resolveOrgLoopLimit(org?.settings);
}

/**
 * Valid status transitions for loops.
 * Key = current status, Value = set of allowed next statuses.
 */
const VALID_TRANSITIONS: Record<LoopStatus, Set<LoopStatus>> = {
  // PENDING → RUNNING covers the race where the container sends "started"
  // before the backend has finished transitioning to CLAIMED.
  // PENDING → FAILED covers the pre-dispatch guard path in launchLoop: when
  // a required parent state is unavailable, failLoopWithError is called before
  // any task is dispatched, while the loop is still PENDING.
  PENDING: new Set<LoopStatus>([
    LoopStatus.Claimed,
    LoopStatus.Running,
    LoopStatus.Cancelled,
    LoopStatus.Failed,
  ]),
  // CLAIMED → terminal states covers the case where the "started" event was
  // dropped (network issue, transient failure). Without this, a lost "started"
  // event would strand the loop in CLAIMED until the cron timeout safety net.
  CLAIMED: new Set<LoopStatus>([
    LoopStatus.Running,
    LoopStatus.Completed,
    LoopStatus.Failed,
    LoopStatus.Cancelled,
    LoopStatus.TimedOut,
  ]),
  RUNNING: new Set<LoopStatus>([
    LoopStatus.Completed,
    LoopStatus.Failed,
    LoopStatus.Cancelled,
    LoopStatus.TimedOut,
  ]),
  COMPLETED: new Set<LoopStatus>(),
  // A successful completion from the runner overrides a prior failure or timeout.
  // The runner is the ground truth for whether work actually finished.
  FAILED: new Set<LoopStatus>([LoopStatus.Completed]),
  // A successful completion from the runner overrides a prior cancellation.
  // The runner is the ground truth for whether work actually finished.
  CANCELLED: new Set<LoopStatus>([LoopStatus.Completed]),
  // Revival (TIMED_OUT → RUNNING) is handled exclusively by reviveTimedOutLoop's
  // own guarded CAS, which does not consult this table. RUNNING is deliberately
  // omitted here so the generic updateStatus cannot perform an unguarded revival.
  TIMED_OUT: new Set<LoopStatus>([LoopStatus.Completed]),
  // BLOCKED → PENDING is performed by reconcileBlockedLoops once every blocking
  // artifact reaches a terminal status, releasing the loop into the normal
  // claim path. BLOCKED → CANCELLED lets a user abandon a deferred loop.
  BLOCKED: new Set<LoopStatus>([LoopStatus.Pending, LoopStatus.Cancelled]),
};

const TERMINAL_STATUSES = new Set<LoopStatus>([
  LoopStatus.Completed,
  LoopStatus.Failed,
  LoopStatus.Cancelled,
  LoopStatus.TimedOut,
]);

/** Max deferred (BLOCKED) loops re-evaluated per reconciliation pass. Bounds
 * the cron budget; any remainder is handled on the next tick. */
const RECONCILE_BLOCKED_LOOPS_BATCH = 200;

/** Age after which an unreleased deferred (BLOCKED) loop is force-cancelled by
 * the reconciliation cron. A blocker that is abandoned without ever reaching a
 * terminal status (e.g. a FEAT left open, never marked OBSOLETE) would otherwise
 * strand its deferred loop in BLOCKED forever — this failsafe reaps it. */
const STALE_BLOCKED_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;

type FindLoopByIdOptions = {
  /**
   * Resolves support artifact download URLs for detail views. Keep disabled for
   * status/event hot paths that only need the loop record.
   */
  includeSupportArtifacts?: boolean;
};

const supportBundleFileSchema = z.object({
  name: z.string().min(1).optional(),
  key: z.string().min(1),
  sizeBytes: z.number().int().nonnegative().optional(),
});

const supportBundleEventDataSchema = z.object({
  keys: z.array(z.string().min(1)).min(1).max(2),
  files: z.array(supportBundleFileSchema).max(2).optional(),
});

/**
 * Age threshold beyond which a PENDING loop with no containerId is treated as
 * an orphan (silently-failed dispatch). Used by the reap step and by the
 * operationally-active lookup so the two stay in lockstep.
 */
const STALE_PENDING_THRESHOLD_MS = 30_000;

/** Camel-case field names emitted by Prisma's `error.meta.target` array. */
const LOOP_ACTIVE_INDEX_TARGET_FIELDS = new Set([
  "artifactId",
  "command",
  "artifactVersion",
]);
/** Snake-case column names emitted by the pg driver-adapter. */
const LOOP_ACTIVE_INDEX_DB_FIELDS = new Set([
  "artifact_id",
  "command",
  "artifact_version",
]);
/**
 * Field sets for the blocked partial unique index
 * (`loops_blocked_artifact_command_key` on (artifact_id, command)
 * WHERE status = 'BLOCKED'). Mirrors the active-index sets above for the two
 * `error.meta` shapes Prisma emits.
 */
const LOOP_BLOCKED_INDEX_TARGET_FIELDS = new Set(["artifactId", "command"]);
const LOOP_BLOCKED_INDEX_DB_FIELDS = new Set(["artifact_id", "command"]);

const prismaErrorMetaSchema = z
  .object({
    target: z
      .union([z.string(), z.array(z.string())])
      .nullable()
      .optional(),
    driverAdapterError: z
      .object({
        cause: z
          .object({
            constraint: z
              .object({
                index: z.string().optional(),
                fields: z.array(z.string()).optional(),
              })
              .optional(),
          })
          .optional(),
      })
      .optional(),
  })
  .optional();

function fieldsMatch(values: string[], expected: Set<string>): boolean {
  return (
    values.length === expected.size && values.every((v) => expected.has(v))
  );
}

const VALID_HARNESS_VALUES = new Set<string>(Object.values(HarnessType));

/**
 * Coerce a DB string to a typed HarnessType, defaulting to HarnessType.Claude
 * for unknown or null values. This is the migration-window default: records
 * created before the harness column was added return the DB default "claude",
 * and any unrecognized future value falls back safely.
 */
function parseHarness(value: string | null | undefined): HarnessType {
  if (value != null && VALID_HARNESS_VALUES.has(value)) {
    return value as HarnessType;
  }
  return HarnessType.Claude;
}

/**
 * True iff the error is a P2002 raised by the loops active-index. Other unique
 * constraints (loop_events idempotency, etc.) return false and pass through
 * unchanged. Handles both shapes Prisma actually emits today:
 *   - `meta.target`: index name (string) or camelCase field array
 *   - `meta.driverAdapterError.cause.constraint.{index|fields}` (pg adapter)
 */
function isLoopActiveIndexViolation(error: unknown): boolean {
  if (getPrismaErrorCode(error) !== "P2002") {
    return false;
  }
  const parsed = prismaErrorMetaSchema.safeParse(
    Reflect.get(error as object, "meta")
  );
  if (!parsed.success || parsed.data == null) {
    return false;
  }
  const { target, driverAdapterError } = parsed.data;

  if (typeof target === "string") {
    return target === LOOP_ACTIVE_INDEX_NAME;
  }
  if (Array.isArray(target)) {
    return fieldsMatch(target, LOOP_ACTIVE_INDEX_TARGET_FIELDS);
  }

  const constraint = driverAdapterError?.cause?.constraint;
  if (constraint?.index === LOOP_ACTIVE_INDEX_NAME) {
    return true;
  }
  if (constraint?.fields) {
    return fieldsMatch(constraint.fields, LOOP_ACTIVE_INDEX_DB_FIELDS);
  }
  log.warn(
    "P2002 unique constraint error with unrecognized meta shape; treating as non-active-index violation",
    {
      code: "P2002",
      meta: {
        targetType: target == null ? "null/undefined" : typeof target,
        hasDriverAdapterError: driverAdapterError != null,
        hasConstraint: constraint != null,
        constraintKeys: constraint == null ? [] : Object.keys(constraint),
      },
    }
  );
  return false;
}

/**
 * True iff the error is a P2002 raised by the blocked partial unique index
 * (`loops_blocked_artifact_command_key`). Used by create() to resolve a
 * concurrent deferred-dispatch race idempotently rather than surfacing the
 * raw constraint error. Handles the same two `error.meta` shapes as
 * {@link isLoopActiveIndexViolation}.
 */
function isLoopBlockedIndexViolation(error: unknown): boolean {
  if (getPrismaErrorCode(error) !== "P2002") {
    return false;
  }
  const parsed = prismaErrorMetaSchema.safeParse(
    Reflect.get(error as object, "meta")
  );
  if (!parsed.success || parsed.data == null) {
    return false;
  }
  const { target, driverAdapterError } = parsed.data;

  if (typeof target === "string") {
    return target === LOOP_BLOCKED_INDEX_NAME;
  }
  if (Array.isArray(target)) {
    return fieldsMatch(target, LOOP_BLOCKED_INDEX_TARGET_FIELDS);
  }

  const constraint = driverAdapterError?.cause?.constraint;
  if (constraint?.index === LOOP_BLOCKED_INDEX_NAME) {
    return true;
  }
  if (constraint?.fields) {
    return fieldsMatch(constraint.fields, LOOP_BLOCKED_INDEX_DB_FIELDS);
  }
  return false;
}

/**
 * Mirrors the partial unique index scope: only non-Chat loops with a concrete
 * document/artifact participate in duplicate-active-loop prevention.
 */
function shouldEnforceActiveGate(
  command: LoopCommand | string | null,
  documentId: string | null | undefined
): boolean {
  return command !== LoopCommand.Chat && documentId != null;
}

/** Initial status for a freshly created loop. Manual loops run immediately;
 * autonomous loops with a non-terminal blocker are deferred as BLOCKED. */
function resolveInitialLoopStatus(
  isManual: boolean,
  isBlocked: boolean
): LoopStatus {
  if (isManual) {
    return LoopStatus.Running;
  }
  return isBlocked ? LoopStatus.Blocked : LoopStatus.Pending;
}

/** Record the blocking artifact ids on the loop's metadata for traceability,
 * preserving any caller-supplied metadata. */
function buildCreateMetadata(
  metadata: JsonObject | undefined,
  blockedBy: LoopBlocker[]
): JsonObject | undefined {
  if (blockedBy.length === 0) {
    return metadata ?? undefined;
  }
  return {
    ...(metadata ?? {}),
    blockedBy: blockedBy.map((blocker) => blocker.id),
  };
}

/**
 * Drop the dispatch-time `blockedBy` traceability key from loop metadata,
 * preserving every other key. A released loop carries no resolved blocker ids
 * forward through PENDING → CLAIMED → RUNNING → COMPLETED, so a later debugger
 * isn't misled by stale blocker references that cleared long ago.
 */
function stripBlockedByMetadata(metadata: unknown): JsonObject {
  if (
    metadata == null ||
    typeof metadata !== "object" ||
    Array.isArray(metadata)
  ) {
    return {};
  }
  const next: JsonObject = {};
  for (const [key, value] of Object.entries(metadata as JsonObject)) {
    if (key !== "blockedBy") {
      next[key] = value;
    }
  }
  return next;
}

/**
 * Atomically release a deferred loop (BLOCKED → PENDING) so the normal claim
 * path picks it up, clearing the now-resolved `blockedBy` metadata in the same
 * write. Returns false when the row was no longer BLOCKED. A P2002 means another
 * active loop already holds the artifact+command slot (the partial unique
 * index), so the loop stays BLOCKED for the next reconcile pass.
 */
async function releaseBlockedLoop(
  loopId: string,
  organizationId: string,
  metadata: unknown
): Promise<boolean> {
  try {
    const result = await withDb((db) =>
      db.loop.updateMany({
        where: { id: loopId, organizationId, status: LoopStatus.Blocked },
        data: {
          status: LoopStatus.Pending,
          metadata: stripBlockedByMetadata(metadata),
        },
      })
    );
    return result.count > 0;
  } catch (error) {
    if (getPrismaErrorCode(error) === "P2002") {
      log.warn(
        "[reconcile-blocked-loops] Release skipped; artifact slot already active",
        { loopId }
      );
      return false;
    }
    throw error;
  }
}

function throwLoopAlreadyActive(existing: {
  id: string;
  command: LoopCommand | string;
  status: LoopStatus | string;
}): never {
  throw new LoopAlreadyActiveError(
    existing.id,
    existing.command as LoopCommand,
    existing.status as LoopStatus
  );
}

async function enforceConcurrencyLimit(
  userId: string,
  organizationId: string
): Promise<void> {
  const maxConcurrentLoops = await fetchOrgLoopLimit(organizationId);
  const activeCount = await withDb((db) =>
    db.loop.count({
      where: {
        userId,
        organizationId,
        status: { in: ACTIVE_LOOP_STATUSES },
      },
    })
  );

  if (activeCount >= maxConcurrentLoops) {
    throw new ConcurrentLoopLimitError(activeCount, maxConcurrentLoops);
  }
}

async function createLoopWithActiveGate<
  T extends { id: string; status: string },
>(args: {
  command: LoopCommand | string;
  documentId: string | null | undefined;
  organizationId: string;
  excludeLoopId?: string;
  insert: () => Promise<T>;
}): Promise<T> {
  const enforce = shouldEnforceActiveGate(args.command, args.documentId);

  if (enforce && args.documentId != null) {
    const existingLoop = await loopsService.findOperationallyActiveLoop(
      args.documentId,
      args.command as LoopCommand,
      args.organizationId
    );
    if (existingLoop != null && existingLoop.id !== args.excludeLoopId) {
      throwLoopAlreadyActive(existingLoop);
    }
  }

  try {
    return await args.insert();
  } catch (error) {
    if (
      enforce &&
      args.documentId != null &&
      isLoopActiveIndexViolation(error)
    ) {
      const existingLoop = await findIndexBlockingLoop(
        args.documentId,
        args.command as LoopCommand,
        args.organizationId
      );
      if (existingLoop != null && existingLoop.id !== args.excludeLoopId) {
        throwLoopAlreadyActive(existingLoop);
      }
    }
    throw error;
  }
}

/**
 * Mirrors the partial unique index — any loop the DB would refuse a duplicate
 * of. Strictly broader than `findOperationallyActiveLoop` (no orphan exclusion)
 * so a P2002 catch can always describe the colliding row, even when it's in
 * one of the orphan-shaped subsets the operational predicate ignores.
 */
async function findIndexBlockingLoop(
  documentId: string,
  command: LoopCommand,
  organizationId: string
): Promise<Loop | null> {
  const loop = await withDb((db) =>
    db.loop.findFirst({
      where: {
        artifactId: documentId,
        command,
        organizationId,
        status: { in: ACTIVE_LOOP_STATUSES },
      },
      orderBy: { createdAt: "desc" },
    })
  );
  return loop ? toLoop(loop) : null;
}

/**
 * The single deferred (BLOCKED) loop for an artifact+command, if any. Backs both
 * the optimistic idempotency check in create() and the recovery path when the
 * blocked partial unique index rejects a concurrent duplicate insert with P2002.
 */
async function findExistingBlockedLoop(
  documentId: string,
  command: LoopCommand,
  organizationId: string
): Promise<{ id: string } | null> {
  return await withDb((db) =>
    db.loop.findFirst({
      where: {
        organizationId,
        artifactId: documentId,
        command,
        status: LoopStatus.Blocked,
      },
      select: { id: true },
    })
  );
}

/**
 * Validate a JSON value as a Loop["repo"] shape, returning null on mismatch.
 */
function parseRepo(value: unknown): Loop["repo"] {
  if (value == null) {
    return null;
  }
  if (
    typeof value === "object" &&
    value !== null &&
    "fullName" in value &&
    "branch" in value &&
    typeof (value as Record<string, unknown>).fullName === "string" &&
    typeof (value as Record<string, unknown>).branch === "string"
  ) {
    return value as Loop["repo"];
  }
  log.warn("Malformed loop.repo JSON, returning null", { value });
  return null;
}

const additionalReposColumnSchema = z.array(AdditionalRepoRefSchema);

/**
 * Validate a JSON value as a Loop["additionalRepos"] shape, returning null on
 * mismatch.
 */
function parseAdditionalRepos(value: unknown): Loop["additionalRepos"] {
  if (value == null) {
    return null;
  }

  const result = additionalReposColumnSchema.safeParse(value);
  if (result.success) {
    return result.data;
  }

  log.warn("Malformed loop.additionalRepos JSON, returning null", { value });
  return null;
}

// Source-loop precedence per *target* command — i.e. "if the user is about
// to launch <target> on <document>, which prior loops are likely to hold a
// useful peer set?". The first match with a non-empty `additionalRepos`
// wins; an empty match keeps walking. Targets not in this map have no
// inheritable defaults and the service returns an empty payload.
const INHERITED_REPOS_SOURCE_PRECEDENCE: Partial<
  Record<LoopCommand, readonly LoopCommand[]>
> = {
  // New PLAN from a PRD inherits from the PRD's GENERATE_PRD; regenerated
  // PLAN on a Plan doc inherits from prior PLAN runs on that Plan doc.
  // Both call sites benefit from the same chain — only the active tier
  // differs based on which document type the lookup runs against.
  [LoopCommand.Plan]: [LoopCommand.Plan, LoopCommand.GeneratePrd],
  // Regenerated PRD inherits from prior GENERATE_PRD runs on this PRD.
  [LoopCommand.GeneratePrd]: [LoopCommand.GeneratePrd],
  // PRD revision inherits the originating generation's peer set. The
  // runtime soft-inheritance in run-loop-helpers also handles this at
  // loop-creation time when the body omits `additionalRepos`; this entry
  // exists so any UI pre-fill points at the same source.
  [LoopCommand.RequestPrdChanges]: [LoopCommand.GeneratePrd],
  // EXECUTE inherits from the Plan's PLAN authoring, falling back to a
  // prior EXECUTE on the same plan if no PLAN is found.
  [LoopCommand.Execute]: [LoopCommand.Plan, LoopCommand.Execute],
};

// FAILED loops and active states (PENDING/CLAIMED/RUNNING) are never
// inherited from. CANCELLED/TIMED_OUT loops still committed a peer-set
// decision the user may want to reuse.
const INHERITANCE_FALLBACK_STATUSES = [
  LoopStatus.Cancelled,
  LoopStatus.TimedOut,
] as const;

const INHERITANCE_LOOP_SELECT = {
  id: true,
  command: true,
  additionalRepos: true,
} as const;

/**
 * Validate a JSON value as a Loop["error"] shape, returning null on mismatch.
 */
function parseError(value: unknown): Loop["error"] {
  if (value == null) {
    return null;
  }
  if (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    "message" in value &&
    typeof (value as Record<string, unknown>).code === "string" &&
    typeof (value as Record<string, unknown>).message === "string"
  ) {
    return value as Loop["error"];
  }
  log.warn("Malformed loop.error JSON, returning null", { value });
  return null;
}

/** Select clause for eager-loading compute target summary fields. */
const computeTargetSelect = {
  select: {
    id: true,
    machineName: true,
    isOnline: true,
  },
} as const;

/**
 * Transform a Prisma loop record to the API Loop type.
 * Handles Decimal → number conversion for estimatedCost and
 * runtime-validated JSON field parsing for repo, additionalRepos, and error.
 * contextRefs, metadata, and tokensByModel use structural casts
 * since they are always written by trusted backend code.
 *
 * tokenExpiresAt, lastRunnerHeartbeatAt, and runnerCapabilities are
 * explicitly omitted — they are runner-internal fields exposed only via
 * the admin-only GET /api/loops/:id/runtime endpoint (AC-005).
 * sessionArtifactId is likewise omitted: it is the internal Loop→SESSION
 * artifact linkage (FEA-1718), not part of the public Loop response contract.
 * All are destructured out so they never leak through the `...rest` spread.
 */
function toLoop(record: PrismaLoop): Loop {
  const {
    tokenExpiresAt: _tokenExpiresAt,
    lastRunnerHeartbeatAt: _lastRunnerHeartbeatAt,
    runnerCapabilities: _runnerCapabilities,
    sessionArtifactId: _sessionArtifactId,
    ...rest
  } = record;
  return {
    ...rest,
    harness: parseHarness(record.harness),
    documentId: record.artifactId,
    estimatedCost:
      record.estimatedCost == null ? null : Number(record.estimatedCost),
    repo: parseRepo(record.repo),
    additionalRepos: parseAdditionalRepos(record.additionalRepos),
    contextRefs: record.contextRefs as Loop["contextRefs"],
    error: parseError(record.error),
    metadata: (record.metadata ?? {}) as Loop["metadata"],
    uploadedArtifacts:
      (record.uploadedArtifacts as Loop["uploadedArtifacts"]) ?? null,
    tokensByModel: record.tokensByModel as Loop["tokensByModel"],
    documentVersion: record.artifactVersion ?? null,
  };
}

function hasUploadedRawPlanState(
  uploadedArtifacts: Loop["uploadedArtifacts"]
): boolean {
  return Boolean(extractUploadedPlanRaw(uploadedArtifacts));
}

function hasDesktopResumeMetadata(loop: Loop): boolean {
  return Boolean(
    loop.computeTargetId && loop.branchName?.trim() && loop.sessionId?.trim()
  );
}

/**
 * Transform a Prisma loop record (with included user and optional compute target)
 * to the API LoopWithUser type.
 */
function toLoopWithUser(
  record: PrismaLoop & {
    user: LoopWithUser["user"];
    computeTarget?: ComputeTargetSummary | null;
    tagLoops?: Array<{ tag: { id: string; name: string; color: string } }>;
  }
): LoopWithUser {
  return {
    ...toLoop(record),
    user: record.user,
    computeTarget: record.computeTarget ?? null,
    tags: mapTagRelations(record.tagLoops ?? []),
  };
}

function supportArtifactNameFromKey(key: string): string {
  return key.split("/").at(-1) ?? key;
}

async function resolveSupportArtifacts(
  loopId: string,
  organizationId: string
): Promise<LoopSupportArtifact[]> {
  const events = await withDb((db) =>
    db.loopEvent.findMany({
      where: {
        loopId,
        type: LoopEventType.SupportBundleUploaded,
      },
      orderBy: { createdAt: "desc" },
      take: 1,
    })
  );
  const event = events[0];
  if (!event) {
    return [];
  }

  const parsed = supportBundleEventDataSchema.safeParse(event.data);
  if (!parsed.success) {
    log.warn("[loops-service] Ignoring malformed support bundle event", {
      loopId,
      eventId: event.id,
    });
    return [];
  }

  const filesByKey = new Map(
    (parsed.data.files ?? []).map((file) => [file.key, file])
  );
  const artifacts: LoopSupportArtifact[] = [];
  for (const key of parsed.data.keys) {
    if (!validateKeyBelongsToLoop(key, organizationId, loopId)) {
      log.warn("[loops-service] Ignoring out-of-scope support artifact key", {
        loopId,
        key,
      });
      continue;
    }
    try {
      const file = filesByKey.get(key);
      artifacts.push({
        name: file?.name ?? supportArtifactNameFromKey(key),
        key,
        downloadUrl: await generateDownloadUrl(key),
        ...(file?.sizeBytes === undefined ? {} : { sizeBytes: file.sizeBytes }),
      });
    } catch (error) {
      log.warn("[loops-service] Failed to generate support artifact URL", {
        loopId,
        key,
        error,
      });
    }
  }
  return artifacts;
}

/**
 * Default maximum concurrent active (PENDING/CLAIMED/RUNNING) loops per user.
 * Prevents resource exhaustion via rapid loop creation.
 * Can be overridden per organization via Organization.settings.maxConcurrentLoops.
 */
export const DEFAULT_MAX_CONCURRENT_LOOPS = 10;

/**
 * Resolve the effective concurrent loop limit for an organization.
 * Reads Organization.settings.maxConcurrentLoops and validates it is a positive
 * integer. Falls back to DEFAULT_MAX_CONCURRENT_LOOPS for null, missing key,
 * non-integer, zero, or negative values.
 */
export function resolveOrgLoopLimit(rawSettings: unknown): number {
  if (rawSettings == null || typeof rawSettings !== "object") {
    return DEFAULT_MAX_CONCURRENT_LOOPS;
  }
  const val = (rawSettings as Record<string, unknown>).maxConcurrentLoops;
  if (Number.isInteger(val) && (val as number) > 0) {
    return val as number;
  }
  return DEFAULT_MAX_CONCURRENT_LOOPS;
}

/**
 * Zod schema for parsing the runnerCapabilities JSON column.
 * Unknown keys are stripped; missing boolean flags default to false.
 */
const runnerCapabilitiesSchema = z.object({
  loopRunnerRefreshSupported: z.boolean().optional(),
  loopRunnerHeartbeatSupported: z.boolean().optional(),
});

/**
 * Runtime validator for the Prisma `Loop.status` column.
 * The column is typed as `string` in Prisma but constrained to LoopStatus
 * values at the application layer. Parse instead of casting so a data-integrity
 * drift (e.g. an unknown status enum value) surfaces as a logged warning
 * rather than a silent type lie.
 */
const loopStatusSchema = z.enum(
  Object.values(LoopStatus) as [LoopStatus, ...LoopStatus[]]
);

/**
 * Transform a stored `loopEvent` DB row into the API {@link StoredLoopEvent}
 * shape returned by the read endpoints.
 *
 * IMPORTANT: `type` is set AFTER the `data` spread so a `type` field persisted
 * inside `e.data` cannot overwrite the canonical DB-stored event type. `id` and
 * `storedAt` (the DB `createdAt`) are server-authoritative and let the client
 * dedup and keyset-paginate events, independent of the producer-set `timestamp`.
 */
function toStoredLoopEvent(e: {
  id: string;
  type: string;
  data: unknown;
  createdAt: Date;
}): StoredLoopEvent {
  const data = (e.data as JsonObject) ?? {};
  return {
    ...data,
    type: e.type,
    timestamp: data.timestamp ?? e.createdAt.toISOString(),
    id: e.id,
    storedAt: e.createdAt.toISOString(),
  } as StoredLoopEvent;
}

/**
 * Loops service - handles database operations for loop management.
 * Loops represent AI execution sessions (plan, execute, chat, etc.).
 */
export const loopsService = {
  /**
   * Create a new Loop.
   * Enforces a per-user concurrency limit on active loops.
   */
  async create(
    organizationId: string,
    userId: string,
    input: CreateLoopRequest
  ): Promise<CreateLoopResponse> {
    await loopsService.reapStalePendingLoops(
      organizationId,
      input.documentId ?? null,
      input.command ?? null
    );

    await enforceConcurrencyLimit(userId, organizationId);

    if (input.additionalRepos) {
      await authorizeAdditionalRepos(input.additionalRepos, organizationId);
    }

    await assertReposInProjectPool({
      organizationId,
      documentId: input.documentId,
      primary: input.repo,
      additionalRepos: input.additionalRepos,
    });

    const isManual = input.command === LoopCommand.Manual;

    // Nested-loop prevention: reject manual loop creation when a platform-managed
    // loop is active for the same document + user.
    if (isManual && input.documentId) {
      const activeNonManual = await withDb((db) =>
        db.loop.count({
          where: {
            userId,
            organizationId,
            artifactId: input.documentId,
            status: { in: ACTIVE_LOOP_STATUSES },
            command: { not: LoopCommand.Manual },
          },
        })
      );
      if (activeNonManual > 0) {
        throw new NestedManualLoopError(input.documentId);
      }
    }

    // Dependency-aware dispatch gating: defer an autonomous loop whose linked
    // artifact still has a non-terminal blocker, surfacing it as BLOCKED until
    // reconciliation releases it. Manual loops are explicit user actions and
    // are never gated.
    const blockedBy =
      !isManual && input.documentId
        ? await findNonTerminalBlockers(organizationId, input.documentId)
        : [];
    const isBlocked = blockedBy.length > 0;

    if (isBlocked && input.documentId) {
      // Idempotency for deferred dispatch: the active-loop gate and its partial
      // unique index both ignore BLOCKED rows, so without this guard a repeated
      // trigger would create a second BLOCKED loop that reconciliation would
      // later release as a duplicate run. Fast-path: reuse the existing deferred
      // loop. Concurrent creators that both miss here are caught below by the
      // blocked partial unique index.
      const existingBlocked = await findExistingBlockedLoop(
        input.documentId,
        input.command,
        organizationId
      );
      if (existingBlocked) {
        log.info("Loop dispatch deferred; reusing existing blocked loop", {
          loopId: existingBlocked.id,
          organizationId,
          command: input.command,
        });
        return { loopId: existingBlocked.id, status: LoopStatus.Blocked };
      }
    }

    let loop: { id: string; status: string };
    try {
      loop = await createLoopWithActiveGate({
        command: input.command,
        documentId: input.documentId,
        organizationId,
        insert: () =>
          withDb((db) =>
            db.loop.create({
              data: {
                organizationId,
                userId,
                command: input.command,
                harness: input.harness ?? HarnessType.Claude,
                artifactId: input.documentId ?? null,
                parentLoopId: input.parentLoopId ?? null,
                computeTargetId: input.computeTargetId ?? null,
                prompt: input.prompt ?? null,
                repo: input.repo ?? undefined,
                additionalRepos: input.additionalRepos ?? undefined,
                contextRefs: input.contextRefs ?? undefined,
                artifactVersion: input.documentVersion ?? null,
                metadata: buildCreateMetadata(input.metadata, blockedBy),
                status: resolveInitialLoopStatus(isManual, isBlocked),
                startedAt: isManual ? new Date() : undefined,
              },
            })
          ),
      });
    } catch (error) {
      // TOCTOU recovery: two concurrent dispatches for the same blocked
      // artifact+command both passed the optimistic check above and both tried
      // to insert a BLOCKED row. The blocked partial unique index rejected the
      // loser with P2002 — resolve to the row that won the race instead of
      // surfacing a duplicate (which reconciliation would later double-run).
      if (isBlocked && input.documentId && isLoopBlockedIndexViolation(error)) {
        const existingBlocked = await findExistingBlockedLoop(
          input.documentId,
          input.command,
          organizationId
        );
        if (existingBlocked) {
          log.info("Loop dispatch deferred; reusing blocked loop after race", {
            loopId: existingBlocked.id,
            organizationId,
            command: input.command,
          });
          return { loopId: existingBlocked.id, status: LoopStatus.Blocked };
        }
      }
      throw error;
    }

    log.info("Loop created", {
      loopId: loop.id,
      organizationId,
      userId,
      command: input.command,
      blocked: isBlocked,
      blockedBy: blockedBy.map((blocker) => blocker.id),
    });

    return {
      loopId: loop.id,
      status: loop.status as LoopStatus,
    };
  },

  /**
   * Reconcile deferred (BLOCKED) loops: re-evaluate each loop's dependency
   * blockers and release any whose blockers have all reached a terminal status
   * back into the dispatch queue (BLOCKED → PENDING). Invoked by the loop
   * reconciliation cron so a blocked autonomous loop starts automatically once
   * its upstream FEAT/PLAN/issue resolves. Returns the number released.
   *
   * Bounded to RECONCILE_BLOCKED_LOOPS_BATCH per pass so a backlog cannot blow
   * the cron budget; the remainder is picked up on the next tick. Release does
   * not re-check the per-user concurrency cap — a deferred dispatch resumes work
   * that was already admitted at create() time.
   */
  async reconcileBlockedLoops(): Promise<number> {
    const blockedLoops = await withDb((db) =>
      db.loop.findMany({
        where: { status: LoopStatus.Blocked },
        select: {
          id: true,
          organizationId: true,
          artifactId: true,
          metadata: true,
        },
        orderBy: { createdAt: "asc" },
        take: RECONCILE_BLOCKED_LOOPS_BATCH,
      })
    );

    let releasedCount = 0;
    for (const loop of blockedLoops) {
      const blockers =
        loop.artifactId === null
          ? []
          : await findNonTerminalBlockers(loop.organizationId, loop.artifactId);
      if (blockers.length > 0) {
        continue;
      }
      if (
        await releaseBlockedLoop(loop.id, loop.organizationId, loop.metadata)
      ) {
        releasedCount++;
      }
    }

    if (releasedCount > 0) {
      log.info("[reconcile-blocked-loops] Released loops", {
        count: releasedCount,
      });
    }
    return releasedCount;
  },

  /**
   * Failsafe sweep for abandoned deferred (BLOCKED) loops. reconcileBlockedLoops
   * releases a loop once its blockers reach a terminal status, but a blocker
   * that is never resolved (e.g. a FEAT left open and never marked OBSOLETE)
   * would otherwise strand its loop in BLOCKED indefinitely. Force-cancels
   * BLOCKED loops older than STALE_BLOCKED_THRESHOLD_MS, mirroring the
   * PENDING/RUNNING staleness reapers in the timeout-loops cron. Returns the
   * number cancelled.
   *
   * Bounded to RECONCILE_BLOCKED_LOOPS_BATCH per pass. A BLOCKED loop never
   * started a container or minted runner tokens, so cancellation needs no ECS
   * stop or token cleanup — only a guarded CAS to CANCELLED plus a best-effort
   * audit event.
   */
  async reapStaleBlockedLoops(): Promise<number> {
    const now = new Date();
    const cutoff = new Date(now.getTime() - STALE_BLOCKED_THRESHOLD_MS);
    const staleLoops = await withDb((db) =>
      db.loop.findMany({
        where: { status: LoopStatus.Blocked, createdAt: { lt: cutoff } },
        select: { id: true, organizationId: true },
        orderBy: { createdAt: "asc" },
        take: RECONCILE_BLOCKED_LOOPS_BATCH,
      })
    );

    const staleDays = Math.floor(
      STALE_BLOCKED_THRESHOLD_MS / (24 * 60 * 60 * 1000)
    );
    const message = `Deferred loop cancelled after ${staleDays} days blocked (upstream blocker never resolved)`;

    let cancelledCount = 0;
    for (const loop of staleLoops) {
      const result = await withDb((db) =>
        db.loop.updateMany({
          where: {
            id: loop.id,
            organizationId: loop.organizationId,
            status: LoopStatus.Blocked,
          },
          data: {
            status: LoopStatus.Cancelled,
            completedAt: now,
            error: { code: "BLOCKED_TIMEOUT", message },
          },
        })
      );
      if (result.count === 0) {
        continue;
      }
      cancelledCount++;
      try {
        await loopsService.addEvent(loop.id, loop.organizationId, {
          type: LoopEventType.Cancelled,
          data: { reason: "blocked_timeout", message },
        });
      } catch (eventErr) {
        log.warn(
          "[reconcile-blocked-loops] Failed to record stale-cancel event",
          {
            loopId: loop.id,
            error:
              eventErr instanceof Error ? eventErr.message : String(eventErr),
          }
        );
      }
    }

    if (cancelledCount > 0) {
      log.info("[reconcile-blocked-loops] Cancelled stale blocked loops", {
        count: cancelledCount,
      });
    }
    return cancelledCount;
  },

  /**
   * Get a single Loop by ID (org-scoped).
   * Includes associated user info for detail views, with PR-enriched additionalRepos.
   */
  async findById(
    id: string,
    organizationId: string,
    options: FindLoopByIdOptions = {}
  ): Promise<LoopDetail | null> {
    const loop = await withDb((db) =>
      db.loop.findUnique({
        where: { id, organizationId },
        include: {
          user: basicUserSelect,
          computeTarget: computeTargetSelect,
          tagLoops: {
            include: {
              ...TAG_RELATION_INCLUDE,
            },
          },
        },
      })
    );

    if (!loop) {
      return null;
    }

    const result = toLoopWithUser(
      loop as PrismaLoop & {
        user: LoopWithUser["user"];
        computeTarget: ComputeTargetSummary | null;
        tagLoops: Array<{ tag: { id: string; name: string; color: string } }>;
      }
    );

    let branches: BranchInfo[] = [];
    let pullRequests: PullRequestInfo[] = [];
    if (
      result.documentId !== null &&
      (result.repo !== null ||
        (result.additionalRepos !== null && result.additionalRepos.length > 0))
    ) {
      branches = await documentPullRequestService.getDocumentBranches(
        result.documentId,
        result.organizationId
      );
      pullRequests = await documentPullRequestService.getDocumentPullRequests(
        result.documentId,
        result.organizationId
      );
    }
    const additionalRepos = _enrichAdditionalReposWithPr(
      result,
      pullRequests,
      branches
    );
    const primaryBranch = _findPrimaryRepoBranch(result, branches);
    const primaryPullRequest = _findPrimaryRepoPr(result, pullRequests);
    const supportArtifacts = options.includeSupportArtifacts
      ? await resolveSupportArtifacts(id, organizationId)
      : [];

    return {
      ...result,
      additionalRepos,
      primaryBranch,
      primaryPullRequest,
      supportArtifacts,
    };
  },

  async findManualLoopById(
    id: string,
    organizationId: string
  ): Promise<
    | { loop: LoopDetail; error?: undefined }
    | { loop?: undefined; error: "not_found" | "not_manual" }
  > {
    const loop = await this.findById(id, organizationId);
    if (!loop) {
      return { error: "not_found" };
    }
    if (loop.command !== LoopCommand.Manual) {
      return { error: "not_manual" };
    }
    return { loop };
  },

  /**
   * List Loops with filters (org-scoped).
   * Returns loops with associated user info for list views.
   */
  async findAll(
    organizationId: string,
    filters: LoopListFilters
  ): Promise<LoopWithUser[]> {
    const {
      status,
      command,
      documentId,
      projectId,
      userId,
      limit = 50,
      offset = 0,
    } = filters;

    const loops = await withDb((db) =>
      db.loop.findMany({
        where: {
          organizationId,
          ...(status ? { status } : {}),
          ...(command ? { command } : {}),
          ...(documentId ? { artifactId: documentId } : {}),
          ...(projectId ? { artifact: { projectId } } : {}),
          ...(userId ? { userId } : {}),
        },
        include: {
          user: basicUserSelect,
          computeTarget: computeTargetSelect,
          tagLoops: {
            include: {
              ...TAG_RELATION_INCLUDE,
            },
          },
        },
        orderBy: { createdAt: "desc" },
        take: limit,
        skip: offset,
      })
    );

    type LoopWithIncludes = PrismaLoop & {
      user: LoopWithUser["user"];
      computeTarget: ComputeTargetSummary | null;
      tagLoops: Array<{ tag: { id: string; name: string; color: string } }>;
    };

    return loops.map((l) => toLoopWithUser(l as LoopWithIncludes));
  },

  /**
   * Update Loop status with transition validation.
   * Enforces the state machine: PENDING → CLAIMED → RUNNING → terminal.
   */
  async updateStatus(
    id: string,
    organizationId: string,
    status: LoopStatus,
    data?: Partial<{
      containerId: string;
      startedAt: Date;
      completedAt: Date;
      tokensInput: number;
      tokensOutput: number;
      tokensByModel: TokensByModel;
      estimatedCost: number;
      error: { code: string; message: string } | null;
      s3StateKey: string;
      prUrl: string;
      prNumber: number;
      branchName: string;
      sessionId: string;
      metadata: JsonObject;
    }>
  ): Promise<Loop> {
    // Compute the set of valid source statuses for this target status
    const validFromStatuses = Object.entries(VALID_TRANSITIONS)
      .filter(([, allowed]) => allowed.has(status))
      .map(([from]) => from as LoopStatus);

    if (validFromStatuses.length === 0) {
      throw new Error(
        `No valid transition to ${status} exists in the state machine`
      );
    }

    // Build the update payload outside the lambda to keep it simple.
    // Only include fields that are explicitly provided (not undefined).
    const updateData: Record<string, unknown> = { status };
    if (data) {
      const optionalFields = [
        "containerId",
        "startedAt",
        "completedAt",
        "tokensInput",
        "tokensOutput",
        "tokensByModel",
        "estimatedCost",
        "error",
        "s3StateKey",
        "prUrl",
        "prNumber",
        "branchName",
        "sessionId",
        "metadata",
      ] as const;
      for (const field of optionalFields) {
        if (data[field] !== undefined) {
          updateData[field] = data[field];
        }
      }
    }

    // Safety net: auto-set completedAt when transitioning to a terminal state
    // if the caller didn't explicitly provide it.
    if (TERMINAL_STATUSES.has(status) && !updateData.completedAt) {
      updateData.completedAt = new Date();
    }

    // Atomic conditional update: only transitions from a valid source status.
    // This prevents TOCTOU races where two concurrent requests both pass
    // validation but one clobbers the other's status change.
    // For terminal transitions (COMPLETED, FAILED, CANCELLED, TIMED_OUT),
    // runner tokens are deleted and an audit event is inserted in the same
    // transaction so the cleanup is atomic with the status flip.
    const isTerminalCleanupStatus = TERMINAL_STATUSES.has(status);

    // Terminal transitions need CAS + runner-token cleanup + audit event in one
    // atomic block. Non-terminal transitions (PENDING->CLAIMED, CLAIMED->RUNNING)
    // do a single updateMany — already atomic at the SQL level — so they skip
    // the interactive transaction to avoid BEGIN/COMMIT overhead on the hot path.
    const result = isTerminalCleanupStatus
      ? await withDb.tx(async (db) => {
          const cas = await db.loop.updateMany({
            where: {
              id,
              organizationId,
              status: { in: validFromStatuses },
            },
            data: updateData,
          });

          if (cas.count > 0) {
            await clearLoopTokens(db, id, organizationId, status);
          }

          return cas;
        })
      : await withDb((db) =>
          db.loop.updateMany({
            where: {
              id,
              organizationId,
              status: { in: validFromStatuses },
            },
            data: updateData,
          })
        );

    if (result.count === 0) {
      // Either the loop doesn't exist, or it's in a status that doesn't
      // allow this transition (e.g., it was already cancelled/completed).
      const current = await withDb((db) =>
        db.loop.findUnique({
          where: { id, organizationId },
          select: { status: true },
        })
      );

      if (!current) {
        throw new Error(`Loop not found: ${id}`);
      }

      throw new InvalidStatusTransitionError(current.status, status);
    }

    log.info("Loop status updated", {
      loopId: id,
      to: status,
    });

    // If transitioning directly to a terminal state (e.g., from CLAIMED when
    // "started" event was lost), backfill startedAt so the record is consistent.
    if (TERMINAL_STATUSES.has(status) && !updateData.startedAt) {
      await withDb((db) =>
        db.loop.updateMany({
          where: { id, organizationId, startedAt: null },
          data: { startedAt: new Date() },
        })
      );
    }

    // Re-fetch the updated record to return the full Loop object
    const loop = await withDb((db) =>
      db.loop.findUnique({ where: { id, organizationId } })
    );

    if (!loop) {
      throw new Error(`Loop not found after update: ${id}`);
    }

    return toLoop(loop);
  },

  /**
   * Persist launch metadata (containerId, s3StateKey) without changing status.
   * Used when the runner races ahead of launchLoop — the loop is already RUNNING
   * but we still need to record which container is executing it.
   */
  async persistLaunchInfo(
    id: string,
    organizationId: string,
    data: { containerId: string; s3StateKey?: string }
  ): Promise<void> {
    await withDb((db) =>
      db.loop.updateMany({
        where: {
          id,
          organizationId,
          // Only update loops that are still in a pre-terminal state.
          // Prevents overwriting metadata on already-completed/cancelled loops
          // if the launch path is delayed.
          status: { in: ACTIVE_LOOP_STATUSES },
        },
        data: {
          containerId: data.containerId,
          s3StateKey: data.s3StateKey,
        },
      })
    );
  },

  /**
   * Cancel a running Loop.
   * Can cancel from PENDING, CLAIMED, or RUNNING states.
   * Uses atomic conditional update to prevent TOCTOU races.
   */
  async cancel(id: string, organizationId: string): Promise<Loop> {
    // Compute valid source statuses for CANCELLED transition
    const validFromStatuses = Object.entries(VALID_TRANSITIONS)
      .filter(([, allowed]) => allowed.has(LoopStatus.Cancelled))
      .map(([from]) => from as LoopStatus);

    // Atomic conditional update: only transitions from a valid source status.
    // Token cleanup and audit log run in the same transaction so cleanup is
    // atomic with the status flip.
    const result = await withDb.tx(async (db) => {
      const cas = await db.loop.updateMany({
        where: {
          id,
          organizationId,
          status: { in: validFromStatuses },
        },
        data: {
          status: LoopStatus.Cancelled,
          completedAt: new Date(),
        },
      });

      if (cas.count > 0) {
        await clearLoopTokens(db, id, organizationId, LoopStatus.Cancelled);
      }

      return cas;
    });

    if (result.count === 0) {
      const current = await withDb((db) =>
        db.loop.findUnique({
          where: { id, organizationId },
          select: { status: true },
        })
      );

      if (!current) {
        throw new Error(`Loop not found: ${id}`);
      }

      throw new InvalidStatusTransitionError(
        current.status,
        LoopStatus.Cancelled
      );
    }

    log.info("Loop cancelled", { loopId: id });

    // Re-fetch the updated record to return the full Loop object
    const loop = await withDb((db) =>
      db.loop.findUnique({ where: { id, organizationId } })
    );

    if (!loop) {
      throw new Error(`Loop not found after cancel: ${id}`);
    }

    return toLoop(loop);
  },

  /**
   * Validate that a parent loop exists and can be resumed.
   * Throws if parent is not found, not owned by user, or in non-resumable status.
   */
  async validateParentForResume(
    parentLoopId: string,
    organizationId: string,
    userId: string
  ): Promise<PrismaLoop> {
    const parent = await withDb((db) =>
      db.loop.findUnique({
        where: { id: parentLoopId, organizationId },
      })
    );

    if (!parent) {
      throw new Error(`Parent loop not found: ${parentLoopId}`);
    }

    if (parent.userId !== userId) {
      throw new Error("You can only resume your own loops");
    }

    const resumableStatuses = new Set<LoopStatus>([
      LoopStatus.Cancelled,
      LoopStatus.Completed,
      LoopStatus.Failed,
      LoopStatus.TimedOut,
    ]);
    if (!resumableStatuses.has(parent.status as LoopStatus)) {
      throw new Error(
        `Cannot resume loop in ${parent.status} status. Only CANCELLED, COMPLETED, FAILED, or TIMED_OUT loops can be resumed.`
      );
    }

    return parent;
  },

  /**
   * Reap stale index-blocking rows for a (artifactId, command) slice before
   * gate check. Bridges the gap between the broad index-blocking tier
   * (`ACTIVE_LOOP_STATUSES`) and the narrower operationally-active tier
   * (`findOperationallyActiveLoop`). Any row that holds the partial unique
   * index slot but is excluded from the operational tier is marked FAILED so
   * a new loop with the same (artifactId, command, artifactVersion) is not
   * permanently blocked by an orphaned dispatch.
   *
   * Reaped shapes (all require age ≥ STALE_PENDING_THRESHOLD_MS):
   * - PENDING with containerId=null (dispatch never acknowledged)
   * - CLAIMED with containerId=null (claim recorded but container never set)
   * - PENDING with containerId set (dispatch wrote container but row never
   *   transitioned to CLAIMED/RUNNING)
   */
  async reapStalePendingLoops(
    organizationId: string,
    artifactId: string | null,
    command: string | null
  ): Promise<void> {
    if (artifactId == null || command == null) {
      return;
    }

    const stalenessThreshold = new Date(
      Date.now() - STALE_PENDING_THRESHOLD_MS
    );

    // Find the IDs of stale loops before the transaction so we can perform
    // per-loop token cleanup and audit log inside the same atomic block.
    const staleLoops = await withDb((db) =>
      db.loop.findMany({
        where: {
          organizationId,
          artifactId,
          command: command as LoopCommand,
          createdAt: { lt: stalenessThreshold },
          OR: [
            { status: LoopStatus.Pending, containerId: null },
            { status: LoopStatus.Claimed, containerId: null },
            { status: LoopStatus.Pending, containerId: { not: null } },
          ],
        },
        select: { id: true },
      })
    );

    if (staleLoops.length === 0) {
      return;
    }

    const staleIds = staleLoops.map((l) => l.id);

    // One transaction per loop: each per-loop CAS + token cleanup + audit event
    // is independently atomic, so we keep each interactive tx bounded to 3 DB
    // calls. Wrapping all N loops in a single tx risked Prisma's default 5s
    // interactive-transaction timeout under burst conditions.
    let reapedCount = 0;
    for (const loopId of staleIds) {
      const transitioned = await withDb.tx(async (db) => {
        const cas = await db.loop.updateMany({
          where: {
            id: loopId,
            organizationId,
            artifactId,
            command: command as LoopCommand,
            createdAt: { lt: stalenessThreshold },
            OR: [
              { status: LoopStatus.Pending, containerId: null },
              { status: LoopStatus.Claimed, containerId: null },
              { status: LoopStatus.Pending, containerId: { not: null } },
            ],
          },
          data: {
            status: LoopStatus.Failed,
            completedAt: new Date(),
            error: {
              code: LoopErrorCode.StaleDispatch,
              message:
                "Loop dispatch was never acknowledged; marked failed after staleness threshold.",
            },
          },
        });

        if (cas.count === 1) {
          await clearLoopTokens(db, loopId, organizationId, LoopStatus.Failed);
          return 1;
        }
        return 0;
      });
      reapedCount += transitioned;
    }

    if (reapedCount > 0) {
      log.info("Reaped stale pending loops", {
        count: reapedCount,
        organizationId,
        artifactId,
        command,
      });
    }
  },

  /**
   * Create a resumed Loop from a parent.
   * The new loop inherits context from the parent but starts fresh.
   */
  async resume(
    parentLoopId: string,
    organizationId: string,
    userId: string,
    input: ResumeLoopRequest,
    computeTargetId?: string
  ): Promise<CreateLoopResponse> {
    const parent = await loopsService.validateParentForResume(
      parentLoopId,
      organizationId,
      userId
    );

    // Reap stale PENDING rows before gate check
    await loopsService.reapStalePendingLoops(
      organizationId,
      parent.artifactId,
      parent.command
    );

    await enforceConcurrencyLimit(userId, organizationId);

    const loop = await createLoopWithActiveGate({
      command: parent.command,
      documentId: parent.artifactId,
      organizationId,
      excludeLoopId: parent.id,
      insert: async () => {
        const parsedAdditionalRepos = parseAdditionalRepos(
          parent.additionalRepos
        );
        if (parent.additionalRepos != null && parsedAdditionalRepos === null) {
          throw new Error(
            `Loop ${parentLoopId} has malformed additionalRepos data and cannot be resumed. Operator action required.`
          );
        }

        if (parsedAdditionalRepos && parsedAdditionalRepos.length > 0) {
          await authorizeAdditionalRepos(parsedAdditionalRepos, organizationId);
        }

        // Do NOT copy parent.s3StateKey — the child loop gets its own key when
        // launched (via ECS claim or desktop persistence). Copying the parent's
        // key creates a window where the child reads/writes the parent's storage.
        return withDb((db) =>
          db.loop.create({
            data: {
              organizationId,
              userId,
              command: parent.command,
              artifactId: parent.artifactId,
              parentLoopId: parent.id,
              prompt: input.prompt ?? parent.prompt,
              repo: parent.repo ?? undefined,
              additionalRepos: parsedAdditionalRepos ?? undefined,
              contextRefs: parent.contextRefs ?? undefined,
              computeTargetId: computeTargetId ?? null,
              harness: parseHarness(parent.harness),
              status: LoopStatus.Pending,
            },
          })
        );
      },
    });

    log.info("Loop resumed", {
      loopId: loop.id,
      parentLoopId,
      organizationId,
      userId,
    });

    return {
      loopId: loop.id,
      status: loop.status as LoopStatus,
    };
  },

  /**
   * Record a Loop event.
   * Events are streamed from the container harness and stored for replay.
   *
   * @param runner - When present, sets eventSource to "runner" and builds a
   *   composite eventId from `${tokenJti}:${nonce}`. On P2002 a
   *   `ReplayDetectedError` is thrown so the route can return 409 before
   *   replayed runner events publish or apply downstream side effects.
   */
  async addEvent(
    loopId: string,
    organizationId: string,
    event: { type: string; data: Record<string, unknown> },
    runner?: { tokenJti: string; nonce: string }
  ): Promise<boolean> {
    const loop = await withDb((db) =>
      db.loop.findUnique({
        where: { id: loopId, organizationId },
        select: { status: true },
      })
    );

    if (!loop) {
      throw new Error(`Loop not found: ${loopId}`);
    }

    // Ignore non-terminal events after the loop is terminal.
    // Known TOCTOU gap: status could change to terminal between this check
    // and the insert below, allowing a late non-terminal event through.
    // Acceptable for V1 — the unique constraint prevents duplicates and the
    // frontend displays state from loop.status, not event order.
    if (shouldIgnoreEventForTerminalLoop(loop.status, event.type)) {
      return false;
    }

    const eventSource = runner ? "runner" : "system";
    let eventId: string;
    if (runner) {
      eventId = `${runner.tokenJti}:${runner.nonce}`;
    } else if (
      typeof event.data.eventId === "string" &&
      event.data.eventId.length > 0
    ) {
      eventId = event.data.eventId;
    } else {
      eventId = createHash("sha256")
        .update(JSON.stringify({ type: event.type, data: event.data }))
        .digest("hex");
    }

    try {
      await withDb((db) =>
        db.loopEvent.create({
          data: {
            loopId,
            type: event.type,
            data: event.data as JsonObject,
            eventSource,
            eventId,
            ...(runner?.tokenJti ? { runnerTokenJti: runner.tokenJti } : {}),
            ...(runner?.nonce ? { runnerNonce: runner.nonce } : {}),
          },
        })
      );
    } catch (error) {
      if (getPrismaErrorCode(error) === "P2002") {
        if (runner) {
          throw new ReplayDetectedError();
        }
        return false;
      }
      throw error;
    }
    return true;
  },

  /**
   * Get events for a Loop (org-scoped via loop lookup).
   */
  async getEvents(
    loopId: string,
    organizationId: string
  ): Promise<StoredLoopEvent[]> {
    // Verify loop belongs to org
    const loop = await withDb((db) =>
      db.loop.findUnique({
        where: { id: loopId, organizationId },
        select: { id: true },
      })
    );

    if (!loop) {
      throw new Error(`Loop not found: ${loopId}`);
    }

    const events = await withDb((db) =>
      db.loopEvent.findMany({
        where: { loopId },
        // Tiebreak same-`createdAt` rows by id so the ordering matches
        // `getEventsSince` and the newest row is an unambiguous keyset cursor.
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      })
    );

    return events.map(toStoredLoopEvent);
  },

  /**
   * Get events for a Loop strictly after a keyset cursor (org-scoped).
   *
   * Powers the active-loop poll (`use-loop-polling`): instead of re-fetching a
   * loop's full, ever-growing event history every few seconds, callers pass the
   * `storedAt`/`id` of the newest event they hold and receive only the delta.
   *
   * The cursor is the composite `(createdAt, id)` — `createdAt` alone is not
   * unique, so a same-millisecond cluster larger than `take` would stall a
   * `createdAt`-only cursor forever. Comparing the unique `(createdAt, id)`
   * tuple guarantees the cursor always advances and never re-returns a held
   * row, so the client can append the delta without deduping. `take` bounds the
   * batch — a large backlog drains over successive polls.
   *
   * The `createdAt` range is served by the `loop_events(loop_id, created_at)`
   * index; the `id` tiebreak only discriminates within one `createdAt` value.
   */
  async getEventsSince(
    loopId: string,
    organizationId: string,
    since: Date,
    sinceId: string,
    take: number
  ): Promise<StoredLoopEvent[]> {
    // Verify loop belongs to org
    const loop = await withDb((db) =>
      db.loop.findUnique({
        where: { id: loopId, organizationId },
        select: { id: true },
      })
    );

    if (!loop) {
      throw new Error(`Loop not found: ${loopId}`);
    }

    const events = await withDb((db) =>
      db.loopEvent.findMany({
        where: {
          loopId,
          OR: [
            { createdAt: { gt: since } },
            { createdAt: since, id: { gt: sinceId } },
          ],
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take,
      })
    );

    return events.map(toStoredLoopEvent);
  },

  /**
   * Get events for a Loop with pagination and filtering.
   * Returns paginated results with total count for audit log views.
   */
  async getEventsPaginated(
    loopId: string,
    organizationId: string,
    filters: LoopEventsFilters
  ): Promise<LoopEventsPaginatedResponse> {
    const { type, limit = 100, offset = 0, sort = "asc" } = filters;

    // Verify loop belongs to org
    const loop = await withDb((db) =>
      db.loop.findUnique({
        where: { id: loopId, organizationId },
        select: { id: true },
      })
    );

    if (!loop) {
      throw new Error(`Loop not found: ${loopId}`);
    }

    const where = {
      loopId,
      ...(type ? { type } : {}),
    };

    const [events, total] = await Promise.all([
      withDb((db) =>
        db.loopEvent.findMany({
          where,
          orderBy: { createdAt: sort },
          take: limit,
          skip: offset,
        })
      ),
      withDb((db) => db.loopEvent.count({ where })),
    ]);

    return { data: events.map(toStoredLoopEvent), total };
  },

  /**
   * Get usage summary with filters.
   * Aggregates token usage and cost across loops for reporting,
   * including a breakdown by command type.
   */
  async getUsageSummary(
    organizationId: string,
    filters: {
      startDate?: Date;
      endDate?: Date;
      userId?: string;
      command?: string;
    }
  ): Promise<LoopUsageSummary> {
    const { startDate, endDate, userId, command } = filters;

    const validCommands = new Set<string>(Object.values(LoopCommand));
    const validatedCommand =
      command && validCommands.has(command) ? command : undefined;

    const where = {
      organizationId,
      ...(userId ? { userId } : {}),
      ...(validatedCommand
        ? {
            command: validatedCommand as LoopCommand,
          }
        : {}),
      ...(startDate || endDate
        ? {
            createdAt: {
              ...(startDate ? { gte: startDate } : {}),
              ...(endDate ? { lte: endDate } : {}),
            },
          }
        : {}),
    };

    // Build parameterized WHERE predicates for the raw cache aggregation query.
    // Must match the same filter conditions as the Prisma `where` object above.
    const rawPredicates: Prisma.Sql[] = [
      Prisma.sql`organization_id = ${organizationId}::uuid`,
    ];
    if (userId) {
      rawPredicates.push(Prisma.sql`user_id = ${userId}::uuid`);
    }
    if (validatedCommand) {
      rawPredicates.push(
        Prisma.sql`command = ${validatedCommand}::"LoopCommand"`
      );
    }
    if (startDate) {
      rawPredicates.push(Prisma.sql`created_at >= ${startDate}`);
    }
    if (endDate) {
      rawPredicates.push(Prisma.sql`created_at <= ${endDate}`);
    }
    const whereClause = Prisma.join(rawPredicates, " AND ");

    type CacheAggRow = {
      total_cache_creation: bigint;
      total_cache_read: bigint;
    };

    const [aggregate, groupByCommand, groupByUser, cacheAgg] =
      await Promise.all([
        withDb((db) =>
          db.loop.aggregate({
            where,
            _count: true,
            _sum: {
              tokensInput: true,
              tokensOutput: true,
              estimatedCost: true,
            },
          })
        ),
        withDb((db) =>
          db.loop.groupBy({
            by: ["command"],
            where,
            _count: true,
            _sum: {
              tokensInput: true,
              tokensOutput: true,
              estimatedCost: true,
            },
          })
        ),
        withDb((db) =>
          db.loop.groupBy({
            by: ["userId"],
            where,
            _count: true,
            _sum: {
              tokensInput: true,
              tokensOutput: true,
              estimatedCost: true,
            },
          })
        ),
        withDb((db) =>
          db.$queryRaw<CacheAggRow[]>(Prisma.sql`
          SELECT
            COALESCE(SUM(
              CASE
                WHEN jsonb_typeof(tokens_by_model) = 'object' THEN (
                  SELECT COALESCE(SUM(
                    CASE
                      WHEN jsonb_typeof(entry.value -> 'cacheCreation') = 'number'
                        AND (entry.value ->> 'cacheCreation') ~ '^[0-9]+$'
                      THEN (entry.value ->> 'cacheCreation')::bigint
                      ELSE 0
                    END
                  ), 0)
                  FROM jsonb_each(tokens_by_model) AS entry(key, value)
                )
                ELSE 0
              END
            ), 0) AS total_cache_creation,
            COALESCE(SUM(
              CASE
                WHEN jsonb_typeof(tokens_by_model) = 'object' THEN (
                  SELECT COALESCE(SUM(
                    CASE
                      WHEN jsonb_typeof(entry.value -> 'cacheRead') = 'number'
                        AND (entry.value ->> 'cacheRead') ~ '^[0-9]+$'
                      THEN (entry.value ->> 'cacheRead')::bigint
                      ELSE 0
                    END
                  ), 0)
                  FROM jsonb_each(tokens_by_model) AS entry(key, value)
                )
                ELSE 0
              END
            ), 0) AS total_cache_read
          FROM loops
          WHERE ${whereClause}
        `)
        ),
      ]);

    const byCommand: LoopUsageByCommand[] = groupByCommand.map((g) => ({
      command: g.command as LoopCommand,
      loopCount: g._count,
      tokensInput: g._sum.tokensInput ?? 0,
      tokensOutput: g._sum.tokensOutput ?? 0,
      estimatedCost: Number(g._sum.estimatedCost ?? 0),
    }));

    // Resolve user details for the by-user breakdown
    const userIds = groupByUser.map((g) => g.userId);
    const users =
      userIds.length > 0
        ? await withDb((db) =>
            db.user.findMany({
              where: { id: { in: userIds } },
              ...basicUserSelect,
            })
          )
        : [];
    const userMap = new Map(users.map((u) => [u.id, u]));

    const byUser: LoopUsageByUser[] = groupByUser.map((g) => {
      const u = userMap.get(g.userId);
      return {
        userId: g.userId,
        userName: u
          ? [u.firstName, u.lastName].filter(Boolean).join(" ") || u.email
          : "Unknown",
        userEmail: u?.email ?? "",
        userAvatarUrl: u?.avatarUrl ?? null,
        loopCount: g._count,
        tokensInput: g._sum.tokensInput ?? 0,
        tokensOutput: g._sum.tokensOutput ?? 0,
        estimatedCost: Number(g._sum.estimatedCost ?? 0),
      };
    });

    return {
      totalLoops: aggregate._count,
      totalTokensInput: aggregate._sum.tokensInput ?? 0,
      totalTokensOutput: aggregate._sum.tokensOutput ?? 0,
      totalEstimatedCost: Number(aggregate._sum.estimatedCost ?? 0),
      totalCacheCreationTokens: Number(cacheAgg[0]?.total_cache_creation ?? 0),
      totalCacheReadTokens: Number(cacheAgg[0]?.total_cache_read ?? 0),
      byCommand,
      byUser,
    };
  },

  /**
   * Find the most recent successfully completed loop for a given artifact.
   * Used to chain PLAN → REQUEST_CHANGES → EXECUTE by linking child loops
   * to their parent's S3 state, session ID, and branch name.
   *
   * Only COMPLETED loops are eligible — FAILED and TIMED_OUT loops have
   * incomplete or missing state (no plan.json, no branch) and chaining
   * to them inherits broken context.
   */
  async findLatestCompletedForArtifact(
    documentId: string,
    organizationId: string
  ): Promise<Loop | null> {
    const loop = await withDb((db) =>
      db.loop.findFirst({
        where: {
          artifactId: documentId,
          organizationId,
          status: "COMPLETED",
        },
        orderBy: { createdAt: "desc" },
      })
    );

    if (!loop) {
      return null;
    }

    return toLoop(loop);
  },

  /**
   * Resolve the peer-repo set the UI should pre-fill when the user is about
   * to launch `targetCommand` against `documentId`.
   *
   * The precedence chain depends on the target command (see
   * `INHERITED_REPOS_SOURCE_PRECEDENCE`). For each source command in the
   * chain we look for the latest non-empty `additionalRepos` — preferring
   * COMPLETED, then falling back to CANCELLED/TIMED_OUT. FAILED loops and
   * active states (PENDING/CLAIMED/RUNNING) are never inherited from.
   * An empty `additionalRepos` on a candidate keeps the chain walking so a
   * recent empty loop does not shadow an earlier loop that has peers.
   *
   * Targets without an inheritance chain (e.g. CHAT, evaluators) return
   * `{ additionalRepos: [], source: null }` immediately.
   */
  findInheritedAdditionalRepos(
    documentId: string,
    organizationId: string,
    targetCommand: LoopCommand
  ): Promise<InheritedAdditionalRepos> {
    return withDb(async (db) => {
      const maybePrecedence = INHERITED_REPOS_SOURCE_PRECEDENCE[targetCommand];
      if (!maybePrecedence) {
        return { additionalRepos: [], source: null };
      }
      const precedence: readonly LoopCommand[] = maybePrecedence;
      const statusFilters: Prisma.EnumLoopStatusFilter[] = [
        { equals: LoopStatus.Completed },
        { in: [...INHERITANCE_FALLBACK_STATUSES] },
      ];

      /**
       * Walk the precedence chain for a given artifact.
       * Returns the first match with a non-empty additionalRepos, or null.
       */
      async function walkPrecedence(
        artifactId: string
      ): Promise<InheritedAdditionalRepos | null> {
        for (const command of precedence) {
          for (const statusFilter of statusFilters) {
            const candidate = await db.loop.findFirst({
              where: {
                artifactId,
                organizationId,
                command,
                status: statusFilter,
              },
              orderBy: { createdAt: "desc" },
              select: INHERITANCE_LOOP_SELECT,
            });
            if (!candidate) {
              continue;
            }
            const peers = parseAdditionalRepos(candidate.additionalRepos);
            if (peers && peers.length > 0) {
              return {
                additionalRepos: peers,
                source: {
                  loopId: candidate.id,
                  command: candidate.command,
                  artifactId,
                },
              };
            }
            // Candidate exists but has no usable peers — keep walking the
            // precedence chain so a recent empty PLAN doesn't shadow a
            // GENERATE_PRD that does have peers.
          }
        }
        return null;
      }

      /**
       * Recursively walk up PRODUCES artifact-link ancestors looking for
       * a non-empty additionalRepos. Maintains a visited set for cycle
       * protection and respects INHERITANCE_ANCESTOR_MAX_DEPTH.
       */
      async function walkAncestors(
        currentId: string,
        depth: number,
        visited: Set<string>
      ): Promise<InheritedAdditionalRepos | null> {
        if (depth > INHERITANCE_ANCESTOR_MAX_DEPTH) {
          return null;
        }
        if (visited.has(currentId)) {
          return null;
        }
        visited.add(currentId);

        const parentLink = await db.artifactLink.findFirst({
          where: {
            organizationId,
            targetId: currentId,
            linkType: LinkType.Produces,
          },
          orderBy: { createdAt: "desc" },
          select: { sourceId: true },
        });

        if (!parentLink) {
          return null;
        }

        const parentId = parentLink.sourceId;
        // Cycle guard: bail before the precedence walk if parentId is already
        // in visited. Without this short-circuit, a PRODUCES cycle A->B->A
        // re-issues every walkPrecedence query for A on the second hop.
        if (visited.has(parentId)) {
          return null;
        }
        const ancestorResult = await walkPrecedence(parentId);
        if (ancestorResult) {
          return ancestorResult;
        }

        return walkAncestors(parentId, depth + 1, visited);
      }

      // Self-lookup: check the current document first.
      const selfResult = await walkPrecedence(documentId);
      if (selfResult) {
        return selfResult;
      }

      // Ancestor walk: traverse up PRODUCES links if self-lookup yields nothing.
      // The visited set starts empty — walkAncestors adds documentId on first
      // entry, which prevents cycles that lead back to the original document.
      const ancestorResult = await walkAncestors(
        documentId,
        1,
        new Set<string>()
      );
      return ancestorResult ?? { additionalRepos: [], source: null };
    });
  },

  /**
   * Find the most recent desktop loop whose uploaded plan artifacts include a
   * reusable raw plan snapshot and whose persisted metadata is sufficient to
   * resume on desktop.
   */
  async findLatestStateBearingDesktopForArtifact(
    documentId: string,
    organizationId: string
  ): Promise<Loop | null> {
    const loops = await withDb((db) =>
      db.loop.findMany({
        where: {
          artifactId: documentId,
          organizationId,
          status: "COMPLETED",
          computeTargetId: { not: null },
          branchName: { not: null },
          sessionId: { not: null },
        },
        orderBy: { createdAt: "desc" },
        take: 50,
      })
    );

    for (const record of loops) {
      const loop = toLoop(record);
      if (
        hasDesktopResumeMetadata(loop) &&
        hasUploadedRawPlanState(loop.uploadedArtifacts)
      ) {
        return loop;
      }
    }

    return null;
  },

  /**
   * Store uploaded artifacts from desktop harness on the loop record.
   * Used by the upload-artifacts endpoint as an alternative to S3.
   */
  async updateUploadedArtifacts(
    id: string,
    organizationId: string,
    uploadedArtifacts: JsonObject
  ): Promise<number> {
    // No status filter — the runner produced artifacts and the server should
    // accept them regardless of the loop's current lifecycle state. A cron
    // timeout or other status change should not block artifact storage.
    const result = await withDb((db) =>
      db.loop.updateMany({
        where: { id, organizationId },
        data: { uploadedArtifacts },
      })
    );
    return result.count;
  },

  /**
   * **Operationally-active tier** (per S1).
   *
   * Find a loop that, from the user's perspective, is currently doing work on
   * `(documentId, command)`. Used for the pre-insert gate and any UX-facing
   * "is a loop running?" question. Orphan-shaped rows are excluded so a
   * silently-failed dispatch does not permanently block retries.
   *
   * Staleness rules:
   * - RUNNING always blocks
   * - CLAIMED with containerId always blocks
   * - CLAIMED without containerId never blocks (regardless of age)
   * - PENDING with containerId never blocks (the dispatch wrote one but the
   *   row hasn't transitioned yet — treated as transient)
   * - PENDING without containerId, younger than STALE_PENDING_THRESHOLD_MS
   *   blocks; older rows are reaped by `reapStalePendingLoops`.
   */
  async findOperationallyActiveLoop(
    documentId: string,
    command: LoopCommand,
    organizationId: string
  ): Promise<Loop | null> {
    const stalenessThreshold = new Date(
      Date.now() - STALE_PENDING_THRESHOLD_MS
    );
    const loop = await withDb((db) =>
      db.loop.findFirst({
        where: {
          artifactId: documentId,
          command,
          organizationId,
          OR: [
            { status: LoopStatus.Running },
            { status: LoopStatus.Claimed, containerId: { not: null } },
            {
              status: LoopStatus.Pending,
              containerId: null,
              createdAt: { gte: stalenessThreshold },
            },
          ],
        },
        orderBy: { createdAt: "desc" },
      })
    );

    if (!loop) {
      return null;
    }

    return toLoop(loop);
  },

  /**
   * Monotonically update token counts on a loop row while it is still active.
   * Uses GREATEST so stale or out-of-order output events cannot overwrite a
   * higher value already written by a later event.
   * Restricted to PENDING/CLAIMED/RUNNING to prevent late-arriving output
   * events from mutating terminal rows after the final completed event.
   */
  async updateTokens(
    id: string,
    organizationId: string,
    tokensInput: number,
    tokensOutput: number,
    cacheCreation = 0,
    cacheRead = 0
  ): Promise<void> {
    const tokensByModel = JSON.stringify({
      default: {
        input: tokensInput,
        output: tokensOutput,
        cacheCreation,
        cacheRead,
      },
    });
    await withDb((db) =>
      db.$executeRaw(Prisma.sql`
        UPDATE loops
        SET tokens_input = GREATEST(tokens_input, ${tokensInput}),
            tokens_output = GREATEST(tokens_output, ${tokensOutput}),
            tokens_by_model = ${tokensByModel}::jsonb
        WHERE id = ${id}::uuid
          AND organization_id = ${organizationId}::uuid
          AND status IN ('PENDING', 'CLAIMED', 'RUNNING')
          AND (tokens_input < ${tokensInput} OR tokens_output < ${tokensOutput})
      `)
    );
  },

  /**
   * Update loop fields from a manual-loop PATCH request.
   * Updates prUrl, branchName on the loop row and stores summary in metadata JSON.
   * Only updates loops owned by the requesting user's org.
   */
  async updateManualLoopFields(
    id: string,
    organizationId: string,
    fields: { prUrl?: string; branchName?: string; summary?: string }
  ): Promise<Loop | null> {
    const current = await withDb((db) =>
      db.loop.findUnique({
        where: { id, organizationId },
      })
    );

    if (!current) {
      return null;
    }

    const updateData: Record<string, unknown> = {};
    if (fields.prUrl !== undefined) {
      updateData.prUrl = fields.prUrl;
    }
    if (fields.branchName !== undefined) {
      updateData.branchName = fields.branchName;
    }
    if (fields.summary !== undefined) {
      const existingMetadata =
        (current.metadata as Record<string, unknown>) ?? {};
      updateData.metadata = { ...existingMetadata, summary: fields.summary };
    }

    if (Object.keys(updateData).length === 0) {
      return toLoop(current);
    }

    // updateMany enforces org scoping — id alone is the primary key.
    const result = await withDb((db) =>
      db.loop.updateMany({
        where: { id, organizationId },
        data: updateData,
      })
    );

    if (result.count === 0) {
      return null;
    }

    const updated = await withDb((db) =>
      db.loop.findUnique({ where: { id, organizationId } })
    );

    return updated ? toLoop(updated) : null;
  },

  /**
   * Replace loop metadata. Caller is responsible for merging with existing values.
   * Returns the number of rows updated (0 if loop is already terminal).
   */
  async updateMetadata(
    id: string,
    organizationId: string,
    metadata: JsonObject
  ): Promise<number> {
    const result = await withDb((db) =>
      db.loop.updateMany({
        where: {
          id,
          organizationId,
          status: { in: ACTIVE_LOOP_STATUSES },
        },
        data: { metadata },
      })
    );
    return result.count;
  },

  /**
   * Fetch the minimal auth data needed to verify a runner JWT.
   * Intentionally NOT org-scoped — the caller has not yet proven org membership;
   * org correctness is enforced downstream in `authenticateLoopRunnerRequest`,
   * which compares the JWT's `organizationId` claim to the value returned here
   * after JWT verification succeeds.
   */
  findRunnerAuthData(
    loopId: string
  ): Promise<{ organizationId: string; activeTokenJti: string | null } | null> {
    return withDb((db) =>
      db.loop.findUnique({
        where: { id: loopId },
        select: { organizationId: true, activeTokenJti: true },
      })
    );
  },

  /**
   * Runner event ingestion: existence check, terminal-loop guard, and
   * explicit replay detection. JTI enforcement is performed earlier by
   * `authenticateLoopRunnerRequest` in the route layer, so this method does
   * not re-verify the token.
   *
   * Does NOT persist the event itself. The route forwards the canonical
   * event to `handleLoopEvent` after a successful `inserted` outcome; the
   * orchestrator becomes the single writer so that canonicalized shapes
   * (e.g. error+CANCELLED → "cancelled", `logTail` truncation) reach the DB
   * unmolested by a raw pre-insert.
   *
   * Replay detection uses an indexed `findUnique` on `LoopEvent` keyed by
   * `(loopId, eventSource, eventId)`, avoiding the previous design's
   * `create → P2002 → catch` flow that used exceptions as control flow.
   *
   * Returns a discriminated `IngestRunnerEventResult` (ok-style; see
   * `loop-ingest-types.ts` for the HTTP mapping).
   */
  async ingestRunnerEvent(args: {
    loopId: string;
    tokenJti: string;
    nonce: string;
    event: { type: string; data: Record<string, unknown> };
    organizationId: string;
  }): Promise<IngestRunnerEventResult> {
    const { loopId, tokenJti, nonce, event, organizationId } = args;

    const loop = await withDb((db) =>
      db.loop.findUnique({
        where: { id: loopId, organizationId },
        select: { status: true },
      })
    );

    if (!loop) {
      return { ok: false, code: IngestRunnerEventErrorCode.LoopNotFound };
    }

    const loopStatus = loop.status as LoopStatus;

    // Terminal status check: ignore non-terminal events for finished loops.
    // `shouldIgnoreEventForTerminalLoop` exempts SupportBundleUploaded on
    // FAILED/TIMED_OUT so Desktop crash recovery can still publish links.
    if (shouldIgnoreEventForTerminalLoop(loopStatus, event.type)) {
      return { ok: true, outcome: "ignored" };
    }

    // Explicit replay pre-check via the unique index on
    // (loopId, eventSource, eventId). This is only a fast path: a concurrent
    // request for the same composite key can still pass this read, so
    // `addEvent` is the authoritative atomic duplicate gate via P2002.
    const compositeEventId = `${tokenJti}:${nonce}`;
    const existing = await withDb((db) =>
      db.loopEvent.findUnique({
        where: {
          loopId_eventSource_eventId: {
            loopId,
            eventSource: "runner",
            eventId: compositeEventId,
          },
        },
        select: { id: true },
      })
    );

    if (existing) {
      return { ok: false, code: IngestRunnerEventErrorCode.Replay };
    }

    return { ok: true, outcome: "inserted" };
  },

  /**
   * Fetch runtime observability state for a loop (admin-only).
   * Returns auth lifecycle fields and parsed runner capability flags.
   * Returns null when the loop does not exist for the given org (covers
   * cross-org access: the query is org-scoped so a different org's loop
   * is indistinguishable from a non-existent loop).
   */
  async getLoopRuntime(
    id: string,
    organizationId: string
  ): Promise<LoopRuntimeState | null> {
    const record = await withDb((db) =>
      db.loop.findUnique({
        where: { id, organizationId },
        select: {
          id: true,
          status: true,
          tokenExpiresAt: true,
          lastRunnerHeartbeatAt: true,
          activeTokenJti: true,
          runnerCapabilities: true,
        },
      })
    );

    if (!record) {
      return null;
    }

    const statusParsed = loopStatusSchema.safeParse(record.status);
    if (!statusParsed.success) {
      log.warn("Loop has unrecognized status value; treating as not found", {
        loopId: record.id,
        status: record.status,
      });
      return null;
    }

    const parsed = runnerCapabilitiesSchema.safeParse(
      record.runnerCapabilities
    );
    const caps = parsed.success ? parsed.data : {};

    return {
      id: record.id,
      status: statusParsed.data,
      tokenExpiresAt: record.tokenExpiresAt,
      lastRunnerHeartbeatAt: record.lastRunnerHeartbeatAt,
      activeTokenJti: record.activeTokenJti,
      runnerCapabilities: {
        loopRunnerRefreshSupported: caps.loopRunnerRefreshSupported ?? false,
        loopRunnerHeartbeatSupported:
          caps.loopRunnerHeartbeatSupported ?? false,
      },
    };
  },
};

/**
 * Enrich each AdditionalRepoRef with its corresponding pull request (if any).
 * Returns the original array unchanged when no enrichment is needed (null array,
 * empty array, or no documentId to look up PRs against).
 */
function _enrichAdditionalReposWithPr(
  loop: LoopWithUser,
  prs: PullRequestInfo[],
  branches: BranchInfo[] = []
): AdditionalRepoRefWithPr[] | null {
  if (
    loop.additionalRepos === null ||
    loop.additionalRepos.length === 0 ||
    loop.documentId === null
  ) {
    return loop.additionalRepos as AdditionalRepoRefWithPr[];
  }

  return loop.additionalRepos.map((repo) => ({
    ...repo,
    branchArtifact:
      branches.find((branch) => branch.repoFullName === repo.fullName) ?? null,
    pullRequest: prs.find((pr) => pr.repoFullName === repo.fullName) ?? null,
  }));
}

/**
 * Find the branch artifact for the primary repo of a loop (if any).
 * Returns null when the loop has no documentId, no primary repo, or no matching branch.
 */
function _findPrimaryRepoBranch(
  loop: LoopWithUser,
  branches: BranchInfo[]
): BranchInfo | null {
  if (loop.documentId === null || loop.repo === null) {
    return null;
  }

  return (
    branches.find((branch) => branch.repoFullName === loop.repo?.fullName) ??
    null
  );
}

/**
 * Find the pull request for the primary repo of a loop (if any).
 * Returns null when the loop has no documentId, no primary repo, or no matching PR.
 */
function _findPrimaryRepoPr(
  loop: LoopWithUser,
  prs: PullRequestInfo[]
): PullRequestInfo | null {
  if (loop.documentId === null || loop.repo === null) {
    return null;
  }

  return prs.find((pr) => pr.repoFullName === loop.repo?.fullName) ?? null;
}

/**
 * Verify the GitHub App installation has access to every repo in `additionalRepos`.
 * Performs a single batch query against GitHubInstallationRepository scoped to
 * the org's ACTIVE installation. Throws UnauthorizedRepoError if any repos are
 * not accessible. Returns the verified repository records on success.
 *
 * @param additionalRepos - List of repos to check (each with a fullName field)
 * @param organizationId - Organization ID used to scope the installation lookup
 */
export async function authorizeAdditionalRepos(
  additionalRepos: Array<{ fullName: string; branch: string }>,
  organizationId: string
): Promise<GitHubInstallationRepository[]> {
  if (additionalRepos.length === 0) {
    return [];
  }

  const fullNames = additionalRepos.map((r) => r.fullName);

  log.info("authorizeAdditionalRepos: checking repos", {
    count: additionalRepos.length,
    repos: fullNames,
    organizationId,
  });

  // Filter tombstoned rows (PLN-634) so dispatch never targets a repo that
  // disappeared from the installation during a disconnect/reinstall window.
  const authorizedRepos = await withDb((db) =>
    db.gitHubInstallationRepository.findMany({
      where: {
        fullName: { in: fullNames },
        removedAt: null,
        installation: {
          organizationId,
          status: GitHubInstallationStatus.ACTIVE,
        },
      },
      select: {
        id: true,
        fullName: true,
        name: true,
        owner: true,
        private: true,
        githubRepoId: true,
        installationId: true,
        lastPushedAt: true,
        removedAt: true,
        createdAt: true,
        updatedAt: true,
        installation: {
          select: {
            installationId: true,
          },
        },
      },
    })
  );

  const authorizedNames = new Set(authorizedRepos.map((r) => r.fullName));
  const unauthorizedRepos = fullNames.filter((n) => !authorizedNames.has(n));

  if (unauthorizedRepos.length > 0) {
    log.warn("authorizeAdditionalRepos: unauthorized repos detected", {
      unauthorizedRepos,
      organizationId,
    });
    throw new UnauthorizedRepoError(unauthorizedRepos);
  }

  // Build a lookup map so we can find the branch for each authorized repo
  const branchByFullName = new Map(
    additionalRepos.map((r) => [r.fullName, r.branch])
  );

  await Promise.all(
    authorizedRepos.map(async (repo) => {
      const branch = branchByFullName.get(repo.fullName);
      if (!branch) {
        return;
      }
      const exists = await verifyInstallationBranchExists(
        repo.installation.installationId,
        repo.owner,
        repo.name,
        branch
      );
      if (!exists) {
        log.warn("authorizeAdditionalRepos: branch not found", {
          repo: repo.fullName,
          branch,
          organizationId,
        });
        throw new BranchNotFoundError(repo.fullName, branch);
      }
    })
  );

  log.info("authorizeAdditionalRepos: authorization succeeded", {
    count: authorizedRepos.length,
    repos: authorizedRepos.map((r) => r.fullName),
    organizationId,
  });

  return authorizedRepos;
}

/**
 * Per-loop refresh rate limit: at most `REFRESH_RATE_LIMIT_MAX_IN_WINDOW`
 * successful rotations per `REFRESH_RATE_LIMIT_WINDOW_MS` window. Counted
 * against the `loop_token_refresh` audit table.
 */
const REFRESH_RATE_LIMIT_WINDOW_MS = 60_000;
const REFRESH_RATE_LIMIT_MAX_IN_WINDOW = 6;
const REFRESH_AUDIT_RETENTION_PER_LOOP = 50;

export type RefreshRunnerTokenOptions = {
  idempotencyKey?: string;
  requesterIp?: string;
  requesterUa?: string;
};

/**
 * Emit a refresh failure metric and build the corresponding RefreshError.
 * Centralises the repeated emit-then-return pattern in refreshRunnerToken.
 */
function refreshError(
  orgId: string,
  code: RefreshTokenErrorCode,
  message: string
): RefreshError {
  emitRefreshFailure(orgId, mapRefreshErrorCodeToReason(code));
  return { ok: false, code, message };
}

/**
 * Rotate the runner JWT for an active loop.
 *
 * Guards: loop must exist, be RUNNING, have a non-expired token, present the
 * current JTI, and not have already used that JTI for a prior refresh. Throttled
 * per-loop via a trailing-window count over the audit table. The atomic CAS
 * predicate enforces both the current JTI and `status: RUNNING`, so a loop that
 * transitions to a terminal status between the pre-read and the CAS cannot
 * have its token rotated; the count===0 branch re-reads to disambiguate
 * `RaceLost` (concurrent rotation) from `NotRunning` (terminal transition).
 *
 * On a successful rotation, emits a single durable `token_refreshed` loop
 * event with the prev/new JTIs, new expiry, and requester metadata. Bounded
 * cleanup of the audit table runs best-effort after commit and never blocks
 * the rotation.
 */
export async function refreshRunnerToken(
  loopId: string,
  currentJti: string,
  options: RefreshRunnerTokenOptions = {}
): Promise<RefreshResult> {
  const { idempotencyKey, requesterIp, requesterUa } = options;

  const loop = await withDb((db) =>
    db.loop.findUnique({
      where: { id: loopId },
      select: {
        organizationId: true,
        status: true,
        activeTokenJti: true,
        tokenExpiresAt: true,
      },
    })
  );

  if (!loop) {
    // Skip org-scoped metrics for non-existent loops: tagging telemetry
    // with an empty orgId would create a synthetic empty-org bucket in
    // Datadog dashboards. The Result return path is still observable via
    // the route's log line.
    return {
      ok: false,
      code: RefreshTokenErrorCode.LoopNotFound,
      message: `Loop not found: ${loopId}`,
    };
  }

  const orgId = loop.organizationId;
  emitRefreshAttempt(orgId);

  if (loop.status !== LoopStatus.Running) {
    return refreshError(
      orgId,
      RefreshTokenErrorCode.NotRunning,
      `Loop ${loopId} is not RUNNING (current status: ${loop.status})`
    );
  }

  if (!loop.tokenExpiresAt || loop.tokenExpiresAt <= new Date()) {
    return refreshError(
      orgId,
      RefreshTokenErrorCode.TokenExpired,
      `Runner token for loop ${loopId} has expired`
    );
  }

  if (loop.activeTokenJti !== currentJti) {
    return refreshError(
      orgId,
      RefreshTokenErrorCode.JtiMismatch,
      `Token JTI mismatch for loop ${loopId}`
    );
  }

  const priorUse = await withDb((db) =>
    db.loopTokenRefresh.findUnique({
      where: { jti: currentJti },
    })
  );

  if (priorUse) {
    return refreshError(
      orgId,
      RefreshTokenErrorCode.JtiAlreadyUsed,
      `Token JTI ${currentJti} has already been used for a refresh`
    );
  }

  const windowStart = new Date(Date.now() - REFRESH_RATE_LIMIT_WINDOW_MS);
  const recentRefreshCount = await withDb((db) =>
    db.loopTokenRefresh.count({
      where: { loopId, refreshedAt: { gte: windowStart } },
    })
  );

  if (recentRefreshCount >= REFRESH_RATE_LIMIT_MAX_IN_WINDOW) {
    return refreshError(
      orgId,
      RefreshTokenErrorCode.RateLimited,
      `Refresh rate limit exceeded for loop ${loopId} (max ${REFRESH_RATE_LIMIT_MAX_IN_WINDOW} per ${REFRESH_RATE_LIMIT_WINDOW_MS}ms)`
    );
  }

  // Issue a new JWT — try/catch is warranted because issueLoopRunnerToken
  // performs cryptographic signing that can throw on misconfigured secrets.
  let issued: LoopRunnerTokenIssueResult;
  try {
    issued = await issueLoopRunnerToken({
      loopId,
      organizationId: loop.organizationId,
    });
  } catch (error) {
    log.error("refreshRunnerToken: failed to issue new token", {
      loopId,
      error,
    });
    return refreshError(
      orgId,
      RefreshTokenErrorCode.GenerationFailed,
      "Failed to generate new runner token"
    );
  }

  // CAS update + audit row + token_refreshed event written atomically: if any
  // write fails the loop's activeTokenJti stays on currentJti and the runner
  // can safely retry with its old token. The `status: Running` predicate
  // prevents rotating a loop that transitioned to a terminal status between
  // the pre-read and this write.
  const raced = await withDb.tx(async (db) => {
    const cas = await db.loop.updateMany({
      where: {
        id: loopId,
        activeTokenJti: currentJti,
        status: LoopStatus.Running,
      },
      data: {
        activeTokenJti: issued.tokenId,
        tokenExpiresAt: issued.expiresAt,
        lastRunnerHeartbeatAt: new Date(),
      },
    });

    if (cas.count === 0) {
      return true;
    }

    await db.loopTokenRefresh.create({
      data: {
        loopId,
        jti: currentJti,
        refreshedAt: new Date(),
      },
    });

    const eventData: JsonObject = {
      prevJti: currentJti,
      newJti: issued.tokenId,
      exp: issued.expiresAt.toISOString(),
    };
    if (requesterIp !== undefined) {
      eventData.requesterIp = requesterIp;
    }
    if (requesterUa !== undefined) {
      eventData.requesterUa = requesterUa;
    }
    if (idempotencyKey !== undefined) {
      eventData.idempotencyKey = idempotencyKey;
    }

    await db.loopEvent.create({
      data: {
        loopId,
        type: LoopEventType.TokenRefreshed,
        eventSource: "system",
        eventId: `token_refreshed:${currentJti}`,
        runnerTokenJti: currentJti,
        data: eventData,
      },
    });

    return false;
  });

  if (raced) {
    // The CAS matched 0 rows. Re-read the loop outside the tx to disambiguate
    // `NotRunning` (loop transitioned to a terminal status) from `RaceLost`
    // (concurrent rotation moved activeTokenJti). The re-read is informational
    // only, so it does not need to share the rotation's transactional scope.
    const reread = await withDb((db) =>
      db.loop.findUnique({
        where: { id: loopId },
        select: { status: true },
      })
    );

    if (reread && reread.status !== LoopStatus.Running) {
      return refreshError(
        orgId,
        RefreshTokenErrorCode.NotRunning,
        `Loop ${loopId} is not RUNNING (current status: ${reread.status})`
      );
    }

    return refreshError(
      orgId,
      RefreshTokenErrorCode.RaceLost,
      `Concurrent token refresh detected for loop ${loopId}; retry with the new token`
    );
  }

  // Best-effort bounded cleanup of the audit table. Failure here must not
  // affect the rotation result — the runner has already received its new
  // token by the time this runs.
  try {
    const stale = await withDb((db) =>
      db.loopTokenRefresh.findMany({
        where: { loopId },
        orderBy: { refreshedAt: "desc" },
        skip: REFRESH_AUDIT_RETENTION_PER_LOOP,
        select: { id: true },
      })
    );

    if (stale.length > 0) {
      await withDb((db) =>
        db.loopTokenRefresh.deleteMany({
          where: { id: { in: stale.map((row) => row.id) } },
        })
      );
    }
  } catch (error) {
    log.warn("refreshRunnerToken: bounded cleanup failed", {
      loopId,
      error,
    });
  }

  log.info("refreshRunnerToken: token rotated", {
    loopId,
    newJti: issued.tokenId,
  });

  return {
    ok: true,
    token: issued.token,
    expiresAt: issued.expiresAt,
    jti: issued.tokenId,
  };
}

type AssertReposInProjectPoolArgs = {
  organizationId: string;
  documentId: string | undefined;
  primary: { fullName: string } | undefined;
  additionalRepos: Array<{ fullName: string }> | undefined;
};

/**
 * Defense-in-depth project-pool membership check (PLN-529 T-4.1).
 *
 * When the loop is associated with a project (via the request's documentId),
 * every repo on the request — primary + additional — must resolve to a
 * `GitHubInstallationRepository` curated on at least one team belonging to
 * that project. Throws `RepoNotInProjectPoolError` otherwise.
 *
 * No-ops when:
 *  - There is no documentId (not project-scoped)
 *  - The artifact has no projectId
 *  - The project has zero team-curated repos (legacy projects pre-PLN-462)
 *
 * The UI gates submission to the team pool, so this firing in production
 * indicates a programmatic client (MCP, CLI, scripts) bypassed the picker.
 */
async function assertReposInProjectPool({
  organizationId,
  documentId,
  primary,
  additionalRepos,
}: AssertReposInProjectPoolArgs): Promise<void> {
  const fullNames: string[] = [];
  if (primary?.fullName) {
    fullNames.push(primary.fullName);
  }
  if (additionalRepos) {
    for (const repo of additionalRepos) {
      fullNames.push(repo.fullName);
    }
  }
  if (!(documentId && fullNames.length > 0)) {
    return;
  }

  const projectInfo = await withDb((db) =>
    db.artifact.findFirst({
      where: { id: documentId, organizationId },
      select: { projectId: true },
    })
  );
  const projectId = projectInfo?.projectId;
  if (!projectId) {
    return;
  }

  const teamRepos = await withDb((db) =>
    db.teamRepository.findMany({
      where: {
        team: {
          projects: { some: { projectId } },
          organizationId,
        },
      },
      select: {
        repository: { select: { fullName: true } },
      },
    })
  );
  if (teamRepos.length === 0) {
    // Legacy projects without a curated pool — fall through to other auth
    // checks (`authorizeAdditionalRepos` already covers org-level access).
    return;
  }

  const poolNames = new Set(teamRepos.map((r) => r.repository.fullName));
  const outsidePool = fullNames.filter((n) => !poolNames.has(n));
  if (outsidePool.length === 0) {
    return;
  }

  log.warn("assertReposInProjectPool: repos outside project pool", {
    organizationId,
    documentId,
    projectId,
    outsidePool,
  });
  throw new RepoNotInProjectPoolError(projectId, outsidePool);
}

/**
 * Record a liveness heartbeat for a running loop runner.
 *
 * Guards:
 * - Loop must exist and be org-scoped
 * - Loop must not be in a terminal status (COMPLETED, FAILED, CANCELLED, TIMED_OUT)
 * - Rate-limited: if `lastRunnerHeartbeatAt` is within the HEARTBEAT_RATE_LIMIT_WINDOW_MS,
 *   the bump is skipped and a success-like result with `bumped: false` is returned
 *
 * Uses `updateMany` with CAS on `status: Running` so concurrent writes (e.g.,
 * a simultaneous heartbeat + terminal transition) are safe. A CAS miss when
 * the loop is still RUNNING is benign — either a concurrent heartbeat already
 * bumped the timestamp, or the status changed to terminal after our pre-read.
 *
 * No LoopEvent row is created — heartbeats emit a structured log only to avoid
 * event-table flooding.
 */
export async function heartbeatRunner(
  loopId: string,
  organizationId: string
): Promise<HeartbeatResult> {
  const loop = await withDb((db) =>
    db.loop.findUnique({
      where: { id: loopId, organizationId },
      select: { status: true, lastRunnerHeartbeatAt: true },
    })
  );

  if (!loop) {
    return { ok: false, code: HeartbeatErrorCode.LoopNotFound };
  }

  const loopStatus = loop.status as LoopStatus;

  if (TERMINAL_STATUSES.has(loopStatus)) {
    return { ok: false, code: HeartbeatErrorCode.TerminalLoop };
  }

  if (loop.lastRunnerHeartbeatAt !== null) {
    const elapsedMs = Date.now() - loop.lastRunnerHeartbeatAt.getTime();
    if (elapsedMs < HEARTBEAT_RATE_LIMIT_WINDOW_MS) {
      return { ok: true, bumped: false };
    }
  }

  const { count } = await withDb((db) =>
    db.loop.updateMany({
      where: {
        id: loopId,
        organizationId,
        status: LoopStatus.Running,
      },
      data: { lastRunnerHeartbeatAt: new Date() },
    })
  );

  if (count === 0) {
    // CAS missed: re-read to disambiguate a concurrent terminal transition
    // (→ TerminalLoop), a loop that was never Running (→ NotRunning), or a
    // concurrent hard-delete between the pre-read and the CAS (→ LoopNotFound).
    const reread = await withDb((db) =>
      db.loop.findUnique({
        where: { id: loopId, organizationId },
        select: { status: true },
      })
    );

    if (!reread) {
      return { ok: false, code: HeartbeatErrorCode.LoopNotFound };
    }

    if (!TERMINAL_STATUSES.has(reread.status as LoopStatus)) {
      return { ok: false, code: HeartbeatErrorCode.NotRunning };
    }

    return { ok: false, code: HeartbeatErrorCode.TerminalLoop };
  }

  emitHeartbeatAccepted(organizationId, loopId);
  return { ok: true, bumped: true };
}

/**
 * Throttled heartbeat bump invoked from the event-ingestion route when a runner
 * event is successfully inserted. Updates `lastRunnerHeartbeatAt` only when it
 * is NULL or older than `HEARTBEAT_RATE_LIMIT_WINDOW_MS`, so the cost is
 * O(no-op) for high-frequency event streams. The CAS on `status: Running`
 * prevents writes that race with a terminal transition. Failures are logged
 * and swallowed — heartbeat bumping is best-effort.
 */
export async function scheduleRunnerHeartbeatBump(
  loopId: string,
  organizationId: string
): Promise<void> {
  const heartbeatThreshold = new Date(
    Date.now() - HEARTBEAT_RATE_LIMIT_WINDOW_MS
  );
  try {
    await withDb((db) =>
      db.loop.updateMany({
        where: {
          id: loopId,
          organizationId,
          status: LoopStatus.Running,
          OR: [
            { lastRunnerHeartbeatAt: null },
            { lastRunnerHeartbeatAt: { lt: heartbeatThreshold } },
          ],
        },
        data: { lastRunnerHeartbeatAt: new Date() },
      })
    );
  } catch (heartbeatError) {
    log.warn("Failed to bump runner heartbeat on event ingestion", {
      loopId,
      error: heartbeatError,
    });
  }
}

/**
 * Reason codes for revival guard rejections. Callers map these to HTTP
 * responses (410 Gone for terminal guards, 409 Conflict for CAS races).
 */
export const RevivalRefusedReason = {
  /** Loop not found or does not belong to the org. */
  LoopNotFound: "LOOP_NOT_FOUND",
  /** Loop is not in TIMED_OUT status. */
  NotTimedOut: "NOT_TIMED_OUT",
  /** Loop's runnerCapabilities do not include desktop heartbeat support. */
  NotDesktop: "NOT_DESKTOP",
  /** Loop was reaped for a non-heartbeat-staleness reason. */
  NonHeartbeatReap: "NON_HEARTBEAT_REAP",
  /** Loop was reaped more than REVIVAL_GRACE_WINDOW_MS ago. */
  GraceWindowExpired: "GRACE_WINDOW_EXPIRED",
  /** Loop has reached REVIVAL_MAX_PER_LOOP revival attempts. */
  RevivalCapReached: "REVIVAL_CAP_REACHED",
  /** CAS missed — a concurrent write transitioned the loop out of TIMED_OUT. */
  CasRace: "CAS_RACE",
  /** Fresh runner token could not be minted. */
  TokenMintFailed: "TOKEN_MINT_FAILED",
} as const;
export type RevivalRefusedReason =
  (typeof RevivalRefusedReason)[keyof typeof RevivalRefusedReason];

export type ReviveTimedOutLoopResult =
  | ({ ok: true } & RunnerTokenIssue)
  | {
      ok: false;
      reason: RevivalRefusedReason;
    };

/**
 * Reap reasons that indicate recoverable heartbeat-staleness. Used by
 * `reviveTimedOutLoop` to decide whether a TIMED_OUT loop is eligible for
 * revival. Allocated once at module level to avoid per-call Set creation.
 */
const HEARTBEAT_STALENESS_REAP_REASONS = new Set<string>([
  ReapReason.DesktopHeartbeatStale,
  ReapReason.DesktopNoHeartbeat,
]);

/**
 * Zod schema for reading the reaper data embedded in a TIMED_OUT audit event.
 * The reaper sub-object is written by `buildTimeoutEventData` in reaper-helpers.
 */
const reaperEventDataSchema = z.object({
  reaper: z
    .object({
      reason: z.string().optional(),
    })
    .optional(),
});

/**
 * Attempt to revive a TIMED_OUT desktop loop when the local process wakes and
 * sends a heartbeat with a valid Clerk session token.
 *
 * Guards (in order):
 * 1. Loop must exist and be in TIMED_OUT status.
 * 2. Loop must have desktop heartbeat capability (runnerCapabilities includes
 *    loopRunnerHeartbeatSupported=true or lastRunnerHeartbeatAt is non-null).
 * 3. The most-recent TIMED_OUT audit event must carry reaper.reason of
 *    heartbeat-staleness (DesktopHeartbeatStale or DesktopNoHeartbeat).
 * 4. The loop's completedAt must be within REVIVAL_GRACE_WINDOW_MS.
 * 5. revivalCount must be < REVIVAL_MAX_PER_LOOP.
 *
 * On passing all guards:
 * - Mints a fresh runner token.
 * - CAS-transitions TIMED_OUT → RUNNING atomically (updateMany with status
 *   predicate) to avoid TOCTOU races with the reaper or concurrent revivals.
 * - Inserts a ReapReversed audit event.
 * - Emits the reap.reversed telemetry metric.
 *
 * Returns a `ReviveTimedOutLoopResult` — never throws for expected refusals.
 */
export async function reviveTimedOutLoop(
  loopId: string,
  organizationId: string
): Promise<ReviveTimedOutLoopResult> {
  // 1. Fetch the loop — org-scoped for security.
  const loop = await withDb((db) =>
    db.loop.findUnique({
      where: { id: loopId, organizationId },
      select: {
        status: true,
        computeTargetId: true,
        completedAt: true,
        revivalCount: true,
        lastRunnerHeartbeatAt: true,
        runnerCapabilities: true,
      },
    })
  );

  if (!loop) {
    return { ok: false, reason: RevivalRefusedReason.LoopNotFound };
  }

  if (loop.status !== LoopStatus.TimedOut) {
    return { ok: false, reason: RevivalRefusedReason.NotTimedOut };
  }

  // 2. Guard: desktop capability check.
  // A loop is desktop-capable when it has a computeTargetId (Desktop runner)
  // and advertises heartbeat support via capabilities or a prior heartbeat.
  const parsedCaps = runnerCapabilitiesSchema.safeParse(
    loop.runnerCapabilities
  );
  const caps = parsedCaps.success ? parsedCaps.data : {};
  const isDesktop =
    loop.computeTargetId !== null &&
    (caps.loopRunnerHeartbeatSupported === true ||
      loop.lastRunnerHeartbeatAt !== null);

  if (!isDesktop) {
    return { ok: false, reason: RevivalRefusedReason.NotDesktop };
  }

  // 3. Guard: heartbeat-staleness reap reason check.
  // Read the most-recent TIMED_OUT audit event to confirm the loop was reaped
  // for a recoverable heartbeat-staleness reason.
  const timedOutEvent = await withDb((db) =>
    db.loopEvent.findFirst({
      where: { loopId, type: LoopEventType.Error },
      orderBy: { createdAt: "desc" },
      select: { data: true },
    })
  );

  const parsedEventData = reaperEventDataSchema.safeParse(timedOutEvent?.data);
  const reapReason = parsedEventData.success
    ? parsedEventData.data.reaper?.reason
    : undefined;

  if (!(reapReason && HEARTBEAT_STALENESS_REAP_REASONS.has(reapReason))) {
    return { ok: false, reason: RevivalRefusedReason.NonHeartbeatReap };
  }

  // 4. Guard: grace window check.
  const completedAt = loop.completedAt;
  if (
    completedAt === null ||
    Date.now() - completedAt.getTime() > REVIVAL_GRACE_WINDOW_MS
  ) {
    return { ok: false, reason: RevivalRefusedReason.GraceWindowExpired };
  }

  // 5. Guard: revival cap check.
  if (loop.revivalCount >= REVIVAL_MAX_PER_LOOP) {
    return { ok: false, reason: RevivalRefusedReason.RevivalCapReached };
  }

  // Mint a fresh runner token before the CAS write. If minting fails, we
  // return early without touching the loop status.
  let issued: LoopRunnerTokenIssueResult;
  try {
    issued = await issueLoopRunnerToken({ loopId, organizationId });
  } catch (mintError) {
    log.error("reviveTimedOutLoop: failed to mint runner token", {
      loopId,
      error: mintError,
    });
    return { ok: false, reason: RevivalRefusedReason.TokenMintFailed };
  }

  // CAS: TIMED_OUT → RUNNING. The status predicate prevents a double-revival
  // or a lost update if the reaper or another heartbeat request races here.
  const now = new Date();
  const casResult = await withDb.tx(async (db) => {
    const cas = await db.loop.updateMany({
      where: {
        id: loopId,
        organizationId,
        status: LoopStatus.TimedOut,
      },
      data: {
        status: LoopStatus.Running,
        completedAt: null,
        activeTokenJti: issued.tokenId,
        tokenExpiresAt: issued.expiresAt,
        lastRunnerHeartbeatAt: now,
        revivalCount: { increment: 1 },
        lastRevivalAt: now,
      },
    });

    if (cas.count === 0) {
      return { raced: true as const };
    }

    // Insert the ReapReversed audit event inside the same transaction.
    await db.loopEvent.create({
      data: {
        loopId,
        type: LoopEventType.ReapReversed,
        eventSource: "system",
        eventId: `${LoopEventType.ReapReversed}:${issued.tokenId}`,
        data: {
          newJti: issued.tokenId,
          exp: issued.expiresAt.toISOString(),
          timestamp: now.toISOString(),
        },
      },
    });

    return { raced: false as const };
  });

  if (casResult.raced) {
    return { ok: false, reason: RevivalRefusedReason.CasRace };
  }

  // Emit telemetry after the transaction commits.
  emitReapReversed(loopId, organizationId);

  log.info("reviveTimedOutLoop: loop revived", {
    loopId,
    newJti: issued.tokenId,
  });

  return {
    ok: true,
    token: issued.token,
    expiresAt: issued.expiresAt,
    jti: issued.tokenId,
  };
}
