import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ArtifactStatus } from "@repo/api/src/types/artifact.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import {
  describeIdOrSlug,
  encodePathSegment,
  withErrorHandling,
} from "./tool-utils.js";

export function registerUpdateArtifact(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.registerTool(
    "update-artifact",
    {
      description:
        "Update an artifact document's title or status by ID or slug. Use create-artifact-version for content edits.",
      inputSchema: {
        artifactId: z
          .string()
          .describe(describeIdOrSlug("Artifact", ["PRD-7", "PLAN-12"])),
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
