import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Priority } from "@repo/api/src/types/common.js";
import { WORKSTREAM_TYPE_OPTIONS } from "@repo/api/src/types/workstream";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import {
  describeIdOrSlug,
  WORKSTREAM_HELP,
  withErrorHandling,
} from "./tool-utils.js";

export function registerCreateWorkstream(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.registerTool(
    "create-workstream",
    {
      description:
        "Create a workstream, an initiative or track of work within a project.",
      inputSchema: {
        title: z.string().describe("Title of the workstream"),
        projectId: z.string().describe(describeIdOrSlug("Project", "PROJ-7")),
        description: z
          .string()
          .optional()
          .describe("Description of the workstream"),
        type: z
          .enum(WORKSTREAM_TYPE_OPTIONS)
          .optional()
          .describe(`${WORKSTREAM_HELP} Choose the workstream type.`),
        priority: z
          .enum(Priority)
          .optional()
          .describe("Priority level of the workstream"),
        hasUIChanges: z
          .boolean()
          .optional()
          .describe("Whether the workstream includes UI changes"),
      },
    },
    ({ title, projectId, description, type, priority, hasUIChanges }) =>
      withErrorHandling(async () => {
        const body: Record<string, unknown> = { title, projectId };
        if (description !== undefined) {
          body.description = description;
        }
        if (type !== undefined) {
          body.type = type;
        }
        if (priority !== undefined) {
          body.priority = priority;
        }
        if (hasUIChanges !== undefined) {
          body.hasUIChanges = hasUIChanges;
        }

        const workstream = await apiClient.post<unknown>("/workstreams", body);
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
