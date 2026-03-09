import { z } from "zod";
import { repoSchema } from "@/app/loops/validators";

export const runLoopSchema = z.object({
  command: z.enum(["plan", "execute", "request_changes", "decompose"]),
  prompt: z.string().optional(),
  repo: repoSchema.optional(),
});

export type RunLoopBody = z.infer<typeof runLoopSchema>;
