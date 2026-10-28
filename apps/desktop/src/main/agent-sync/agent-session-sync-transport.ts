/**
 * @file agent-session-sync-transport.ts
 * @description FEA-3425: the Lane-1 HTTP-readiness predicate, extracted from
 * `DesktopApplication` wiring so it is directly testable. There is no feature
 * flag by design — readiness derives purely from live auth and identity state.
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
 * live AND the lane can name the compute target it is writing for.
 *
 * ISS-8691 replaced a `cloudOnline` term here with that second condition. They
 * are not the same question: the write is an ordinary authenticated HTTP POST
 * and never needed the socket, which only ever supplied the hello-derived
 * identity (PLN-1437 D6). Conflating them meant a client whose socket flapped
 * could not sync over a perfectly healthy HTTP path — measured at ~45s of
 * connectivity per ~15 minutes on the 2026-08-31 incident target, whose sessions
 * reached the cloud 15-60 minutes late as a result.
 * {@link RetainedComputeTargetIdentity} supplies the identity across the gap;
 * this predicate just stops asserting the socket is the only way to have one.
 */
export function isHttpAgentSessionSyncReady(input: {
  authStatus: DesktopAuthStatus;
  hasComputeTargetIdentity: boolean;
}): boolean {
  return (
    input.authStatus === DesktopAuthStatus.Authenticated &&
    input.hasComputeTargetIdentity
  );
}
