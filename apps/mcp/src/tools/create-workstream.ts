import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import { withErrorHandling } from "./tool-utils.js";

export function registerCreateWorkstream(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.tool(
    "create-workstream",
    "Create a new workstream (initiative) in a project",
    {
      title: z.string().describe("Title of the workstream"),
      projectId: z
        .string()
        .describe("ID of the project to create the workstream in"),
      description: z
        .string()
        .optional()
        .describe("Description of the workstream"),
      type: z
        .enum(["FEATURE_DELIVERY", "BUG_FIX", "TECH_DEBT", "SPIKE"])
        .optional()
        .describe("Type of the workstream"),
      hasUIChanges: z
        .boolean()
        .optional()
        .describe("Whether the workstream includes UI changes"),
    },
    ({ title, projectId, description, type, hasUIChanges }) =>
      withErrorHandling(async () => {
        const body: Record<string, unknown> = { title, projectId };
        if (description !== undefined) {
          body.description = description;
        }
        if (type !== undefined) {
          body.type = type;
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
