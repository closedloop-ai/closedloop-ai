import { z } from "zod";

export const connectGitHubValidator = z.object({
  code: z.string().min(1, "Authorization code is required"),
  installationId: z.string().min(1, "Installation ID is required"),
});
