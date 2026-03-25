import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { LoopStatus } from "@repo/api/src/types/loop.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import {
  asRecord,
  buildPaginatedPayload,
  describeIdOrSlug,
  MAX_PAGE_LIMIT,
  readString,
  withErrorHandling,
} from "./tool-utils.js";

export function registerListLoops(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.registerTool(
    "list-loops",
    {
      description:
        "List automation runs, called loops, with optional filters by artifact or status.",
      inputSchema: {
        artifactId: z
          .string()
          .optional()
          .describe(describeIdOrSlug("Artifact", ["PRD-7", "PLAN-12"])),
        status: z.enum(LoopStatus).optional().describe("Filter by loop status"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_PAGE_LIMIT)
          .optional()
          .describe(`Maximum number of loops to return (1-${MAX_PAGE_LIMIT})`),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Starting offset for pagination (default 0)"),
      },
    },
    ({ artifactId, status, limit, offset }) =>
      withErrorHandling(async () => {
        const query: Record<string, string> = {};
        if (artifactId !== undefined) {
          query.artifactId = artifactId;
        }
        if (status !== undefined) {
          query.status = status;
        }

        const loops = await apiClient.get<unknown[]>("/loops", query);
        const payload = buildPaginatedPayload(loops, {
          limit,
          offset,
          mapItem: (value) => {
            const row = asRecord(value);
            return {
              id: readString(row.id),
              status: readString(row.status),
              command: readString(row.command),
              artifactId: readString(row.artifactId),
              workstreamId: readString(row.workstreamId),
              createdAt: readString(row.createdAt),
              startedAt: readString(row.startedAt),
              completedAt: readString(row.completedAt),
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
