import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import { encodePathSegment, withErrorHandling } from "./tool-utils.js";

/**
 * Register the complete-loop tool on the given MCP server.
 * Marks a manual loop as COMPLETED with optional PR URL, branch name, and summary.
 */
export function registerCompleteLoop(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.registerTool(
    "complete-loop",
    {
      description:
        "Mark a manual loop as COMPLETED. Call when you've finished implementing the feature.\n\n" +
        "This sends a completed event and updates the loop with final metadata (PR URL, branch, summary). " +
        "After completing the loop, consider updating the workstream status via update-workstream.",
      inputSchema: {
        loopId: z.string().describe("Loop UUID returned by create-loop"),
        prUrl: z
          .string()
          .optional()
          .describe("URL of the pull request created for this work"),
        branchName: z
          .string()
          .optional()
          .describe("Git branch name used for implementation"),
        summary: z
          .string()
          .optional()
          .describe("Brief summary of what was accomplished"),
        tokensInput: z
          .number()
          .optional()
          .describe(
            "Total input tokens used (best-effort, may not be available)"
          ),
        tokensOutput: z
          .number()
          .optional()
          .describe(
            "Total output tokens used (best-effort, may not be available)"
          ),
      },
    },
    ({ loopId, prUrl, branchName, summary, tokensInput, tokensOutput }) =>
      withErrorHandling(async () => {
        const completedData: Record<string, unknown> = {
          result: { exitCode: 0, summary: summary ?? "Manual loop completed" },
          tokensUsed: {
            input: tokensInput ?? 0,
            output: tokensOutput ?? 0,
          },
          timestamp: new Date().toISOString(),
        };

        await apiClient.post<unknown>(
          `/loops/${encodePathSegment(loopId)}/manual-events`,
          {
            type: "completed",
            data: completedData,
          }
        );

        // Update loop metadata (prUrl, branchName, summary)
        const metadataUpdate: Record<string, unknown> = {};
        if (prUrl !== undefined) {
          metadataUpdate.prUrl = prUrl;
        }
        if (branchName !== undefined) {
          metadataUpdate.branchName = branchName;
        }
        if (summary !== undefined) {
          metadataUpdate.summary = summary;
        }

        if (Object.keys(metadataUpdate).length > 0) {
          await apiClient.patch<unknown>(
            `/loops/${encodePathSegment(loopId)}`,
            metadataUpdate
          );
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { loopId, status: "COMPLETED", prUrl, branchName, summary },
                null,
                2
              ),
            },
          ],
        };
      })
  );
}
