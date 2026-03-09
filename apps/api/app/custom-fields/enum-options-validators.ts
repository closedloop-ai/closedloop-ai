import { z } from "zod";

export const createEnumOptionValidator = z.object({
  name: z.string().min(1).max(256),
  color: z.string().optional(),
  enabled: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

export const updateEnumOptionValidator = z.object({
  name: z.string().min(1).max(256).optional(),
  color: z.string().optional(),
  enabled: z.boolean().optional(),
});

export const reorderEnumOptionsValidator = z.object({
  optionIds: z.array(z.string().uuid()),
});
