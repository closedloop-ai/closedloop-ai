import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import {
  asRecord,
  buildPaginatedPayload,
  MAX_PAGE_LIMIT,
  readString,
  withErrorHandling,
} from "./tool-utils.js";

export function registerListIssues(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.tool(
    "list-issues",
    "List issues with optional filters by project, status, assignee, or workstream",
    {
      projectId: z.string().optional().describe("Filter by project ID"),
      status: z
        .enum(["TODO", "IN_PROGRESS", "IN_REVIEW", "CLOSED"])
        .optional()
        .describe("Filter by issue status"),
      assigneeId: z.string().optional().describe("Filter by assignee user ID"),
      workstreamId: z.string().optional().describe("Filter by workstream ID"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_PAGE_LIMIT)
        .optional()
        .describe(`Maximum number of issues to return (1-${MAX_PAGE_LIMIT})`),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Starting offset for pagination (default 0)"),
    },
    ({ projectId, status, assigneeId, workstreamId, limit, offset }) =>
      withErrorHandling(async () => {
        const query: Record<string, string> = {};
        if (projectId !== undefined) {
          query.projectId = projectId;
        }
        if (status !== undefined) {
          query.status = status;
        }
        if (assigneeId !== undefined) {
          query.assigneeId = assigneeId;
        }
        if (workstreamId !== undefined) {
          query.workstreamId = workstreamId;
        }

        const issues = await apiClient.get<unknown[]>("/issues", query);
        const payload = buildPaginatedPayload(issues, {
          limit,
          offset,
          mapItem: (value) => {
            const row = asRecord(value);
            const assigneeRaw = asRecord(row.assignee);
            const projectRaw = asRecord(row.project);
            const workstreamRaw = asRecord(row.workstream);
            return {
              id: readString(row.id),
              title: readString(row.title),
              slug: readString(row.slug),
              description: readString(row.description),
              status: readString(row.status),
              priority: readString(row.priority),
              projectId: readString(row.projectId),
              workstreamId: readString(row.workstreamId),
              assigneeId: readString(row.assigneeId),
              createdAt: readString(row.createdAt),
              updatedAt: readString(row.updatedAt),
              assignee: row.assignee
                ? {
                    id: readString(assigneeRaw.id),
                    firstName: readString(assigneeRaw.firstName),
                    lastName: readString(assigneeRaw.lastName),
                    avatarUrl: readString(assigneeRaw.avatarUrl),
                  }
                : null,
              project: row.project
                ? { name: readString(projectRaw.name) }
                : null,
              workstream: row.workstream
                ? { title: readString(workstreamRaw.title) }
                : null,
            };
          },
        });
        const text = JSON.stringify(payload, null, 2);
        return {
          content: [{ type: "text" as const, text }],
        };
      })
  );
}
