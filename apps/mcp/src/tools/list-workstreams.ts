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

export function registerListWorkstreams(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.tool(
    "list-workstreams",
    "List workstreams (initiatives) for a project with optional filters",
    {
      projectId: z
        .string()
        .describe("ID of the project to list workstreams for"),
      state: z
        .enum([
          "INITIATED",
          "REQUIREMENTS_GENERATING",
          "REQUIREMENTS_PENDING_APPROVAL",
          "DESIGN_IN_PROGRESS",
          "DESIGN_PENDING_APPROVAL",
          "IMPLEMENTATION_PLANNING",
          "IMPLEMENTATION_IN_PROGRESS",
          "IMPLEMENTATION_PENDING_REVIEW",
          "CODE_REVIEW_RUNNING",
          "CODE_REVIEW_PENDING_APPROVAL",
          "VISUAL_QA_RUNNING",
          "VISUAL_QA_PENDING_APPROVAL",
          "MERGING",
          "DEPLOYED",
          "COMPLETED",
          "BLOCKED",
          "CANCELLED",
        ])
        .optional()
        .describe("Filter by workstream state"),
      search: z.string().optional().describe("Search workstreams by title"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_PAGE_LIMIT)
        .optional()
        .describe(
          `Maximum number of workstreams to return (1-${MAX_PAGE_LIMIT})`
        ),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Starting offset for pagination (default 0)"),
    },
    ({ projectId, state, search, limit, offset }) =>
      withErrorHandling(async () => {
        const query: Record<string, string> = { projectId };
        if (state !== undefined) {
          query.state = state;
        }
        if (search !== undefined) {
          query.search = search;
        }

        const workstreams = await apiClient.get<unknown[]>(
          "/workstreams",
          query
        );
        if (workstreams.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No workstreams found." }],
          };
        }
        const payload = buildPaginatedPayload(workstreams, {
          limit,
          offset,
          mapItem: (value) => {
            const row = asRecord(value);
            return {
              id: readString(row.id),
              title: readString(row.title),
              state: readString(row.state),
              projectId: readString(row.projectId),
              ownerId: readString(row.ownerId),
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
