import { z } from "zod";

const uploadedPlanRawSchema = z.record(z.string(), z.unknown());

const uploadedPlanArtifactsSchema = z
  .object({
    plan: z
      .object({
        raw: uploadedPlanRawSchema.optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

/**
 * Read raw desktop plan state from the DB-stored uploaded artifacts shape.
 *
 * `/loops/:id/upload-artifacts` stores the request's `artifacts` object
 * directly on the loop row, so the live shape is `{ plan: { raw } }`.
 */
export function extractUploadedPlanRaw(
  uploadedArtifacts: unknown
): Record<string, unknown> | undefined {
  const parsed = uploadedPlanArtifactsSchema.safeParse(uploadedArtifacts);
  if (parsed.success) {
    return parsed.data.plan?.raw;
  }

  return undefined;
}
