import {
  type DocumentListPage,
  type DocumentWithProject,
  type FindDocumentsOptions,
  normalizeDocumentListResponse,
  normalizeDocumentType,
} from "@repo/api/src/types/document";
import {
  DOCUMENT_METRIC_TREND_DAYS,
  DOCUMENT_SUMMARY_ID_BATCH_SIZE,
  DOCUMENT_SUMMARY_WINDOW_DAYS,
  type DocumentListSummary,
  type DocumentSummaryTrendlines,
} from "@repo/api/src/types/document-list-summary";
import type { DocumentSummaryParams } from "@repo/api/src/types/document-metric-scope";
import { ApiError } from "../../shared/api/api-error";
import type { ApiClient } from "../../shared/api/create-api-client";
import { buildDocumentListSearchParams } from "./document-list-search-params";

/** Older servers may reject or ignore union filters; scalar reads remain valid. */
export async function readDocumentsWithSubtypeUnion(
  client: ApiClient,
  options: FindDocumentsOptions
): Promise<DocumentWithProject[]> {
  try {
    const rows = await client.get<DocumentWithProject[]>(
      `/documents?${buildDocumentListSearchParams(options)}`
    );
    const types = requestedTypes(options);
    return types ? rows.filter((row) => types.includes(row.type)) : rows;
  } catch (error) {
    if (!isUnsupportedTypes(error, options)) {
      throw error;
    }
    return readLegacyUnion(client, options);
  }
}

export async function readDocumentPageWithSubtypeUnion(
  client: ApiClient,
  options: FindDocumentsOptions
): Promise<DocumentListPage> {
  try {
    const response = await client.get<unknown>(
      `/documents?${buildDocumentListSearchParams({ ...options, includeTotal: true })}`
    );
    const page = normalizeDocumentListResponse(response);
    if (!options.types?.length || honorsTypes(page.appliedTypes, options)) {
      return page;
    }
  } catch (error) {
    if (!isUnsupportedTypes(error, options)) {
      throw error;
    }
  }
  const all = await readLegacyUnion(client, options);
  const offset = options.offset ?? 0;
  const items =
    options.limit === undefined
      ? all
      : all.slice(offset, offset + options.limit);
  const appliedTypes = requestedTypes(options);
  return {
    items,
    total: all.length,
    limit: options.limit ?? null,
    offset,
    hasMore: offset + items.length < all.length,
    ...(appliedTypes ? { appliedTypes } : {}),
  };
}

export async function readDocumentSummaryWithSubtypeUnion(
  client: ApiClient,
  options: DocumentSummaryParams,
  parse: (body: unknown) => DocumentListSummary
): Promise<DocumentListSummary> {
  if (
    options.artifactIds &&
    options.artifactIds.length > DOCUMENT_SUMMARY_ID_BATCH_SIZE
  ) {
    const ids = [...new Set(options.artifactIds)].sort();
    const summaries: DocumentListSummary[] = [];
    for (
      let offset = 0;
      offset < ids.length;
      offset += DOCUMENT_SUMMARY_ID_BATCH_SIZE
    ) {
      summaries.push(
        await readDocumentSummaryWithSubtypeUnion(
          client,
          {
            ...options,
            artifactIds: ids.slice(
              offset,
              offset + DOCUMENT_SUMMARY_ID_BATCH_SIZE
            ),
          },
          parse
        )
      );
    }
    return {
      ...sumSummaries(summaries, requestedTypes(options)),
      appliedArtifactIds: ids,
    };
  }
  const read = async (params: DocumentSummaryParams) =>
    parse(
      await client.get<unknown>(
        `/documents/summary?${buildDocumentListSearchParams(params)}`
      )
    );
  try {
    const summary = await read(options);
    assertExactArtifactIds(summary, options.artifactIds);
    if (!options.types?.length || honorsTypes(summary.appliedTypes, options)) {
      return summary;
    }
  } catch (error) {
    if (!isUnsupportedTypes(error, options)) {
      throw error;
    }
  }
  const {
    types: _types,
    type: _type,
    limit: _limit,
    offset: _offset,
    ...scope
  } = options;
  const types = requestedTypes(options) ?? [];
  const summaries = await Promise.all(
    types.map(async (type) => {
      const summary = await read({ ...scope, type });
      assertExactArtifactIds(summary, options.artifactIds);
      return summary;
    })
  );
  return {
    ...sumSummaries(summaries, types),
    ...(options.artifactIds
      ? { appliedArtifactIds: [...new Set(options.artifactIds)] }
      : {}),
  };
}

function requestedTypes(options: FindDocumentsOptions) {
  if (!options.types?.length) {
    return undefined;
  }
  const types = [...new Set(options.types.map(normalizeDocumentType))];
  if (options.type === undefined) {
    return types;
  }
  const scalarType = normalizeDocumentType(options.type);
  return types.filter((type) => type === scalarType);
}

function honorsTypes(
  applied: readonly string[] | undefined,
  options: FindDocumentsOptions
) {
  const requested = requestedTypes(options);
  return (
    requested !== undefined &&
    applied !== undefined &&
    requested.length === new Set(applied).size &&
    requested.every((type) => applied.includes(type))
  );
}

function isUnsupportedTypes(error: unknown, options: FindDocumentsOptions) {
  return (
    options.types !== undefined &&
    error instanceof ApiError &&
    error.status === 400 &&
    error.message.includes("types")
  );
}

async function readLegacyUnion(
  client: ApiClient,
  options: FindDocumentsOptions
) {
  const {
    types: _types,
    type: _type,
    limit: _limit,
    offset: _offset,
    ...scope
  } = options;
  // This fan-out is bounded by the closed subtype vocabulary, not the row count.
  const rows = await Promise.all(
    (requestedTypes(options) ?? []).map((type) =>
      client.get<DocumentWithProject[]>(
        `/documents?${buildDocumentListSearchParams({ ...scope, type })}`
      )
    )
  );
  return rows.flat().sort((left, right) => {
    const dateOrder =
      new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();
    return dateOrder || right.id.localeCompare(left.id);
  });
}

/** Scalar subtype cohorts are disjoint; only aligned UTC bins can be combined. */
function mergeSummaryTrendlines(summaries: DocumentListSummary[]): {
  trendlines?: DocumentSummaryTrendlines;
} {
  const lines = summaries.map((summary) => summary.trendlines);
  const first = lines[0];
  if (
    !first ||
    lines.some((line) => !line || line.startDate !== first.startDate)
  ) {
    return {};
  }
  const sum = (key: "total" | "producedByAgentSessions" | "updatedInWindow") =>
    Array.from({ length: DOCUMENT_METRIC_TREND_DAYS }, (_, day) =>
      lines.reduce((value, line) => value + (line?.[key][day] ?? 0), 0)
    );
  return {
    trendlines: {
      startDate: first.startDate,
      endDate: lines.reduce(
        (end, line) => (line && line.endDate > end ? line.endDate : end),
        first.endDate
      ),
      total: sum("total"),
      producedByAgentSessions: sum("producedByAgentSessions"),
      updatedInWindow: sum("updatedInWindow"),
    },
  };
}

function sumSummaries(
  summaries: DocumentListSummary[],
  types: DocumentListSummary["appliedTypes"]
): DocumentListSummary {
  const windowDays = summaries[0]?.windowDays ?? DOCUMENT_SUMMARY_WINDOW_DAYS;
  if (
    windowDays === undefined ||
    summaries.some((summary) => summary.windowDays !== windowDays)
  ) {
    throw new ApiError(
      "Received a malformed (non-JSON) response from the server.",
      502
    );
  }
  return {
    ...mergeSummaryTrendlines(summaries),
    ...(types ? { appliedTypes: types } : {}),
    total: summaries.reduce((sum, summary) => sum + summary.total, 0),
    producedByAgentSessions: summaries.reduce(
      (sum, summary) => sum + summary.producedByAgentSessions,
      0
    ),
    updatedInWindow: summaries.reduce(
      (sum, summary) => sum + summary.updatedInWindow,
      0
    ),
    neverEdited: summaries.reduce(
      (sum, summary) => sum + summary.neverEdited,
      0
    ),
    windowDays,
  };
}

function assertExactArtifactIds(
  summary: DocumentListSummary,
  requested: string[] | undefined
) {
  if (requested === undefined) {
    return;
  }
  const ids = new Set(requested);
  const applied = summary.appliedArtifactIds;
  if (
    !applied ||
    ids.size !== new Set(applied).size ||
    !applied.every((id) => ids.has(id))
  ) {
    throw new ApiError(
      "Received a malformed (non-JSON) response from the server.",
      502
    );
  }
}
