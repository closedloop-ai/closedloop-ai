import { z } from "zod";

export const dismissGenerationStatusValidator = z.object({
  runKey: z.string().min(1).nullable().optional(),
});
