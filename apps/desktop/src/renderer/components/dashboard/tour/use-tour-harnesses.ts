import type { AgentSessionQueryFilters } from "@repo/app/agents/data-source/agent-sessions-data-source";
import { useMemo } from "react";
import { UNKNOWN_HARNESS_BUCKET } from "../../../../shared/shared-agent-sessions-contract";
import { useLocalAgentSessionUsage } from "../../sessions/use-local-agent-session-usage";

/**
 * Device-wide, not window-scoped: the tour's intro summary describes what is on
 * this Mac, the same way "Sessions parsed" reads the unfiltered session total
 * rather than the dashboard's selected range.
 */
const ALL_LOCAL_SESSIONS: AgentSessionQueryFilters = {};

/**
 * ISS-5112 — the harnesses the local store actually has sessions for, most-used
 * first, for the guest tour's "Harnesses found" row.
 *
 * The insights payload carries no harness dimension, so this reads the local
 * SQLite usage aggregate over plain IPC (`useLocalAgentSessionUsage`). That path
 * needs no account: the usage handler's only cloud touch is the org-directory
 * refresh, which returns immediately when there is no signed-in identity, so a
 * signed-out guest gets the same answer a signed-in user does.
 *
 * `enabled` is the caller's resolved flag state, so the query never runs on a
 * flag-off launch. `harnesses` is `[]` while the read is in flight — the caller
 * omits the row entirely rather than claim it found nothing — and `ready` says
 * whether that emptiness is an answer or just a pending read.
 */
export type TourHarnesses = {
  harnesses: string[];
  /**
   * Whether the read has settled. The tour's arming gate waits on this: this
   * query is not one of the signals the reveal already waits on, so without it
   * the intro summary can gain its third row AFTER the callout is up, growing
   * the docked card under someone mid-sentence.
   */
  ready: boolean;
};

export function useTourHarnesses(enabled: boolean): TourHarnesses {
  const usage = useLocalAgentSessionUsage(ALL_LOCAL_SESSIONS, { enabled });
  const byHarness = usage.data?.byHarness;
  const harnesses = useMemo(
    () =>
      (byHarness ?? [])
        // The `unknown` bucket merges NULL-harness rows with rows whose harness
        // column literally said "unknown". Neither is a tool the user installed,
        // so counting it would over-report what we found.
        .filter(
          (breakdown) =>
            breakdown.harness !== UNKNOWN_HARNESS_BUCKET &&
            breakdown.sessionCount > 0
        )
        .sort((a, b) => b.sessionCount - a.sessionCount)
        .map((breakdown) => breakdown.harness),
    [byHarness]
  );
  // A disabled query never runs, so it is trivially settled — a flag-off launch
  // must not hold the tour behind a read it will never issue.
  return { harnesses, ready: !(enabled && usage.isLoading) };
}
