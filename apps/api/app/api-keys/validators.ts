import { API_KEY_SCOPES } from "@repo/api/src/types/api-key";
import { z } from "zod";

const createApiKeyScopesValidator = z
  .array(z.enum(API_KEY_SCOPES))
  .nonempty("At least one scope is required")
  .optional()
  .describe(
    "Optional. When omitted, the server defaults the key to ['read'] scope."
  );

export const createApiKeyValidator = z.object({
  name: z.string().min(1, "Name is required").max(100),
  expiresAt: z.string().datetime().optional(),
  scopes: createApiKeyScopesValidator,
});
