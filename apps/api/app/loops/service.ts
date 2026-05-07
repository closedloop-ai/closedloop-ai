import { createHash } from "node:crypto";
import { AdditionalRepoRefSchema } from "@closedloop-ai/loops-api/context-pack";
import type { JsonObject } from "@repo/api/src/types/common";
import type { PullRequestInfo } from "@repo/api/src/types/document";
import {
  type AdditionalRepoRefWithPr,
  type ComputeTargetSummary,
  type CreateLoopRequest,
  type CreateLoopResponse,
  type InheritedAdditionalRepos,
  type Loop,
  LoopCommand,
  type LoopDetail,
  LoopErrorCode,
  type LoopEvent,
  type LoopEventsFilters,
  type LoopEventsPaginatedResponse,
  type LoopListFilters,
  LoopStatus,
  type LoopUsageByCommand,
  type LoopUsageByUser,
  type LoopUsageSummary,
  type LoopWithUser,
  type ResumeLoopRequest,
  type TokensByModel,
} from "@repo/api/src/types/loop";
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
import { basicUserSelect, getPrismaErrorCode } from "@/lib/db-utils";
import { extractUploadedPlanRaw } from "@/lib/loops/uploaded-plan-artifacts";
import { LOOP_ACTIVE_INDEX_NAME } from "./loop-constants";
import {
  BranchNotFoundError,
  ConcurrentLoopLimitError,
  InvalidStatusTransitionError,
  LoopAlreadyActiveError,
  NestedManualLoopError,
  ReplayDetectedError,
  UnauthorizedRepoError,
} from "./loop-errors";

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
  TIMED_OUT: new Set<LoopStatus>([LoopStatus.Completed]),
};

const TERMINAL_STATUSES = new Set<LoopStatus>([
  LoopStatus.Completed,
  LoopStatus.Failed,
  LoopStatus.Cancelled,
  LoopStatus.TimedOut,
]);

/**
 * Loop statuses that the partial unique index `loops_active_artifact_command_version_key`
 * (migration 20260319195219_add_partial_unique_loop_artifact_command_version)
 * treats as "currently holding an (artifact_id, command, artifact_version) slot."
 * This is the **index-blocking tier**: the DB physically refuses a duplicate
 * insert for any row in this set. The narrower **operationally-active tier**
 * lives in `findOperationallyActiveLoop` and is strictly a subset; the reap step
 * bridges the two so any row in this set but not in the operational set is
 * eventually marked FAILED.
 *
 * Phase 1 (PLN-477) enforces the broader (artifact_id, command) invariant in
 * application code only; Phase 2 (FEA-906) will widen the DB index to match.
 */
const ACTIVE_LOOP_STATUSES: LoopStatus[] = [
  LoopStatus.Pending,
  LoopStatus.Claimed,
  LoopStatus.Running,
];

/**
 * Age threshold beyond which a PENDING loop with no containerId is treated as
 * an orphan (silently-failed dispatch). Used by the reap step and by the
 * operationally-active lookup so the two stay in lockstep.
 */
const STALE_PENDING_THRESHOLD_MS = 30_000;

const PRISMA_UNIQUE_CONSTRAINT_ERROR_CODE = "P2002";
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

/** Checks for Prisma's `P2002` (unique constraint) error code. */
function isPrismaUniqueConstraintError(error: unknown): boolean {
  return getPrismaErrorCode(error) === PRISMA_UNIQUE_CONSTRAINT_ERROR_CODE;
}

/**
 * True iff the error is a P2002 raised by the loops active-index. Other unique
 * constraints (loop_events idempotency, etc.) return false and pass through
 * unchanged. Handles both shapes Prisma actually emits today:
 *   - `meta.target`: index name (string) or camelCase field array
 *   - `meta.driverAdapterError.cause.constraint.{index|fields}` (pg adapter)
 */
function isLoopActiveIndexViolation(error: unknown): boolean {
  if (!isPrismaUniqueConstraintError(error)) {
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
      code: PRISMA_UNIQUE_CONSTRAINT_ERROR_CODE,
      meta: {
        targetType: target == null ? "null/undefined" : typeof target,
        hasDriverAdapterError: driverAdapterError != null,
        hasConstraint: constraint != null,
        constraintKeys: constraint != null ? Object.keys(constraint) : [],
      },
    }
  );
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
 */
function toLoop(record: PrismaLoop): Loop {
  return {
    ...record,
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
  }
): LoopWithUser {
  return {
    ...toLoop(record),
    user: record.user,
    computeTarget: record.computeTarget ?? null,
  };
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

    const loop = await createLoopWithActiveGate({
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
              artifactId: input.documentId ?? null,
              workstreamId: input.workstreamId ?? null,
              parentLoopId: input.parentLoopId ?? null,
              computeTargetId: input.computeTargetId ?? null,
              prompt: input.prompt ?? null,
              repo: input.repo ?? undefined,
              additionalRepos: input.additionalRepos ?? undefined,
              contextRefs: input.contextRefs ?? undefined,
              artifactVersion: input.documentVersion ?? null,
              metadata: input.metadata ?? undefined,
              status: isManual ? LoopStatus.Running : LoopStatus.Pending,
              startedAt: isManual ? new Date() : undefined,
            },
          })
        ),
    });

    log.info("Loop created", {
      loopId: loop.id,
      organizationId,
      userId,
      command: input.command,
    });

    return {
      loopId: loop.id,
      status: loop.status as LoopStatus,
    };
  },

  /**
   * Get a single Loop by ID (org-scoped).
   * Includes associated user info for detail views, with PR-enriched additionalRepos.
   */
  async findById(
    id: string,
    organizationId: string
  ): Promise<LoopDetail | null> {
    const loop = await withDb((db) =>
      db.loop.findUnique({
        where: { id, organizationId },
        include: {
          user: basicUserSelect,
          computeTarget: computeTargetSelect,
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
      }
    );

    let pullRequests: PullRequestInfo[] = [];
    if (
      result.documentId !== null &&
      (result.repo !== null ||
        (result.additionalRepos !== null && result.additionalRepos.length > 0))
    ) {
      pullRequests = await documentPullRequestService.getDocumentPullRequests(
        result.documentId,
        result.organizationId
      );
    }
    const additionalRepos = _enrichAdditionalReposWithPr(result, pullRequests);
    const primaryPullRequest = _findPrimaryRepoPr(result, pullRequests);

    return {
      ...result,
      additionalRepos,
      primaryPullRequest,
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
      workstreamId,
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
          ...(workstreamId ? { workstreamId } : {}),
          ...(projectId ? { artifact: { projectId } } : {}),
          ...(userId ? { userId } : {}),
        },
        include: {
          user: basicUserSelect,
          computeTarget: computeTargetSelect,
        },
        orderBy: { createdAt: "desc" },
        take: limit,
        skip: offset,
      })
    );

    type LoopWithIncludes = PrismaLoop & {
      user: LoopWithUser["user"];
      computeTarget: ComputeTargetSummary | null;
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
    const result = await withDb((db) =>
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
    const result = await withDb((db) =>
      db.loop.updateMany({
        where: {
          id,
          organizationId,
          status: { in: validFromStatuses },
        },
        data: {
          status: LoopStatus.Cancelled,
          completedAt: new Date(),
        },
      })
    );

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
    const result = await withDb((db) =>
      db.loop.updateMany({
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
        data: {
          status: LoopStatus.Failed,
          completedAt: new Date(),
          error: {
            code: LoopErrorCode.StaleDispatch,
            message:
              "Loop dispatch was never acknowledged; marked failed after staleness threshold.",
          },
        },
      })
    );
    if (result.count > 0) {
      log.info("Reaped stale pending loops", {
        count: result.count,
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
              workstreamId: parent.workstreamId,
              parentLoopId: parent.id,
              prompt: input.prompt ?? parent.prompt,
              repo: parent.repo ?? undefined,
              additionalRepos: parsedAdditionalRepos ?? undefined,
              contextRefs: parent.contextRefs ?? undefined,
              computeTargetId: computeTargetId ?? null,
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
    if (
      TERMINAL_STATUSES.has(loop.status as LoopStatus) &&
      !["completed", "error", "cancelled"].includes(event.type)
    ) {
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
      if (isPrismaUniqueConstraintError(error)) {
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
  ): Promise<LoopEvent[]> {
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
        orderBy: { createdAt: "asc" },
      })
    );

    // Transform DB events to API LoopEvent type.
    // IMPORTANT: `type` must come AFTER the spread so that e.data's `type` field
    // (if present) does not overwrite the canonical DB-stored event type.
    return events.map((e) => {
      const data = (e.data as JsonObject) ?? {};
      return {
        ...data,
        type: e.type,
        timestamp: data.timestamp ?? e.createdAt.toISOString(),
      } as LoopEvent;
    });
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

    // Transform DB events to API LoopEvent type.
    // IMPORTANT: `type` must come AFTER the spread so that e.data's `type` field
    // (if present) does not overwrite the canonical DB-stored event type.
    const data = events.map((e) => {
      const eventData = (e.data as JsonObject) ?? {};
      return {
        ...eventData,
        type: e.type,
        timestamp: eventData.timestamp ?? e.createdAt.toISOString(),
      } as LoopEvent;
    });

    return { data, total };
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
      const precedence = INHERITED_REPOS_SOURCE_PRECEDENCE[targetCommand];
      if (!precedence) {
        return { additionalRepos: [], source: null };
      }
      const statusFilters: Prisma.EnumLoopStatusFilter[] = [
        { equals: LoopStatus.Completed },
        { in: [...INHERITANCE_FALLBACK_STATUSES] },
      ];
      for (const command of precedence) {
        for (const statusFilter of statusFilters) {
          const candidate = await db.loop.findFirst({
            where: {
              artifactId: documentId,
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
              },
            };
          }
          // Candidate exists but has no usable peers — keep walking the
          // precedence chain so a recent empty PLAN doesn't shadow a
          // GENERATE_PRD that does have peers.
        }
      }
      return { additionalRepos: [], source: null };
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
};

/**
 * Enrich each AdditionalRepoRef with its corresponding pull request (if any).
 * Returns the original array unchanged when no enrichment is needed (null array,
 * empty array, or no documentId to look up PRs against).
 */
function _enrichAdditionalReposWithPr(
  loop: LoopWithUser,
  prs: PullRequestInfo[]
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
    pullRequest: prs.find((pr) => pr.repoFullName === repo.fullName) ?? null,
  }));
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

  const authorizedRepos = await withDb((db) =>
    db.gitHubInstallationRepository.findMany({
      where: {
        fullName: { in: fullNames },
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
