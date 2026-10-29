import { z } from "zod";
import type { AgentSessionListItem } from "./agent-session.ts";

/** Additive, source-scoped continuation of the component's session cohort. */
export type AgentComponentSessionsPage = {
  items: readonly AgentSessionListItem[];
  total: number | null;
  nextCursor: string | null;
};

const pageCountSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);

/** HTTP envelope guards retain newer row fields and reject malformed pages. */
export const agentComponentSessionsPageEnvelopeSchema = z.looseObject({
  items: z.array(z.looseObject({ id: z.string().min(1) })),
  total: pageCountSchema.nullable(),
  nextCursor: z.string().min(1).nullable(),
});

export const agentComponentInvocationsPageEnvelopeSchema = z.looseObject({
  items: z.array(z.looseObject({ id: z.string().min(1) })),
  total: pageCountSchema,
  hasMore: z.boolean(),
  unmatchedCount: pageCountSchema,
  ambiguousCount: pageCountSchema,
  nextCursor: z.string().min(1).optional(),
});
