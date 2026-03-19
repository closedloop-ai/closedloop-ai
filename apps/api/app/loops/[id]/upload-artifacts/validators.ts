import { z } from "zod";

export const uploadArtifactsSchema = z.object({
  artifacts: z.object({
    plan: z
      .object({
        content: z.string(),
        raw: z.record(z.string(), z.unknown()).optional(),
      })
      .optional(),
    prd: z.object({ content: z.string() }).optional(),
    executionResult: z.record(z.string(), z.unknown()).optional(),
    features: z.record(z.string(), z.unknown()).optional(),
    judges: z.record(z.string(), z.unknown()).optional(),
    codeJudges: z.record(z.string(), z.unknown()).optional(),
    prdJudges: z.record(z.string(), z.unknown()).optional(),
    openQuestions: z.string().optional(),
  }),
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
