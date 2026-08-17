import type {
  BranchIdleSpan,
  BranchLeadTimeActivity,
} from "@repo/api/src/types/branch";
import { MERGED_TRACE_IDLE_THRESHOLD_MS } from "@repo/lib/branches/merged-trace";
import type { SyncedAgentSession } from "../agent-sync/agent-session-sync-contract.js";

/**
 * Builds the lightweight work/idle summary from captured event instants so the
 * detail view does not need to hydrate the events-heavy merged trace.
 */
export function buildBranchLeadTime(
  sessions: SyncedAgentSession[]
): BranchLeadTimeActivity {
  const instants: number[] = [];
  for (const session of sessions) {
    for (const event of session.events) {
      const ms = Date.parse(event.createdAt);
      if (!Number.isNaN(ms)) {
        instants.push(ms);
      }
    }
  }
  instants.sort((a, b) => a - b);
  const first = instants[0];
  const last = instants.at(-1);
  if (first === undefined || last === undefined) {
    return { firstActivityT: null, lastActivityT: null, idleSpans: [] };
  }
  const idleSpans: BranchIdleSpan[] = [];
  for (let i = 1; i < instants.length; i += 1) {
    const gapMs = instants[i] - instants[i - 1];
    if (gapMs >= MERGED_TRACE_IDLE_THRESHOLD_MS) {
      idleSpans.push({
        startT: new Date(instants[i - 1]).toISOString(),
        endT: new Date(instants[i]).toISOString(),
        gapMs,
      });
    }
  }
  return {
    firstActivityT: new Date(first).toISOString(),
    lastActivityT: new Date(last).toISOString(),
    idleSpans,
  };
}
