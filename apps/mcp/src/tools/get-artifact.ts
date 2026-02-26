import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import {
  asRecord,
  encodePathSegment,
  readNumber,
  readString,
  truncateString,
  withErrorHandling,
} from "./tool-utils.js";

const DEFAULT_CONTENT_MAX_CHARS = 4000;
const MAX_CONTENT_MAX_CHARS = 120_000;

/**
 * Register the get-artifact tool on the given MCP server.
 * Calls GET /artifacts/:artifactId to retrieve a single artifact.
 */
export function registerGetArtifact(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.registerTool(
    "get-artifact",
    {
      description: "Retrieve a single artifact by its ID",
      inputSchema: {
        artifactId: z.string().describe("ID of the artifact to retrieve"),
        includeContent: z
          .boolean()
          .optional()
          .describe(
            "Whether to include artifact version content in the response (default false)"
          ),
        contentMaxChars: z
          .number()
          .int()
          .min(200)
          .max(MAX_CONTENT_MAX_CHARS)
          .optional()
          .describe(
            `Maximum content characters when includeContent=true (default ${DEFAULT_CONTENT_MAX_CHARS}, max ${MAX_CONTENT_MAX_CHARS})`
          ),
      },
    },
    ({ artifactId, includeContent, contentMaxChars }) =>
      withErrorHandling(async () => {
        const response = await apiClient.get<unknown>(
          `/artifacts/${encodePathSegment(artifactId)}`
        );
        const envelope = asRecord(response);
        const row = asRecord(envelope.data ?? response);
        const version = asRecord(row.version);
        const rawContent = readString(version.content) ?? "";
        const resolvedContentMaxChars =
          contentMaxChars ?? DEFAULT_CONTENT_MAX_CHARS;
        const content =
          includeContent === true
            ? truncateString(rawContent, resolvedContentMaxChars)
            : undefined;

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  id: readString(row.id),
                  title: readString(row.title),
                  slug: readString(row.slug),
                  type: readString(row.type),
                  status: readString(row.status),
                  projectId: readString(row.projectId),
                  workstreamId: readString(row.workstreamId),
                  latestVersion: readNumber(row.latestVersion),
                  updatedAt: readString(row.updatedAt),
                  version: {
                    id: readString(version.id),
                    version: readNumber(version.version),
                    createdAt: readString(version.createdAt),
                    createdById: readString(version.createdById),
                    contentLength: rawContent.length,
                    ...(includeContent === true ? { content } : {}),
                  },
                },
                null,
                2
              ),
            },
          ],
        };
      })
  );
}
