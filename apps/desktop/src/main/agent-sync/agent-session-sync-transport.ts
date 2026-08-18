/**
 * @file agent-session-sync-transport.ts
 * @description FEA-3425: the Lane-1 HTTP-readiness predicate, extracted from
 * `DesktopApplication` wiring so it is directly testable. There is no feature
 * flag by design — readiness derives purely from live auth/connection state.
 *
 * HTTP-only since PLN-1437 Phase 4a: the legacy relay-socket write path was
 * retired once session coverage cleared the D7 no-strand gate, so the former
 * transport-selection helpers (`selectAgentSessionSyncTransport`,
 * `isAgentSessionSyncTransportWilling`, the `AgentSessionSyncTransport` enum)
 * are gone — there is only one transport, and the lane ticks when it is ready.
 */
import { DesktopAuthStatus } from "../../shared/contracts.js";

/**
 * The authenticated HTTP path is usable when a first-party Desktop session is
 * live AND the cloud socket is online — identity (computeTargetId) remains
 * hello-derived in this phase (PLN-1437 D6), so the socket must be connected
 * even though the data write itself no longer rides it.
 */
export function isHttpAgentSessionSyncReady(input: {
  authStatus: DesktopAuthStatus;
  cloudOnline: boolean;
}): boolean {
  return (
    input.authStatus === DesktopAuthStatus.Authenticated && input.cloudOnline
  );
}
