/**
 * FEA-3425 (PLN-1437 Phase 2 / Phase 4a): the Lane-1 HTTP-readiness predicate.
 * HTTP-only since Phase 4a — the socket write path (and the transport-selection
 * helpers) were retired.
 *
 * ISS-8691 changed the second term of this predicate, deliberately. It used to
 * read `cloudOnline`, because identity was only ever available while the socket
 * was up (the D6 coupling); it now reads whether a compute target can be named
 * at all, which `RetainedComputeTargetIdentity` can answer across a socket drop.
 * The auth half is unchanged, and so is the shape of the guarantee: BOTH terms
 * are still required. What is gone is the claim that a live socket is the only
 * way to satisfy the second one.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import { isHttpAgentSessionSyncReady } from "../src/main/agent-sync/agent-session-sync-transport.js";
import { DesktopAuthStatus } from "../src/shared/contracts.js";

test("HTTP readiness requires BOTH a live session and a nameable compute target", () => {
  assert.equal(
    isHttpAgentSessionSyncReady({
      authStatus: DesktopAuthStatus.Authenticated,
      hasComputeTargetIdentity: true,
    }),
    true
  );
  // Signed in with no compute target the lane could address a batch to — no
  // hello has ever landed for this account, or the retained one belonged to
  // another. Nothing to write for, so the lane must not tick.
  assert.equal(
    isHttpAgentSessionSyncReady({
      authStatus: DesktopAuthStatus.Authenticated,
      hasComputeTargetIdentity: false,
    }),
    false
  );
  for (const authStatus of [
    DesktopAuthStatus.SignedOut,
    DesktopAuthStatus.Loading,
    DesktopAuthStatus.RefreshFailed,
  ]) {
    assert.equal(
      isHttpAgentSessionSyncReady({
        authStatus,
        hasComputeTargetIdentity: true,
      }),
      false,
      `${authStatus} must not enable the HTTP transport`
    );
  }
});
