// Attachment types for API contract
// These are explicitly defined to keep packages/api independent of database

/**
 * Represents a file attachment associated with an artifact.
 * createdAt is ISO 8601 string — use .toISOString() in service mapping.
 */
export type FileAttachment = {
  id: string;
  artifactId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
  createdById: string;
};

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
  ".html,.pdf,.jpg,.jpeg,.png,.gif,.svg,.webp,.csv,.json,.txt,.md,.doc,.docx,.xls,.xlsx";
