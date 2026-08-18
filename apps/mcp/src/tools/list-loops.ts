import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { LoopCommand, LoopStatus } from "@repo/api/src/types/loop.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import {
  asRecord,
  buildPaginatedPayload,
  buildQuery,
  describeIdOrSlug,
  MAX_PAGE_LIMIT,
  type McpUrlBuilder,
  readString,
  withErrorHandling,
} from "./tool-utils.js";

export function registerListLoops(
  server: McpServer,
  apiClient: ApiClient,
  urls: McpUrlBuilder
): void {
  server.registerTool(
    "list-loops",
    {
      description:
        "List automation runs (loops) with optional filters by document, status, project, or command. The documentId filter accepts a document slug (PRD-*, PLN-*, FEA-*) verbatim, and the projectId filter accepts a project slug (PRO-*) verbatim.",
      inputSchema: {
        documentId: z
          .string()
          .optional()
          .describe(
            describeIdOrSlug("Document", ["PRD-7", "PLN-12", "FEA-42"])
          ),
        status: z.enum(LoopStatus).optional().describe("Filter by loop status"),
        command: z
          .enum(LoopCommand)
          .optional()
          .describe("Filter by loop command type"),
        projectId: z
          .string()
          .optional()
          .describe(describeIdOrSlug("Project", "PRO-7")),
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
    ({ documentId, status, command, projectId, limit, offset }) =>
      withErrorHandling(async () => {
        const query = buildQuery({ documentId, status, command, projectId });

        const loops = await apiClient.get<unknown[]>("/loops", query);
        const payload = buildPaginatedPayload(loops, {
          limit,
          offset,
          mapItem: (value) => {
            const row = asRecord(value);
            const id = readString(row.id);
            return {
              id,
              status: readString(row.status),
              command: readString(row.command),
              documentId: readString(row.documentId),
              createdAt: readString(row.createdAt),
              startedAt: readString(row.startedAt),
              completedAt: readString(row.completedAt),
              webUrl: id ? urls.buildLoopUrl(id) : null,
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
