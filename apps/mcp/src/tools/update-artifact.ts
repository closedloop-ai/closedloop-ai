import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ArtifactStatus } from "@repo/api/src/types/artifact.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import { encodePathSegment, withErrorHandling } from "./tool-utils.js";

export function registerUpdateArtifact(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.registerTool(
    "update-artifact",
    {
      description:
        "Update an existing artifact's metadata or status. For content changes, use create-artifact-version.",
      inputSchema: {
        artifactId: z.string().describe("ID of the artifact to update"),
        title: z.string().optional().describe("New title for the artifact"),
        status: z
          .enum(ArtifactStatus)
          .optional()
          .describe("New status for the artifact"),
      },
    },
    ({ artifactId, title, status }) =>
      withErrorHandling(async () => {
        const body: Record<string, unknown> = {};
        if (title !== undefined) {
          body.title = title;
        }
        if (status !== undefined) {
          body.status = status;
        }

        const artifact = await apiClient.put<unknown>(
          `/artifacts/${encodePathSegment(artifactId)}`,
          body
        );
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(artifact, null, 2),
            },
          ],
        };
      })
  );
}
