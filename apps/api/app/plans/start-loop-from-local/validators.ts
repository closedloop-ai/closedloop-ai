import { z } from "zod";
import { repoSchema } from "@/app/loops/validators";

const baseSchema = z.object({
  issueId: z.string().uuid(),
  ticketTitle: z.string().optional(),
  computeTargetId: z.string().uuid(),
  localRepoPath: z.string().min(1),
  repo: repoSchema.optional(),
});

export const startPlanLoopSchema = baseSchema.strict();

export const selectArtifactPlanLoopSchema = baseSchema
  .extend({
    selectedArtifactId: z.string().uuid(),
  })
  .strict();

export type StartPlanLoopBody = z.infer<typeof startPlanLoopSchema>;
export type SelectArtifactPlanLoopBody = z.infer<
  typeof selectArtifactPlanLoopSchema
>;
