import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import {
  asRecord,
  buildLoopUrl,
  encodePathSegment,
  withErrorHandling,
} from "./tool-utils.js";

/**
 * Register the fail-loop tool on the given MCP server.
 * Marks a manual loop as FAILED with an error message.
 */
export function registerFailLoop(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.registerTool(
    "fail-loop",
    {
      description:
        "Mark a manual loop as FAILED. Call if implementation fails or you're abandoning the work.\n\n" +
        "Provide a clear error message explaining why the work failed so your team has context.\n\n" +
        "After failing a loop, update the linked document's status via update-document so it's clear the work hasn't been completed — for a Feature: BLOCKED if it's stuck on something, CANCELED if the work is being abandoned; for a Document (PRD/Plan): DRAFT.",
      inputSchema: {
        loopId: z.string().describe("Loop UUID returned by create-loop"),
        errorMessage: z
          .string()
          .describe(
            "Human-readable explanation of why the work failed (e.g. 'Build errors in dependency package, blocked on upstream fix')"
          ),
      },
    },
    ({ loopId, errorMessage }) =>
      withErrorHandling(async () => {
        const result = await apiClient.post<unknown>(
          `/loops/${encodePathSegment(loopId)}/manual-events`,
          {
            type: "error",
            data: {
              code: "MANUAL_FAILURE",
              message: errorMessage,
              timestamp: new Date().toISOString(),
            },
          }
        );
        const record = asRecord(result);
        const webUrl = buildLoopUrl(loopId);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ ...record, webUrl }, null, 2),
            },
          ],
        };
      })
  );
}
