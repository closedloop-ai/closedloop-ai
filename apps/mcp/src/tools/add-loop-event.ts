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
        "in the Closedloop platform UI, giving your team real-time visibility into what you're working on.\n\n" +
        "Send events at meaningful milestones — not just start and end. Good milestones include:\n" +
        '- "Reading FEA-1035 spec and investigating codebase" (investigation start)\n' +
        '- "Implementation complete, 2 files changed. Running tests." (implementation done)\n' +
        '- "All 23 tests pass, lint clean. Running code review." (verification)\n' +
        '- "PR created: https://github.com/org/repo/pull/123" (PR)\n' +
        '- "Blocked: dependency X needs upgrade first" (blocker)\n\n' +
        "Keep messages concise and factual. Include counts, file names, or PR URLs where relevant. " +
        "The team reads these to understand progress without interrupting you.",
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
              chunk: message,
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
