import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { LinkType } from "@repo/api/src/types/artifact.js";
import type {
  ResolvedInlineImage,
  ResolveInlineImagesResponse,
} from "@repo/api/src/types/attachment.js";
import type { DocumentDetail } from "@repo/api/src/types/document.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import { McpApiError } from "../api-error.js";
import {
  asRecord,
  buildDocumentUrlFromRecord,
  DOCUMENT_DOC_HELP,
  describeIdOrSlug,
  encodePathSegment,
  PARENT_ARTIFACT_METADATA_HELP,
  type ParentArtifactProjectionInput,
  readNumber,
  readString,
  truncateString,
  withErrorHandling,
  withParentArtifactProjection,
} from "./tool-utils.js";

const DEFAULT_CONTENT_MAX_CHARS = 4000;
const MAX_CONTENT_MAX_CHARS = 120_000;
const INLINE_IMAGE_REF_REGEX =
  /!\[[^\]]*]\(attachment:\/\/([0-9a-fA-F-]{36})(?:\s+"[^"]*")?\)/g;
const MARKDOWN_IMAGE_TOKEN_REGEX = /!\[[^\]]*]\([^)]*\)/g;
const INLINE_IMAGE_RESOLVE_BATCH_SIZE = 50;
const MCP_IMAGE_BLOCK_MAX_COUNT = 10;
const MCP_IMAGE_BLOCK_MAX_BYTES = 2 * 1024 * 1024;
const MCP_IMAGE_BLOCK_AGGREGATE_MAX_BYTES = 6 * 1024 * 1024;
const MCP_IMAGE_FETCH_TIMEOUT_MS = 10_000;

type JsonDocumentDetail = Partial<
  Omit<DocumentDetail, "createdAt" | "updatedAt" | "dueDate" | "version">
> & {
  createdAt?: string | null;
  updatedAt?: string | null;
  dueDate?: string | null;
  version?: {
    id?: string | null;
    version?: number | null;
    createdAt?: string | null;
    createdById?: string | null;
    content?: string | null;
  } | null;
};

type JsonParentProjection = ParentArtifactProjectionInput & {
  targetId: string;
};

type DocumentDetailResponse =
  | JsonDocumentDetail
  | { data?: JsonDocumentDetail };

type InlineImageManifestEntry = {
  attachmentId: string;
  status: "resolved" | "skipped";
  url?: string;
  filename?: string;
  mimeType?: string;
  sizeBytes?: number;
  expiresAt?: string;
  reason?: string;
};

type InlineImageSkip = {
  attachmentId: string;
  reason: string;
};

type InlineImageResolution = {
  manifest: InlineImageManifestEntry[];
  resolvedById: Map<string, ResolvedInlineImage>;
};

type GetDocumentToolInput = {
  documentId: string;
  includeContent?: boolean;
  contentMaxChars?: number;
  includeParentArtifact?: boolean;
  resolveInlineImages?: boolean;
  includeImages?: boolean;
};

/**
 * Shape an API document detail payload for the `get-document` MCP response.
 * Parent metadata is top-level MCP output derived from artifact-link lineage.
 */
export function shapeGetDocumentPayload(
  response: DocumentDetailResponse,
  options: {
    includeContent?: boolean;
    contentMaxChars?: number;
    parentProjection?: JsonParentProjection | null;
    inlineImages?: InlineImageManifestEntry[];
    inlineImageBlockSkips?: InlineImageManifestEntry[];
    contentWithResolvedInlineImages?: string;
  } = {}
) {
  const envelope = asRecord(response);
  const row = asRecord(envelope.data ?? response);
  const version = asRecord(row.version);
  const rawContent = readString(version.content) ?? "";
  const resolvedContentMaxChars =
    options.contentMaxChars ?? DEFAULT_CONTENT_MAX_CHARS;
  const content =
    options.includeContent === true
      ? truncateString(rawContent, resolvedContentMaxChars)
      : undefined;

  const base = {
    id: readString(row.id),
    title: readString(row.title),
    slug: readString(row.slug),
    type: readString(row.type),
    status: readString(row.status),
    projectId: readString(row.projectId),
    priority: readString(row.priority),
    fileName: readString(row.fileName),
    assigneeId: readString(row.assigneeId),
    assignee: row.assignee ?? null,
    approverId: readString(row.approverId),
    approver: row.approver ?? null,
    // Immutable per-document repository record, set at creation (PLN-602).
    repositorySnapshot: row.repositorySnapshot ?? null,
    // Stack-rank position within the project (PRD-421); lower sorts first,
    // null when unranked. Lets agents read order before calling move-artifact.
    sortOrder: readNumber(row.sortOrder),
    latestVersion: readNumber(row.latestVersion),
    updatedAt: readString(row.updatedAt),
    version: {
      id: readString(version.id),
      version: readNumber(version.version),
      createdAt: readString(version.createdAt),
      createdById: readString(version.createdById),
      contentLength: rawContent.length,
      ...(options.includeContent === true ? { content } : {}),
    },
    ...(options.inlineImages ? { inlineImages: options.inlineImages } : {}),
    ...(options.inlineImageBlockSkips
      ? { inlineImageBlockSkips: options.inlineImageBlockSkips }
      : {}),
    ...(options.contentWithResolvedInlineImages
      ? {
          contentWithResolvedInlineImages:
            options.contentWithResolvedInlineImages,
        }
      : {}),
  };
  return options.parentProjection === undefined
    ? base
    : withParentArtifactProjection(base, options.parentProjection);
}

export function extractInlineImageAttachmentIds(content: string): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const match of content.matchAll(INLINE_IMAGE_REF_REGEX)) {
    const id = match[1];
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

function replaceInlineImageRefs(
  content: string,
  resolvedById: Map<string, ResolvedInlineImage>
): string {
  return content.replaceAll(INLINE_IMAGE_REF_REGEX, (match, attachmentId) => {
    const resolved = resolvedById.get(attachmentId);
    return resolved
      ? match.replace(`attachment://${attachmentId}`, resolved.url)
      : match;
  });
}

function truncateMarkdownImageSafe(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  let safeLimit = maxChars;
  for (const match of value.matchAll(MARKDOWN_IMAGE_TOKEN_REGEX)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (start >= maxChars) {
      break;
    }
    if (end > maxChars) {
      safeLimit = start;
      break;
    }
  }

  return `${value.slice(0, safeLimit)}...[truncated]`;
}

function buildContentWithResolvedInlineImages(
  content: string,
  resolvedById: Map<string, ResolvedInlineImage>,
  maxChars: number
): string {
  return truncateMarkdownImageSafe(
    replaceInlineImageRefs(content, resolvedById),
    maxChars
  );
}

function chunkIds(ids: string[]): string[][] {
  const chunks: string[][] = [];
  for (
    let index = 0;
    index < ids.length;
    index += INLINE_IMAGE_RESOLVE_BATCH_SIZE
  ) {
    chunks.push(ids.slice(index, index + INLINE_IMAGE_RESOLVE_BATCH_SIZE));
  }
  return chunks;
}

function getInlineImageResolveFailureReason(error: unknown): string {
  if (error instanceof McpApiError && error.status === 404) {
    return "resolver_unavailable";
  }
  return "resolve_failed";
}

async function resolveInlineImagesForMcp(
  apiClient: ApiClient,
  documentId: string,
  attachmentIds: string[]
): Promise<InlineImageResolution> {
  const chunkResults = await Promise.all(
    chunkIds(attachmentIds).map(async (chunk) => {
      const images: ResolvedInlineImage[] = [];
      const skipped: InlineImageSkip[] = [];

      try {
        const response = await apiClient.post<ResolveInlineImagesResponse>(
          `/documents/${encodePathSegment(documentId)}/attachments/resolve`,
          { attachmentIds: chunk }
        );
        images.push(...(Array.isArray(response.images) ? response.images : []));
        skipped.push(
          ...(Array.isArray(response.skipped) ? response.skipped : [])
        );
      } catch (error) {
        const reason = getInlineImageResolveFailureReason(error);
        skipped.push(
          ...chunk.map((attachmentId) => ({
            attachmentId,
            reason,
          }))
        );
      }

      return { images, skipped };
    })
  );

  const images: ResolvedInlineImage[] = [];
  const skipped: InlineImageSkip[] = [];
  for (const result of chunkResults) {
    images.push(...result.images);
    skipped.push(...result.skipped);
  }

  const resolvedById = new Map(
    images.map((image) => [image.attachmentId, image])
  );
  const skippedById = new Map(skipped.map((item) => [item.attachmentId, item]));
  const manifest = attachmentIds.map((attachmentId) => {
    const image = resolvedById.get(attachmentId);
    if (image) {
      return {
        attachmentId,
        status: "resolved" as const,
        url: image.url,
        filename: image.filename,
        mimeType: image.mimeType,
        sizeBytes: image.sizeBytes,
        expiresAt: image.expiresAt,
      };
    }
    return {
      attachmentId,
      status: "skipped" as const,
      reason: skippedById.get(attachmentId)?.reason ?? "not_found",
    };
  });

  return { manifest, resolvedById };
}

// Presigned inline-image URLs carry a signature in the query string; strip it
// before logging so image-fetch diagnostics never leak the signed credential.
function describeInlineImageUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "<unparseable-url>";
  }
}

// A fetch/URL-parse failure echoes the raw URL in its message (e.g. Node's
// "Failed to parse URL from <rawUrl>"), which bypasses describeInlineImageUrl
// and would leak X-Amz-Signature into logs. Redact the raw URL (and any residual
// signature param) from the error detail before it is written.
function sanitizeInlineImageErrorDetail(
  detail: string,
  rawUrl: string
): string {
  return detail
    .replaceAll(rawUrl, describeInlineImageUrl(rawUrl))
    .replace(/X-Amz-Signature=[^&\s]+/gi, "X-Amz-Signature=REDACTED");
}

async function fetchInlineImageBlocks(
  images: ResolvedInlineImage[],
  documentId: string
): Promise<{
  blocks: { type: "image"; data: string; mimeType: string }[];
  skipped: InlineImageManifestEntry[];
}> {
  const blocks: { type: "image"; data: string; mimeType: string }[] = [];
  const skipped: InlineImageManifestEntry[] = [];
  let aggregateBytes = 0;

  for (const image of images.slice(0, MCP_IMAGE_BLOCK_MAX_COUNT)) {
    if (image.sizeBytes > MCP_IMAGE_BLOCK_MAX_BYTES) {
      skipped.push({
        attachmentId: image.attachmentId,
        status: "skipped",
        reason: "image_block_too_large",
      });
      continue;
    }
    try {
      const abortController = new AbortController();
      const timeout = setTimeout(
        () => abortController.abort(),
        MCP_IMAGE_FETCH_TIMEOUT_MS
      );
      const response = await fetch(image.url, {
        signal: abortController.signal,
      }).finally(() => clearTimeout(timeout));
      if (!response.ok) {
        throw new Error(
          `HTTP ${response.status} ${response.statusText}`.trim()
        );
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.byteLength > MCP_IMAGE_BLOCK_MAX_BYTES) {
        skipped.push({
          attachmentId: image.attachmentId,
          status: "skipped",
          reason: "image_block_too_large",
        });
        continue;
      }
      if (
        aggregateBytes + bytes.byteLength >
        MCP_IMAGE_BLOCK_AGGREGATE_MAX_BYTES
      ) {
        skipped.push({
          attachmentId: image.attachmentId,
          status: "skipped",
          reason: "image_block_budget_exceeded",
        });
        continue;
      }
      aggregateBytes += bytes.byteLength;
      blocks.push({
        type: "image",
        data: bytes.toString("base64"),
        mimeType: image.mimeType,
      });
    } catch (error) {
      const detail = sanitizeInlineImageErrorDetail(
        error instanceof Error ? error.message : String(error),
        image.url
      );
      console.warn(
        `[mcp] get-document: failed to fetch inline image attachment ${image.attachmentId} (${image.filename}) for document ${documentId} from ${describeInlineImageUrl(image.url)}: ${detail}. The presigned image URL may have expired (expiresAt ${image.expiresAt}); re-fetch the document to refresh inline image URLs.`
      );
      skipped.push({
        attachmentId: image.attachmentId,
        status: "skipped",
        reason: "image_block_fetch_failed",
      });
    }
  }

  for (const image of images.slice(MCP_IMAGE_BLOCK_MAX_COUNT)) {
    skipped.push({
      attachmentId: image.attachmentId,
      status: "skipped",
      reason: "image_block_count_exceeded",
    });
  }

  return { blocks, skipped };
}

async function fetchParentProjection(
  apiClient: ApiClient,
  documentId: string | null
): Promise<JsonParentProjection | null | undefined> {
  if (!documentId) {
    return null;
  }
  try {
    const projections = await apiClient.get<JsonParentProjection[]>(
      "/artifact-links/parents",
      { targetIds: [documentId], linkType: LinkType.Produces }
    );
    return (
      projections.find((projection) => projection.targetId === documentId) ?? {
        targetId: documentId,
        linkId: null,
        linkType: null,
        linkCreatedAt: null,
        parentArtifact: null,
      }
    );
  } catch (error) {
    if (error instanceof McpApiError && error.status === 404) {
      return undefined;
    }
    throw error;
  }
}

async function buildGetDocumentToolResult(
  apiClient: ApiClient,
  input: GetDocumentToolInput
) {
  const response = await apiClient.get<JsonDocumentDetail>(
    `/documents/${encodePathSegment(input.documentId)}`
  );
  const row = asRecord(asRecord(response).data ?? response);
  const version = asRecord(row.version);
  const rawContent = readString(version.content) ?? "";
  const resolvedDocumentId = readString(row.id);
  const parentProjection =
    input.includeParentArtifact === false
      ? undefined
      : await fetchParentProjection(apiClient, readString(row.id));
  const shouldResolveInlineImages =
    input.includeContent === true &&
    input.resolveInlineImages !== false &&
    !!resolvedDocumentId;
  const inlineImageIds = shouldResolveInlineImages
    ? extractInlineImageAttachmentIds(rawContent)
    : [];
  const inlineResolution =
    resolvedDocumentId && shouldResolveInlineImages && inlineImageIds.length > 0
      ? await resolveInlineImagesForMcp(
          apiClient,
          resolvedDocumentId,
          inlineImageIds
        )
      : null;
  const imageBlocks =
    input.includeImages === true && inlineResolution
      ? await fetchInlineImageBlocks(
          inlineImageIds
            .map((id) => inlineResolution.resolvedById.get(id))
            .filter((image): image is ResolvedInlineImage => !!image),
          input.documentId
        )
      : null;
  const resolvedContentMaxChars =
    input.contentMaxChars ?? DEFAULT_CONTENT_MAX_CHARS;
  const payload = shapeGetDocumentPayload(response, {
    includeContent: input.includeContent,
    contentMaxChars: input.contentMaxChars,
    parentProjection,
    inlineImages: inlineResolution?.manifest,
    inlineImageBlockSkips: imageBlocks?.skipped,
    contentWithResolvedInlineImages: inlineResolution
      ? buildContentWithResolvedInlineImages(
          rawContent,
          inlineResolution.resolvedById,
          resolvedContentMaxChars
        )
      : undefined,
  });

  const webUrl = buildDocumentUrlFromRecord(row);
  const contentBlocks: (
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  )[] = [
    {
      type: "text" as const,
      text: JSON.stringify({ ...payload, webUrl }, null, 2),
    },
  ];

  if (imageBlocks) {
    contentBlocks.push(...imageBlocks.blocks);
  }

  return { content: contentBlocks };
}

/**
 * Register the get-document tool on the given MCP server.
 * Calls GET /documents/:documentId to retrieve a single document.
 */
export function registerGetDocument(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.registerTool(
    "get-document",
    {
      description: `Get one document — a PRD (PRD-*), implementation plan (PLN-*), or feature (FEA-*) — by UUID or slug. When the user references a record by its slug (e.g. "show me FEA-42"), pass that slug as documentId directly; no UUID lookup is needed. ${PARENT_ARTIFACT_METADATA_HELP}`,
      inputSchema: {
        documentId: z
          .string()
          .describe(
            describeIdOrSlug("Document", ["PRD-7", "PLN-12", "FEA-42"])
          ),
        includeContent: z
          .boolean()
          .optional()
          .describe(
            `Include the latest version content in the response. ${DOCUMENT_DOC_HELP} Default false.`
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
        includeParentArtifact: z
          .boolean()
          .optional()
          .describe(
            "Include the selected direct parentArtifact projection from artifact-link lineage. Default true; set false when parent context is not needed."
          ),
        resolveInlineImages: z
          .boolean()
          .optional()
          .describe(
            "Resolve attachment:// inline image refs when includeContent=true. Default true with includeContent; false skips the extra API call."
          ),
        includeImages: z
          .boolean()
          .optional()
          .describe(
            "When true, fetch bounded inline images and return MCP image content blocks. Requires includeContent=true with resolveInlineImages not set to false — image fetching reuses the inline-image resolution performed for content, so on its own this returns no image blocks. Default false."
          ),
      },
    },
    (input) =>
      withErrorHandling(() => buildGetDocumentToolResult(apiClient, input))
  );
}
