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

const MARKDOWN_ALT_TEXT_CLOSE_BRACKET_REGEX = /]/g;
const MARKDOWN_ALT_TEXT_LINE_BREAK_REGEX = /[\r\n]+/g;
const DEFAULT_INLINE_IMAGE_ALT_TEXT = "image";
