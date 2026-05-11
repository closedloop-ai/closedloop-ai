import { z } from "zod";

export const createAgentValidator = z.object({
  name: z.string().min(1).max(200),
  role: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  prompt: z.string().min(1),
  sourceRepo: z.string().max(200).optional(),
  bootstrapRunId: z.string().optional(),
});

export const updateAgentValidator = z
  .object({
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(500).optional(),
    prompt: z.string().min(1).optional(),
    enabled: z.boolean().optional(),
    changeNote: z.string().max(500).optional(),
  })
  .refine(
    (data) => {
      if (data.prompt !== undefined || data.name !== undefined) {
        return data.changeNote !== undefined && data.changeNote.length > 0;
      }
      return true;
    },
    { message: "changeNote required when updating prompt or name" }
  );

const bulkIngestAgentItemValidator = z.object({
  name: z.string().min(1).max(200),
  role: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  prompt: z.string().min(1),
});

export const bulkIngestValidator = z.object({
  agents: z.array(bulkIngestAgentItemValidator).min(1).max(100),
  bootstrapRunId: z.string().min(1),
  sourceRepo: z.string().min(1),
  criticGates: z.record(z.string(), z.unknown()).optional(),
});

export const listAgentsQueryValidator = z.object({
  enabled: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
  search: z.string().max(200).optional(),
  sourceRepo: z.string().max(200).optional(),
});
