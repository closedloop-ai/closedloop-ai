import { z } from "zod";

const uploadedPlanRawSchema = z.record(z.string(), z.unknown());

const uploadedPlanArtifactsSchema = z
  .object({
    artifacts: z
      .object({
        plan: z
          .object({
            raw: uploadedPlanRawSchema.optional(),
          })
          .passthrough(),
      })
      .passthrough(),
  })
  .passthrough();

export function extractUploadedPlanRaw(
  uploadedArtifacts: unknown
): Record<string, unknown> | undefined {
  const parsed = uploadedPlanArtifactsSchema.safeParse(uploadedArtifacts);
  if (!parsed.success) {
    return undefined;
  }

  return parsed.data.artifacts.plan.raw;
}
