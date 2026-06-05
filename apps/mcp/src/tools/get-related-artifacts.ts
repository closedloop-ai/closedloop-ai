import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import {
  describeIdOrSlug,
  encodePathSegment,
  withErrorHandling,
} from "./tool-utils.js";

export function registerGetRelatedArtifacts(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.registerTool(
    "get-related-artifacts",
    {
      description:
        "List artifact documents linked to an artifact, such as PRD-to-plan relationships.",
      inputSchema: {
        artifactId: z
          .string()
          .describe(describeIdOrSlug("Artifact", ["PRD-7", "PLAN-12"])),
      },
    },
    ({ artifactId }) =>
      withErrorHandling(async () => {
        const related = await apiClient.get<unknown>(
          `/artifacts/${encodePathSegment(artifactId)}/related`
        );
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(related, null, 2),
            },
          ],
        };
      })
  );
}
