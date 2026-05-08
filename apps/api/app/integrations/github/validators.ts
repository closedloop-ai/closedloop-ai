import { z } from "zod";

export const connectGitHubValidator = z.object({
  code: z.string().min(1, "Authorization code is required"),
  // Optional: present when using /installations/new flow, absent in standard OAuth flow
  installationId: z.string().min(1).optional(),
});
