import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import { EXTERNAL_LINK_TYPE_VALUES } from "../tool-enums.js";
import {
  asRecord,
  buildPaginatedPayload,
  MAX_PAGE_LIMIT,
  readString,
  withErrorHandling,
} from "./tool-utils.js";

export function registerListExternalLinks(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.tool(
    "list-external-links",
    "List external links filtered by workstream or project",
    {
      workstreamId: z
        .string()
        .optional()
        .describe("ID of the workstream to list links for"),
      projectId: z
        .string()
        .optional()
        .describe("ID of the project to list links for"),
      type: z
        .enum(EXTERNAL_LINK_TYPE_VALUES)
        .optional()
        .describe("Filter by external link type"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_PAGE_LIMIT)
        .optional()
        .describe(
          `Maximum number of external links to return (1-${MAX_PAGE_LIMIT})`
        ),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Starting offset for pagination (default 0)"),
    },
    ({ workstreamId, projectId, type, limit, offset }) =>
      withErrorHandling(async () => {
        if (!(workstreamId || projectId)) {
          throw new Error("Either workstreamId or projectId is required");
        }
        const query: Record<string, string> = {};
        if (workstreamId !== undefined) {
          query.workstreamId = workstreamId;
        }
        if (projectId !== undefined) {
          query.projectId = projectId;
        }
        if (type !== undefined) {
          query.type = type;
        }

        const links = await apiClient.get<unknown[]>("/external-links", query);
        const payload = buildPaginatedPayload(links, {
          limit,
          offset,
          mapItem: (value) => {
            const row = asRecord(value);
            return {
              id: readString(row.id),
              type: readString(row.type),
              url: readString(row.url),
              title: readString(row.title),
              projectId: readString(row.projectId),
              workstreamId: readString(row.workstreamId),
              createdAt: readString(row.createdAt),
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
