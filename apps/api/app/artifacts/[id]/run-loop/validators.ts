import { z } from "zod";

export const runLoopSchema = z.object({
  command: z.enum(["plan", "execute", "request_changes"]),
  prompt: z.string().optional(),
});

export type RunLoopBody = z.infer<typeof runLoopSchema>;
