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
        if (issues.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No issues found." }],
          };
        }
        const payload = buildPaginatedPayload(issues, {
          limit,
          offset,
          mapItem: (value) => {
            const row = asRecord(value);
            return {
              id: readString(row.id),
              title: readString(row.title),
              status: readString(row.status),
              projectId: readString(row.projectId),
              workstreamId: readString(row.workstreamId),
              assigneeId: readString(row.assigneeId),
              updatedAt: readString(row.updatedAt),
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
