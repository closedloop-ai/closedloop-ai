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

/**
 * Register the list-projects tool on the given MCP server.
 * Calls GET /projects and returns a formatted project list.
 */
export function registerListProjects(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.tool(
    "list-projects",
    "List all projects accessible to the authenticated user",
    {
      limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_PAGE_LIMIT)
        .optional()
        .describe(`Maximum number of projects to return (1-${MAX_PAGE_LIMIT})`),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Starting offset for pagination (default 0)"),
    },
    ({ limit, offset }) =>
      withErrorHandling(async () => {
        const projects = await apiClient.get<unknown[]>("/projects");
        const payload = buildPaginatedPayload(projects, {
          limit,
          offset,
          mapItem: (value) => {
            const row = asRecord(value);
            return {
              id: readString(row.id),
              name: readString(row.name),
              slug: readString(row.slug),
              status: readString(row.status),
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
