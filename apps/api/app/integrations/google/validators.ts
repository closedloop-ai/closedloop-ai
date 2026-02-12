import { z } from "zod";

export const connectGoogleValidator = z.object({
  code: z.string().min(1, "Authorization code is required"),
  codeVerifier: z.string().min(1, "PKCE code verifier is required"),
});

export const importGoogleDocsValidator = z.object({
  folderId: z
    .string()
    .regex(/^[a-zA-Z0-9_-]{28,40}$/, "Invalid Google Drive folder ID format"),
  projectId: z.string().uuid("Valid project ID is required"),
});
