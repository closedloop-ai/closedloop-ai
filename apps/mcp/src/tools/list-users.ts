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

export function registerListUsers(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.registerTool(
    "list-users",
    {
      description:
        "List organization users available for assignment or lookup.",
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_PAGE_LIMIT)
          .optional()
          .describe(`Maximum number of users to return (1-${MAX_PAGE_LIMIT})`),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Starting offset for pagination (default 0)"),
      },
    },
    ({ limit, offset }) =>
      withErrorHandling(async () => {
        const users = await apiClient.get<unknown[]>("/users");
        const payload = buildPaginatedPayload(users, {
          limit,
          offset,
          mapItem: (value) => {
            const row = asRecord(value);
            return {
              id: readString(row.id),
              firstName: readString(row.firstName),
              lastName: readString(row.lastName),
              email: readString(row.email),
              role: readString(row.role),
              updatedAt: readString(row.updatedAt),
            };
          },
        });
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(payload, null, 2) },
          ],
        };
      })
  );
}
