import type { JsonObject } from "@repo/api/src/types/common";
import type {
  CreateLoopRequest,
  CreateLoopResponse,
  Loop,
  LoopCommand,
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
import { type Loop as PrismaLoop, withDb } from "@repo/database";
import { log } from "@repo/observability/log";

export class ReplayDetectedError extends Error {
  constructor(message = "Replay detected") {
    super(message);
    this.name = "ReplayDetectedError";
  }
}

export function isReplayDetectedError(error: unknown): boolean {
  return error instanceof ReplayDetectedError;
}

/**
 * Valid status transitions for loops.
 * Key = current status, Value = set of allowed next statuses.
 */
const VALID_TRANSITIONS: Record<LoopStatus, Set<LoopStatus>> = {
  PENDING: new Set(["CLAIMED", "CANCELLED"]),
  CLAIMED: new Set(["RUNNING", "CANCELLED"]),
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
 * Transform a Prisma loop record to the API Loop type.
 * Handles Decimal → number conversion for estimatedCost and
 * typed JSON field casts for repo, contextRefs, error, metadata, tokensByModel.
 */
function toLoop(record: PrismaLoop): Loop {
  return {
    ...record,
    estimatedCost:
      record.estimatedCost != null ? Number(record.estimatedCost) : null,
    repo: record.repo as Loop["repo"],
    contextRefs: record.contextRefs as Loop["contextRefs"],
    error: record.error as Loop["error"],
    metadata: record.metadata as Loop["metadata"],
    tokensByModel: record.tokensByModel as Loop["tokensByModel"],
  };
}

/**
 * Transform a Prisma loop record (with included user) to the API LoopWithUser type.
 */
function toLoopWithUser(
  record: PrismaLoop & { user: LoopWithUser["user"] }
): LoopWithUser {
  return {
    ...toLoop(record),
    user: record.user,
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
          prompt: input.prompt ?? null,
          repo: input.repo ?? undefined,
          contextRefs: input.contextRefs ?? undefined,
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
   */
  async findById(id: string, organizationId: string): Promise<Loop | null> {
    const loop = await withDb((db) =>
      db.loop.findUnique({
        where: { id, organizationId },
      })
    );

    if (!loop) {
      return null;
    }

    return toLoop(loop);
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
        },
        include: {
          user: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              avatarUrl: true,
              email: true,
            },
          },
        },
        orderBy: { createdAt: "desc" },
        take: limit,
        skip: offset,
      })
    );

    return loops.map((l) =>
      toLoopWithUser(l as PrismaLoop & { user: LoopWithUser["user"] })
    );
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
        data: {
          status,
          ...(data?.containerId !== undefined
            ? { containerId: data.containerId }
            : {}),
          ...(data?.startedAt !== undefined
            ? { startedAt: data.startedAt }
            : {}),
          ...(data?.completedAt !== undefined
            ? { completedAt: data.completedAt }
            : {}),
          ...(data?.tokensInput !== undefined
            ? { tokensInput: data.tokensInput }
            : {}),
          ...(data?.tokensOutput !== undefined
            ? { tokensOutput: data.tokensOutput }
            : {}),
          ...(data?.tokensByModel !== undefined
            ? { tokensByModel: data.tokensByModel }
            : {}),
          ...(data?.estimatedCost !== undefined
            ? { estimatedCost: data.estimatedCost }
            : {}),
          ...(data?.error !== undefined ? { error: data.error } : {}),
          ...(data?.s3StateKey !== undefined
            ? { s3StateKey: data.s3StateKey }
            : {}),
        },
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

      throw new Error(
        `Invalid status transition: ${current.status} → ${status}`
      );
    }

    log.info("Loop status updated", {
      loopId: id,
      to: status,
    });

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

      throw new Error(
        `Invalid status transition: ${current.status} → CANCELLED`
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

    if (parent.status !== "COMPLETED" && parent.status !== "FAILED") {
      throw new Error(
        `Cannot resume loop in ${parent.status} status. Only COMPLETED or FAILED loops can be resumed.`
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
    if (
      TERMINAL_STATUSES.has(loop.status as LoopStatus) &&
      !["completed", "error", "cancelled"].includes(event.type)
    ) {
      return false;
    }

    try {
      await withDb((db) =>
        db.loopEvent.create({
          data: {
            loopId,
            type: event.type,
            data: event.data as JsonObject,
            ...(runner?.tokenJti ? { runnerTokenJti: runner.tokenJti } : {}),
            ...(runner?.nonce ? { runnerNonce: runner.nonce } : {}),
          },
        })
      );
    } catch (error) {
      if (
        runner &&
        error instanceof Error &&
        "code" in error &&
        (error as { code: string }).code === "P2002"
      ) {
        throw new ReplayDetectedError();
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

    // Transform DB events to API LoopEvent type
    return events.map((e) => ({
      type: e.type,
      ...(e.data as Record<string, unknown>),
      timestamp:
        (e.data as Record<string, unknown>).timestamp ??
        e.createdAt.toISOString(),
    })) as unknown as LoopEvent[];
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

    // Transform DB events to API LoopEvent type
    const data = events.map((e) => ({
      type: e.type,
      ...(e.data as Record<string, unknown>),
      timestamp:
        (e.data as Record<string, unknown>).timestamp ??
        e.createdAt.toISOString(),
    })) as unknown as LoopEvent[];

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

    const where = {
      organizationId,
      ...(userId ? { userId } : {}),
      ...(command ? { command: command as never } : {}),
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
};
