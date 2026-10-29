import {
  MAX_CREATE_DOCUMENT_VERSION_REQUEST_BODY_BYTES as SHARED_MAX_CREATE_DOCUMENT_VERSION_REQUEST_BODY_BYTES,
  MAX_DOCUMENT_VERSION_INLINE_EXPANDED_CONTENT_CHARS as SHARED_MAX_DOCUMENT_VERSION_INLINE_EXPANDED_CONTENT_CHARS,
  MAX_DOCUMENT_VERSION_INLINE_IMAGE_ALT_TEXT_CHARS as SHARED_MAX_DOCUMENT_VERSION_INLINE_IMAGE_ALT_TEXT_CHARS,
  MAX_DOCUMENT_VERSION_INLINE_IMAGE_FILENAME_CHARS as SHARED_MAX_DOCUMENT_VERSION_INLINE_IMAGE_FILENAME_CHARS,
  MAX_DOCUMENT_VERSION_INLINE_IMAGE_PLACEHOLDER_CHARS as SHARED_MAX_DOCUMENT_VERSION_INLINE_IMAGE_PLACEHOLDER_CHARS,
  MAX_DOCUMENT_VERSION_INLINE_IMAGES as SHARED_MAX_DOCUMENT_VERSION_INLINE_IMAGES,
} from "@closedloop-ai/loops-api/document";
import type {
  FileAttachment,
  ImageMimeType,
  INLINE_ATTACHMENT_REF_PREFIX,
} from "./attachment.js";

export type DocumentVersion = {
  id: string;
  documentId: string;
  version: number;
  content: string | null;
  createdById: string | null;
  createdAt: Date;
};

export const MAX_DOCUMENT_VERSION_INLINE_IMAGES =
  SHARED_MAX_DOCUMENT_VERSION_INLINE_IMAGES;
export const MAX_DOCUMENT_VERSION_INLINE_IMAGE_FILENAME_CHARS =
  SHARED_MAX_DOCUMENT_VERSION_INLINE_IMAGE_FILENAME_CHARS;
export const MAX_DOCUMENT_VERSION_INLINE_IMAGE_PLACEHOLDER_CHARS =
  SHARED_MAX_DOCUMENT_VERSION_INLINE_IMAGE_PLACEHOLDER_CHARS;
export const MAX_DOCUMENT_VERSION_INLINE_IMAGE_ALT_TEXT_CHARS =
  SHARED_MAX_DOCUMENT_VERSION_INLINE_IMAGE_ALT_TEXT_CHARS;
export const MAX_CREATE_DOCUMENT_VERSION_REQUEST_BODY_BYTES =
  SHARED_MAX_CREATE_DOCUMENT_VERSION_REQUEST_BODY_BYTES;
export const MAX_DOCUMENT_VERSION_INLINE_EXPANDED_CONTENT_CHARS =
  SHARED_MAX_DOCUMENT_VERSION_INLINE_EXPANDED_CONTENT_CHARS;

export const CreateDocumentVersionErrorCode = {
  DocumentNotFound: "document_not_found",
  DuplicateInlineImagePlaceholder: "duplicate_inline_image_placeholder",
  ExpandedContentTooLarge: "expanded_inline_image_content_too_large",
  InlineImageCreationFailed: "inline_image_creation_failed",
  MissingInlineImagePlaceholder: "missing_inline_image_placeholder",
  OverlappingInlineImagePlaceholder: "overlapping_inline_image_placeholder",
  RequestBodyTooLarge: "document_version_inline_images_request_too_large",
  VersionCreationFailed: "document_version_create_failed",
} as const;
export type CreateDocumentVersionErrorCode =
  (typeof CreateDocumentVersionErrorCode)[keyof typeof CreateDocumentVersionErrorCode];

export type CreateDocumentVersionInlineImageInput = {
  placeholder: string;
  filename: string;
  mimeType: ImageMimeType;
  dataBase64: string;
  altText?: string;
};

export type CreatedDocumentVersionInlineImage = {
  placeholder: string;
  attachmentId: string;
  attachmentRef: `${typeof INLINE_ATTACHMENT_REF_PREFIX}${string}`;
  markdownImage: string;
  attachment: FileAttachment;
};

/**
 * Postgres int4 max. `DocumentVersion.version` is a Prisma `Int`, so an ordinal
 * above this cannot name a row — but Prisma rejects the out-of-range comparand
 * rather than returning empty, and the callers' catch would report that as a
 * 500. Named per-domain like the repo's other int4 bounds (`PR_INT_MAX`,
 * `FRUSTRATION_RAW_MAX`) rather than reusing one that documents another column.
 */
export const MAX_DOCUMENT_VERSION_NUMBER = 2_147_483_647;

/**
 * The single guard every version locator shares: the API's `?version=` query
 * param and `/versions/{versionRef}` path segment, and the app detail pages'
 * `?version=` param. `Number.isInteger` already rejects `NaN` and `Infinity`,
 * so an unparseable or overlong digit string fails here too.
 */
export function isValidVersionNumber(value: number): boolean {
  return (
    Number.isInteger(value) &&
    value >= 1 &&
    value <= MAX_DOCUMENT_VERSION_NUMBER
  );
}
