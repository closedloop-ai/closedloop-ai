import type {
  ArtifactsByType,
  ContributionDay,
  CreateUserInput,
  UpdateUserInput,
  UpdateUserProfileFromClerkInput,
  UserProfileStats,
} from "@repo/api/src/types/user";
import { GitHubPRState, WorkstreamState, withDb } from "@repo/database";
import { log } from "@repo/observability/log";

/**
 * Users service - handles database operations for user management
 */
export const usersService = {
  /**
   * Find all users in an organization
   * @returns Only active users (filters out soft-deleted users)
   */
  findByOrganization(organizationId: string) {
    return withDb((db) =>
      db.user.findMany({
        where: {
          organizationId,
          active: true,
        },
        orderBy: { createdAt: "desc" },
      })
    );
  },

  /**
   * Find a user by ID
   * @returns User regardless of active status (needed for authentication and admin operations)
   * @note Does NOT filter by active status - returns both active and inactive users.
   *       This is intentional to support:
   *       - Current user lookups (/api/me) for logged-in but deactivated users
   *       - Webhook processing that needs to update deactivated users
   *       - Admin operations that need to view/manage inactive users
   *       For user lists visible to end users, use findByOrganization() instead.
   */
  findById(id: string, organizationId: string) {
    return withDb((db) =>
      db.user.findUnique({
        where: { id, organizationId },
      })
    );
  },

  /**
   * Find a user by Clerk ID and organization ID
   * @returns User regardless of active status (needed for authentication flows)
   * @note Does NOT filter by active status - returns both active and inactive users.
   *       This is intentional to support authentication and webhook processing.
   *       Used by withAuth() middleware to authenticate requests from deactivated users.
   */
  findByClerkIdAndOrg(clerkId: string, organizationId: string) {
    return withDb((db) =>
      db.user.findUnique({
        where: {
          clerkId_organizationId: {
            clerkId,
            organizationId,
          },
        },
      })
    );
  },

  /**
   * Create a new user
   */
  create(input: CreateUserInput) {
    return withDb((db) =>
      db.user.create({
        data: {
          clerkId: input.clerkId,
          organizationId: input.organizationId,
          email: input.email,
          firstName: input.firstName,
          lastName: input.lastName,
          avatarUrl: input.avatarUrl,
          phoneNumber: input.phoneNumber,
          role: input.role ?? "ENGINEER",
        },
      })
    );
  },

  /**
   * Create or update a user by Clerk ID and organization (used by webhooks and auth)
   * @note Uses composite unique constraint (clerkId, organizationId) for idempotency
   * @note Reactivates previously deactivated users by setting active: true
   * @note Does NOT update organizationId on existing records (composite key is immutable)
   */
  upsertByClerkIdAndOrg(input: CreateUserInput) {
    const profileFields = {
      email: input.email,
      firstName: input.firstName,
      lastName: input.lastName,
      avatarUrl: input.avatarUrl,
      phoneNumber: input.phoneNumber,
    };

    return withDb((db) =>
      db.user.upsert({
        where: {
          clerkId_organizationId: {
            clerkId: input.clerkId,
            organizationId: input.organizationId,
          },
        },
        create: {
          clerkId: input.clerkId,
          organizationId: input.organizationId,
          ...profileFields,
          role: input.role ?? "ENGINEER",
        },
        update: {
          ...profileFields,
          active: true,
        },
      })
    );
  },

  /**
   * Update an existing user by ID
   */
  update(id: string, input: Omit<UpdateUserInput, "id">) {
    return withDb((db) =>
      db.user.update({
        where: { id },
        data: input,
      })
    );
  },

  /**
   * Update an existing user by Clerk ID (used by webhooks).
   * Uses updateMany to intentionally update ALL org records for this clerkId,
   * keeping profile data (name, avatar, email) consistent across organizations.
   */
  updateByClerkId(clerkId: string, input: UpdateUserProfileFromClerkInput) {
    return withDb((db) =>
      db.user.updateMany({
        where: { clerkId },
        data: input,
      })
    );
  },

  /**
   * Deactivate a user (soft delete)
   */
  deactivate(id: string) {
    return withDb((db) =>
      db.user.update({
        where: { id },
        data: { active: false },
      })
    );
  },

  /**
   * Deactivate a user by Clerk ID and organization (soft delete, org-scoped)
   * @throws Prisma P2025 error if user not found in organization
   * @note Uses composite unique constraint for precise targeting
   * @note Throws if user doesn't exist - caller must handle this case
   */
  deactivateByClerkIdAndOrg(clerkId: string, organizationId: string) {
    return withDb((db) =>
      db.user.update({
        where: {
          clerkId_organizationId: {
            clerkId,
            organizationId,
          },
        },
        data: { active: false },
      })
    );
  },

  /**
   * Deactivate all users across all organizations for a given Clerk ID (soft delete, global)
   * @returns Prisma BatchPayload with count of affected records
   * @note Returns count: 0 if no users found (does not throw)
   * @note Use for Clerk webhooks that affect all user records across orgs
   */
  deactivateAllByClerkId(clerkId: string) {
    return withDb((db) =>
      db.user.updateMany({
        where: { clerkId },
        data: { active: false },
      })
    );
  },

  /**
   * Get aggregate profile statistics for a user.
   * Runs multiple count queries in parallel for performance.
   */
  async getUserStats(
    userId: string,
    organizationId: string
  ): Promise<UserProfileStats> {
    try {
      const oneYearAgo = new Date();
      oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);

      const [
        totalArtifacts,
        artifactsByTypeRaw,
        totalComments,
        totalPRsLanded,
        totalLoops,
        totalWorkstreams,
        contributionData,
        concurrencyData,
      ] = await Promise.all([
        // Total artifacts created
        withDb((db) =>
          db.artifact.count({
            where: { createdById: userId, organizationId },
          })
        ),
        // Artifacts grouped by type
        withDb((db) =>
          db.artifact.groupBy({
            by: ["type"],
            where: { createdById: userId, organizationId },
            _count: { id: true },
          })
        ),
        // Total comments authored (org-scoped via thread)
        withDb((db) =>
          db.comment.count({
            where: {
              authorId: userId,
              thread: { organizationId },
            },
          })
        ),
        // Merged PRs (org-scoped via denormalized organizationId on PR model)
        withDb((db) =>
          db.gitHubPullRequest.count({
            where: {
              organizationId,
              state: GitHubPRState.MERGED,
              workstream: { assigneeId: userId },
            },
          })
        ),
        // Total loops initiated
        withDb((db) =>
          db.loop.count({
            where: { userId, organizationId },
          })
        ),
        // Total workstreams (created or assigned)
        withDb((db) =>
          db.workstream.count({
            where: {
              organizationId,
              OR: [{ createdById: userId }, { assigneeId: userId }],
            },
          })
        ),
        // Contribution heatmap: artifact creations over last year
        withDb((db) =>
          db.artifact.findMany({
            where: {
              createdById: userId,
              organizationId,
              createdAt: { gte: oneYearAgo },
            },
            select: { createdAt: true },
          })
        ),
        // Concurrency: assigned workstreams with their active date ranges
        withDb((db) =>
          db.workstream.findMany({
            where: {
              organizationId,
              assigneeId: userId,
            },
            select: { createdAt: true, updatedAt: true, state: true },
          })
        ),
      ]);

      const artifactsByType: ArtifactsByType[] = artifactsByTypeRaw.map(
        (row) => ({
          type: row.type,
          count: row._count.id,
        })
      );

      const contributionHeatmap = buildContributionHeatmap(contributionData);
      const avgConcurrency = computeAvgConcurrency(concurrencyData);

      return {
        totalArtifacts,
        artifactsByType,
        totalComments,
        totalPRsLanded,
        totalLoops,
        totalWorkstreams,
        avgConcurrency,
        contributionHeatmap,
      };
    } catch (error) {
      log.error("[users-service] Failed to get user stats", {
        error: error instanceof Error ? error.message : String(error),
        userId,
        organizationId,
      });
      throw error;
    }
  },
};

/** Format a Date as YYYY-MM-DD using UTC date parts. */
function toDateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Build a dense 52-week contribution heatmap from artifact creation dates. */
function buildContributionHeatmap(
  data: { createdAt: Date }[]
): ContributionDay[] {
  const countsByDate = new Map<string, number>();
  for (const item of data) {
    const key = toDateKey(item.createdAt);
    countsByDate.set(key, (countsByDate.get(key) ?? 0) + 1);
  }

  const result: ContributionDay[] = [];
  const today = new Date();
  const totalDays = 364; // 52 weeks
  for (let i = totalDays - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = toDateKey(d);
    result.push({ date: key, count: countsByDate.get(key) ?? 0 });
  }
  return result;
}

/**
 * Compute average number of concurrent assigned workstreams.
 * Uses a simplified model: count workstreams whose active period overlaps
 * each week in the last 12 weeks, then average.
 */
const TERMINAL_STATES = new Set<string>([
  WorkstreamState.COMPLETED,
  WorkstreamState.CANCELLED,
]);

function computeAvgConcurrency(
  workstreams: {
    createdAt: Date;
    updatedAt: Date;
    state: WorkstreamState;
  }[]
): number {
  if (workstreams.length === 0) {
    return 0;
  }

  const weeks = 12;
  const now = new Date();
  let totalConcurrent = 0;

  for (let w = 0; w < weeks; w++) {
    const weekStart = new Date(now);
    weekStart.setDate(weekStart.getDate() - (w + 1) * 7);
    const weekEnd = new Date(now);
    weekEnd.setDate(weekEnd.getDate() - w * 7);

    let concurrent = 0;
    for (const ws of workstreams) {
      const started = ws.createdAt;
      // Active workstreams: use updatedAt as a proxy for "still active" period
      const ended = TERMINAL_STATES.has(ws.state) ? ws.updatedAt : now;
      if (started <= weekEnd && ended >= weekStart) {
        concurrent++;
      }
    }
    totalConcurrent += concurrent;
  }

  return Math.round((totalConcurrent / weeks) * 10) / 10;
}
