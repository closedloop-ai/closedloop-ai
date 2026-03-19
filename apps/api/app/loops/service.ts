import { createHash } from "node:crypto";
import type { JsonObject } from "@repo/api/src/types/common";
import type {
  ComputeTargetSummary,
  CreateLoopRequest,
  CreateLoopResponse,
  Loop,
  LoopEvent,
  LoopEventsFilters,
  LoopEventsPaginatedResponse,
  LoopListFilters,
  LoopStatus,
  LoopUsageByCommand,
  LoopUsageSummary,
  LoopWithUser,
  ResumeLoopRequest,
} from "@repo/api/src/types/loop";
import { LoopCommand } from "@repo/api/src/types/loop";
import { type Loop as PrismaLoop, withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { basicUserSelect } from "@/lib/db-utils";

export class ReplayDetectedError extends Error {
  constructor(message = "Replay detected") {
    super(message);
    this.name = "ReplayDetectedError";
  }
}

export function isReplayDetectedError(error: unknown): boolean {
  return error instanceof ReplayDetectedError;
}

export class InvalidStatusTransitionError extends Error {
  readonly from: string;
  readonly to: string;
  constructor(from: string, to: string) {
    super(`Invalid status transition: ${from} → ${to}`);
    this.name = "InvalidStatusTransitionError";
    this.from = from;
    this.to = to;
  }
}

export function isInvalidStatusTransitionError(error: unknown): boolean {
  return error instanceof InvalidStatusTransitionError;
}

/**
 * Valid status transitions for loops.
 * Key = current status, Value = set of allowed next statuses.
 */
const VALID_TRANSITIONS: Record<LoopStatus, Set<LoopStatus>> = {
  // PENDING → RUNNING covers the race where the container sends "started"
  // before the backend has finished transitioning to CLAIMED.
  PENDING: new Set(["CLAIMED", "RUNNING", "CANCELLED"]),
  // CLAIMED → terminal states covers the case where the "started" event was
  // dropped (network issue, transient failure). Without this, a lost "started"
  // event would strand the loop in CLAIMED until the cron timeout safety net.
  CLAIMED: new Set([
    "RUNNING",
    "COMPLETED",
    "FAILED",
    "CANCELLED",
    "TIMED_OUT",
  ]),
  RUNNING: new Set(["COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT"]),
  COMPLETED: new Set(),
  FAILED: new Set(),
  CANCELLED: new Set(),
  TIMED_OUT: new Set(),
};

const TERMINAL_STATUSES = new Set<LoopStatus>([
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "TIMED_OUT",
]);

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
 * runtime-validated JSON field parsing for repo, error.
 * contextRefs, metadata, and tokensByModel use structural casts
 * since they are always written by trusted backend code.
 */
function toLoop(record: PrismaLoop): Loop {
  return {
    ...record,
    estimatedCost:
      record.estimatedCost != null ? Number(record.estimatedCost) : null,
    repo: parseRepo(record.repo),
    contextRefs: record.contextRefs as Loop["contextRefs"],
    error: parseError(record.error),
    metadata: (record.metadata ?? {}) as Loop["metadata"],
    uploadedArtifacts:
      (record.uploadedArtifacts as Loop["uploadedArtifacts"]) ?? null,
    tokensByModel: record.tokensByModel as Loop["tokensByModel"],
  };
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
 * Maximum concurrent active (PENDING/CLAIMED/RUNNING) loops per user.
 * Prevents resource exhaustion via rapid loop creation.
 */
const MAX_CONCURRENT_LOOPS_PER_USER = 5;

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
    // Enforce per-user concurrency limit.
    // NOTE: This is a soft limit with a known TOCTOU window — two concurrent
    // requests could both read count=4 and both proceed. The risk is low
    // (same user, tight race window, generous limit of 5) so a DB-level
    // INSERT ... WHERE (SELECT count) < 5 is overkill for V1.
    const activeCount = await withDb((db) =>
      db.loop.count({
        where: {
          userId,
          organizationId,
          status: { in: ["PENDING", "CLAIMED", "RUNNING"] },
        },
      })
    );

    if (activeCount >= MAX_CONCURRENT_LOOPS_PER_USER) {
      throw new Error(
        `Too many active loops (${activeCount}). ` +
          `Maximum ${MAX_CONCURRENT_LOOPS_PER_USER} concurrent loops allowed per user. ` +
          "Wait for existing loops to complete or cancel them."
      );
    }

    const loop = await withDb((db) =>
      db.loop.create({
        data: {
          organizationId,
          userId,
          command: input.command,
          artifactId: input.artifactId ?? null,
          workstreamId: input.workstreamId ?? null,
          parentLoopId: input.parentLoopId ?? null,
          computeTargetId: input.computeTargetId ?? null,
          prompt: input.prompt ?? null,
          repo: input.repo ?? undefined,
          contextRefs: input.contextRefs ?? undefined,
          metadata: input.metadata ?? undefined,
          status: "PENDING",
        },
      })
    );

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
   * Includes associated user info for detail views.
   */
  async findById(
    id: string,
    organizationId: string
  ): Promise<LoopWithUser | null> {
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

    return toLoopWithUser(
      loop as PrismaLoop & {
        user: LoopWithUser["user"];
        computeTarget: ComputeTargetSummary | null;
      }
    );
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
      artifactId,
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
          ...(artifactId ? { artifactId } : {}),
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
      tokensByModel: Record<string, { input: number; output: number }>;
      estimatedCost: number;
      error: { code: string; message: string };
      s3StateKey: string;
      prUrl: string;
      prNumber: number;
      branchName: string;
      sessionId: string;
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
          status: { in: ["PENDING", "CLAIMED", "RUNNING"] },
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
      .filter(([, allowed]) => allowed.has("CANCELLED"))
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
          status: "CANCELLED",
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

      throw new InvalidStatusTransitionError(current.status, "CANCELLED");
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
   * Create a resumed Loop from a parent.
   * The new loop inherits context from the parent but starts fresh.
   */
  async resume(
    parentLoopId: string,
    organizationId: string,
    userId: string,
    input: ResumeLoopRequest
  ): Promise<CreateLoopResponse> {
    const parent = await withDb((db) =>
      db.loop.findUnique({
        where: { id: parentLoopId, organizationId },
      })
    );

    if (!parent) {
      throw new Error(`Parent loop not found: ${parentLoopId}`);
    }

    // Only the original loop creator can resume it
    if (parent.userId !== userId) {
      throw new Error("You can only resume your own loops");
    }

    const resumableStatuses = new Set(["COMPLETED", "FAILED", "TIMED_OUT"]);
    if (!resumableStatuses.has(parent.status)) {
      throw new Error(
        `Cannot resume loop in ${parent.status} status. Only COMPLETED, FAILED, or TIMED_OUT loops can be resumed.`
      );
    }

    // Enforce per-user concurrency limit (same as create())
    const activeCount = await withDb((db) =>
      db.loop.count({
        where: {
          userId,
          organizationId,
          status: { in: ["PENDING", "CLAIMED", "RUNNING"] },
        },
      })
    );

    if (activeCount >= MAX_CONCURRENT_LOOPS_PER_USER) {
      throw new Error(
        `Too many active loops (${activeCount}). ` +
          `Maximum ${MAX_CONCURRENT_LOOPS_PER_USER} concurrent loops allowed per user. ` +
          "Wait for existing loops to complete or cancel them."
      );
    }

    const loop = await withDb((db) =>
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
          contextRefs: parent.contextRefs ?? undefined,
          s3StateKey: parent.s3StateKey,
          status: "PENDING",
        },
      })
    );

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
      if (
        error instanceof Error &&
        "code" in error &&
        (error as { code: string }).code === "P2002"
      ) {
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
      const data = (e.data as Record<string, unknown>) ?? {};
      return {
        ...data,
        type: e.type,
        timestamp: data.timestamp ?? e.createdAt.toISOString(),
      };
    }) as unknown as LoopEvent[];
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
    const { type, limit = 100, offset = 0 } = filters;

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
          orderBy: { createdAt: "asc" },
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
      const eventData = (e.data as Record<string, unknown>) ?? {};
      return {
        ...eventData,
        type: e.type,
        timestamp: eventData.timestamp ?? e.createdAt.toISOString(),
      };
    }) as unknown as LoopEvent[];

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
            command:
              validatedCommand as (typeof LoopCommand)[keyof typeof LoopCommand],
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

    const [aggregate, groupByCommand] = await Promise.all([
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
    ]);

    const byCommand: LoopUsageByCommand[] = groupByCommand.map((g) => ({
      command: g.command as LoopCommand,
      loopCount: g._count,
      tokensInput: g._sum.tokensInput ?? 0,
      tokensOutput: g._sum.tokensOutput ?? 0,
      estimatedCost: Number(g._sum.estimatedCost ?? 0),
    }));

    return {
      totalLoops: aggregate._count,
      totalTokensInput: aggregate._sum.tokensInput ?? 0,
      totalTokensOutput: aggregate._sum.tokensOutput ?? 0,
      totalEstimatedCost: Number(aggregate._sum.estimatedCost ?? 0),
      byCommand,
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
    artifactId: string,
    organizationId: string
  ): Promise<Loop | null> {
    const loop = await withDb((db) =>
      db.loop.findFirst({
        where: {
          artifactId,
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
   * Store uploaded artifacts from desktop harness on the loop record.
   * Used by the upload-artifacts endpoint as an alternative to S3.
   */
  async updateUploadedArtifacts(
    id: string,
    organizationId: string,
    uploadedArtifacts: JsonObject
  ): Promise<number> {
    const result = await withDb((db) =>
      db.loop.updateMany({
        where: {
          id,
          organizationId,
          status: { in: ["PENDING", "CLAIMED", "RUNNING"] },
        },
        data: { uploadedArtifacts },
      })
    );
    return result.count;
  },

  /**
   * Find an active (PENDING/CLAIMED/RUNNING) PLAN loop for an artifact.
   * Returns the most recently created one, or null if none exist.
   */
  async findActivePlanLoopForArtifact(
    artifactId: string,
    organizationId: string,
    computeTargetId?: string
  ): Promise<Loop | null> {
    // RUNNING/CLAIMED with a containerId are genuinely active (dispatched
    // and acknowledged by the desktop). PENDING loops are only in-flight
    // briefly (<30s) while the API dispatches them. Older PENDING loops
    // without a containerId are stuck (relay failed) and must not block
    // new launches.
    // Scope to the caller's compute target so a loop running on another
    // user's desktop doesn't block this user's Start Planning.
    const stalenessThreshold = new Date(Date.now() - 30_000);
    const loop = await withDb((db) =>
      db.loop.findFirst({
        where: {
          artifactId,
          organizationId,
          command: "PLAN",
          ...(computeTargetId ? { computeTargetId } : {}),
          OR: [
            { status: "RUNNING" },
            { status: "CLAIMED", containerId: { not: null } },
            {
              status: { in: ["PENDING", "CLAIMED"] },
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
          status: { in: ["PENDING", "CLAIMED", "RUNNING"] },
        },
        data: { metadata },
      })
    );
    return result.count;
  },
};
