import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import {
  describeIdOrSlug,
  encodePathSegment,
  withErrorHandling,
} from "./tool-utils.js";

export function registerCreateArtifactVersion(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.registerTool(
    "create-artifact-version",
    {
      description:
        "Append a new version to an artifact document by ID or slug. Older versions stay in history.",
      inputSchema: {
        artifactId: z
          .string()
          .describe(describeIdOrSlug("Artifact", ["PRD-7", "PLAN-12"])),
        content: z.string().describe("Full content for the new version"),
      },
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
