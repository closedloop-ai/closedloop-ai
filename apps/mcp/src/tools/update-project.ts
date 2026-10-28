import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Priority } from "@repo/api/src/types/common.js";
import {
  MAX_PROJECT_TEAMS,
  ProjectStatus,
} from "@repo/api/src/types/project.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import {
  encodePathSegment,
  requiredIdOrSlug,
  withErrorHandling,
} from "./tool-utils.js";

export function registerUpdateProject(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.registerTool(
    "update-project",
    {
      description:
        "Update a project's metadata, status, or owning teams by UUID or slug (PRO-*). Pass the user's slug verbatim. Setting teamIds is how a project that belongs to no team — created before a team was required, so it has no URL in the web app and is invisible to humans — is made reachable again; call list-teams for the valid ids, or — on a write-only grant, which is not offered that read-scoped tool — send any id that does not resolve and the 400 names this organization's teams to retry with.",
      inputSchema: {
        projectId: requiredIdOrSlug(
          "Project",
          "PRO-7",
          "Use list-projects to find one."
        ),
        name: z.string().optional().describe("New name for the project"),
        teamIds: z
          .array(
            z.uuid({
              error:
                "A team UUID is required (from list-teams; teams are identified by UUID only and have no slug form).",
            })
          )
          .min(1, "At least one team is required")
          .max(MAX_PROJECT_TEAMS)
          .optional()
          .describe(
            "UUIDs of the teams that should own this project, from list-teams. REPLACES the project's current teams rather than adding to them, so pass every team the project should belong to, not just the new one. Omit to leave them untouched; the server rejects an empty array."
          ),
        description: z
          .string()
          .optional()
          .describe("New description for the project"),
        priority: z
          .enum(Priority)
          .nullable()
          .optional()
          .describe(
            "New priority level for the project. Pass null to clear it."
          ),
        status: z
          .enum(ProjectStatus)
          .optional()
          .describe("New status for the project"),
      },
    },
    ({ projectId, name, teamIds, description, priority, status }) =>
      withErrorHandling(async () => {
        const body: Record<string, unknown> = {};
        if (name !== undefined) {
          body.name = name;
        }
        // Forwarded as the caller's whole set, never a single id wrapped in an
        // array: `projectsService.update` deletes every ProjectTeam row and
        // recreates only what it is given, so a one-id shape would silently drop
        // a multi-team project's other teams — turning ISS-6559's invisible
        // project into a wrong one.
        //
        // Omission is preserved rather than sent as null: the API treats an
        // absent teamIds ("leave the teams alone") and a present one ("replace
        // them") differently, and it rejects an empty array outright, so old and
        // new server versions must both read this the same way.
        if (teamIds !== undefined) {
          body.teamIds = teamIds;
        }
        if (description !== undefined) {
          body.description = description;
        }
        // `!== undefined` rather than a truthiness check: ISS-9441 made an
        // explicit `null` the clear, and omission still means "leave it alone",
        // so the two must not collapse into one body.
        if (priority !== undefined) {
          body.priority = priority;
        }
        if (status !== undefined) {
          body.status = status;
        }

        const project = await apiClient.put<unknown>(
          `/projects/${encodePathSegment(projectId)}`,
          body
        );
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
