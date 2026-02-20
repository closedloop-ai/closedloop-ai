import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import { withErrorHandling } from "./tool-utils.js";

export function registerListLoops(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.tool(
    "list-loops",
    "List execution loops with optional filters by artifact or status",
    {
      artifactId: z.string().optional().describe("Filter by artifact ID"),
      status: z.string().optional().describe("Filter by loop status"),
    },
    ({ artifactId, status }) =>
      withErrorHandling(async () => {
        const query: Record<string, string> = {};
        if (artifactId !== undefined) {
          query.artifactId = artifactId;
        }
        if (status !== undefined) {
          query.status = status;
        }

        const loops = await apiClient.get<unknown[]>("/loops", query);
        const text =
          loops.length === 0
            ? "No loops found."
            : JSON.stringify(loops, null, 2);
        return {
          content: [{ type: "text" as const, text }],
        };
      })
  );
}
