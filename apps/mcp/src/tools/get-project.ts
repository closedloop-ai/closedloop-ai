import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ApiClient } from "../api-client.js";
import {
  encodePathSegment,
  requiredIdOrSlug,
  withErrorHandling,
} from "./tool-utils.js";

export function registerGetProject(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.registerTool(
    "get-project",
    {
      description:
        'Get one project by UUID or slug (PRO-*). When the user references a project by its slug (e.g. "tell me about PRO-7"), pass that slug as projectId directly.',
      inputSchema: {
        projectId: requiredIdOrSlug(
          "Project",
          "PRO-7",
          "Use list-projects to find one."
        ),
      },
    },
    ({ projectId }) =>
      withErrorHandling(async () => {
        const project = await apiClient.get<unknown>(
          `/projects/${encodePathSegment(projectId)}`
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
