import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import { encodePathSegment, withErrorHandling } from "./tool-utils.js";

export function registerGetProject(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.tool(
    "get-project",
    "Get a project's detail with recent workstreams",
    {
      projectId: z.string().describe("ID of the project to retrieve"),
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
