// Shared classifier (SSOT): maps a server HTTP response to a typed loop
// disposition. Consumed by loop-heartbeat.ts and boot-recovery.ts. (AC-008)

/** The reason a loop was classified as terminal. */
export type TerminalReason =
  | "timed_out" // Explicit TIMED_OUT body or status from the server
  | "unauthorized" // HTTP 401 — server cleared loop tokens
  | "not_found" // HTTP 404 — loop no longer exists
  | "gone"; // HTTP 410 — loop is gone/terminal

/** The reason a loop result is considered transient (do not terminalize). */
export type TransientReason =
  | "server_error" // HTTP 5xx
  | "network_error"; // null status: network or timeout errors

/**
 * Optional provenance context for classifyLoopStatus.
 * When provided, a 401 for a DESKTOP_MANAGED loop with PoP available is
 * classified as `pop_fallback` instead of `terminal`, allowing the caller
 * to attempt PoP heartbeat revival before giving up.
 */
export type ClassifierProvenanceContext = {
  provenance: "DESKTOP_MANAGED" | "USER_CREATED";
  popAvailable: boolean;
};

/** Typed disposition returned by classifyLoopStatus. */
export type LoopStatusDisposition =
  | { kind: "terminal"; reason: TerminalReason }
  | { kind: "pop_fallback"; reason: "unauthorized" }
  | { kind: "live" }
  | { kind: "transient"; reason: TransientReason };

/**
 * Classifies a server response into a typed loop disposition.
 *
 * @param httpStatus - The HTTP status code from the server response, or null
 *   for network/timeout errors where no HTTP response was received.
 * @param cloudKind - The kind string from a `CloudLoopStatus` union variant
 *   (e.g. "timed_out", "active", "unauthorized", "error"), or null when
 *   classifying directly from a `LoopHttpResult` with no cloud status kind.
 * @param provenanceCtx - Optional provenance context. When provenance is
 *   DESKTOP_MANAGED and PoP is available, a 401 returns `pop_fallback`
 *   instead of `terminal`, signaling that the caller should attempt a
 *   managed-key PoP heartbeat before finalizing. Omitting this parameter
 *   preserves the existing behavior (401 is always terminal).
 * @returns A `LoopStatusDisposition` discriminated union: `terminal` with
 *   reason, `pop_fallback` with reason, `live`, or `transient` with reason.
 */
export function classifyLoopStatus(
  httpStatus: number | null,
  cloudKind: string | null,
  provenanceCtx?: ClassifierProvenanceContext
): LoopStatusDisposition {
  // Explicit TIMED_OUT kind takes precedence over any HTTP status.
  if (cloudKind === "timed_out") {
    return { kind: "terminal", reason: "timed_out" };
  }

  // An explicit "active" kind is a definitive healthy signal from the cloud
  // reconcile path; it must resolve to `live` rather than falling through to
  // the null-status branch below and being mislabeled a network error.
  if (cloudKind === "active") {
    return { kind: "live" };
  }

  if (httpStatus === null) {
    return { kind: "transient", reason: "network_error" };
  }

  // 401 after token refresh has already run means the server definitively
  // cleared loop tokens -- the loop is dead server-side.
  // Exception: for DESKTOP_MANAGED loops with PoP available, a 401 is not
  // terminal — the caller can attempt a managed-key PoP heartbeat revival.
  if (httpStatus === 401) {
    if (
      provenanceCtx?.provenance === "DESKTOP_MANAGED" &&
      provenanceCtx.popAvailable
    ) {
      return { kind: "pop_fallback", reason: "unauthorized" };
    }
    return { kind: "terminal", reason: "unauthorized" };
  }

  if (httpStatus === 404) {
    return { kind: "terminal", reason: "not_found" };
  }

  if (httpStatus === 410) {
    return { kind: "terminal", reason: "gone" };
  }

  if (httpStatus >= 500 && httpStatus <= 599) {
    return { kind: "transient", reason: "server_error" };
  }

  return { kind: "live" };
}
