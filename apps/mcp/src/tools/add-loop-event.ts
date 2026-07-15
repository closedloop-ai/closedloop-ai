import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { LoopEventReceivedResponse } from "@repo/api/src/types/loop.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import {
  buildLoopUrl,
  encodePathSegment,
  withErrorHandling,
} from "./tool-utils.js";

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
        // The /manual-events endpoint responds with the shared
        // LoopEventReceivedResponse contract ({ received: true; ignored?: true });
        // type the ApiClient response to it instead of unknown + asRecord.
        const result = await apiClient.post<LoopEventReceivedResponse>(
          `/loops/${encodePathSegment(loopId)}/manual-events`,
          {
            type: "output",
            data: {
              chunk: message,
              timestamp: new Date().toISOString(),
            },
          }
        );
        // Normalize to the shared loop-tool contract ({...response, webUrl}) so
        // callers don't have to special-case this one tool. The receipt response
        // carries no loopId, so surface it too. Narrow at the boundary in case a
        // proxy hands back a non-object body.
        const receipt: Partial<LoopEventReceivedResponse> =
          result && typeof result === "object" ? result : {};
        const webUrl = buildLoopUrl(loopId);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ loopId, ...receipt, webUrl }, null, 2),
            },
          ],
        };
      })
  );
}
