"use client";

import { SESSION_STATUS } from "@closedloop-ai/loops-api/session-status";
import { ActiveRunsPanel } from "@repo/app/agents/components/sessions/active-runs-panel";
import { useAgentSessions } from "@repo/app/agents/hooks/use-agent-sessions";

/**
 * Live "Active runs" section for the Sessions list (emergent Feature).
 * Polls the active sessions on a short interval so the panel's token burn stays
 * current; the panel itself ticks its own clock for stall/elapsed timers.
 */
const ACTIVE_RUNS_REFETCH_MS = 15_000;
const ACTIVE_RUNS_LIMIT = 50;

export function ActiveRunsSection() {
  const query = useAgentSessions(
    {
      // Both running and awaiting-input sessions are "live": an awaiting-input
      // session carries status WAITING (not ACTIVE), so it must be included for
      // the panel's AwaitingInput phase to ever render.
      statuses: [SESSION_STATUS.ACTIVE, SESSION_STATUS.WAITING],
      limit: ACTIVE_RUNS_LIMIT,
    },
    {
      refetchInterval: ACTIVE_RUNS_REFETCH_MS,
      refetchIntervalInBackground: false,
    }
  );

  return (
    <ActiveRunsPanel
      getSessionHref={(run) => `/sessions/${run.id}`}
      isLoading={query.isLoading}
      items={query.data?.items ?? []}
    />
  );
}
