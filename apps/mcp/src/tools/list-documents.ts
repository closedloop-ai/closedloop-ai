import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { LinkType } from "@repo/api/src/types/artifact.js";
import {
  DocumentType,
  type DocumentWithProject,
} from "@repo/api/src/types/document.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import { McpApiError } from "../api-error.js";
import {
  asRecord,
  buildDocumentUrlFromRecord,
  buildPaginatedPayload,
  buildQuery,
  DEFAULT_PAGE_LIMIT,
  DOCUMENT_DOC_HELP,
  describeIdOrSlug,
  extractArrayItems,
  MAX_PAGE_LIMIT,
  PARENT_ARTIFACT_METADATA_HELP,
  type ParentArtifactProjectionInput,
  readNumber,
  readString,
  withErrorHandling,
  withParentArtifactProjection,
} from "./tool-utils.js";

type JsonDocumentWithProject = Partial<
  Omit<DocumentWithProject, "createdAt" | "updatedAt" | "dueDate">
> & {
  createdAt?: string | null;
  updatedAt?: string | null;
  dueDate?: string | null;
};

type JsonParentProjection = ParentArtifactProjectionInput & {
  targetId: string;
};

/** Shape one API document row for the `list-documents` MCP response. */
export function shapeListDocumentItem(
  value: JsonDocumentWithProject,
  parentProjection?: JsonParentProjection | null
) {
  const row = asRecord(value);
  const assigneeRaw = asRecord(row.assignee);
  const projectRaw = asRecord(row.project);
  const base = {
    id: readString(row.id),
    title: readString(row.title),
    slug: readString(row.slug),
    type: readString(row.type),
    status: readString(row.status),
    projectId: readString(row.projectId),
    // Stack-rank position within the project (PRD-421); lower sorts first,
    // null when unranked. Lets agents read order before calling move-artifact.
    sortOrder: readNumber(row.sortOrder),
    assigneeId: readString(row.assigneeId),
    createdAt: readString(row.createdAt),
    updatedAt: readString(row.updatedAt),
    assignee: row.assignee
      ? {
          id: readString(assigneeRaw.id),
          email: readString(assigneeRaw.email),
          firstName: readString(assigneeRaw.firstName),
          lastName: readString(assigneeRaw.lastName),
          avatarUrl: readString(assigneeRaw.avatarUrl),
        }
      : null,
    project: row.project ? { name: readString(projectRaw.name) } : null,
  };
  return parentProjection === undefined
    ? base
    : withParentArtifactProjection(base, parentProjection);
}

async function fetchParentProjectionMap(
  apiClient: ApiClient,
  ids: string[]
): Promise<Map<string, JsonParentProjection> | null> {
  if (ids.length === 0) {
    return new Map();
  }
  try {
    const projections = await apiClient.get<JsonParentProjection[]>(
      "/artifact-links/parents",
      { targetIds: ids, linkType: LinkType.Produces }
    );
    return new Map(
      projections.map((projection) => [projection.targetId, projection])
    );
  } catch (error) {
    if (error instanceof McpApiError && error.status === 404) {
      return null;
    }
    throw error;
  }
}

/**
 * Register the list-documents tool on the given MCP server.
 * Calls GET /documents with optional query filters for projectId, type, and assigneeId.
 */
export function registerListDocuments(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.registerTool(
    "list-documents",
    {
      description: `List documents — PRDs (PRD-*), implementation plans (PLN-*), and features (FEA-*). Filter by project, type, or assignee. Returned \`slug\` values are the preferred user-facing handles for follow-up calls. ${PARENT_ARTIFACT_METADATA_HELP}`,
      inputSchema: {
        projectId: z
          .string()
          .optional()
          .describe(describeIdOrSlug("Project", "PRO-7")),
        assigneeId: z
          .string()
          .optional()
          .describe("Filter by assignee user ID"),
        type: z
          .enum(DocumentType)
          .optional()
          .describe(`${DOCUMENT_DOC_HELP} Filter by type.`),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_PAGE_LIMIT)
          .optional()
          .describe(`Maximum documents to return (1-${MAX_PAGE_LIMIT})`),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Starting offset for pagination (default 0)"),
        includeParentArtifact: z
          .boolean()
          .optional()
          .describe(
            "Include the selected direct parentArtifact projection from artifact-link lineage. Default true; set false when parent context is not needed."
          ),
      },
    },
    ({ projectId, assigneeId, type, limit, offset, includeParentArtifact }) =>
      withErrorHandling(async () => {
        const query = buildQuery({ projectId, assigneeId, type });

        const documents = await apiClient.get<JsonDocumentWithProject[]>(
          "/documents",
          query
        );
        const allDocuments =
          extractArrayItems<JsonDocumentWithProject>(documents);
        const resolvedOffset = offset ?? 0;
        const resolvedLimit = limit ?? DEFAULT_PAGE_LIMIT;
        const pageDocuments = allDocuments.slice(
          resolvedOffset,
          resolvedOffset + resolvedLimit
        );
        const parentProjectionMap =
          includeParentArtifact === false
            ? null
            : await fetchParentProjectionMap(
                apiClient,
                pageDocuments
                  .map((document) => readString(document.id))
                  .filter((id): id is string => id !== null)
              );

        const payload = buildPaginatedPayload<JsonDocumentWithProject>(
          documents,
          {
            limit,
            offset,
            mapItem: (item) => {
              const itemId = readString(item.id);
              const shaped = shapeListDocumentItem(
                item,
                parentProjectionMap === null
                  ? undefined
                  : (parentProjectionMap.get(itemId ?? "") ?? {
                      targetId: itemId ?? "",
                      linkId: null,
                      linkType: null,
                      linkCreatedAt: null,
                      parentArtifact: null,
                    })
              );
              return {
                ...shaped,
                webUrl: buildDocumentUrlFromRecord(asRecord(item)),
              };
            },
          }
        );
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(payload, null, 2) },
          ],
        };
      })
  );
}
