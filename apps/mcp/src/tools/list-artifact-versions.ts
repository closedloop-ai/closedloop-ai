import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import {
  asRecord,
  buildPaginatedPayload,
  encodePathSegment,
  MAX_PAGE_LIMIT,
  readNumber,
  readString,
  withErrorHandling,
} from "./tool-utils.js";

export function registerListArtifactVersions(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.registerTool(
    "list-artifact-versions",
    {
      description:
        "List all versions of an artifact by ID or slug with version numbers and timestamps",
      inputSchema: {
        artifactId: z.string().describe("ID or slug of the artifact"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_PAGE_LIMIT)
          .optional()
          .describe(
            `Maximum number of artifact versions to return (1-${MAX_PAGE_LIMIT})`
          ),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Starting offset for pagination (default 0)"),
      },
    },
    ({ artifactId, limit, offset }) =>
      withErrorHandling(async () => {
        const response = await apiClient.get<{
          success: boolean;
          data: unknown[];
        }>(`/artifacts/${encodePathSegment(artifactId)}/versions`);
        const versions = response.data;
        const payload = buildPaginatedPayload(versions, {
          limit,
          offset,
          mapItem: (value) => {
            const row = asRecord(value);
            const content = readString(row.content);
            return {
              id: readString(row.id),
              version: readNumber(row.version),
              createdAt: readString(row.createdAt),
              createdById: readString(row.createdById),
              contentLength: content?.length ?? null,
            };
          },
        });
        const text = JSON.stringify(payload, null, 2);
        return {
          content: [{ type: "text" as const, text }],
        };
      })
  );
}
