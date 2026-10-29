import type { UpdateArtifactPriorityRequest } from "@repo/api/src/types/artifact-priority-mutation";
import { Priority } from "@repo/api/src/types/common";
import { z } from "zod";
import { optionalSingleArtifactPriorityEditSurface } from "@/app/documents/validators";

const updateBranchPriorityShape = {
  priority: z.enum(Priority).nullable(),
  expectedPriority: z.enum(Priority).nullable().optional(),
  surface: optionalSingleArtifactPriorityEditSurface,
} satisfies Record<keyof UpdateArtifactPriorityRequest, z.ZodTypeAny>;

/**
 * ISS-10332: `PATCH /branches/[id]` writes priority and nothing else, so the
 * body is `.strict()` — a key this route cannot honor is refused rather than
 * accepted and dropped. `surface` is the one companion key: telemetry
 * provenance, never a write (PLN-2086 Milestone 2).
 */
export const updateBranchPriorityBodySchema = z
  .object(updateBranchPriorityShape)
  .strict();
