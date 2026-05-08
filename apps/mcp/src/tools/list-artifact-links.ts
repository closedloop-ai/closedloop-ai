import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { LinkType } from "@repo/api/src/types/artifact.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import {
  ARTIFACT_LINK_SLUG_HELP,
  asRecord,
  buildPaginatedPayload,
  MAX_PAGE_LIMIT,
  readString,
  withErrorHandling,
} from "./tool-utils.js";

/**
 * After the artifact cutover, ArtifactLink endpoints are raw artifact IDs.
 * The tool input accepts `artifactId` (artifact id / slug) and optional
 * `linkType`, `direction`, `mode`, and `maxDepth` filters.
 *
 * Calls `GET /artifact-links/resolved`, which returns
 * `ArtifactLinkWithEndpoints[]` — each link carries fully hydrated source
 * and target endpoint objects (`{ id, type, subtype, name, slug, externalUrl }`).
 */
export function registerListArtifactLinks(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.registerTool(
    "list-artifact-links",
    {
      description:
        "List typed relationships for an artifact (e.g. PRD-to-plan, plan-to-feature). Pass the artifact id (UUID) or supported slug (PRD-*, PLN-*, FEA-*) verbatim for artifactId.",
      inputSchema: {
        artifactId: z
          .string()
          .describe(`Artifact ID. ${ARTIFACT_LINK_SLUG_HELP}`),
        linkType: z.enum(LinkType).optional().describe("Filter by link type"),
        direction: z
          .enum(["source", "target", "both"])
          .optional()
          .describe(
            "Filter by link direction: 'source' for incoming links, 'target' for outgoing links, 'both' for all"
          ),
        mode: z
          .enum(["direct", "tree"])
          .optional()
          .describe(
            "'direct' returns only immediate links; 'tree' traverses the link graph via BFS"
          ),
        maxDepth: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("Max traversal depth when mode='tree' (1-50)"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_PAGE_LIMIT)
          .optional()
          .describe(
            `Maximum number of artifact links to return (1-${MAX_PAGE_LIMIT})`
          ),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Starting offset for pagination (default 0)"),
      },
    },
    ({ artifactId, linkType, direction, mode, maxDepth, limit, offset }) =>
      withErrorHandling(async () => {
        const query: Record<string, string> = { artifactId };
        if (linkType !== undefined) {
          query.linkType = linkType;
        }
        if (direction !== undefined) {
          query.direction = direction;
        }
        if (mode !== undefined) {
          query.mode = mode;
        }
        if (maxDepth !== undefined) {
          query.maxDepth = String(maxDepth);
        }

        const links = await apiClient.get<unknown[]>(
          "/artifact-links/resolved",
          query
        );
        const payload = buildPaginatedPayload(links, {
          limit,
          offset,
          mapItem: (value) => shapeResolvedLink(value),
        });
        const text = JSON.stringify(payload, null, 2);
        return {
          content: [{ type: "text" as const, text }],
        };
      })
  );
}

/**
 * Normalize an `ArtifactLinkWithEndpoints` wire record into the MCP response
 * shape. The REST response hydrates both endpoints, so `source` and `target`
 * each carry `{ id, type, subtype, name, slug, externalUrl }`.
 */
function shapeResolvedLink(value: unknown): {
  id: string | null;
  linkType: string | null;
  createdAt: string | null;
  source: ArtifactEndpointShape;
  target: ArtifactEndpointShape;
} {
  const row = asRecord(value);
  return {
    id: readString(row.id),
    linkType: readString(row.linkType),
    createdAt: readString(row.createdAt),
    source: shapeEndpoint(row.source),
    target: shapeEndpoint(row.target),
  };
}

type ArtifactEndpointShape = {
  id: string | null;
  type: string | null;
  subtype: string | null;
  name: string | null;
  slug: string | null;
  externalUrl: string | null;
};

function shapeEndpoint(value: unknown): ArtifactEndpointShape {
  const row = asRecord(value);
  return {
    id: readString(row.id),
    type: readString(row.type),
    subtype: readString(row.subtype),
    name: readString(row.name),
    slug: readString(row.slug),
    externalUrl: readString(row.externalUrl),
  };
}
