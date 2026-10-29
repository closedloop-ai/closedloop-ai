import { z } from "zod";
import {
  type BranchTraceResult,
  mergedTraceItemSchema,
} from "./branch-trace.ts";

export const BranchTracePageMode = { Cursor: "cursor" } as const;
export const BRANCH_TRACE_CURSOR_PATTERN = /^v1:[a-f0-9]{64}:[0-9]{1,15}$/;

/** Optional extensions; complete-trace adapters and older servers remain valid. */
export type BranchTracePageResult = BranchTraceResult & {
  nextCursor?: string;
  overviewItems?: BranchTraceResult["items"];
  reset?: true;
};

export const branchTracePagingSchema = z.object({
  nextCursor: z.string().regex(BRANCH_TRACE_CURSOR_PATTERN).optional(),
  overviewItems: z.array(mergedTraceItemSchema).optional(),
  reset: z.literal(true).optional(),
});
