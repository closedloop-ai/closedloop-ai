import type { DocumentType } from "@repo/api/src/types/document";
import { LoopStatus } from "@repo/api/src/types/loop";
import type {
  ContributionDay,
  CreateUserInput,
  DocumentsByType,
  UpdateUserInput,
  UpdateUserProfileFromClerkInput,
  UserProfileStats,
} from "@repo/api/src/types/user";
import { ArtifactType, GitHubPRState, withDb } from "@repo/database";
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
        loopConcurrencyData,
        loopTokenAggregate,
      ] = await Promise.all([
        // Total document artifacts created
        withDb((db) =>
          db.artifact.count({
            where: {
              createdById: userId,
              organizationId,
              type: ArtifactType.DOCUMENT,
            },
          })
        ),
        // Document artifacts grouped by subtype (legacy DocumentType)
        withDb((db) =>
          db.artifact.groupBy({
            by: ["subtype"],
            where: {
              createdById: userId,
              organizationId,
              type: ArtifactType.DOCUMENT,
            },
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
        // Merged PRs — PR artifacts on workstreams assigned to the user
        withDb((db) =>
          db.artifact.count({
            where: {
              organizationId,
              type: ArtifactType.PULL_REQUEST,
              pullRequest: { prState: GitHubPRState.MERGED },
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
        // Contribution heatmap: document artifact creations over last year
        withDb((db) =>
          db.artifact.findMany({
            where: {
              createdById: userId,
              organizationId,
              type: ArtifactType.DOCUMENT,
              createdAt: { gte: oneYearAgo },
            },
            select: { createdAt: true },
          })
        ),
        // Loop concurrency: loops with timing data
        withDb((db) =>
          db.loop.findMany({
            where: {
              userId,
              organizationId,
              startedAt: { not: null },
            },
            select: { startedAt: true, completedAt: true, status: true },
          })
        ),
        // Loop token/cost totals
        withDb((db) =>
          db.loop.aggregate({
            where: { userId, organizationId },
            _sum: {
              tokensInput: true,
              tokensOutput: true,
              estimatedCost: true,
            },
          })
        ),
      ]);

      const artifactsByType: DocumentsByType[] = artifactsByTypeRaw.flatMap(
        (row) => {
          if (row.subtype === null) {
            return [];
          }
          return [{ type: row.subtype as DocumentType, count: row._count.id }];
        }
      );

      const contributionHeatmap = buildContributionHeatmap(contributionData);
      const avgConcurrency = computeAvgLoopConcurrency(loopConcurrencyData);

      return {
        totalDocuments: totalArtifacts,
        documentsByType: artifactsByType,
        totalComments,
        totalPRsLanded,
        totalLoops,
        totalWorkstreams,
        avgConcurrency,
        contributionHeatmap,
        totalTokensInput: loopTokenAggregate._sum.tokensInput ?? 0,
        totalTokensOutput: loopTokenAggregate._sum.tokensOutput ?? 0,
        totalEstimatedCost: Number(loopTokenAggregate._sum.estimatedCost ?? 0),
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
 * Compute average loop concurrency: when this user has a loop running,
 * how many loops are they running simultaneously on average?
 *
 * For each loop's start time, counts how many other loops overlapped,
 * then averages those counts.
 */
const TERMINAL_LOOP_STATUSES = new Set<string>([
  LoopStatus.Completed,
  LoopStatus.Failed,
  LoopStatus.Cancelled,
  LoopStatus.TimedOut,
]);

function computeAvgLoopConcurrency(
  loops: {
    startedAt: Date | null;
    completedAt: Date | null;
    status: string;
  }[]
): number {
  const now = new Date();

  const intervals = loops
    .filter((l): l is typeof l & { startedAt: Date } => l.startedAt !== null)
    .map((l) => ({
      start: l.startedAt,
      end:
        TERMINAL_LOOP_STATUSES.has(l.status) && l.completedAt
          ? l.completedAt
          : now,
    }));

  if (intervals.length === 0) {
    return 0;
  }

  let totalConcurrent = 0;
  for (const point of intervals) {
    let concurrent = 0;
    for (const interval of intervals) {
      if (interval.start <= point.start && interval.end >= point.start) {
        concurrent++;
      }
    }
    totalConcurrent += concurrent;
  }

  return Math.round((totalConcurrent / intervals.length) * 10) / 10;
}
