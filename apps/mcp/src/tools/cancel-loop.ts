import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import { encodePathSegment, withErrorHandling } from "./tool-utils.js";

/**
 * Register the cancel-loop tool on the given MCP server.
 * Cancels a running manual loop via DELETE /loops/[id].
 */
export function registerCancelLoop(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.registerTool(
    "cancel-loop",
    {
      description:
        "Cancel a running manual loop. Use when the work is being abandoned without failure — " +
        "for example, if the approach changed or the feature was deprioritized.",
      inputSchema: {
        loopId: z.string().describe("Loop UUID returned by create-loop"),
      },
    },
    ({ loopId }) =>
      withErrorHandling(async () => {
        const result = await apiClient.delete<unknown>(
          `/loops/${encodePathSegment(loopId)}`
        );
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      })
  );
}
