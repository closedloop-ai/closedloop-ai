import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { LinkType } from "@repo/api/src/types/artifact.js";
import {
  DOCUMENT_LIST_MAX_OFFSET,
  type DocumentWithProject,
  documentListPageSchema,
  documentTypeInputSchema,
} from "@repo/api/src/types/document.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import { McpApiError } from "../api-error.js";
import {
  asRecord,
  buildPaginatedPayload,
  buildQuery,
  DEFAULT_PAGE_LIMIT,
  DOCUMENT_DOC_HELP,
  describeIdOrSlug,
  extractArrayItems,
  MAX_PAGE_LIMIT,
  type McpUrlBuilder,
  PARENT_ARTIFACT_METADATA_HELP,
  type ParentArtifactProjectionInput,
  readNumber,
  readString,
  readTagSummaries,
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
    dueDate: readString(row.dueDate),
    priority: readString(row.priority),
    // Stack-rank position within the project (PRD-421); lower sorts first,
    // null when unranked. Lets agents read order before calling move-artifact.
    sortOrder: readNumber(row.sortOrder),
    assigneeId: readString(row.assigneeId),
    createdAt: readString(row.createdAt),
    updatedAt: readString(row.updatedAt),
    tags: readTagSummaries(row.tags),
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
 * Calls GET /documents with optional filters for projectId, type and assigneeId,
 * and — ISS-6137 — the page bound this tool returns, so the server slices rather
 * than this tool slicing a corpus it fetched whole.
 */
export function registerListDocuments(
  server: McpServer,
  apiClient: ApiClient,
  urls: McpUrlBuilder
): void {
  server.registerTool(
    "list-documents",
    {
      // ISS-4397: describe the current Issue vocabulary (ISS-*), with
      // FEATURE/FEA kept only as compatibility aliases. Reuses DOCUMENT_DOC_HELP
      // so this surface cannot drift from the shared type help text.
      description: `List documents. ${DOCUMENT_DOC_HELP} Filter by project, type (\`ISSUE\`≡\`FEATURE\`), or assignee. Returned \`slug\` values are the preferred user-facing handles for follow-up calls. ${PARENT_ARTIFACT_METADATA_HELP}`,
      inputSchema: {
        projectId: z
          .string()
          .optional()
          .describe(describeIdOrSlug("Project", "PRO-7")),
        assigneeId: z
          .string()
          .optional()
          .describe("Filter by assignee user ID"),
        // ISS-4397: reuse the shared public-contract input schema
        // (`documentTypeInputSchema`, colocated with the type in `@repo/api`). It
        // accepts the input superset (canonical types + the `ISSUE` alias) and
        // normalizes to the persisted type before the outgoing query, so
        // `type=ISSUE` and `type=FEATURE` both resolve regardless of whether the
        // API deploy is upgraded (skew-safe).
        type: documentTypeInputSchema
          .optional()
          .describe(
            `${DOCUMENT_DOC_HELP} Filter by type (\`ISSUE\`≡\`FEATURE\`).`
          ),
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
        const resolvedOffset = offset ?? 0;
        const resolvedLimit = limit ?? DEFAULT_PAGE_LIMIT;
        // ISS-6137 / ISS-11161: every page, however deep, asks the server for
        // exactly the rows it returns.
        const boundedQuery = buildQuery({
          projectId,
          assigneeId,
          type,
          limit: String(resolvedLimit),
          offset: String(resolvedOffset),
          includeTotal: "true",
        });
        // `unknown` rather than a response contract on purpose: these are the
        // calls in the tool whose shape depends on how the peer deploy answers,
        // and `readDocumentPage` is the boundary that decides which it was.
        const { pageDocuments, total, hasMore } = await readDocumentPage(
          () => apiClient.get<unknown>("/documents", boundedQuery),
          () =>
            apiClient.get<unknown>(
              "/documents",
              buildQuery({ projectId, assigneeId, type })
            ),
          { limit: resolvedLimit, offset: resolvedOffset }
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

        // `pageDocuments` IS the page on both arms, so the payload builder is
        // told the counts rather than left to derive them by slicing again.
        const payload = buildPaginatedPayload<JsonDocumentWithProject>(
          pageDocuments,
          {
            limit,
            offset,
            page: { total, hasMore },
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
                webUrl: urls.buildDocumentUrlFromRecord(asRecord(item)),
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

/**
 * The page of documents to return, and the counts describing the whole matching
 * set, from whichever response shape the API answered with.
 *
 * ISS-6137: this tool now sends `limit`/`offset`/`includeTotal`, so a current
 * API answers with the {@link documentListPageSchema} envelope and has already
 * applied the bound — re-slicing that page at the requested offset would read
 * past it and return nothing for every page after the first.
 *
 * The envelope is the only shape that STATES what the server did. A bare array
 * says the peer ignored `includeTotal`, and that does NOT imply it ignored
 * `limit`: the two landed in separate changes (FEA-4373 then ISS-4576), so a
 * deploy between them — or any intermediary that strips an unknown param —
 * returns a bare array that is ALREADY the page. Slicing that again yields an
 * empty page and a `total` of the page's own length: a confident wrong count of
 * the corpus, which is worse than a slow answer.
 *
 * Nothing in a bare body distinguishes the two readings, so this resolver asks
 * whether it CAN be ambiguous, via {@link isWholeMatchingSet}, and re-reads
 * unbounded when it is. The continuation headers ISS-6941 added to that arm
 * cannot settle it: they shipped 2026-09-14, six weeks after the envelope
 * (2026-08-02), so every peer that emits them also answers `includeTotal` with
 * an envelope and never reaches this arm on a bounded ask.
 */
async function resolveDocumentPage(
  documents: unknown,
  page: DocumentPageRequest,
  readUnbounded: () => Promise<unknown>
): Promise<{
  pageDocuments: JsonDocumentWithProject[];
  total: number;
  hasMore: boolean;
}> {
  const envelope = documentListPageSchema.safeParse(documents);
  if (envelope.success) {
    const items = extractArrayItems<JsonDocumentWithProject>(
      envelope.data.items
    );
    // `limit: null` inside an envelope says the server applied no bound, so its
    // items are the whole matching set and this tool still owes the slice.
    if (envelope.data.limit === null) {
      return slicePage(items, page);
    }
    return {
      pageDocuments: items,
      total: envelope.data.total,
      hasMore: envelope.data.hasMore,
    };
  }
  const bare = extractArrayItems<JsonDocumentWithProject>(documents);
  if (isWholeMatchingSet(bare, page)) {
    return slicePage(bare, page);
  }
  return slicePage(
    extractArrayItems<JsonDocumentWithProject>(await readUnbounded()),
    page
  );
}

/** The window this tool asked the server for. */
type DocumentPageRequest = {
  limit: number;
  offset: number;
};

/**
 * Whether a bare-array body can be read as the whole matching set rather than as
 * a page the server already cut.
 *
 * The row COUNT is the evidence, and only at offset 0, where
 * a server that ignored `offset` and one that applied it return the same rows. A
 * server honouring `limit` returns at most that many, so:
 *   - MORE than `limit` proves it ignored the bound — the array is the corpus.
 *   - FEWER than `limit` is the tail either way: a bound below the one asked for
 *     cannot return short while more rows remain.
 *   - EXACTLY `limit` is the one ambiguous count, and it is the common one.
 *
 * Offset 0 does not make that last case safe. Slicing is a no-op there, but that
 * is a fact about the ITEMS; the COUNTS are what an agent pages on, and reading a
 * server-cut page as the corpus publishes `total` = the page's own length and
 * `hasMore` = false, telling an agent there is no page two over a corpus that may
 * hold thousands. Past offset 0 nothing about the count settles whether `offset`
 * was applied, so every bounded ask there re-reads.
 */
function isWholeMatchingSet(
  bare: JsonDocumentWithProject[],
  page: DocumentPageRequest
): boolean {
  return page.offset === 0 && bare.length !== page.limit;
}

/** The requested window of a population this tool holds in full, and its counts. */
function slicePage(
  allDocuments: JsonDocumentWithProject[],
  page: DocumentPageRequest
): {
  pageDocuments: JsonDocumentWithProject[];
  total: number;
  hasMore: boolean;
} {
  const pageDocuments = allDocuments.slice(
    page.offset,
    page.offset + page.limit
  );
  return {
    pageDocuments,
    total: allDocuments.length,
    hasMore: page.offset + pageDocuments.length < allDocuments.length,
  };
}

/**
 * Read one page through the bounded query, falling back to the whole corpus
 * only when the API predates ISS-11161 and refuses the offset.
 *
 * An API before ISS-11161 400s any `offset` past `DOCUMENT_LIST_MAX_OFFSET`,
 * and `apps/mcp` can deploy ahead of `apps/api`. Surfacing that 400 would make
 * a page this tool has always served unreachable for the length of the deploy
 * window, so against such a peer the deep page keeps the read it had before.
 * A current API accepts the offset, so a 400 it returns at a deep offset comes
 * from a filter; the unbounded retry repeats that filter and is refused too.
 */
async function readDocumentPage(
  readBounded: () => Promise<unknown>,
  readUnbounded: () => Promise<unknown>,
  page: DocumentPageRequest
): Promise<{
  pageDocuments: JsonDocumentWithProject[];
  total: number;
  hasMore: boolean;
}> {
  let documents: unknown;
  try {
    documents = await readBounded();
  } catch (error) {
    if (!isPreDeepOffsetRejection(error, page)) {
      throw error;
    }
    return slicePage(
      extractArrayItems<JsonDocumentWithProject>(await readUnbounded()),
      page
    );
  }
  return await resolveDocumentPage(documents, page, readUnbounded);
}

/** Whether `error` could be an API older than ISS-11161 refusing a deep offset. */
function isPreDeepOffsetRejection(
  error: unknown,
  page: DocumentPageRequest
): boolean {
  return (
    error instanceof McpApiError &&
    error.status === 400 &&
    page.offset > DOCUMENT_LIST_MAX_OFFSET
  );
}
