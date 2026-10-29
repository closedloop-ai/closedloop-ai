import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Priority } from "@repo/api/src/types/common";
import { ProjectStatus } from "@repo/api/src/types/project.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import { withErrorHandling } from "./tool-utils.js";

export function registerCreateProject(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.registerTool(
    "create-project",
    {
      description:
        "Create a project — the top-level container for documents. A project MUST belong to a team: pass teamId, or the call fails with a 400 that lists the teams in this organization so you can retry with one of them. Call list-teams for the complete set, which is also what to use when that 400 says teams were omitted for length. A project with no team has no URL in the web app and is invisible to humans. The assigned slug (PRO-*) is returned in the response and is the preferred handle for future calls.",
      inputSchema: {
        name: z.string().describe("Name of the project"),
        teamId: z
          .uuid()
          .optional()
          .describe(
            "UUID of the team that will own this project, from list-teams. Required in practice — omitting it returns a 400 naming the valid teams for this organization."
          ),
        description: z
          .string()
          .optional()
          .describe("Description of the project"),
        priority: z
          .enum(Priority)
          .optional()
          .describe(
            "Priority level of the project. Omit to create the project with no priority (ISS-9441); an explicit null is not accepted here."
          ),
        status: z
          .enum(ProjectStatus)
          .optional()
          .describe("Initial status for the project"),
      },
    },
    ({ name, teamId, description, priority, status }) =>
      withErrorHandling(async () => {
        const body: Record<string, unknown> = { name };
        // Omission is preserved rather than sent as null: the API treats an
        // absent teamIds and an empty one differently, and old/new server
        // versions must both read this the same way.
        if (teamId !== undefined) {
          body.teamIds = [teamId];
        }
        if (description !== undefined) {
          body.description = description;
        }
        if (priority !== undefined) {
          body.priority = priority;
        }
        if (status !== undefined) {
          body.status = status;
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
