// Context attachment types for API contract
// These are explicitly defined to keep packages/api independent of database

/**
 * A single attachment included in a context pack dispatched to a loop runner.
 * Canonical definition — imported by both packages/api and apps/api.
 */
export type ContextPackAttachment = {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  signedUrl: string;
  signedUrlExpiresAt: string;
};

/**
 * Response returned after initiating a context file upload.
 * The client should PUT the file to uploadUrl, then confirm via the API.
 * Uses uploadUrl (not presignedUrl) to match CreateAttachmentResponse convention.
 */
export type CreateContextAttachmentResponse = {
  uploadUrl: string;
  artifactId: string;
  attachmentId: string;
};

/**
 * Result for a single Google Drive document import into context.
 */
export type GDriveContextImportResult = {
  docId: string;
  artifactId?: string;
  error?: string;
};

/**
 * Response returned after importing one or more Google Drive documents as context.
 */
export type ImportGDriveContextResponse = {
  results: GDriveContextImportResult[];
};
