import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import { withErrorHandling } from "./tool-utils.js";

export function registerCreateProject(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.tool(
    "create-project",
    "Create a new project",
    {
      name: z.string().describe("Name of the project"),
      description: z.string().optional().describe("Description of the project"),
      priority: z
        .enum(["NOT_SET", "LOW", "MEDIUM", "HIGH"])
        .optional()
        .describe("Priority level of the project"),
    },
    ({ name, description, priority }) =>
      withErrorHandling(async () => {
        const body: Record<string, unknown> = { name };
        if (description !== undefined) {
          body.description = description;
        }
        if (priority !== undefined) {
          body.priority = priority;
        }

        const project = await apiClient.post<unknown>("/projects", body);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(project, null, 2),
            },
          ],
        };
      })
  );
}
