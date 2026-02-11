import type { JsonObject } from "@repo/api/src/types/common";
import type {
  CreateLoopRequest,
  CreateLoopResponse,
  Loop,
  LoopEvent,
  LoopListFilters,
  LoopStatus,
  LoopUsageSummary,
  LoopWithUser,
  ResumeLoopRequest,
} from "@repo/api/src/types/loop";
import { withDb } from "@repo/database";
import { log } from "@repo/observability/log";

/**
 * Valid status transitions for loops.
 * Key = current status, Value = set of allowed next statuses.
 */
const VALID_TRANSITIONS: Record<LoopStatus, Set<LoopStatus>> = {
  PENDING: new Set(["CLAIMED", "CANCELLED"]),
  CLAIMED: new Set(["RUNNING"]),
  RUNNING: new Set(["COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT"]),
  COMPLETED: new Set(),
  FAILED: new Set(),
  CANCELLED: new Set(),
  TIMED_OUT: new Set(),
};

/**
 * Validate that a status transition is allowed.
 * Throws if the transition is invalid.
 */
function validateTransition(
  currentStatus: LoopStatus,
  newStatus: LoopStatus
): void {
  const allowed = VALID_TRANSITIONS[currentStatus];
  if (!allowed?.has(newStatus)) {
    throw new Error(
      `Invalid status transition: ${currentStatus} → ${newStatus}`
    );
  }
}

/**
 * Transform a Prisma loop record to the API Loop type.
 * Handles Decimal → number conversion for estimatedCost.
 */
function toLoop(record: Record<string, unknown>): Loop {
  return {
    ...record,
    estimatedCost:
      record.estimatedCost !== null && record.estimatedCost !== undefined
        ? Number(record.estimatedCost)
        : null,
  } as Loop;
}

/**
 * Transform a Prisma loop record with user to the API LoopWithUser type.
 */
function toLoopWithUser(record: Record<string, unknown>): LoopWithUser {
  return {
    ...toLoop(record),
    user: (record as { user: LoopWithUser["user"] }).user,
  } as LoopWithUser;
}

/**
 * Loops service - handles database operations for loop management.
 * Loops represent AI execution sessions (plan, execute, chat, etc.).
 */
export const loopsService = {
  /**
   * Create a new Loop.
   */
  async create(
    organizationId: string,
    userId: string,
    input: CreateLoopRequest
  ): Promise<CreateLoopResponse> {
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

    return toLoop(loop as unknown as Record<string, unknown>);
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
      toLoopWithUser(l as unknown as Record<string, unknown>)
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
      estimatedCost: number;
      error: { code: string; message: string };
      s3StateKey: string;
    }>
  ): Promise<Loop> {
    // Fetch current loop to validate transition
    const current = await withDb((db) =>
      db.loop.findUnique({
        where: { id, organizationId },
      })
    );

    if (!current) {
      throw new Error(`Loop not found: ${id}`);
    }

    validateTransition(current.status as LoopStatus, status);

    const loop = await withDb((db) =>
      db.loop.update({
        where: { id, organizationId },
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

    log.info("Loop status updated", {
      loopId: id,
      from: current.status,
      to: status,
    });

    return toLoop(loop as unknown as Record<string, unknown>);
  },

  /**
   * Cancel a running Loop.
   * Can cancel from PENDING or RUNNING states.
   */
  async cancel(id: string, organizationId: string): Promise<Loop> {
    const current = await withDb((db) =>
      db.loop.findUnique({
        where: { id, organizationId },
      })
    );

    if (!current) {
      throw new Error(`Loop not found: ${id}`);
    }

    validateTransition(current.status as LoopStatus, "CANCELLED");

    const loop = await withDb((db) =>
      db.loop.update({
        where: { id, organizationId },
        data: {
          status: "CANCELLED",
          completedAt: new Date(),
        },
      })
    );

    log.info("Loop cancelled", { loopId: id, previousStatus: current.status });

    return toLoop(loop as unknown as Record<string, unknown>);
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
    event: { type: string; data: Record<string, unknown> }
  ): Promise<void> {
    await withDb((db) =>
      db.loopEvent.create({
        data: {
          loopId,
          type: event.type,
          data: event.data as JsonObject,
        },
      })
    );
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
   * Get usage summary with filters.
   * Aggregates token usage and cost across loops for reporting.
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

    const aggregate = await withDb((db) =>
      db.loop.aggregate({
        where: {
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
        },
        _count: true,
        _sum: {
          tokensInput: true,
          tokensOutput: true,
          estimatedCost: true,
        },
      })
    );

    return {
      totalLoops: aggregate._count,
      totalTokensInput: aggregate._sum.tokensInput ?? 0,
      totalTokensOutput: aggregate._sum.tokensOutput ?? 0,
      totalEstimatedCost: Number(aggregate._sum.estimatedCost ?? 0),
    };
  },
};
