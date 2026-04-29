import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import { encodePathSegment, withErrorHandling } from "./tool-utils.js";

/**
 * Register the add-loop-event tool on the given MCP server.
 * Posts a progress/output event to a running manual loop.
 */
export function registerAddLoopEvent(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.registerTool(
    "add-loop-event",
    {
      description:
        "Post a progress update to a running manual loop. The message appears as a log entry " +
        "in the ClosedLoop platform UI, giving your team real-time visibility into what you're working on.\n\n" +
        "Call periodically during implementation — when starting a new task, completing a milestone, " +
        "running tests, or encountering a blocker. Keep messages concise and informative.",
      inputSchema: {
        loopId: z.string().describe("Loop UUID returned by create-loop"),
        message: z
          .string()
          .describe(
            "Human-readable status message (e.g. 'Implementing API routes for manual loop events')"
          ),
      },
    },
    ({ loopId, message }) =>
      withErrorHandling(async () => {
        const result = await apiClient.post<unknown>(
          `/loops/${encodePathSegment(loopId)}/manual-events`,
          {
            type: "output",
            data: {
              message,
              timestamp: new Date().toISOString(),
            },
          }
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
