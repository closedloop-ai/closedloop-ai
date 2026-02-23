import { SymphonyCommand } from "@repo/api/src/types/artifact";
import { z } from "zod";

export const runLoopSchema = z.object({
  command: z.enum([
    SymphonyCommand.Plan,
    SymphonyCommand.Execute,
    SymphonyCommand.RequestChanges,
  ]),
  prompt: z.string().optional(),
});

export type RunLoopBody = z.infer<typeof runLoopSchema>;
