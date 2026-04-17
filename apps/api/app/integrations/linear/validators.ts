import { z } from "zod";

export const connectLinearValidator = z.object({
  code: z.string().min(1, "Authorization code is required"),
  codeVerifier: z.string().min(1, "PKCE code verifier is required"),
});

export const exportToLinearValidator = z.object({
  documentId: z.uuid(),
  teamId: z.string().min(1, "Team ID is required"),
});
