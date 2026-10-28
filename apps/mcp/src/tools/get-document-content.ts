import { createHash } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import {
  encodePathSegment,
  MAX_CURSOR_CHARS,
  requiredIdOrSlug,
  withErrorHandling,
} from "./tool-utils.js";

/** Register exact, byte-bounded document content retrieval. */
export function registerGetDocumentContent(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.registerTool(
    "get-document-content",
    {
      description:
        "Retrieve one exact immutable document-version body as UTF-8 text chunks. Start with documentId and optional version; continue with documentId and the returned unsigned cursor. Every response reports a half-open byte range, total bytes, resolved version, and full SHA-256. The cursor is an untrusted convenience selector, not authorization or valid-offset tamper detection.",
      inputSchema: {
        documentId: requiredIdOrSlug(
          "Document",
          ["PRD-7", "PLN-12", "ISS-42"],
          "Use list-documents to find one."
        ),
        version: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Positive immutable version number for an initial call. Omit for latest. Do not combine with cursor."
          ),
        cursor: z
          .string()
          .min(1)
          .max(MAX_CURSOR_CHARS)
          .regex(BASE64URL_CURSOR_REGEX)
          .optional()
          .describe(
            "Unsigned continuation cursor returned by a prior call. Do not combine with version."
          ),
        chunkSizeBytes: z
          .number()
          .int()
          .min(1)
          .max(MAX_CHUNK_SIZE_BYTES)
          .optional()
          .describe(
            `Maximum UTF-8 bytes in this chunk (default and maximum ${MAX_CHUNK_SIZE_BYTES}).`
          ),
      },
      outputSchema: {
        documentId: z.uuid(),
        resolvedVersion: z.number().int().positive(),
        content: z.string(),
        byteStart: z.number().int().nonnegative(),
        byteEndExclusive: z.number().int().nonnegative(),
        returnedBytes: z.number().int().nonnegative(),
        totalBytes: z.number().int().nonnegative(),
        contentSha256: z.string().regex(SHA256_HEX_REGEX),
        nextCursor: z
          .string()
          .max(MAX_CURSOR_CHARS)
          .regex(BASE64URL_CURSOR_REGEX)
          .nullable(),
      },
    },
    (input: GetDocumentContentInput) =>
      withErrorHandling(() => buildGetDocumentContentResult(apiClient, input))
  );
}

async function buildGetDocumentContentResult(
  apiClient: ApiClient,
  input: GetDocumentContentInput
) {
  const selector = resolveSelector(input);
  const path = `/documents/${encodePathSegment(input.documentId)}`;
  const response =
    selector.resolvedVersion === undefined
      ? await apiClient.get<unknown>(path)
      : await apiClient.get<unknown>(path, {
          version: String(selector.resolvedVersion),
        });
  const row = parseDocumentContentResponse(response);

  validateResolvedIdentity(row, selector);

  const bytes = Buffer.from(row.version.content, "utf8");
  const contentSha256 = createHash("sha256").update(bytes).digest("hex");
  if (
    selector.cursor !== undefined &&
    selector.cursor.contentSha256 !== contentSha256
  ) {
    throw new Error(
      "Continuation cursor digest does not match the selected immutable document version"
    );
  }

  const chunkSizeBytes = resolveChunkSizeBytes(input.chunkSizeBytes);
  const byteStart = selector.cursor?.nextByteOffset ?? 0;
  const chunk = selectUtf8Chunk(bytes, byteStart, chunkSizeBytes);
  const nextCursor =
    chunk.byteEndExclusive < bytes.length
      ? encodeCursor({
          schemaVersion: CURSOR_SCHEMA_VERSION,
          documentId: row.id,
          resolvedVersion: row.version.version,
          nextByteOffset: chunk.byteEndExclusive,
          contentSha256,
        })
      : null;
  const payload: GetDocumentContentPayload = {
    documentId: row.id,
    resolvedVersion: row.version.version,
    content: chunk.content,
    byteStart,
    byteEndExclusive: chunk.byteEndExclusive,
    returnedBytes: chunk.byteEndExclusive - byteStart,
    totalBytes: bytes.length,
    contentSha256,
    nextCursor,
  };

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(payload, null, 2),
      },
    ],
    structuredContent: payload,
  };
}

function resolveSelector(input: GetDocumentContentInput): ContentSelector {
  if (input.documentId.length === 0) {
    throw new Error("documentId must not be empty");
  }
  if (input.cursor !== undefined && input.version !== undefined) {
    throw new Error("cursor and version cannot be supplied together");
  }
  if (input.cursor !== undefined) {
    const cursor = decodeCursor(input.cursor);
    return { cursor, resolvedVersion: cursor.resolvedVersion };
  }
  if (
    input.version !== undefined &&
    !(Number.isInteger(input.version) && input.version > 0)
  ) {
    throw new Error("version must be a positive integer");
  }
  return { cursor: undefined, resolvedVersion: input.version };
}

function parseDocumentContentResponse(value: unknown): DocumentContentRow {
  const parsed = DOCUMENT_CONTENT_RESPONSE_SCHEMA.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      "Document API returned an invalid exact-content response: canonical document id, matching version document id, positive version, and string content are required"
    );
  }
  return parsed.data;
}

function validateResolvedIdentity(
  row: DocumentContentRow,
  selector: ContentSelector
): void {
  if (row.version.documentId !== row.id) {
    throw new Error(
      "Document API version documentId does not match the canonical document id"
    );
  }
  if (
    selector.resolvedVersion !== undefined &&
    row.version.version !== selector.resolvedVersion
  ) {
    throw new Error(
      "Document API resolved a different version than the requested or cursor-pinned version"
    );
  }
  if (selector.cursor !== undefined && row.id !== selector.cursor.documentId) {
    throw new Error(
      "Continuation cursor document id does not match the freshly resolved document"
    );
  }
}

function resolveChunkSizeBytes(value: number | undefined): number {
  const resolved = value ?? MAX_CHUNK_SIZE_BYTES;
  if (
    !(
      Number.isInteger(resolved) &&
      resolved >= 1 &&
      resolved <= MAX_CHUNK_SIZE_BYTES
    )
  ) {
    throw new Error(
      `chunkSizeBytes must be an integer between 1 and ${MAX_CHUNK_SIZE_BYTES}`
    );
  }
  return resolved;
}

function selectUtf8Chunk(
  bytes: Buffer,
  byteStart: number,
  chunkSizeBytes: number
): Utf8Chunk {
  if (
    !(
      Number.isInteger(byteStart) &&
      byteStart >= 0 &&
      byteStart <= bytes.length
    )
  ) {
    throw new Error("Continuation cursor byte offset is outside the document");
  }
  if (!isUtf8Boundary(bytes, byteStart)) {
    throw new Error(
      "Continuation cursor byte offset is not on a UTF-8 scalar boundary"
    );
  }

  let byteEndExclusive = Math.min(byteStart + chunkSizeBytes, bytes.length);
  while (
    byteEndExclusive > byteStart &&
    byteEndExclusive < bytes.length &&
    isUtf8ContinuationByte(bytes[byteEndExclusive] ?? 0)
  ) {
    byteEndExclusive--;
  }
  if (byteEndExclusive === byteStart && byteStart < bytes.length) {
    throw new Error(
      "chunkSizeBytes is too small to include the next complete UTF-8 scalar"
    );
  }

  return {
    byteEndExclusive,
    content: bytes.subarray(byteStart, byteEndExclusive).toString("utf8"),
  };
}

function isUtf8Boundary(bytes: Buffer, offset: number): boolean {
  return (
    offset === 0 ||
    offset === bytes.length ||
    !isUtf8ContinuationByte(bytes[offset] ?? 0)
  );
}

function isUtf8ContinuationByte(value: number): boolean {
  // biome-ignore lint/suspicious/noBitwiseOperators: UTF-8 continuation-byte detection requires masking the leading bits.
  return (value & UTF8_CONTINUATION_MASK) === UTF8_CONTINUATION_PREFIX;
}

function encodeCursor(cursor: DocumentContentCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string): DocumentContentCursor {
  if (
    value.length === 0 ||
    value.length > MAX_CURSOR_CHARS ||
    !BASE64URL_CURSOR_REGEX.test(value)
  ) {
    throw new Error("Continuation cursor is malformed or too large");
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) {
    throw new Error("Continuation cursor is not canonical base64url");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded.toString("utf8"));
  } catch {
    throw new Error("Continuation cursor does not contain valid JSON");
  }
  const result = DOCUMENT_CONTENT_CURSOR_SCHEMA.safeParse(parsed);
  if (!result.success) {
    throw new Error("Continuation cursor has an invalid schema");
  }
  return result.data;
}

const MAX_CHUNK_SIZE_BYTES = 64 * 1024;
const CURSOR_SCHEMA_VERSION = 1;
const UTF8_CONTINUATION_MASK = 0xc0;
const UTF8_CONTINUATION_PREFIX = 0x80;
const BASE64URL_CURSOR_REGEX = /^[A-Za-z0-9_-]+$/;
const SHA256_HEX_REGEX = /^[a-f0-9]{64}$/;

const DOCUMENT_CONTENT_RESPONSE_SCHEMA = z
  .object({
    id: z.uuid(),
    version: z
      .object({
        documentId: z.uuid(),
        version: z.number().int().positive(),
        content: z.string(),
      })
      .passthrough(),
  })
  .passthrough();

const DOCUMENT_CONTENT_CURSOR_SCHEMA = z
  .object({
    schemaVersion: z.literal(CURSOR_SCHEMA_VERSION),
    documentId: z.uuid(),
    resolvedVersion: z.number().int().positive(),
    nextByteOffset: z.number().int().nonnegative(),
    contentSha256: z.string().regex(SHA256_HEX_REGEX),
  })
  .strict();

type GetDocumentContentInput = {
  documentId: string;
  version?: number;
  cursor?: string;
  chunkSizeBytes?: number;
};

type DocumentContentRow = z.infer<typeof DOCUMENT_CONTENT_RESPONSE_SCHEMA>;
type DocumentContentCursor = z.infer<typeof DOCUMENT_CONTENT_CURSOR_SCHEMA>;

type ContentSelector = {
  cursor: DocumentContentCursor | undefined;
  resolvedVersion: number | undefined;
};

type Utf8Chunk = {
  content: string;
  byteEndExclusive: number;
};

type GetDocumentContentPayload = {
  documentId: string;
  resolvedVersion: number;
  content: string;
  byteStart: number;
  byteEndExclusive: number;
  returnedBytes: number;
  totalBytes: number;
  contentSha256: string;
  nextCursor: string | null;
};
