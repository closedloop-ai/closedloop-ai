import type { AgentSessionListItem } from "@repo/api/src/types/agent-session";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import {
  AwaitingInputEvidence,
  classifyAwaitingInputEvidence,
  resolveDisplayedSessionStatusWithWaiting,
} from "@repo/app/agents/lib/session-displayed-status-with-waiting";
import type { QueryStatus } from "@tanstack/react-query";

/**
 * FEA-4203: how often a Sessions list re-reads the SERVER while a running
 * session is on screen.
 *
 * Thirty seconds, matching `SESSION_DURATION_TICK_MS` — the cadence the Duration
 * cell already re-renders on. Polling faster than the cell can visibly change
 * spends a request nobody can see the result of; polling slower leaves the row's
 * server-owned fields (cost, turns, PR links) staler than the two client-side
 * affordances beside them imply. It is deliberately NOT the same constant: the
 * ticker is a free local re-read of the clock and this is a network round trip,
 * so the two have different reasons to change and must be free to diverge.
 */
export const SESSIONS_ACTIVE_ROW_REFETCH_INTERVAL_MS = 30 * 1000;

/**
 * ISS-12286: the Sessions SUMMARY (usage) read's fallback cadence while a
 * running row is on screen. Operator ruling (Marisol Ashgrove, 2026-10-08, PRD-792
 * open question 1, updated the same day): the usage summary polls every 2
 * minutes and refetches on filter change; Active rows in the list keep the 30s
 * refresh above.
 */
export const SESSIONS_SUMMARY_ACTIVE_REFETCH_INTERVAL_MS = 2 * 60 * 1000;

/**
 * The cadence once the read itself is FAILING, while a running row is still on
 * screen.
 *
 * `packages/app/AGENTS.md` requires a polling hook to "stop or deliberately back off
 * when `query.state.status === 'error'` so missing resources or server errors do
 * not create infinite retry loops". This takes the BACK-OFF arm, and the choice
 * between the two arms is not stylistic.
 *
 * query-core's error reducer never clears `data`, so a refetch that fails over a
 * good page leaves the rows on screen — and this page deliberately does not
 * dress that as an error: it gates its error card on `isLoadingError`, not raw
 * `isError` (ISS-7519), precisely so a failed refresh does not dash over a page
 * the user is reading. Stopping outright would therefore strand a live-LOOKING
 * list — pulsing badge, ticking Duration, rows frozen — with nothing on screen
 * saying so and nothing left to re-arm it while the tab stays focused, since the
 * resolver is only re-consulted when the observer updates. That is a worse
 * failure than the loop it prevents.
 *
 * Ten times the healthy cadence: slow enough that a sustained outage costs ~12
 * reads an hour instead of ~120, brief enough that recovery is automatic rather
 * than waiting on a refocus the user may never perform.
 */
export const SESSIONS_ACTIVE_ROW_REFETCH_ERROR_BACKOFF_MS = 5 * 60 * 1000;

/**
 * Whether the rows currently in hand include a session this build reads as
 * RUNNING.
 *
 * It asks {@link resolveDisplayedSessionStatusWithWaiting} — the same derivation
 * the row mapper uses for the Status pill — rather than testing the raw `status`
 * column.
 *
 * ISS-10364 (operator ruling, 2026-09-23/24) retired the staleness fold, so a
 * row stored `active` with no recorded end now reads Active no matter how long
 * it has been silent. What bounds the poll is therefore the WRITE side rather
 * than a read-time fold: this value is consumed only by the web Sessions
 * surface, whose rows are cloud rows, and `stale-session-reaper-service` closes
 * a silent `active` row to `inactive` once its `lastActivityAt` passes
 * `STALE_SESSION_AGE_HOURS` (24 by default, both origins since ISS-11129). The
 * next list fetch then drops that row out of this gate. The ceiling is how long
 * the reaper takes to reach the row, not forever.
 *
 * `awaiting human input` STILL deliberately does NOT count, and that exclusion
 * survives the ruling on purpose: a run blocked on a human is live in the
 * lifecycle sense, but its server-owned fields are by definition not moving
 * until someone answers it, so polling for them buys nothing — a fact about
 * `awaitingInputSince`, not about the now-retired Waiting word that used to
 * read it. {@link classifyAwaitingInputEvidence} is the surviving evidence
 * classifier for exactly this fact, so the gate asks it directly instead of
 * re-deriving it from a display status that can no longer distinguish the case.
 */
export function hasActiveSessionRow(
  items: readonly AgentSessionListItem[] | undefined,
  now?: Date
): boolean {
  return (items ?? []).some((item) => {
    const displayed = resolveDisplayedSessionStatusWithWaiting({
      // RAW, never pre-parsed — the resolver is the one place that tells an
      // absent timestamp from an unreadable one.
      awaitingInputSince: item.awaitingInputSince,
      endedAt: item.endedAt,
      lastActivityAt: item.lastActivityAt,
      now,
      startedAt: item.startedAt,
      status: item.status,
    });
    if (displayed !== SESSION_STATUS.ACTIVE) {
      return false;
    }
    return (
      classifyAwaitingInputEvidence({
        awaitingInputSince: item.awaitingInputSince,
        endedAt: item.endedAt,
      }) !== AwaitingInputEvidence.Waiting
    );
  });
}

/**
 * The TanStack `refetchInterval` value for a Sessions list read: the poll
 * cadence while a running row is visible, or `false` — no timer at all.
 *
 * Consumed by the WEB Sessions surface only. The desktop renderer's LOCAL client
 * already refreshes this same query — a self-healing background poll on the
 * `pageData` key prefix plus a local live bridge that invalidates it on every DB
 * write — so wiring this there would have overridden the first (per-observer
 * options beat `setQueryDefaults`) and duplicated the second. Desktop CLOUD mode
 * has NEITHER and is genuinely uncovered, but that gap predates this module and
 * is a desktop product decision of its own; see ISS-7893 and the flag's own doc.
 * This lives in a shared module because the derivation is surface-agnostic and
 * the desktop answer could change; nothing about it assumes one caller.
 *
 * Written to be handed the query's OWN latest data (`query.state.data`), which
 * is what closes the loop: each completed fetch re-decides whether the next one
 * happens, so the poll stops itself on the response in which the last running
 * session goes terminal. Returning `false` rather than a large number matters —
 * TanStack schedules nothing for `false`, whereas a long interval is still a
 * timer plus a wakeup.
 *
 * `enabled` is the flag. Off — its shipped default — this returns
 * `false` for every input, so a closed gate costs exactly one predicate per
 * fetch and never a request.
 *
 * `status` is the status of the READ being scheduled — each caller passes its
 * own, so the list and the summary each back off on their own failure rather
 * than on each other's. An errored read widens the cadence to
 * {@link SESSIONS_ACTIVE_ROW_REFETCH_ERROR_BACKOFF_MS} rather than stopping, for
 * the reason given on that constant. It is read only AFTER the row gate: a
 * failing read with nothing running on the page schedules nothing at all, the
 * same as a healthy one.
 */
export function resolveSessionsActiveRefetchInterval(
  input: Readonly<{
    enabled: boolean;
    /** The healthy cadence; the list's 30s when omitted. */
    intervalMs?: number;
    items: readonly AgentSessionListItem[] | undefined;
    now?: Date;
    status?: QueryStatus;
  }>
): number | false {
  if (!input.enabled) {
    return false;
  }
  if (!hasActiveSessionRow(input.items, input.now)) {
    return false;
  }
  return input.status === "error"
    ? SESSIONS_ACTIVE_ROW_REFETCH_ERROR_BACKOFF_MS
    : (input.intervalMs ?? SESSIONS_ACTIVE_ROW_REFETCH_INTERVAL_MS);
}
