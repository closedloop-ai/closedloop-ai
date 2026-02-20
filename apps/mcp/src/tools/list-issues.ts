import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import { withErrorHandling } from "./tool-utils.js";

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
    },
    ({ projectId, status, assigneeId, workstreamId }) =>
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
        const text =
          issues.length === 0
            ? "No issues found."
            : JSON.stringify(issues, null, 2);
        return {
          content: [{ type: "text" as const, text }],
        };
      })
  );
}
