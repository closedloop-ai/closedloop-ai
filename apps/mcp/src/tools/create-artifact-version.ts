import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import { encodePathSegment, withErrorHandling } from "./tool-utils.js";

export function registerCreateArtifactVersion(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.tool(
    "create-artifact-version",
    "Create a new version of an artifact. The previous version is preserved in history.",
    {
      artifactId: z
        .string()
        .describe("ID of the artifact to create a new version for"),
      content: z.string().describe("Content for the new version"),
    },
    ({ artifactId, content }) =>
      withErrorHandling(async () => {
        const result = await apiClient.post<unknown>(
          `/artifacts/${encodePathSegment(artifactId)}/versions`,
          { content }
        );
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      })
  );
}
