import type { ApiResult } from "@repo/api/src/types/common";
import { auth } from "@repo/auth/server";
import { withDb } from "@repo/database";
import type { NextResponse } from "next/server";
import {
  errorResponse,
  forbiddenResponse,
  type IdRouteParams,
  notFoundResponse,
  successResponse,
  unauthorizedResponse,
} from "@/lib/route-utils";
import { usersService } from "../../../users/service";
import { projectsService } from "../../service";

export type ActivityType =
  | "ARTIFACT_CREATED"
  | "ARTIFACT_UPDATED"
  | "STATE_CHANGED"
  | "APPROVAL_REQUESTED"
  | "APPROVAL_GRANTED"
  | "APPROVAL_REJECTED"
  | "PROJECT_CREATED"
  | "PROJECT_UPDATED";

export type ActivityItem = {
  id: string;
  type: ActivityType;
  actor?: {
    id: string;
    name: string;
    avatarUrl?: string;
  };
  description: string;
  metadata?: Record<string, unknown>;
  timestamp: Date;
};

export type ActivityResponse = {
  activities: ActivityItem[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
  };
};

/**
 * GET /projects/:id/activity - Get project activity feed
 * Query params:
 *   - page: Page number (default: 1)
 *   - pageSize: Items per page (default: 20, max: 100)
 */
export async function GET(
  request: Request,
  { params }: IdRouteParams
): Promise<NextResponse<ApiResult<ActivityResponse>>> {
  try {
    const { userId } = await auth();
    if (!userId) {
      return unauthorizedResponse();
    }

    const user = await usersService.findByClerkId(userId);
    if (!user) {
      return unauthorizedResponse();
    }

    const { id: projectId } = await params;
    const project = await projectsService.findById(projectId);

    if (!project) {
      return notFoundResponse("Project");
    }

    // Check access - user must be in same org
    if (project.organizationId !== user.organizationId) {
      return forbiddenResponse();
    }

    // Parse pagination params
    const url = new URL(request.url);
    const page = Math.max(
      1,
      Number.parseInt(url.searchParams.get("page") || "1", 10)
    );
    const pageSize = Math.min(
      100,
      Math.max(1, Number.parseInt(url.searchParams.get("pageSize") || "20", 10))
    );
    const skip = (page - 1) * pageSize;

    // Get workstream events for this project
    const workstreamIds = await withDb((db) =>
      db.workstream.findMany({
        where: { projectId },
        select: { id: true },
      })
    );

    const workstreamIdList = workstreamIds.map((w) => w.id);

    // Query workstream events
    const [events, totalEvents] = await withDb((db) =>
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
        events
          .filter((e: { actorId: string | null }) => e.actorId)
          .map((e: { actorId: string | null }) => e.actorId as string)
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

    const response: ActivityResponse = {
      activities,
      pagination: {
        page,
        pageSize,
        total: totalEvents,
      },
    };

    return successResponse(response);
  } catch (error) {
    return errorResponse("Failed to fetch project activity", error);
  }
}

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
  return generator ? generator(data) : type.replace(/_/g, " ").toLowerCase();
}
