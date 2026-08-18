import {
  IMAGE_MIME_TYPES as SHARED_IMAGE_MIME_TYPES,
  INLINE_ATTACHMENT_REF_PREFIX as SHARED_INLINE_ATTACHMENT_REF_PREFIX,
  MAX_ATTACHMENT_FILE_SIZE_BYTES as SHARED_MAX_ATTACHMENT_FILE_SIZE_BYTES,
  MAX_INLINE_IMAGE_ATTACHMENT_BASE64_CHARS as SHARED_MAX_INLINE_IMAGE_ATTACHMENT_BASE64_CHARS,
  MAX_INLINE_IMAGE_ATTACHMENT_BYTES as SHARED_MAX_INLINE_IMAGE_ATTACHMENT_BYTES,
  MAX_INLINE_IMAGE_ATTACHMENT_REQUEST_BODY_BYTES as SHARED_MAX_INLINE_IMAGE_ATTACHMENT_REQUEST_BODY_BYTES,
  AttachmentPurpose as SharedAttachmentPurpose,
  AttachmentPurposeSelector as SharedAttachmentPurposeSelector,
  AttachmentUploadError as SharedAttachmentUploadError,
  type AttachmentUploadError as SharedAttachmentUploadErrorType,
  AttachmentUploadResponseErrorCode as SharedAttachmentUploadResponseErrorCode,
  type AttachmentUploadResponseErrorCode as SharedAttachmentUploadResponseErrorCodeType,
  CreateInlineImageAttachmentErrorCode as SharedCreateInlineImageAttachmentErrorCode,
  type CreateInlineImageAttachmentErrorCode as SharedCreateInlineImageAttachmentErrorCodeType,
  buildInlineAttachmentMarkdownImage as sharedBuildInlineAttachmentMarkdownImage,
  buildInlineAttachmentRef as sharedBuildInlineAttachmentRef,
  isDocumentMimeType as sharedIsDocumentMimeType,
  isImageMimeType as sharedIsImageMimeType,
} from "@closedloop-ai/loops-api/attachment";

// Attachment types for API contract
// These are explicitly defined to keep packages/api independent of database

export const AttachmentPurpose = SharedAttachmentPurpose;
export type AttachmentPurpose =
  (typeof AttachmentPurpose)[keyof typeof AttachmentPurpose];
export const AttachmentPurposeSelector = SharedAttachmentPurposeSelector;
export type AttachmentPurposeSelector =
  (typeof AttachmentPurposeSelector)[keyof typeof AttachmentPurposeSelector];
export const AttachmentUploadError = SharedAttachmentUploadError;
export type AttachmentUploadError = SharedAttachmentUploadErrorType;
export const AttachmentUploadResponseErrorCode =
  SharedAttachmentUploadResponseErrorCode;
export type AttachmentUploadResponseErrorCode =
  SharedAttachmentUploadResponseErrorCodeType;
export const CreateInlineImageAttachmentErrorCode =
  SharedCreateInlineImageAttachmentErrorCode;
export type CreateInlineImageAttachmentErrorCode =
  SharedCreateInlineImageAttachmentErrorCodeType;
export const IMAGE_MIME_TYPES = SHARED_IMAGE_MIME_TYPES;
export type ImageMimeType = (typeof IMAGE_MIME_TYPES)[number];
export const MAX_ATTACHMENT_FILE_SIZE_BYTES =
  SHARED_MAX_ATTACHMENT_FILE_SIZE_BYTES;
export const MAX_INLINE_IMAGE_ATTACHMENT_BYTES =
  SHARED_MAX_INLINE_IMAGE_ATTACHMENT_BYTES;
export const MAX_INLINE_IMAGE_ATTACHMENT_BASE64_CHARS =
  SHARED_MAX_INLINE_IMAGE_ATTACHMENT_BASE64_CHARS;
export const MAX_INLINE_IMAGE_ATTACHMENT_REQUEST_BODY_BYTES =
  SHARED_MAX_INLINE_IMAGE_ATTACHMENT_REQUEST_BODY_BYTES;
export const INLINE_ATTACHMENT_REF_PREFIX = SHARED_INLINE_ATTACHMENT_REF_PREFIX;
export const isDocumentMimeType = sharedIsDocumentMimeType;
export const isImageMimeType = sharedIsImageMimeType;
export const buildInlineAttachmentRef = sharedBuildInlineAttachmentRef;
export const buildInlineAttachmentMarkdownImage =
  sharedBuildInlineAttachmentMarkdownImage;

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

/**
 * Response returned after initiating a file upload.
 * The client should PUT the file to uploadUrl, then confirm via the API.
 */
export type CreateAttachmentResponse = {
  attachmentId: string;
  uploadUrl: string;
  key: string;
  /** API-owned upload URL expiry. Optional for version-skewed producers. */
  expiresAt?: string;
};

/**
 * Response returned after creating an inline image attachment from API-owned bytes.
 * The response intentionally omits storage keys and never echoes the base64 input.
 */
export type CreateInlineImageAttachmentResponse = {
  attachmentId: string;
  attachmentRef: `${typeof INLINE_ATTACHMENT_REF_PREFIX}${string}`;
  attachment: FileAttachment;
};

/**
 * Response returned when requesting a download URL for an attachment.
 */
export type AttachmentDownloadResponse = {
  downloadUrl: string;
};

export const InlineImageResolveSkipReason = {
  NotFound: "not_found",
  NotInline: "not_inline",
  NotImage: "not_image",
  SigningFailed: "signing_failed",
} as const;
export type InlineImageResolveSkipReason =
  (typeof InlineImageResolveSkipReason)[keyof typeof InlineImageResolveSkipReason];

export type ResolvedInlineImage = {
  attachmentId: string;
  url: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  expiresAt: string;
};

export type SkippedInlineImage = {
  attachmentId: string;
  reason: InlineImageResolveSkipReason;
};

export type ResolveInlineImagesResponse = {
  images: ResolvedInlineImage[];
  skipped: SkippedInlineImage[];
};

/**
 * Comma-separated list of allowed file extensions for use in HTML <input accept=""> attributes.
 * Runtime MIME type validation and file size limits live in apps/api validators, not here.
 */
export const ALLOWED_EXTENSIONS =
  ".pdf,.jpg,.jpeg,.png,.gif,.webp,.csv,.json,.txt,.md,.doc,.docx,.xls,.xlsx";
