import { z } from "zod";

export const createApiKeyValidator = z.object({
  name: z.string().min(1, "Name is required").max(100),
  expiresAt: z.string().datetime().optional(),
});
