import { MAX_ADDITIONAL_REPOS } from "@repo/api/src/types/loop";
import { z } from "zod";
import { repoSchema } from "@/app/loops/validators";
import { COMMAND_MAP } from "./run-loop-helpers";

const loopCommands = Object.keys(COMMAND_MAP) as (keyof typeof COMMAND_MAP)[];

export const runLoopSchema = z.object({
  command: z.enum(loopCommands),
  prompt: z.string().max(100_000).optional(),
  repo: repoSchema.optional(),
  additionalRepos: z
    .array(repoSchema)
    .max(MAX_ADDITIONAL_REPOS)
    .optional()
    .transform((v) => (v?.length ? v : undefined)),
  computeTargetId: z.uuid().nullable().optional(),
  backendOverride: z.boolean().optional(),
});

export type RunLoopBody = z.infer<typeof runLoopSchema>;
