import {
  CURRENT_DESKTOP_API_NAMESPACE,
  LEGACY_DESKTOP_API_NAMESPACE,
} from "@repo/api/src/desktop-api-namespace";
import { z } from "zod";
import { repoSchema } from "@/app/loops/validators";

const baseSchema = z.object({
  featureId: z.string().uuid(),
  ticketTitle: z.string().optional(),
  computeTargetId: z.string().uuid(),
  localRepoPath: z.string().min(1),
  desktopApiNamespace: z
    .enum([CURRENT_DESKTOP_API_NAMESPACE, LEGACY_DESKTOP_API_NAMESPACE])
    .optional(),
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
