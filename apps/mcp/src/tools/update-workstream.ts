import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Priority } from "@repo/api/src/types/common.js";
import { WORKSTREAM_STATE_OPTIONS } from "@repo/api/src/types/workstream.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import { encodePathSegment, withErrorHandling } from "./tool-utils.js";

export function registerUpdateWorkstream(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.registerTool(
    "update-workstream",
    {
      description:
        "Update an existing workstream's title, description, state, or UI changes flag",
      inputSchema: {
        workstreamId: z.string().describe("ID of the workstream to update"),
        title: z.string().optional().describe("New title for the workstream"),
        description: z
          .string()
          .optional()
          .describe("New description for the workstream"),
        state: z
          .enum(WORKSTREAM_STATE_OPTIONS)
          .optional()
          .describe("New state for the workstream"),
        priority: z
          .enum(Priority)
          .optional()
          .describe("New priority level for the workstream"),
        hasUIChanges: z
          .boolean()
          .optional()
          .describe("Whether the workstream includes UI changes"),
      },
    },
    ({ workstreamId, title, description, state, priority, hasUIChanges }) =>
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
        if (priority !== undefined) {
          body.priority = priority;
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
