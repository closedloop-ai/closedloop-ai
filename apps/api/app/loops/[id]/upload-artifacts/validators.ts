import { z } from "zod";

export const uploadArtifactsSchema = z.object({
  artifacts: z.object({
    plan: z
      .object({
        content: z.string(),
        raw: z.unknown().optional(),
      })
      .optional(),
    executionResult: z.unknown().optional(),
    features: z.unknown().optional(),
    judges: z.unknown().optional(),
    codeJudges: z.unknown().optional(),
    openQuestions: z.string().optional(),
  }),
  metadata: z
    .object({
      tokensInput: z.number().optional(),
      tokensOutput: z.number().optional(),
      tokensByModel: z.record(z.string(), z.unknown()).optional(),
      sessionId: z.string().optional(),
      branchName: z.string().optional(),
    })
    .optional(),
});

export type UploadArtifactsBody = z.infer<typeof uploadArtifactsSchema>;
