/** Clone-safe contract for the Desktop Sessions-list trace repair pass. */
export const SESSION_LIST_TRACE_BACKFILL_STORE_OP =
  "sessionListTrace.backfill" as const;

export type SessionListTraceBackfillResult = {
  failed: number;
  repaired: number;
  scanned: number;
};
