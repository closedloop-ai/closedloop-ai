import { z } from "zod";
import {
  batchDocumentIdsSchema,
  batchDocumentSelectionSchema,
  refineBatchSelectionArms,
} from "./validators";

/** Batch owner target; both selection arms share the existing 500-row bound. */
export const batchUpdateAssigneeValidator = z
  .object({
    documentIds: batchDocumentIdsSchema.optional(),
    selection: batchDocumentSelectionSchema.optional(),
    assigneeId: z.uuid().nullable(),
  })
  .strict()
  .superRefine(refineBatchSelectionArms);
