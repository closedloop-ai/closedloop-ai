import type { JsonObject } from "@repo/api/src/types/common.js";
import { getRoutePrefixForType } from "@repo/api/src/types/document.js";
import { resolveFriendlyError } from "@repo/api/src/types/friendly-error.js";
import { McpApiError } from "../api-error.js";

type ToolResult = {
  content: (
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  )[];
  isError?: boolean;
};

export const DEFAULT_PAGE_LIMIT = 25;
export const MAX_PAGE_LIMIT = 100;
export const DOCUMENT_DOC_HELP =
  "User-facing documents are PRDs (PRD-*), implementation plans (PLN-*), and features (FEA-*). Templates exist but are internal and not exposed to end users.";
export const ARTIFACT_LINK_SLUG_HELP =
  "User-facing slugs are supported for documents (PRD-7, PLN-4, FEA-42); other artifacts (pull requests, deployments) require UUIDs.";
export const ARTIFACT_LINK_TYPE_HELP =
  "Link types: PRODUCES — directional lineage where the source artifact produces/derives the target (e.g. a PRD PRODUCES a feature; a feature PRODUCES the implementation plan written from it). PRODUCES is the only type that establishes parent→child lineage and drives the project tree and loop roll-ups. BLOCKS — the source blocks the target (the target cannot proceed until the source is done); directional, but not lineage. RELATES_TO — a non-hierarchical association between peers; direction carries no special meaning.";
export const ARTIFACT_LINK_DIRECTION_HELP =
  "Links are directional: source → target. The source is the upstream/producing artifact (the parent for PRODUCES); the target is the downstream/produced artifact (the child for PRODUCES). Example: you fetched feature FEA-42 and authored plan PLN-12 from it → link with sourceId=FEA-42, targetId=PLN-12, linkType=PRODUCES.";
export const PARENT_ARTIFACT_METADATA_HELP =
  "`parentArtifact` is a selected direct-parent convenience projection from artifact-link lineage, useful for grouping or stack-ranking. It is null when no qualifying direct parent exists. Use `list-artifact-links` for complete lineage traversal.";

export function withErrorHandling(
  fn: () => Promise<ToolResult>
): Promise<ToolResult> {
  return fn().catch((error: unknown) => ({
    content: [
      {
        type: "text" as const,
        text: formatToolError(error),
      },
    ],
    isError: true,
  }));
}

function formatToolError(error: unknown): string {
  const friendly = resolveFriendlyError(
    error instanceof McpApiError
      ? {
          code: error.code,
          details: error.details,
          message: error.message,
          timestamp: error.timestamp,
        }
      : {
          message: error instanceof Error ? error.message : "Unknown error",
        }
  );
  const parts = [friendly.title, "", friendly.description];
  if (friendly.remediation.length > 0) {
    parts.push("", "Remediation:");
    parts.push(...friendly.remediation.map((step) => `- ${step}`));
  }
  const technicalDetails = sanitizeTechnicalDetails(friendly.technicalDetails);
  if (Object.keys(technicalDetails).length > 0) {
    parts.push(
      "",
      "Technical details:",
      JSON.stringify(technicalDetails, null, 2)
    );
  }
  return parts.join("\n");
}

/**
 * Keys of `technicalDetails` allowed into the client-visible MCP error text.
 * The upstream API error `details`/`result` payloads are deliberately excluded:
 * they are arbitrary nested objects that echo raw server-side data — internal
 * paths, SQL fragments, or other sensitive information (FEA-2550). Only the
 * scalar identifier fields are surfaced, and the allowlist redacts any future
 * field by default. `message` is retained because it is the primary actionable
 * error signal for the client; callers that build `message` from raw upstream
 * bodies (see api-client.ts) remain responsible for not embedding secrets there.
 */
const SAFE_TECHNICAL_DETAIL_KEYS = new Set(["code", "message", "timestamp"]);

function sanitizeTechnicalDetails(technicalDetails: JsonObject): JsonObject {
  const sanitized: JsonObject = {};
  for (const [key, value] of Object.entries(technicalDetails)) {
    if (SAFE_TECHNICAL_DETAIL_KEYS.has(key)) {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

/**
 * Encode a user-supplied ID for safe interpolation into a URL path segment.
 * Prevents path traversal attacks (e.g. "../../admin") by URI-encoding
 * slashes and other special characters.
 */
export function encodePathSegment(id: string): string {
  return encodeURIComponent(id);
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

export function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * Copy only the defined entries, so optional tool inputs are forwarded to the
 * API exactly when the caller supplied them (null is a meaningful value, e.g.
 * unassign).
 */
export function pickDefined(
  fields: Record<string, unknown>
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

export function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export type ParentArtifactProjectionInput = {
  linkId?: string | null;
  linkType?: string | null;
  linkCreatedAt?: string | null;
  parentArtifact?: {
    id?: string | null;
    type?: string | null;
    subtype?: string | null;
    name?: string | null;
    slug?: string | null;
    externalUrl?: string | null;
  } | null;
};

export type ParentArtifactShape = {
  id: string | null;
  type: string | null;
  subtype: string | null;
  name: string | null;
  slug: string | null;
  externalUrl: string | null;
  linkId: string | null;
  linkType: string | null;
  linkCreatedAt: string | null;
};

/**
 * Shape the artifact-link selected-parent projection into the nested MCP
 * document field. Missing endpoint values become null, but a null projection
 * remains null instead of synthesizing a parent.
 */
export function shapeParentArtifact(
  projection: ParentArtifactProjectionInput | null | undefined
): ParentArtifactShape | null {
  if (!projection || projection.parentArtifact == null) {
    return null;
  }
  return {
    id: projection.parentArtifact.id ?? null,
    type: projection.parentArtifact.type ?? null,
    subtype: projection.parentArtifact.subtype ?? null,
    name: projection.parentArtifact.name ?? null,
    slug: projection.parentArtifact.slug ?? null,
    externalUrl: projection.parentArtifact.externalUrl ?? null,
    linkId: projection.linkId ?? null,
    linkType: projection.linkType ?? null,
    linkCreatedAt: projection.linkCreatedAt ?? null,
  };
}

export function withParentArtifactProjection<T extends object>(
  base: T,
  projection: ParentArtifactProjectionInput | null
): T & { parentArtifact: ParentArtifactShape | null } {
  return {
    ...base,
    parentArtifact: shapeParentArtifact(projection),
  };
}

export function truncateString(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars)}...[truncated]`;
}

export function describeIdOrSlug(
  entityLabel: string,
  example: string | string[]
): string {
  const exampleText = Array.isArray(example) ? example.join(", ") : example;
  return `${entityLabel} UUID or user-facing slug (e.g. ${exampleText}). Pass the user's slug verbatim — the API resolves it server-side.`;
}

/**
 * Build an API query object from optional filter fields, dropping any that are
 * `undefined`. Shared by list-style tools so each doesn't re-derive the same
 * undefined-filtering logic.
 */
export function buildQuery(
  fields: Record<string, string | undefined>
): Record<string, string> {
  const query: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) {
      query[key] = value;
    }
  }
  return query;
}

export function buildPaginatedPayload<T>(
  itemsOrPayload: unknown,
  options: {
    limit?: number;
    offset?: number;
    mapItem: (item: T) => unknown;
    defaultLimit?: number;
  }
): {
  total: number;
  offset: number;
  limit: number;
  returned: number;
  hasMore: boolean;
  nextOffset: number | null;
  items: unknown[];
} {
  const items = extractArrayItems<T>(itemsOrPayload);
  const resolvedOffset = options.offset ?? 0;
  const resolvedLimit =
    options.limit ?? options.defaultLimit ?? DEFAULT_PAGE_LIMIT;
  const page = items
    .slice(resolvedOffset, resolvedOffset + resolvedLimit)
    .map(options.mapItem);
  const hasMore = resolvedOffset + page.length < items.length;
  return {
    total: items.length,
    offset: resolvedOffset,
    limit: resolvedLimit,
    returned: page.length,
    hasMore,
    nextOffset: hasMore ? resolvedOffset + page.length : null,
    items: page,
  };
}

const RECEIVED_PAYLOAD_SAMPLE_MAX_CHARS = 200;
const RECEIVED_PAYLOAD_SAMPLE_MAX_ARRAY_ITEMS = 5;

// Only ever called on the non-array payloads that reach extractArrayItems'
// error path (arrays are handled before it), so no array branch is needed.
function describeReceivedType(value: unknown): string {
  if (value === null) {
    return "null";
  }
  return typeof value;
}

/**
 * JSON-stringify a value for an error sample without walking large collections:
 * arrays are capped to a small prefix at every depth, so a shape-drift payload
 * like `{ items: [...thousands...] }` can't allocate and traverse the whole
 * collection just to build a diagnostic string.
 */
function boundedStringifyForSample(value: unknown): string {
  const seen = new WeakSet<object>();
  try {
    return (
      JSON.stringify(value, (_key, val) => {
        if (typeof val === "object" && val !== null) {
          if (seen.has(val)) {
            return "[Circular]";
          }
          seen.add(val);
          if (
            Array.isArray(val) &&
            val.length > RECEIVED_PAYLOAD_SAMPLE_MAX_ARRAY_ITEMS
          ) {
            return [
              ...val.slice(0, RECEIVED_PAYLOAD_SAMPLE_MAX_ARRAY_ITEMS),
              `…(+${val.length - RECEIVED_PAYLOAD_SAMPLE_MAX_ARRAY_ITEMS} more)`,
            ];
          }
        }
        return val;
      }) ?? String(value)
    );
  } catch {
    return String(value);
  }
}

/**
 * Render a compact, safe description of an unexpected payload for error
 * messages: its runtime type plus a truncated JSON sample, so the calling
 * agent can see what actually came back instead of a shape-only complaint.
 */
function describeReceivedPayload(value: unknown): string {
  return `type "${describeReceivedType(value)}" (sample: ${truncateString(
    boundedStringifyForSample(value),
    RECEIVED_PAYLOAD_SAMPLE_MAX_CHARS
  )})`;
}

export function extractArrayItems<T>(payload: unknown): T[] {
  if (Array.isArray(payload)) {
    return payload as T[];
  }
  const record = asRecord(payload);
  if (Array.isArray(record.data)) {
    return record.data as T[];
  }
  throw new Error(
    `Expected array response or { data: [] } response, but received ${describeReceivedPayload(
      payload
    )}`
  );
}

export const WEBAPP_URL =
  process.env.WEBAPP_URL?.replace(/\/+$/, "") ?? "https://app.closedloop.ai";

const DOCUMENT_FALLBACK_PREFIX = "documents";

let sessionOrgSlug: string | null = null;

export function setSessionOrgSlug(slug: string): void {
  sessionOrgSlug = slug;
}

function withOrgPrefix(path: string): string {
  return sessionOrgSlug
    ? `${WEBAPP_URL}/${sessionOrgSlug}${path}`
    : `${WEBAPP_URL}${path}`;
}

/**
 * Build a full webapp URL for a document, using the document type to resolve
 * the correct route prefix (e.g. `/acme/features/FEA-42`, `/acme/prds/PRD-7`).
 */
export function buildDocumentUrl(slug: string, documentType: string): string {
  const prefix =
    getRoutePrefixForType(documentType) ?? DOCUMENT_FALLBACK_PREFIX;
  return withOrgPrefix(`/${prefix}/${encodePathSegment(slug)}`);
}

/**
 * Extract slug and type from a document record and build the webapp URL.
 * Returns null when slug or type are missing.
 */
export function buildDocumentUrlFromRecord(
  row: Record<string, unknown>
): string | null {
  const slug = readString(row.slug);
  const docType = readString(row.type);
  if (!(slug && docType)) {
    return null;
  }
  return buildDocumentUrl(slug, docType);
}

/**
 * Build a full webapp URL for a loop (e.g. `/acme/loops/{id}`).
 */
export function buildLoopUrl(loopId: string): string {
  return withOrgPrefix(`/loops/${encodePathSegment(loopId)}`);
}
