/**
 * Google integration types for API contract.
 * Used by both apps/api (backend) and apps/app (frontend).
 *
 * Internal Google SDK types (GoogleDriveFolder, GoogleDriveDoc, drive.files.list responses)
 * belong in @repo/google package. This file contains only types that cross the
 * apps/api ↔ apps/app boundary.
 */

export type GoogleIntegrationStatus = {
  connected: boolean;
  email: string | null;
};

export type ConnectGoogleInput = {
  code: string;
  codeVerifier: string;
  redirectUri: string;
};

export type ConnectGoogleResponse = {
  connected: true;
  email: string | null;
};

export type ImportGoogleDocsInput = {
  folderId: string;
  projectId: string;
};

export type ImportGoogleDocsResponse = {
  importedCount: number;
  totalDocsInFolder: number;
  artifacts: Array<{
    id: string;
    documentSlug: string;
    title: string;
  }>;
  failures: Array<{
    docId: string;
    docTitle: string;
    error: string;
  }>;
};

export type GoogleDisconnectResponse = {
  disconnected: true;
};
