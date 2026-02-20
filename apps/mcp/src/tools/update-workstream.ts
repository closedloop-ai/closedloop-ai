import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import { encodePathSegment, withErrorHandling } from "./tool-utils.js";

export function registerUpdateWorkstream(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.tool(
    "update-workstream",
    "Update an existing workstream's title, description, state, or UI changes flag",
    {
      workstreamId: z.string().describe("ID of the workstream to update"),
      title: z.string().optional().describe("New title for the workstream"),
      description: z
        .string()
        .optional()
        .describe("New description for the workstream"),
      state: z
        .enum([
          "INITIATED",
          "REQUIREMENTS_GENERATING",
          "REQUIREMENTS_PENDING_APPROVAL",
          "DESIGN_IN_PROGRESS",
          "DESIGN_PENDING_APPROVAL",
          "IMPLEMENTATION_PLANNING",
          "IMPLEMENTATION_IN_PROGRESS",
          "IMPLEMENTATION_PENDING_REVIEW",
          "CODE_REVIEW_RUNNING",
          "CODE_REVIEW_PENDING_APPROVAL",
          "VISUAL_QA_RUNNING",
          "VISUAL_QA_PENDING_APPROVAL",
          "MERGING",
          "DEPLOYED",
          "COMPLETED",
          "BLOCKED",
          "CANCELLED",
        ])
        .optional()
        .describe("New state for the workstream"),
      hasUIChanges: z
        .boolean()
        .optional()
        .describe("Whether the workstream includes UI changes"),
    },
    ({ workstreamId, title, description, state, hasUIChanges }) =>
      withErrorHandling(async () => {
        const body: Record<string, unknown> = {};
        if (title !== undefined) {
          body.title = title;
        }
        if (description !== undefined) {
          body.description = description;
        }
        if (state !== undefined) {
          body.state = state;
        }
        if (hasUIChanges !== undefined) {
          body.hasUIChanges = hasUIChanges;
        }

        const workstream = await apiClient.put<unknown>(
          `/workstreams/${encodePathSegment(workstreamId)}`,
          body
        );
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(workstream, null, 2),
            },
          ],
        };
      })
  );
}
