import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import { encodePathSegment, withErrorHandling } from "./tool-utils.js";

export function registerUpdateArtifact(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.tool(
    "update-artifact",
    "Update an existing artifact's title, content, or status",
    {
      artifactId: z.string().describe("ID of the artifact to update"),
      title: z.string().optional().describe("New title for the artifact"),
      content: z.string().optional().describe("New content for the artifact"),
      status: z
        .enum(["DRAFT", "REVIEW", "APPROVED", "ARCHIVED"])
        .optional()
        .describe("New status for the artifact"),
    },
    ({ artifactId, title, content, status }) =>
      withErrorHandling(async () => {
        const body: Record<string, unknown> = {};
        if (title !== undefined) {
          body.title = title;
        }
        if (content !== undefined) {
          body.content = content;
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
