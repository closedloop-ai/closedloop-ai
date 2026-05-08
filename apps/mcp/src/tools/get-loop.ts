import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import { encodePathSegment, withErrorHandling } from "./tool-utils.js";

export function registerGetLoop(server: McpServer, apiClient: ApiClient): void {
  server.registerTool(
    "get-loop",
    {
      description:
        "Get one automation run (a loop) by UUID. Loops do not have user-facing slugs — pass the UUID returned by list-loops or a prior create call.",
      inputSchema: {
        loopId: z.string().describe("Loop UUID (no slug form available)"),
      },
    },
    ({ loopId }) =>
      withErrorHandling(async () => {
        const loop = await apiClient.get<unknown>(
          `/loops/${encodePathSegment(loopId)}`
        );
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(loop, null, 2),
            },
          ],
        };
      })
  );
}
