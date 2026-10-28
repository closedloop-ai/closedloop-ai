/**
 * The token half of the desktop agent-sessions sync payload: per-model usage,
 * the per-event token record, and the cloud-precision bound their costs must
 * clear before persistence.
 *
 * Split out of `desktop-agent-sessions-schema.ts` (ISS-8733 rebase): merging
 * `main` pushed that file past the 1,000-line ceiling, and this is the block
 * that comes out whole — every symbol below is used only by the session schema
 * and the guards module, and `TOKEN_EVENT_COST_STORAGE_MAX_USD` /
 * `isPersistableTokenCost` are referenced nowhere else at all. Splitting by
 * responsibility rather than at a line count, per AGENTS.md.
 */
import {
  tokenCostSummarySchema,
  tokenEventTransportIdSchema,
  tokenSourceIdentitySchema,
} from "@repo/api/src/types/token-cost-provenance";
import { z } from "zod";
import {
  isoDateSchema,
  nullableTrimmedStringSchema,
} from "./desktop-agent-sessions-schema-primitives";
import {
  projectKnownTokenCostSummary,
  projectKnownTokenSourceIdentity,
} from "./desktop-agent-sessions-token-provenance-projection";

// Token counts cross the wire as JSON numbers, deliberately kept within the
// 2^53 safe-integer envelope rather than stringified: the desktop preserves the
// same ceiling and the cloud stores them in BigInt (int8) columns, so a session
// that exceeds the old int4 limit (2,147,483,647) carries through without
// truncation or precision loss. See the BigInt-carry regression in
// app/desktop/agent-sessions/sync/route.integration.test.ts (FEA-2728).
export const syncedAgentSessionTokenUsageSchema = z
  .object({
    model: z.string().trim().min(1),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    cacheReadTokens: z.number().int().nonnegative(),
    cacheWriteTokens: z.number().int().nonnegative(),
    cacheWrite5mTokens: z.number().int().nonnegative().nullish(),
    cacheWrite1hTokens: z.number().int().nonnegative().nullish(),
    estimatedCostUsd: z.number().finite().nonnegative().optional(),
  })
  .superRefine((usage, context) => {
    const fiveMinuteTokens = usage.cacheWrite5mTokens;
    const oneHourTokens = usage.cacheWrite1hTokens;
    const hasFiveMinuteTokens = fiveMinuteTokens != null;
    const hasOneHourTokens = oneHourTokens != null;
    if (hasFiveMinuteTokens !== hasOneHourTokens) {
      context.addIssue({
        code: "custom",
        message: "cache-write TTL fields must be supplied together",
        path: ["cacheWrite5mTokens"],
      });
      return;
    }
    if (
      fiveMinuteTokens != null &&
      oneHourTokens != null &&
      fiveMinuteTokens + oneHourTokens > usage.cacheWriteTokens
    ) {
      context.addIssue({
        code: "custom",
        message: "cache-write TTL subdivision exceeds cacheWriteTokens",
        path: ["cacheWrite5mTokens"],
      });
    }
  });

// FEA-2730 (G1): raw per-event token rows. Same 2^53 numeric envelope as
// tokenUsageByModel above (land in BigInt columns). `externalEventId` is the
// provider-neutral transport identity and the sole idempotency key for re-sync.
// ISS-4882 consumes the additive ISS-4881 provenance/cost contract here; both
// fields stay optional so older producers and servers preserve omission.
// Cloud token-event costs land in DECIMAL(14,6). Keep the shared producer
// contract provider-neutral, but reject values here that would round beyond the
// owning cloud column instead of dead-lettering the persistence transaction.
const TOKEN_EVENT_COST_STORAGE_MAX_USD = 99_999_999.999_999;
const persistedTokenCostSummarySchema = tokenCostSummarySchema.superRefine(
  (summary, context) => {
    if (
      "subtotalUsd" in summary &&
      !isPersistableTokenCost(summary.subtotalUsd)
    ) {
      context.addIssue({
        code: "custom",
        message: "token-event subtotal exceeds cloud storage precision",
        path: ["subtotalUsd"],
      });
    }
    if (!("lanes" in summary) || summary.lanes === undefined) {
      return;
    }
    for (const [index, lane] of summary.lanes.entries()) {
      if (!isPersistableTokenCost(lane.subtotalUsd)) {
        context.addIssue({
          code: "custom",
          message: "token-event lane exceeds cloud storage precision",
          path: ["lanes", index, "subtotalUsd"],
        });
      }
    }
  }
);
export const syncedAgentSessionTokenEventObjectSchema = z.object({
  externalEventId: tokenEventTransportIdSchema,
  agentExternalId: nullableTrimmedStringSchema,
  model: z.string().trim().min(1),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
  estimatedCostUsd: z
    .number()
    .finite()
    .nonnegative()
    .refine(isPersistableTokenCost, {
      message: "token-event cost exceeds cloud storage precision",
    })
    .optional(),
  createdAt: isoDateSchema,
  sourceIdentity: z.preprocess(
    projectKnownTokenSourceIdentity,
    tokenSourceIdentitySchema.optional()
  ),
  costSummary: z.preprocess(
    projectKnownTokenCostSummary,
    persistedTokenCostSummarySchema.optional()
  ),
});
export const syncedAgentSessionTokenEventSchema =
  syncedAgentSessionTokenEventObjectSchema.transform(
    ({ sourceIdentity, costSummary, ...event }) => ({
      ...event,
      ...(sourceIdentity === undefined ? {} : { sourceIdentity }),
      ...(costSummary === undefined ? {} : { costSummary }),
    })
  );

// The ISS-4882 token-provenance keys-covered guard lives in
// `desktop-agent-sessions-schema-guards.ts` with the other compile-time guards.

function isPersistableTokenCost(value: number): boolean {
  return Number(value.toFixed(6)) <= TOKEN_EVENT_COST_STORAGE_MAX_USD;
}
