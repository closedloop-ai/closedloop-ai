import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import { encodePathSegment, withErrorHandling } from "./tool-utils.js";

export function registerListArtifactVersions(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.tool(
    "list-artifact-versions",
    "List all versions of an artifact with version numbers and timestamps",
    {
      artifactId: z
        .string()
        .describe("ID of the artifact to list versions for"),
    },
    ({ artifactId }) =>
      withErrorHandling(async () => {
        const response = await apiClient.get<unknown>(
          `/artifacts/${encodePathSegment(artifactId)}/versions`
        );
        if (!Array.isArray(response)) {
          throw new Error("Unexpected response format for artifact versions");
        }
        const versions = response;
        const text =
          versions.length === 0
            ? "No versions found."
            : JSON.stringify(versions, null, 2);
        return {
          content: [{ type: "text" as const, text }],
        };
      })
  );
}
