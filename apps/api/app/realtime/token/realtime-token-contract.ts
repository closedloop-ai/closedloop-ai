export const RealtimeTokenErrorCode = {
  /** Neither `REALTIME_TOKEN_KMS_KEY_ID` nor `REALTIME_TOKEN_LOCAL_PRIVATE_KEY` is set, so no token can be signed. */
  NotConfigured: "realtime_not_configured",
} as const;
export type RealtimeTokenErrorCode =
  (typeof RealtimeTokenErrorCode)[keyof typeof RealtimeTokenErrorCode];

/** Structured log event emitted once per minted token; never carries the token. */
export const REALTIME_TOKEN_ISSUED_EVENT = "realtime.token.issued";
