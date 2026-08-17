/**
 * @file synced-session-substantive.ts
 * @description FEA-3287: the sync-side twin of the FEA-3284 `isSubstantiveSession`
 * SSOT (`@repo/api/src/agent-session-filters`), applied to a hydrated
 * `SyncedAgentSession` so the desktop never uploads a "phantom" row (a 0-turn /
 * 0-token / no-tool-use session the live-hook INSERTs on `SessionStart` before
 * any real activity).
 *
 * The signals are derived from the hydrated session EXACTLY as the desktop read
 * path derives them (`sessionIsSubstantive` in
 * `session/shared-agent-sessions-api.ts`): `session.turns`, the summed per-model
 * token usage, and the tool-use event count (events with a `toolName`). Keeping
 * this derivation identical to the read row guarantees a session buckets as idle
 * vs substantive the same way on the sync boundary, the cloud SQL twin
 * (`SESSION_SUBSTANTIVE_WHERE`), and the shared UI — the FEA-3149 lockstep
 * contract.
 *
 * A session filtered here is DEFERRED, not dropped: it stays in the local store
 * (so the desktop live-Kanban still shows "Waiting on start"), and the moment a
 * real turn/token/tool-use arrives the live hook bumps `sessions.updated_at`, so
 * the now-substantive session re-enters the incremental cursor and syncs on the
 * next pass. No real session is lost.
 */
import { isSubstantiveSession } from "@repo/api/src/agent-session-filters";
import type { SyncedAgentSession } from "./agent-session-sync-contract.js";

/**
 * True when a hydrated session did substantive work (>=1 turn, OR any token
 * consumed, OR >=1 tool used), using the shared `isSubstantiveSession` SSOT.
 * Idle ("phantom") sessions return false and are withheld from cloud sync.
 */
export function syncedSessionIsSubstantive(
  session: SyncedAgentSession
): boolean {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  for (const usage of session.tokenUsageByModel) {
    inputTokens += usage.inputTokens;
    outputTokens += usage.outputTokens;
    cacheReadTokens += usage.cacheReadTokens;
    cacheWriteTokens += usage.cacheWriteTokens;
  }
  let toolUseCount = 0;
  for (const event of session.events) {
    if (event.toolName) {
      toolUseCount += 1;
    }
  }
  return isSubstantiveSession({
    turns: session.turns ?? null,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    toolUseCount,
  });
}
