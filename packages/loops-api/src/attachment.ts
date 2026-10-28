export type FileAttachment = {
  id: string;
  artifactId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
  createdById: string;
  purpose?: AttachmentPurpose;
  previewUrl?: string;
};

export const AttachmentPurpose = {
  Context: "context",
  Inline: "inline",
} as const;
export type AttachmentPurpose =
  (typeof AttachmentPurpose)[keyof typeof AttachmentPurpose];

export const AttachmentPurposeSelector = {
  Context: "context",
  Inline: "inline",
  All: "all",
} as const;
export type AttachmentPurposeSelector =
  (typeof AttachmentPurposeSelector)[keyof typeof AttachmentPurposeSelector];

export const MAX_ATTACHMENT_FILE_SIZE_BYTES = 10 * 1024 * 1024;
export const MAX_INLINE_IMAGE_ATTACHMENT_BYTES = 512 * 1024;
export const MAX_INLINE_IMAGE_ATTACHMENT_BASE64_CHARS =
  Math.ceil(MAX_INLINE_IMAGE_ATTACHMENT_BYTES / 3) * 4;
export const MAX_INLINE_IMAGE_ATTACHMENT_REQUEST_BODY_BYTES = 768 * 1024;
/**
 * Per-request cap the inline-image resolve endpoint enforces. A caller that can
 * hold more refs than this splits at exactly this size: one over-limit request
 * is a 400 that takes every ref in it down, not just the ones past the cap.
 */
export const MAX_INLINE_IMAGE_RESOLVE_BATCH_SIZE = 50;
export const INLINE_ATTACHMENT_REF_PREFIX = "attachment://" as const;

export const AttachmentUploadError = {
  RateLimited: "rate_limited",
} as const;
export type AttachmentUploadError = {
  type: (typeof AttachmentUploadError)["RateLimited"];
  retryAfterSeconds: number;
};

export const AttachmentUploadResponseErrorCode = {
  McpUploadDisabled: "mcp_attachment_upload_disabled",
  RateLimited: "attachment_upload_rate_limited",
} as const;
export type AttachmentUploadResponseErrorCode =
  (typeof AttachmentUploadResponseErrorCode)[keyof typeof AttachmentUploadResponseErrorCode];

export const CreateInlineImageAttachmentErrorCode = {
  DocumentNotFound: "document_not_found",
  InvalidBase64: "invalid_inline_image_base64",
  MimeMismatch: "inline_image_mime_mismatch",
  PayloadTooLarge: "inline_image_too_large",
  PersistenceFailed: "attachment_persistence_failed",
  RateLimited: AttachmentUploadError.RateLimited,
  StorageUnconfigured: "file_attachments_storage_unconfigured",
  StorageWriteFailed: "attachment_storage_write_failed",
  UnsupportedMimeType: "unsupported_image_mime_type",
} as const;
export type CreateInlineImageAttachmentErrorCode =
  (typeof CreateInlineImageAttachmentErrorCode)[keyof typeof CreateInlineImageAttachmentErrorCode];

export const IMAGE_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
] as const;
export type ImageMimeType = (typeof IMAGE_MIME_TYPES)[number];

export function isImageMimeType(mimeType: string): mimeType is ImageMimeType {
  return IMAGE_MIME_TYPES.some((imageMimeType) => imageMimeType === mimeType);
}

const DOCUMENT_MIME_TYPES: readonly string[] = [
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/markdown",
  "text/html",
] as const;

export function isDocumentMimeType(mimeType: string): boolean {
  return DOCUMENT_MIME_TYPES.includes(mimeType);
}

export function buildInlineAttachmentRef(
  attachmentId: string
): `${typeof INLINE_ATTACHMENT_REF_PREFIX}${string}` {
  return `${INLINE_ATTACHMENT_REF_PREFIX}${attachmentId}`;
}

export function buildInlineAttachmentMarkdownImage(
  attachmentRef: `${typeof INLINE_ATTACHMENT_REF_PREFIX}${string}`,
  altText: string | undefined,
  filename: string
): string {
  const rawAltText =
    altText?.trim() || filename || DEFAULT_INLINE_IMAGE_ALT_TEXT;
  const escapedAltText = rawAltText
    .replace(MARKDOWN_ALT_TEXT_LINE_BREAK_REGEX, " ")
    .replace(MARKDOWN_ALT_TEXT_CLOSE_BRACKET_REGEX, String.raw`\]`)
    .trim();
  return `![${escapedAltText || DEFAULT_INLINE_IMAGE_ALT_TEXT}](${attachmentRef})`;
}

/**
 * Split inline-image refs into requests the resolve endpoint will accept. Lives
 * here, beside the cap it reads, so the MCP reader and the web editor cannot
 * drift into two different splits of the same limit.
 */
export function chunkInlineImageAttachmentIds(
  attachmentIds: readonly string[]
): string[][] {
  const chunks: string[][] = [];
  for (
    let index = 0;
    index < attachmentIds.length;
    index += MAX_INLINE_IMAGE_RESOLVE_BATCH_SIZE
  ) {
    chunks.push(
      attachmentIds.slice(index, index + MAX_INLINE_IMAGE_RESOLVE_BATCH_SIZE)
    );
  }
  return chunks;
}

const MARKDOWN_ALT_TEXT_CLOSE_BRACKET_REGEX = /]/g;
const MARKDOWN_ALT_TEXT_LINE_BREAK_REGEX = /[\r\n]+/g;
const DEFAULT_INLINE_IMAGE_ALT_TEXT = "image";

/**
 * Ids of the attachments a Markdown body renders as inline images.
 *
 * Kept beside {@link buildInlineAttachmentMarkdownImage} — the writer of this
 * exact token — so the parser and the writer of one format cannot drift apart.
 * The alt-text class therefore crosses the `\]` that writer emits for a `]` in
 * alt text; before ISS-8036 it stopped there, and a rendered image was reported
 * as unreferenced.
 *
 * One bound it does NOT have, pinned by a test: a ref inside a fenced code block
 * still matches, because the pattern carries no fence awareness.
 */
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

/**
 * Rewrite each inline image ref whose id `resolve` can map, leaving the rest of
 * the token — and every unresolvable ref — byte-identical.
 *
 * Exported as a function rather than exposing the regex: a `/g` RegExp carries a
 * mutable `lastIndex`, and a future `.test()`/`.exec()` on a shared instance
 * would make the NEXT extract call skip matches before that offset. That is
 * silent wrong data rather than a crash, so the state stays module-private.
 */
export function replaceInlineImageAttachmentRefs(
  content: string,
  resolve: (attachmentId: string) => string | undefined
): string {
  return content.replaceAll(INLINE_IMAGE_REF_REGEX, (match, attachmentId) => {
    const resolved = resolve(attachmentId);
    return resolved
      ? match.replace(buildInlineAttachmentRef(attachmentId), resolved)
      : match;
  });
}

/**
 * The alt-text alternation is DISJOINT — `\\.` starts with a backslash and
 * `[^\\\]]` excludes one — so the scan stays linear on a body of arbitrary
 * length. An ambiguous spelling such as `(?:[^\]]|\\])*` accepts the same alt
 * texts but backtracks exponentially on a run of backslashes, and this runs over
 * user-authored document content.
 */
const INLINE_IMAGE_REF_REGEX =
  /!\[(?:\\.|[^\\\]])*]\(attachment:\/\/([0-9a-fA-F-]{36})(?:\s+"[^"]*")?\)/g;

/**
 * ISS-10415: media types accepted on artifact attachments. They carry their own
 * size ceiling — a screen recording or a voice note does not fit the 10 MB
 * document limit, and accepting the type while rejecting every real file is a
 * capability in name only.
 *
 * `.mov` is `video/quicktime` and `.mp3` is `audio/mpeg`; neither spells the way
 * its extension does, which is what this list exists to hold in one place.
 *
 * Hoisted here from the `apps/api` route directory so the picker, the MCP tool
 * and the route validator read ONE list. While it lived under a route, neither
 * client could import it, and both gated at the document ceiling.
 */
export const MEDIA_MIME_TYPES = [
  "video/quicktime",
  "video/mp4",
  "audio/mpeg",
] as const;
export type MediaMimeType = (typeof MEDIA_MIME_TYPES)[number];

export function isMediaMimeType(mimeType: string): mimeType is MediaMimeType {
  return MEDIA_MIME_TYPES.some((mediaMimeType) => mediaMimeType === mimeType);
}

/**
 * The ceiling for {@link MEDIA_MIME_TYPES}. Deliberately the SAME number the
 * context-attachment lane already allows rather than a new one invented here —
 * the two lanes accept the same media and should not disagree about how big it
 * may be.
 */
export const MAX_MEDIA_FILE_SIZE_BYTES = 500 * 1024 * 1024;

export const ALLOWED_ATTACHMENT_MIME_TYPES = [
  ...MEDIA_MIME_TYPES,
  ...IMAGE_MIME_TYPES,
  "application/pdf",
  "text/csv",
  "application/json",
  "text/plain",
  "text/markdown",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
] as const;
export type AllowedAttachmentMimeType =
  (typeof ALLOWED_ATTACHMENT_MIME_TYPES)[number];

/**
 * The picker's `accept=` attribute is DERIVED from this map, not hand-listed
 * beside it. ISS-10415 shipped its server half against three side inventories
 * that were all typed `string[]`, so adding a MIME to the allow-list compiled
 * cleanly while the picker kept offering the old extensions and the capability
 * stayed unreachable. An exhaustive `Record` keyed by the union cannot be
 * written without naming every member: a fourth MIME now fails `tsc` here until
 * someone says what a user would pick it by.
 */
const ATTACHMENT_FILE_EXTENSIONS: Record<
  AllowedAttachmentMimeType,
  readonly string[]
> = {
  "video/quicktime": [".mov"],
  "video/mp4": [".mp4"],
  "audio/mpeg": [".mp3"],
  "image/jpeg": [".jpg", ".jpeg"],
  "image/png": [".png"],
  "image/gif": [".gif"],
  "image/webp": [".webp"],
  "application/pdf": [".pdf"],
  "text/csv": [".csv"],
  "application/json": [".json"],
  "text/plain": [".txt"],
  "text/markdown": [".md"],
  "application/msword": [".doc"],
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [
    ".docx",
  ],
  "application/vnd.ms-excel": [".xls"],
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [
    ".xlsx",
  ],
};

/**
 * Comma-separated extension list for an HTML `<input accept="">` attribute.
 * Runtime MIME and size validation stays in the API validators; this is only
 * what the native picker offers.
 */
export const ALLOWED_EXTENSIONS = ALLOWED_ATTACHMENT_MIME_TYPES.flatMap(
  (mimeType) => ATTACHMENT_FILE_EXTENSIONS[mimeType]
).join(",");

/**
 * The size ceiling that actually applies to one file, so a client can reject it
 * early AND tell the user the limit it was measured against. A single
 * `MAX_ATTACHMENT_FILE_SIZE_BYTES` check here is what made the media path
 * unreachable from the picker.
 */
export function maxAttachmentSizeBytesForMimeType(mimeType: string): number {
  return isMediaMimeType(mimeType)
    ? MAX_MEDIA_FILE_SIZE_BYTES
    : MAX_ATTACHMENT_FILE_SIZE_BYTES;
}
