/**
 * @file synced-session-substantive.ts
 * @description FEA-3287: the sync-side twin of the FEA-3284 `isSubstantiveSession`
 * SSOT (`@repo/api/src/agent-session-filters`), applied to a hydrated
 * `SyncedAgentSession` so the desktop never uploads a "phantom" row (a 0-turn /
 * 0-token / no-tool-use / no-invocation session the live-hook INSERTs on
 * `SessionStart` before any real activity).
 *
 * The signals are derived from the hydrated session EXACTLY as the desktop read
 * path derives them (`sessionIsSubstantive` in
 * `session/session-usage-totals.ts`): `session.turns`, the summed per-model
 * token usage, the tool-use event count (events with a `toolName`), and the
 * hydrated component-invocation count (ISS-5801 — the same local
 * `agent_component_invocations` rows the invocation sync lane queues, so a
 * session with queued invocation children is substantive by construction and
 * its parent can never be withheld into `session_missing` orphans). Keeping
 * this derivation identical to the read row guarantees a session buckets as idle
 * vs substantive the same way on the sync boundary, the cloud SQL twin
 * (`SESSION_SUBSTANTIVE_WHERE`), and the shared UI — the FEA-3149 lockstep
 * contract.
 *
 * A session filtered here is DEFERRED, not dropped: it stays in the local store
 * (so the desktop live-Kanban still shows "Waiting on start"), and the moment a
 * real turn/token/tool-use arrives — or the invocation set changes, which the
 * import pipeline stamps into `sessions.updated_at` (write-core's
 * `sync_watermark` group; the stored-row rebuild bumps it itself) — the
 * now-substantive session re-enters the incremental cursor and syncs on the
 * next pass. No real session is lost.
 */
import { isSubstantiveSession } from "@repo/api/src/agent-session-filters";
import type { SyncedAgentSession } from "./agent-session-sync-contract.js";

/**
 * True when a hydrated session did substantive work (>=1 turn, OR any token
 * consumed, OR >=1 tool used, OR >=1 component invocation — ISS-5801), using
 * the shared `isSubstantiveSession` SSOT. Idle ("phantom") sessions return
 * false and are withheld from cloud sync. The invocation count is what keeps
 * this gate consistent with the invocation lane: a session whose derived
 * invocation children are queued is substantive by construction, so the parent
 * uploads and the children can never terminally reject with `session_missing`.
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
    componentInvocationCount: session.componentInvocationCount ?? null,
  });
}
