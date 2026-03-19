import { z } from "zod";
import { repoSchema } from "@/app/loops/validators";
import { COMMAND_MAP } from "./run-loop-helpers";

const loopCommands = Object.keys(COMMAND_MAP) as (keyof typeof COMMAND_MAP)[];

export const runLoopSchema = z.object({
  command: z.enum(loopCommands),
  prompt: z.string().optional(),
  repo: repoSchema.optional(),
  computeTargetId: z.uuid().optional(),
});

export type RunLoopBody = z.infer<typeof runLoopSchema>;
