import { z } from "zod";
import { jsonObjectSchema, jsonValueSchema } from "@/lib/json-schema";

export const uploadArtifactsSchema = z.object({
  artifacts: z
    .object({
      plan: z
        .object({
          content: z.string(),
          raw: jsonObjectSchema.optional(),
        })
        .optional(),
      prd: z.object({ content: z.string() }).optional(),
      executionResult: jsonObjectSchema.optional(),
      features: jsonObjectSchema.optional(),
      judges: jsonObjectSchema.optional(),
      codeJudges: jsonObjectSchema.optional(),
      planJudges: jsonObjectSchema.optional(),
      prdJudges: jsonObjectSchema.optional(),
      featureJudges: jsonObjectSchema.optional(),
      openQuestions: z.string().optional(),
    })
    .catchall(jsonValueSchema),
  metadata: z
    .object({
      tokensInput: z.number().optional(),
      tokensOutput: z.number().optional(),
      tokensByModel: z
        .record(
          z.string(),
          z.object({
            input: z.number().optional(),
            output: z.number().optional(),
          })
        )
        .optional(),
      sessionId: z.string().optional(),
      branchName: z.string().optional(),
    })
    .optional(),
});

export type UploadArtifactsBody = z.infer<typeof uploadArtifactsSchema>;
