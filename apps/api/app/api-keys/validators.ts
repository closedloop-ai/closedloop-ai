import { API_KEY_SCOPES } from "@repo/api/src/types/api-key";
import { z } from "zod";

// TODO: Remove this field from the validator once all API callers have been updated. Tracked in FEA-3 (T-1.4).
const createApiKeyScopesValidator = z
  .array(z.enum(API_KEY_SCOPES))
  .nonempty("At least one scope is required")
  .optional()
  .describe(
    "Deprecated. Omit this field; all new keys receive ['read', 'write', 'delete'] scopes. Submitting ['read'] only returns a 400 error."
  );

export const createApiKeyValidator = z
  .object({
    name: z.string().min(1, "Name is required").max(100),
    expiresAt: z.string().datetime().optional(),
    scopes: createApiKeyScopesValidator,
  })
  .superRefine((data, ctx) => {
    if (data.scopes?.every((s) => s === "read")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Read-only API keys are no longer supported. Omit the 'scopes' field to create a full-access key.",
        path: ["scopes"],
      });
    }
  });
