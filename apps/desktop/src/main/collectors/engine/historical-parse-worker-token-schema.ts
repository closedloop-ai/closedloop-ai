import {
  tokenCostSummarySchema,
  tokenEventTransportIdSchema,
  tokenSourceIdentitySchema,
} from "@repo/api/src/types/token-cost-provenance";
import { z } from "zod";
import { safeStorageTokenCountSchema } from "../../cost/token-counts.js";
import { HistoricalParseWorkerLimits } from "./historical-parse-worker-limits.js";

const MAX_SHORT_TEXT_LENGTH = HistoricalParseWorkerLimits.maxShortTextLength;

/** Optional cache-write TTL subdivision carried by usage and event records. */
export const cacheWriteTtlSchema = z.object({
  fiveM: z.number().int().nonnegative(),
  oneH: z.number().int().nonnegative(),
});

/**
 * Strict historical-worker transport for every `NormalizedTokenRecord` key.
 * The protocol owner also binds this shape to `keyof NormalizedTokenRecord` so
 * a future source-type field cannot be omitted silently.
 */
export const historicalWorkerTokenRecordSchema = z
  .object({
    timestamp: z.string().max(MAX_SHORT_TEXT_LENGTH),
    model: z.string().max(MAX_SHORT_TEXT_LENGTH),
    input: safeStorageTokenCountSchema,
    output: safeStorageTokenCountSchema,
    cacheRead: safeStorageTokenCountSchema,
    cacheWrite: safeStorageTokenCountSchema,
    cacheWriteTtl: cacheWriteTtlSchema.optional(),
    inferred: z.boolean().optional(),
    subagentId: z.string().max(MAX_SHORT_TEXT_LENGTH).optional(),
    transportId: tokenEventTransportIdSchema.optional(),
    sourceIdentity: tokenSourceIdentitySchema.optional(),
    costSummary: tokenCostSummarySchema.optional(),
  })
  .strict();
