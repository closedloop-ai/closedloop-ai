/**
 * ISS-7895: what a session's `models` array MEANS, in one place.
 *
 * The ruling (Tamsin, 2026-08-25): `models` is the set of models a session
 * actually BILLED, never the models it merely declared. A codex `turn_context`
 * naming a model that then produced no output, and an auth-failure session that
 * never reached the provider, both bill nothing and contribute nothing here. The
 * declared model is not lost — it stays on `model`/`primaryModel`, the field
 * that answers "a session has a model even when idle".
 *
 * Shared because the cloud detail projection
 * (`apps/api/app/agent-sessions/service.ts`) and the desktop detail projection
 * (`apps/desktop/src/main/session/shared-agent-session-detail-projection.ts`)
 * are the two producers of the field, and ISS-7895 exists precisely because
 * they answered the same question differently. One derivation, so they cannot
 * disagree again.
 */

import type { SyncedAgentSessionTokenUsage } from "./types/agent-session.ts";

/**
 * True when a per-model usage row carries evidence the model was billed.
 *
 * A row's PRESENCE is not that evidence. Both stores default every counter to 0
 * (cloud `agent_session_token_usage`, desktop `token_usage`) and the desktop
 * writes a row from the transcript's declared model before usage lands — the
 * same before-any-activity shape `isSubstantiveSession` calls a phantom session
 * (`./agent-session-filters.ts`). So a zeroed row says "declared, billed
 * nothing" and must read as unbilled.
 *
 * Cost counts alongside tokens because a row can carry a priced amount its
 * counters do not explain, and money attributed to a model is billing.
 *
 * Every comparison is `> 0`, so a negative or non-finite counter on a corrupt
 * row fails it. Deliberate: an impossible value is not proof a model ran, and
 * naming a model that never ran is the defect this module exists to prevent.
 */
function isBilledUsage(usage: SyncedAgentSessionTokenUsage): boolean {
  return (
    usage.inputTokens > 0 ||
    usage.outputTokens > 0 ||
    usage.cacheReadTokens > 0 ||
    usage.cacheWriteTokens > 0 ||
    (usage.estimatedCostUsd ?? 0) > 0
  );
}

/**
 * The distinct models a session billed, in first-billed-row order.
 *
 * `[]` is the honest answer for a session that ran no billable work; callers
 * must NOT fall back to the declared model to fill it.
 */
export function deriveBilledModels(
  rows: readonly SyncedAgentSessionTokenUsage[]
): string[] {
  const billed = new Set<string>();
  for (const usage of rows) {
    if (usage.model && isBilledUsage(usage)) {
      billed.add(usage.model);
    }
  }
  return [...billed];
}
