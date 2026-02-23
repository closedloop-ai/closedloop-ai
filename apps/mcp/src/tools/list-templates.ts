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

export function registerListTemplates(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.tool(
    "list-templates",
    "List available artifact templates for the organization",
    {
      limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_PAGE_LIMIT)
        .optional()
        .describe(
          `Maximum number of templates to return (1-${MAX_PAGE_LIMIT})`
        ),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Starting offset for pagination (default 0)"),
    },
    ({ limit, offset }) =>
      withErrorHandling(async () => {
        const templates = await apiClient.get<unknown[]>("/templates");
        if (templates.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No templates found." }],
          };
        }
        const payload = buildPaginatedPayload(templates, {
          limit,
          offset,
          mapItem: (value) => {
            const row = asRecord(value);
            return {
              id: readString(row.id),
              title: readString(row.title),
              type: readString(row.type),
              templateForType: readString(row.templateForType),
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
