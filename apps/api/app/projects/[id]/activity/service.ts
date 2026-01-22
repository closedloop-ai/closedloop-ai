import type {
  ActivityItem,
  ActivityResponse,
  ActivityType,
} from "@repo/api/src/types/activity";
import { withDb } from "@repo/database";

export type FindActivityOptions = {
  projectId: string;
  page?: number;
  pageSize?: number;
};

/**
 * Activity service - handles database operations for project activity feeds
 */
export const activityService = {
  /**
   * Find activity for a project with pagination
   */
  async findByProject(options: FindActivityOptions): Promise<ActivityResponse> {
    const { projectId, page = 1, pageSize = 20 } = options;
    const skip = (page - 1) * pageSize;

    // Get workstream IDs for this project
    const workstreamIds = await withDb((db) =>
      db.workstream.findMany({
        where: { projectId },
        select: { id: true },
      })
    );

    const workstreamIdList = workstreamIds.map((w) => w.id);

    // Query workstream events
    const [events, total] = await withDb((db) =>
      Promise.all([
        db.workstreamEvent.findMany({
          where: {
            workstreamId: { in: workstreamIdList },
          },
          orderBy: { createdAt: "desc" },
          skip,
          take: pageSize,
        }),
        db.workstreamEvent.count({
          where: {
            workstreamId: { in: workstreamIdList },
          },
        }),
      ])
    );

    // Get user info for actors
    const actorIds = [
      ...new Set(
        events.filter((e) => e.actorId).map((e) => e.actorId as string)
      ),
    ];

    const actors = await withDb((db) =>
      db.user.findMany({
        where: { id: { in: actorIds } },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          avatarUrl: true,
        },
      })
    );

    const actorMap = new Map(
      actors.map((a) => [
        a.id,
        {
          id: a.id,
          name:
            [a.firstName, a.lastName].filter(Boolean).join(" ") || "Unknown",
          avatarUrl: a.avatarUrl || undefined,
        },
      ])
    );

    // Transform events to activity items
    const activities: ActivityItem[] = events.map((event) => {
      const actor = event.actorId ? actorMap.get(event.actorId) : undefined;

      return {
        id: event.id,
        type: event.type as ActivityType,
        actor,
        description: generateDescription(
          event.type,
          event.data as Record<string, unknown>
        ),
        metadata: event.data as Record<string, unknown>,
        timestamp: event.createdAt,
      };
    });

    return {
      activities,
      pagination: {
        page,
        pageSize,
        total,
      },
    };
  },
};

/** Description generators for each event type */
const EVENT_DESCRIPTIONS: Record<
  string,
  (data: Record<string, unknown>) => string
> = {
  STATE_CHANGED: (data) =>
    `Status changed from ${data.fromState || "unknown"} to ${data.toState || "unknown"}`,
  ARTIFACT_CREATED: (data) =>
    `Created ${data.artifactType || "artifact"}: ${data.artifactTitle || "Untitled"}`,
  ARTIFACT_UPDATED: (data) =>
    `Updated ${data.artifactType || "artifact"}: ${data.artifactTitle || "Untitled"}`,
  APPROVAL_REQUESTED: (data) =>
    `Requested approval for ${data.artifactTitle || "artifact"}`,
  APPROVAL_GRANTED: (data) => `Approved ${data.artifactTitle || "artifact"}`,
  APPROVAL_REJECTED: (data) => `Rejected ${data.artifactTitle || "artifact"}`,
  LINEAR_ISSUE_CREATED: (data) =>
    `Created Linear issue: ${data.issueKey || "unknown"}`,
  LINEAR_ISSUE_UPDATED: (data) =>
    `Updated Linear issue: ${data.issueKey || "unknown"}`,
  GITHUB_PR_CREATED: (data) =>
    `Created pull request: ${data.prTitle || "unknown"}`,
  GITHUB_PR_MERGED: (data) =>
    `Merged pull request: ${data.prTitle || "unknown"}`,
  COMMENT_ADDED: () => "Added a comment",
  ASSIGNEE_CHANGED: (data) =>
    `Assignee changed to ${data.assigneeName || "unknown"}`,
  BLOCKED: (data) =>
    `Marked as blocked: ${data.reason || "no reason provided"}`,
  UNBLOCKED: () => "Unblocked",
};

/**
 * Generate a human-readable description for an event
 */
function generateDescription(
  type: string,
  data: Record<string, unknown>
): string {
  const generator = EVENT_DESCRIPTIONS[type];
  return generator ? generator(data) : type.replaceAll("_", " ").toLowerCase();
}
