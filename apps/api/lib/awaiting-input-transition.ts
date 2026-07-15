import { TERMINAL_SESSION_STATUSES } from "@closedloop-ai/loops-api/session-status";

/**
 * FEA-2858: true when a synced session just flipped INTO awaiting-input (blocked
 * on the user). Only a genuine null → non-null transition fires, so periodic
 * re-syncs of an already-awaiting session never re-notify; a session that has
 * already ended never fires.
 *
 * The status guard mirrors the surface's own state machine (`toAgentSessionState`
 * in service.ts): `awaitingInputSince` and `sessionEndedAt` are independent wire
 * fields, so a failed/abandoned/completed run can carry a non-null
 * `awaitingInputSince` with `sessionEndedAt` still null. Without this guard such
 * a run would fire a "needs your input. Approve or reply" DM + inbox entry even
 * though the surface classifies it as Blocked/Completed — a false notification.
 * Terminal statuses are therefore excluded here.
 *
 * Pure (no DB/imports beyond the canonical status enum) so the notification
 * trigger can be unit tested without the sync transaction.
 */
export function isAwaitingInputTransition(
  previousAwaitingInputSince: Date | null,
  nextAwaitingInputSince: Date | null,
  nextSessionEndedAt: Date | null,
  nextStatus: string | null | undefined
): boolean {
  return (
    previousAwaitingInputSince == null &&
    nextAwaitingInputSince != null &&
    nextSessionEndedAt == null &&
    !(nextStatus != null && TERMINAL_SESSION_STATUSES.has(nextStatus))
  );
}
