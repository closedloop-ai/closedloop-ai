import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { JsonObject } from "@repo/api/src/types/common.js";
import {
  buildScopedDocumentPath,
  DOCUMENT_ROUTE_PREFIX,
  getRoutePrefixForType,
} from "@repo/api/src/types/document.js";
import { resolveFriendlyError } from "@repo/api/src/types/friendly-error.js";
import { TAG_COLORS, type TagSummary } from "@repo/api/src/types/tag.js";
import { z } from "zod";
import { McpApiError } from "../api-error.js";

type ToolResult = CallToolResult;

export const DEFAULT_PAGE_LIMIT = 25;
export const MAX_PAGE_LIMIT = 100;
export const MAX_CURSOR_CHARS = 2048;
export const DOCUMENT_DOC_HELP =
  "User-facing documents are PRDs (PRD-*), implementation plans (PLN-*), and issues (ISS-*; legacy FEA-* slugs still resolve). Templates exist but are internal and not exposed to end users.";
export const ARTIFACT_LINK_SLUG_HELP =
  "User-facing slugs are supported for documents (PRD-7, PLN-4, ISS-42; legacy FEA-42 still resolves); other artifacts (pull requests, deployments) require UUIDs.";
export const ARTIFACT_LINK_TYPE_HELP =
  "Link types: PRODUCES — directional lineage where the source artifact produces/derives the target (e.g. a PRD PRODUCES a feature; a feature PRODUCES the implementation plan written from it). PRODUCES is the only type that establishes parent→child lineage and drives the project tree. BLOCKS — the source blocks the target (the target cannot proceed until the source is done); directional, but not lineage. RELATES_TO — a non-hierarchical association between peers; direction carries no special meaning.";
export const ARTIFACT_LINK_DIRECTION_HELP =
  "Links are directional: source → target. The source is the upstream/producing artifact (the parent for PRODUCES); the target is the downstream/produced artifact (the child for PRODUCES). Example: you fetched issue ISS-42 and authored plan PLN-12 from it → link with sourceId=ISS-42, targetId=PLN-12, linkType=PRODUCES.";
export const PARENT_ARTIFACT_METADATA_HELP =
  "`parentArtifact` is a selected direct-parent convenience projection from artifact-link lineage, useful for grouping or stack-ranking. It is null when no qualifying direct parent exists. Use `list-artifact-links` for complete lineage traversal.";

const tagSummarySchema: z.ZodType<TagSummary> = z.object({
  id: z.string(),
  name: z.string(),
  color: z.enum(TAG_COLORS),
});

const tagSummaryArrayInputSchema = z.array(z.unknown());

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
    parts.push(
      "",
      "Remediation:",
      ...friendly.remediation.map((step) => `- ${step}`)
    );
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
 * Prevents path traversal (e.g. "../../admin") by URI-encoding slashes and
 * other special characters, and by rejecting the dot segments that no encoding
 * can neutralize — see {@link isDotPathSegment}. Callers that must stay total
 * (a per-row URL builder answering `null`) check that predicate first.
 */
export function encodePathSegment(id: string): string {
  if (isDotPathSegment(id)) {
    throw new Error(`"${id}" is not a valid path segment.`);
  }
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

export function readTagSummaries(value: unknown): TagSummary[] {
  const parsedInput = tagSummaryArrayInputSchema.safeParse(value);
  if (!parsedInput.success) {
    return [];
  }

  const tags: TagSummary[] = [];
  for (const item of parsedInput.data) {
    const parsedTag = tagSummarySchema.safeParse(item);
    if (parsedTag.success) {
      tags.push(parsedTag.data);
    }
  }
  return tags;
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
  const exampleText = formatIdOrSlugExamples(example);
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
    /**
     * Authoritative counts from a server that did the paging itself.
     *
     * When supplied, `itemsOrPayload` IS the page the server already sliced, so
     * this function must NOT slice it again: re-applying `.slice(offset,
     * offset + limit)` to a 25-row page requested at `offset=25` yields an
     * empty array, and every page after the first would silently come back
     * empty. `total` and `hasMore` then describe the whole matching set rather
     * than the handful of rows in memory, which is the point of asking the
     * server for them.
     */
    page?: { total: number; hasMore: boolean };
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
  const serverPage = options.page;
  const pageItems = (
    serverPage
      ? items
      : items.slice(resolvedOffset, resolvedOffset + resolvedLimit)
  ).map(options.mapItem);
  const hasMore =
    serverPage?.hasMore ?? resolvedOffset + pageItems.length < items.length;
  return {
    total: serverPage?.total ?? items.length,
    offset: resolvedOffset,
    limit: resolvedLimit,
    returned: pageItems.length,
    hasMore,
    // Advance by the page SIZE, not by how many rows survived mapping. The
    // server paged by `limit`, so advancing by a short page would re-read rows
    // the caller already has — and a fully-dropped page would leave
    // `nextOffset === offset` while `hasMore` is true, which is a
    // non-terminating loop for an agent told to page until `hasMore` is false.
    nextOffset: hasMore
      ? resolvedOffset + (serverPage ? resolvedLimit : pageItems.length)
      : null,
    items: pageItems,
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

/**
 * Per-session webapp URL builder. The org slug is read through a getter per
 * URL — never from module state, and never frozen for the session's lifetime.
 * `apps/mcp` is ONE process serving every org, so a module-level slug is
 * cross-tenant state: whichever session initialized last would stamp its org's
 * slug into every other tenant's `webUrl` (ISS-6570). The getter also lets the
 * owner expire a binding it can no longer vouch for (org slugs are editable and
 * a released slug can be claimed by another org — see `session-urls.ts`). A null
 * slug degrades to org-less URLs, which the app proxy redirects to the caller's
 * own org.
 */
export type McpUrlBuilder = {
  withOrgPrefix(path: string): string;
  buildDocumentUrlFromRecord(row: Record<string, unknown>): string | null;
};

export function createUrlBuilder(
  getOrgSlug: () => string | null
): McpUrlBuilder {
  // ISS-12855: documents route at `/documents/<slug>`; legacy per-type URLs
  // redirect there.
  const buildDocumentUrl = (slug: string, documentType: string): string => {
    const prefix = getRoutePrefixForType(documentType) ?? DOCUMENT_ROUTE_PREFIX;
    return `${WEBAPP_URL}${buildScopedDocumentPath(
      prefix,
      encodePathSegment(slug),
      getOrgSlug()
    )}`;
  };

  return {
    // Raw prefixing for pre-resolved route paths (unified search). Entity URLs
    // below go through the canonical `buildScopedDocumentPath` instead.
    withOrgPrefix(path: string): string {
      const orgSlug = getOrgSlug();
      return orgSlug
        ? `${WEBAPP_URL}/${orgSlug}${path}`
        : `${WEBAPP_URL}${path}`;
    },
    buildDocumentUrlFromRecord(row: Record<string, unknown>): string | null {
      const slug = readString(row.slug);
      const docType = readString(row.type);
      // Stay total: this builder's contract is a null webUrl for a row it
      // cannot address, not a thrown error that would fail every sibling row
      // in the same `.map()`.
      if (!(slug && docType) || isDotPathSegment(slug)) {
        return null;
      }
      return buildDocumentUrl(slug, docType);
    },
  };
}

/**
 * A segment `new URL(path, base)` RESOLVES AWAY instead of sending, so it
 * silently retargets the request: `/agent-sessions/../trace-comments` becomes
 * `/trace-comments`, the org-wide aggregate. Encoding cannot save it — the URL
 * parser strips the segment whether it is written `..` or `%2E%2E` — so every
 * consumer either rejects it or degrades, and neither value is ever a real id.
 */
export function isDotPathSegment(id: string): boolean {
  return id === "." || id === "..";
}

/**
 * Schema for a REQUIRED entity id-or-slug tool argument. A bare `z.string()`
 * rejects a missing or blank value with the SDK's opaque
 * `-32602 … expected string, received undefined`, which an agent cannot act on
 * (ISS-7080); this attaches an actionable message that names the entity kind
 * and how to find a valid value. The schema also rejects blank, whitespace-only,
 * `.` and `..` values before they can retarget a request path.
 */
export function requiredIdOrSlug(
  entityLabel: string,
  example: string | string[],
  discoveryHint?: string
): z.ZodString {
  const friendly = idOrSlugRequiredMessage(entityLabel, example, discoveryHint);
  return z
    .string({ error: friendly })
    .trim()
    .min(1, { error: friendly })
    .refine((value) => !isDotPathSegment(value), { error: friendly })
    .describe(describeIdOrSlug(entityLabel, example));
}

function formatIdOrSlugExamples(example: string | string[]): string {
  return Array.isArray(example) ? example.join(", ") : example;
}

/**
 * The actionable "missing id" message {@link requiredIdOrSlug} attaches, for a
 * handler that enforces the same requirement conditionally.
 */
export function idOrSlugRequiredMessage(
  entityLabel: string,
  example: string | string[],
  discoveryHint?: string
): string {
  const base = `A ${entityLabel} UUID or user-facing slug is required (e.g. ${formatIdOrSlugExamples(example)}).`;
  return discoveryHint ? `${base} ${discoveryHint}` : base;
}
