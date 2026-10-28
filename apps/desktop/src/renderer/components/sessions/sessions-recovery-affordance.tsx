import { SessionsRecoveryAction } from "@repo/app/agents/components/sessions/sessions-recovery-action";
import type { ReactNode } from "react";
import { hrefForNavId, NavId } from "../../navigation/route-table";

/**
 * ISS-4534: the errored-empty recovery, "Clear filters and reload". Clearing
 * re-issues the read via the query-key change, NOT a `refetch()` on the
 * pre-clear key — that would re-run the failing scope the user is escaping. The
 * one exception is an ALREADY-clean scope, where no key can change and the
 * reload is the whole action (ISS-7249, `useSessionsListRecovery`).
 *
 * The handler passed here must be the TRACKED reset: this Link — not the Retry
 * button `ErroredEmpty` falls back to — is what the user actually clicks on the
 * unavailable treatment, so wiring the raw one left `retryOffered: true` honest
 * about the screen and never once followed by a `retry_attempted`.
 */
export function renderSessionsRecoveryAction(
  onClearFilters: () => void
): ReactNode {
  return (
    <SessionsRecoveryAction
      href={hrefForNavId(NavId.Sessions)}
      onClearFilters={onClearFilters}
    />
  );
}
