import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WORKSTREAM_STATE_OPTIONS } from "@repo/api/src/types/workstream.js";
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
  server.registerTool(
    "list-workstreams",
    {
      description:
        "List workstreams (initiatives) for a project with optional filters",
      inputSchema: {
        projectId: z
          .string()
          .describe("ID of the project to list workstreams for"),
        state: z
          .enum(WORKSTREAM_STATE_OPTIONS)
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
