// Attachment types for API contract
// These are explicitly defined to keep packages/api independent of database

/**
 * Represents a file attachment associated with a document.
 * createdAt is ISO 8601 string — use .toISOString() in service mapping.
 */
export type FileAttachment = {
  id: string;
  documentId: string;
  featureId?: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
  createdById: string;
  /** Presigned inline URL for image previews. Only present for image/* mime types. */
  previewUrl?: string;
};

const IMAGE_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
] as const;

export function isImageMimeType(mimeType: string): boolean {
  return IMAGE_MIME_TYPES.some((t) => mimeType === t);
}

const DOCUMENT_MIME_TYPES = [
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/markdown",
  "text/html",
] as const;

export function isDocumentMimeType(mimeType: string): boolean {
  return DOCUMENT_MIME_TYPES.some((t) => mimeType === t);
}

/**
 * Response returned after initiating a file upload.
 * The client should PUT the file to uploadUrl, then confirm via the API.
 */
export type CreateAttachmentResponse = {
  attachmentId: string;
  uploadUrl: string;
  key: string;
};

/**
 * Response returned when requesting a download URL for an attachment.
 */
export type AttachmentDownloadResponse = {
  downloadUrl: string;
};

/**
 * Comma-separated list of allowed file extensions for use in HTML <input accept=""> attributes.
 * Runtime MIME type validation and file size limits live in apps/api validators, not here.
 */
export const ALLOWED_EXTENSIONS =
  ".pdf,.jpg,.jpeg,.png,.gif,.webp,.csv,.json,.txt,.md,.doc,.docx,.xls,.xlsx";
