import { API_KEY_SCOPES } from "@repo/api/src/types/api-key";
import { z } from "zod";

export const createApiKeyValidator = z.object({
  name: z.string().min(1, "Name is required").max(100),
  expiresAt: z.string().datetime().optional(),
  scopes: z
    .array(z.enum(API_KEY_SCOPES))
    .min(1, "At least one scope is required")
    .optional(),
});
