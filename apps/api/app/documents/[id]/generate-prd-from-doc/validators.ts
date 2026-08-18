import { z } from "zod";

/**
 * Body for POST /documents/[id]/generate-prd-from-doc.
 *
 * `[id]` in the path is the source evergreen Document; the body carries the
 * target project the new DRAFT PRD lands in plus an optional title override.
 */
export const generatePrdFromDocSchema = z
  .object({
    projectId: z.string().min(1),
    title: z.string().max(500).optional(),
  })
  .strict();

export type GeneratePrdFromDocBody = z.infer<typeof generatePrdFromDocSchema>;
