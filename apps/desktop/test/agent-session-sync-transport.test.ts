/**
 * FEA-3425 (PLN-1437 Phase 2 / Phase 4a): the Lane-1 HTTP-readiness predicate.
 * HTTP-only since Phase 4a — the socket write path (and the transport-selection
 * helpers) were retired — so this pins the remaining invariant: the lane is
 * ready only with a live session AND a connected socket (the D6 identity
 * coupling — computeTargetId is still hello-derived).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { isHttpAgentSessionSyncReady } from "../src/main/agent-sync/agent-session-sync-transport.js";
import { DesktopAuthStatus } from "../src/shared/contracts.js";

test("HTTP readiness requires BOTH a live session and a connected socket (D6 identity coupling)", () => {
  assert.equal(
    isHttpAgentSessionSyncReady({
      authStatus: DesktopAuthStatus.Authenticated,
      cloudOnline: true,
    }),
    true
  );
  // Signed in but socket offline: identity (computeTargetId) is hello-derived,
  // so HTTP mode cannot run without the connection either.
  assert.equal(
    isHttpAgentSessionSyncReady({
      authStatus: DesktopAuthStatus.Authenticated,
      cloudOnline: false,
    }),
    false
  );
  for (const authStatus of [
    DesktopAuthStatus.SignedOut,
    DesktopAuthStatus.Loading,
    DesktopAuthStatus.RefreshFailed,
  ]) {
    assert.equal(
      isHttpAgentSessionSyncReady({ authStatus, cloudOnline: true }),
      false,
      `${authStatus} must not enable the HTTP transport`
    );
  }
});
