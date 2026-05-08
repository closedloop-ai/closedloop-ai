import { z } from "zod";

export const BootstrapAgentSchema = z.object({
  name: z.string(),
  slug: z.string(),
  role: z.string(),
  description: z.string(),
  prompt: z.string(),
});

export const BootstrapRepoResultSchema = z.object({
  fullName: z.string(),
  success: z.boolean(),
  error: z.string().optional(),
  agents: z.array(BootstrapAgentSchema),
  criticGates: z.record(z.string(), z.unknown()).nullable(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  duration: z.number(),
});

export const BootstrapLoopResultSchema = z.object({
  repos: z.array(BootstrapRepoResultSchema),
  totalDuration: z.number(),
});

export type BootstrapAgent = z.infer<typeof BootstrapAgentSchema>;
export type BootstrapRepoResult = z.infer<typeof BootstrapRepoResultSchema>;
export type BootstrapLoopResult = z.infer<typeof BootstrapLoopResultSchema>;
