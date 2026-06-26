import {
  IMAGE_MIME_TYPES as SHARED_IMAGE_MIME_TYPES,
  MAX_ATTACHMENT_FILE_SIZE_BYTES as SHARED_MAX_ATTACHMENT_FILE_SIZE_BYTES,
  AttachmentPurpose as SharedAttachmentPurpose,
  AttachmentPurposeSelector as SharedAttachmentPurposeSelector,
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
export const IMAGE_MIME_TYPES = SHARED_IMAGE_MIME_TYPES;
export const MAX_ATTACHMENT_FILE_SIZE_BYTES =
  SHARED_MAX_ATTACHMENT_FILE_SIZE_BYTES;
export const isDocumentMimeType = sharedIsDocumentMimeType;
export const isImageMimeType = sharedIsImageMimeType;

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
