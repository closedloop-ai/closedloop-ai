import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  LinkDirection,
  LinkQueryMode,
  LinkType,
} from "@repo/api/src/types/artifact.js";
import type { SessionLinkAttributionEvidence } from "@repo/api/src/types/attribution-evidence.js";
import { sessionLinkAttributionEvidenceSchema } from "@repo/api/src/types/attribution-evidence-schema.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import {
  ARTIFACT_LINK_DIRECTION_HELP,
  ARTIFACT_LINK_SLUG_HELP,
  ARTIFACT_LINK_TYPE_HELP,
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
 * Calls `GET /artifact-links/resolved`, whose links carry fully hydrated source
 * and target endpoint objects (`{ id, type, subtype, name, slug, externalUrl }`).
 * That endpoint is paginated as of ISS-10102 and this tool follows its cursor
 * internally — see {@link fetchAllResolvedLinkPages} for why it follows rather
 * than exposes. The tool's own `limit` / `offset` contract is unchanged.
 */
export function registerListArtifactLinks(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.registerTool(
    "list-artifact-links",
    {
      description: `List typed, directional relationships for an artifact (e.g. PRD-to-plan, feature-to-plan). Pass the artifact id (UUID) or supported slug (PRD-*, PLN-*, FEA-*) verbatim for artifactId. ${ARTIFACT_LINK_DIRECTION_HELP} ${ARTIFACT_LINK_TYPE_HELP}`,
      inputSchema: {
        artifactId: z
          .string()
          .describe(`Artifact ID. ${ARTIFACT_LINK_SLUG_HELP}`),
        linkType: z
          .enum(LinkType)
          .optional()
          .describe(`Filter by link type. ${ARTIFACT_LINK_TYPE_HELP}`),
        direction: z
          .enum(LinkDirection)
          .optional()
          .describe(
            "Which links to return relative to artifactId (the param value names the OTHER endpoint's role). 'target' = outgoing links where artifactId is the source: its downstream/produced children (e.g. the plans a feature produces). 'source' = incoming links where artifactId is the target: its upstream producers (e.g. the feature that produced this plan). 'both' = all (default)."
          ),
        mode: z
          .enum(LinkQueryMode)
          .optional()
          .describe(
            "'direct' returns only immediate links; 'tree' traverses the link graph via BFS"
          ),
        maxDepth: z
          .number()
          .int()
          .min(1)
          .max(MAX_TREE_DEPTH)
          .optional()
          .describe(
            `Max traversal depth when mode='tree' (1-${MAX_TREE_DEPTH}). direction='both' (the default) follows every link in both directions, so its tree is limited to ${MAX_BOTH_DIRECTION_TREE_DEPTH} and uses ${MAX_BOTH_DIRECTION_TREE_DEPTH} when maxDepth is omitted; pass direction 'source' or 'target' to walk a lineage deeper.`
          ),
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
        const depth =
          mode === LinkQueryMode.Tree
            ? boundTreeDepth(direction, maxDepth)
            : maxDepth;
        if (depth !== undefined) {
          query.maxDepth = String(depth);
        }

        const links = await fetchAllResolvedLinkPages(apiClient, query);
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
  sessionEvidence?: SessionLinkAttributionEvidence;
} {
  const row = asRecord(value);
  // ISS-12552: a SESSION row's evidence, passed through as
  // the API sent it. Non-strict, so keys a newer API adds survive; absent or
  // unreadable evidence stays absent rather than becoming a relationship.
  const sessionEvidence = sessionLinkAttributionEvidenceSchema.safeParse(
    row.sessionEvidence
  );
  return {
    id: readString(row.id),
    linkType: readString(row.linkType),
    createdAt: readString(row.createdAt),
    source: shapeEndpoint(row.source),
    target: shapeEndpoint(row.target),
    ...(sessionEvidence.success
      ? { sessionEvidence: sessionEvidence.data }
      : {}),
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

/**
 * Read every page of `GET /artifact-links/resolved` and concatenate them
 * (ISS-10102).
 *
 * WHY FOLLOW RATHER THAN EXPOSE. This tool already HAS a pagination contract —
 * `limit` / `offset` in, `total` / `hasMore` / `nextOffset` out — and it is
 * consumed by clients outside this repo. Surfacing the endpoint's cursor beside
 * that would give one tool two continuation schemes an agent has to reconcile,
 * and stopping early at `offset + limit` would make `total` a count of what this
 * process happened to fetch rather than of what matches — a number that reads
 * like a measurement and is not one. Following every page keeps `total` and
 * `hasMore` meaning exactly what they meant before, so no MCP client sees a
 * contract change at all.
 *
 * KNOWN CEILING: the whole link set is assembled in this process before it is
 * sliced — the same set this tool received in ONE response before ISS-10102, so
 * this is not a regression, but the ceiling moved off the 2,048 MB API function
 * rather than out of existence. If a tenant ever grows a graph this container
 * cannot hold, the answer is to push `limit`/`offset` down into the query, not
 * to cap the walk here and report a `total` that counts only what was read.
 *
 * An api build from before ISS-10102 ignores `paginated` and answers with a bare
 * array; that is normalized to one terminal page, so a skewed deploy degrades to
 * the old single-request behavior rather than throwing.
 */
async function fetchAllResolvedLinkPages(
  apiClient: ApiClient,
  query: Record<string, string>
): Promise<unknown[]> {
  const all: unknown[] = [];
  let cursor: string | undefined;
  let snapshotId: string | undefined;

  for (;;) {
    const response = await apiClient.get<unknown>("/artifact-links/resolved", {
      ...query,
      paginated: "true",
      ...(cursor === undefined ? {} : { cursor }),
      ...(snapshotId === undefined ? {} : { snapshotId }),
    });
    const page = readResolvedLinkPage(response);
    all.push(...page.items);

    // Absent, never null, on the last page. A cursor that did not advance would
    // re-read the same page forever, so it terminates the walk too.
    if (page.nextCursor === undefined || page.nextCursor === cursor) {
      return all;
    }
    cursor = page.nextCursor;
    snapshotId = page.snapshotId;
  }
}

/**
 * Accept both the `ArtifactLinkPage` envelope and the pre-ISS-10102 bare array.
 *
 * A response that is NEITHER throws. Defaulting a missing `items` to `[]` would
 * end the walk on the first page and report `total: 0` — a successful empty
 * result where the contract actually failed, which is the silent-truncation
 * shape this whole ticket exists to remove (#7368 review, whitlockk). Two link
 * shapes are legal here; a third is a bug worth surfacing, and
 * `withErrorHandling` turns it into an MCP error the caller can see.
 */
function readResolvedLinkPage(response: unknown): {
  items: unknown[];
  nextCursor?: string;
  snapshotId?: string;
} {
  if (Array.isArray(response)) {
    return { items: response };
  }
  const row = asRecord(response);
  if (!Array.isArray(row.items)) {
    throw new Error(
      "GET /artifact-links/resolved: expected an ArtifactLinkPage with an items array or a bare array"
    );
  }
  const items = row.items;
  const nextCursor = readString(row.nextCursor);
  const snapshotId = readString(row.snapshotId);
  return nextCursor === null
    ? { items }
    : { items, nextCursor, ...(snapshotId ? { snapshotId } : {}) };
}

/**
 * ISS-10840: a `both` walk crosses every hub artifact, so it already logs
 * `artifact_link_tree_oversize` at depth 3; no `source`/`target` walk has.
 */
const MAX_TREE_DEPTH = 10;
const MAX_BOTH_DIRECTION_TREE_DEPTH = 2;

/**
 * ISS-10840 asks for a refusal that names the limit, so an explicit depth past
 * the `both` limit throws instead of clamping. An omitted `both` depth gets that
 * limit, per AGENTS.md Cross-Repo Compatibility (a missing value degrades to a
 * safe default).
 */
function boundTreeDepth(
  direction: LinkDirection | undefined,
  maxDepth: number | undefined
): number | undefined {
  if ((direction ?? LinkDirection.Both) !== LinkDirection.Both) {
    return maxDepth;
  }
  if (maxDepth === undefined) {
    return MAX_BOTH_DIRECTION_TREE_DEPTH;
  }
  if (maxDepth > MAX_BOTH_DIRECTION_TREE_DEPTH) {
    throw new Error(
      `mode='tree' with direction='both' accepts maxDepth up to ${MAX_BOTH_DIRECTION_TREE_DEPTH} (received ${maxDepth}). Pass direction 'source' or 'target' to walk deeper (maxDepth up to ${MAX_TREE_DEPTH}).`
    );
  }
  return maxDepth;
}
