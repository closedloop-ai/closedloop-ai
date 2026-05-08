import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { LinkType } from "@repo/api/src/types/artifact.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import {
  ARTIFACT_LINK_SLUG_HELP,
  asRecord,
  readString,
  withErrorHandling,
} from "./tool-utils.js";

/**
 * After the artifact cutover, ArtifactLink endpoints are raw artifact IDs.
 * The MCP tool input accepts only `sourceId`, `targetId`, and `linkType`.
 * The underlying `/artifact-links` REST endpoint resolves UUIDs and document
 * slugs (PRD-*, PLN-*, FEA-*) server-side via `resolveArtifactIdentifier`.
 */
export function registerCreateArtifactLink(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.registerTool(
    "create-artifact-link",
    {
      description:
        "Create a typed relationship between artifacts (e.g. PRD-to-plan, plan-to-feature). Pass the artifact id (UUID) or supported slug (PRD-*, PLN-*, FEA-*) verbatim for sourceId/targetId.",
      inputSchema: {
        sourceId: z
          .string()
          .describe(`Source artifact ID. ${ARTIFACT_LINK_SLUG_HELP}`),
        targetId: z
          .string()
          .describe(`Target artifact ID. ${ARTIFACT_LINK_SLUG_HELP}`),
        linkType: z.enum(LinkType).describe("Type of the link"),
      },
    },
    ({ sourceId, targetId, linkType }) =>
      withErrorHandling(async () => {
        const link = await apiClient.post<unknown>("/artifact-links", {
          sourceId,
          targetId,
          linkType,
        });
        const shaped = shapeArtifactLink(link);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(shaped, null, 2),
            },
          ],
        };
      })
  );
}

/**
 * Shape an ArtifactLink wire record into the MCP tool response shape.
 * The `POST /artifact-links` route returns an `ArtifactLink` row; no joined
 * source/target artifact rows are included, so name is omitted.
 */
function shapeArtifactLink(link: unknown): {
  id: string | null;
  linkType: string | null;
  createdAt: string | null;
  sourceId: string | null;
  targetId: string | null;
} {
  const row = asRecord(link);
  return {
    id: readString(row.id),
    linkType: readString(row.linkType),
    createdAt: readString(row.createdAt),
    sourceId: readString(row.sourceId),
    targetId: readString(row.targetId),
  };
}
