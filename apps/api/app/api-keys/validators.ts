import { API_KEY_SCOPES } from "@repo/api/src/types/api-key";
import { z } from "zod";

// TODO: Remove the scopes field entirely once the deprecation window closes. Tracked in FEA-563.
// Accepted but ignored: service.generate() always assigns full ["read","write","delete"] scopes regardless of input.
const createApiKeyScopesValidator = z
  .array(z.enum(API_KEY_SCOPES))
  .nonempty("At least one scope is required")
  .optional()
  .describe(
    "Deprecated. Omit this field; all new keys receive ['read', 'write', 'delete'] scopes. Legacy values are accepted and ignored."
  );

export const createApiKeyValidator = z.object({
  name: z.string().min(1, "Name is required").max(100),
  expiresAt: z.string().datetime().optional(),
  scopes: createApiKeyScopesValidator,
});
